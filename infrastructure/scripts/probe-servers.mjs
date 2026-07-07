#!/usr/bin/env node
// Client-eye reachability + protocol probe for deployed Kiyeovo infra nodes.
//
// Unlike the container healthcheck (which only proves a process is up from
// INSIDE the container), this dials each server the way a real client would and
// verifies it is actually reachable AND speaking the right protocol:
//
//   bootstrap  libp2p dial -> the noise handshake verifies the peer ID against
//              the multiaddr, then a stream is opened on the fast DHT protocol
//              (/kiyeovo-fast/1.0.0/dht). Opening that stream is what catches the
//              "port is open and it connects, but every DHT op is rejected"
//              mode/protocol mismatch that a bare TCP check cannot see.
//   relay      same, on the circuit-relay v2 hop protocol.
//   stun       a raw STUN binding request; confirms it answers with the caller's
//              reflexive address.
//   turn       an authenticated Allocate (long-term credential); confirms the
//              relay allocates AND the credential is valid.
//   onion-bootstrap  NOT dialed here (needs a running Tor daemon); the exact
//              functional command to run is printed instead.
//
// Usage:
//   infrastructure/scripts/probe-servers.mjs servers.json
//   kiyeovo-infra addresses ... | (produce JSON) | probe-servers.mjs -
//   probe-servers.mjs servers.json --json      # machine-readable output
//
// Input: a JSON array of entries. `node` groups the table; `kind` is one of
// bootstrap | relay | stun | turn | onion-bootstrap. TURN credentials may be
// given per-entry (username/credential) or via env TURN_USER/TURN_PASS.
//
//   [
//     { "node": "sfo2", "kind": "bootstrap", "value": "/ip4/1.2.3.4/tcp/9000/p2p/12D3Koo..." },
//     { "node": "sfo2", "kind": "relay",     "value": "/ip4/1.2.3.4/tcp/4002/p2p/12D3Koo..." },
//     { "node": "sfo2", "kind": "stun",      "value": "stun:1.2.3.4:3478" },
//     { "node": "sfo2", "kind": "turn",      "value": "turn:1.2.3.4:3478", "username": "kiyeovo", "credential": "SECRET" },
//     { "node": "sfo2", "kind": "onion-bootstrap", "value": "/onion3/abc...:9000/p2p/12D3Koo..." }
//   ]
//
// SECURITY: a file containing real TURN credentials is a secret — keep it
// gitignored (e.g. alongside e2e/e2e.env.local) or pass creds via env instead.
//
// Exits non-zero if any dialed (non-onion) check fails, so it can gate a deploy.

import { readFile } from 'node:fs/promises';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';

const FAST_DHT_PROTOCOL = '/kiyeovo-fast/1.0.0/dht';
const RELAY_HOP_PROTOCOL = '/libp2p/circuit/relay/0.2.0/hop';
const DIAL_TIMEOUT_MS = 20_000;
const STREAM_TIMEOUT_MS = 15_000;
const UDP_TIMEOUT_MS = 6_000;
const STUN_MAGIC_COOKIE = 0x2112a442;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  console.log(readFileHelp());
  process.exit(args.length === 0 ? 2 : 0);
}
const jsonOut = args.includes('--json');
const inputPath = args.find((a) => a !== '--json') ?? '-';

function readFileHelp() {
  return 'Usage: probe-servers.mjs <servers.json|-> [--json]\n' +
    '  Reads a JSON array of { node, kind, value, [username], [credential] } entries.\n' +
    '  kind: bootstrap | relay | stun | turn | onion-bootstrap.\n' +
    '  TURN creds: per-entry or via env TURN_USER / TURN_PASS.\n' +
    '  Exits non-zero if any dialed check fails.';
}

async function readInput(path) {
  const raw = path === '-'
    ? await new Promise((res) => { let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => res(d)); })
    : await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('input must be a JSON array');
  return parsed;
}

// --- libp2p dial + protocol check (bootstrap / relay) ---
async function probeLibp2p(value, protocol) {
  const started = Date.now();
  const node = await createLibp2p({
    transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
    services: { identify: identify() },
    connectionManager: { maxConnections: 10 },
  });
  await node.start();
  try {
    const ma = multiaddr(value);
    const expectedPeer = ma.getPeerId();
    const conn = await node.dial(ma, { signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) });
    const dialMs = Date.now() - started;
    const peerIdMatch = conn.remotePeer.toString() === expectedPeer;
    let protoOk = false, protoErr;
    try {
      const stream = await conn.newStream(protocol, { signal: AbortSignal.timeout(STREAM_TIMEOUT_MS) });
      protoOk = true;
      await stream.close().catch(() => {});
    } catch (err) { protoErr = err?.message ?? String(err); }
    return { ok: peerIdMatch && protoOk, detail: `dial ${dialMs}ms, peerId ${peerIdMatch ? 'match' : 'MISMATCH'}, ${protocol} ${protoOk ? 'ok' : 'FAIL'}${protoErr ? ` (${protoErr})` : ''}` };
  } catch (err) {
    return { ok: false, detail: `dial failed: ${err?.message ?? String(err)}` };
  } finally {
    await node.stop().catch(() => {});
  }
}

// --- STUN / TURN over UDP ---
function stunHeader(type, attrs, tid) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0); h.writeUInt16BE(attrs.length, 2);
  h.writeUInt32BE(STUN_MAGIC_COOKIE, 4); tid.copy(h, 8);
  return Buffer.concat([h, attrs]);
}
function stunAttr(type, val) {
  const pad = (4 - (val.length % 4)) % 4;
  const a = Buffer.alloc(4 + val.length + pad);
  a.writeUInt16BE(type, 0); a.writeUInt16BE(val.length, 2); val.copy(a, 4);
  return a;
}
function parseStunAttrs(msg) {
  const out = {}; let o = 20;
  while (o + 4 <= msg.length) {
    const t = msg.readUInt16BE(o), l = msg.readUInt16BE(o + 2);
    out[t] = msg.slice(o + 4, o + 4 + l); o += 4 + l + ((4 - (l % 4)) % 4);
  }
  return out;
}
function xorAddr(attr) {
  const port = attr.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16);
  const ip = [attr[4] ^ 0x21, attr[5] ^ 0x12, attr[6] ^ 0xa4, attr[7] ^ 0x42].join('.');
  return `${ip}:${port}`;
}
function hostPort(value) {
  const m = value.replace(/^(stuns?|turns?):/, '').split('?')[0];
  const [host, port] = m.split(':');
  return { host, port: Number(port) || 3478 };
}
function udpSend(sock, buf, host, port) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('timeout')), UDP_TIMEOUT_MS);
    sock.once('message', (m) => { clearTimeout(to); res(m); });
    sock.send(buf, port, host, (e) => { if (e) { clearTimeout(to); rej(e); } });
  });
}
async function probeStun(value) {
  const { host, port } = hostPort(value);
  const sock = dgram.createSocket('udp4');
  try {
    const tid = crypto.randomBytes(12);
    const resp = await udpSend(sock, stunHeader(0x0001, Buffer.alloc(0), tid), host, port);
    const attrs = parseStunAttrs(resp);
    const reflexive = attrs[0x0020] ? xorAddr(attrs[0x0020]) : null;
    const ok = resp.readUInt16BE(0) === 0x0101;
    return { ok, detail: ok ? `binding ok, reflexive ${reflexive ?? '?'}` : 'no binding success' };
  } catch (err) {
    return { ok: false, detail: `stun failed: ${err?.message ?? String(err)}` };
  } finally { sock.close(); }
}
async function probeTurn(value, username, credential) {
  if (!username || !credential) return { ok: false, detail: 'no TURN credential (set username/credential or TURN_USER/TURN_PASS)' };
  const { host, port } = hostPort(value);
  const sock = dgram.createSocket('udp4');
  try {
    const reqTransport = stunAttr(0x0019, Buffer.from([17, 0, 0, 0]));
    // First Allocate -> expect 401 with realm + nonce.
    const r1 = await udpSend(sock, stunHeader(0x0003, reqTransport, crypto.randomBytes(12)), host, port);
    const a1 = parseStunAttrs(r1);
    const realm = a1[0x0014], nonce = a1[0x0015];
    if (!realm || !nonce) return { ok: false, detail: 'no realm/nonce in Allocate response' };
    // Re-send Allocate with MESSAGE-INTEGRITY.
    const key = crypto.createHash('md5').update(`${username}:${realm.toString()}:${credential}`).digest();
    const tid = crypto.randomBytes(12);
    const pre = Buffer.concat([
      stunAttr(0x0019, Buffer.from([17, 0, 0, 0])),
      stunAttr(0x0006, Buffer.from(username)),
      stunAttr(0x0014, realm),
      stunAttr(0x0015, nonce),
    ]);
    const lenWithMI = pre.length + 24; // MESSAGE-INTEGRITY attr is 24 bytes
    const forMac = Buffer.alloc(20 + pre.length);
    forMac.writeUInt16BE(0x0003, 0); forMac.writeUInt16BE(lenWithMI, 2);
    forMac.writeUInt32BE(STUN_MAGIC_COOKIE, 4); tid.copy(forMac, 8); pre.copy(forMac, 20);
    const mac = crypto.createHmac('sha1', key).update(forMac).digest();
    const alloc2 = Buffer.concat([forMac, stunAttr(0x0008, mac)]);
    const r2 = await udpSend(sock, alloc2, host, port);
    const type = r2.readUInt16BE(0);
    const a2 = parseStunAttrs(r2);
    const relayed = a2[0x0016] ? xorAddr(a2[0x0016]) : null;
    if (type === 0x0103) return { ok: true, detail: `allocate ok, relayed ${relayed ?? '?'}` };
    const errStr = a2[0x0009] ? a2[0x0009].slice(4).toString() : `code 0x${type.toString(16)}`;
    return { ok: false, detail: `allocate rejected: ${errStr}` };
  } catch (err) {
    return { ok: false, detail: `turn failed: ${err?.message ?? String(err)}` };
  } finally { sock.close(); }
}

async function probeEntry(entry) {
  const username = entry.username ?? process.env.TURN_USER;
  const credential = entry.credential ?? process.env.TURN_PASS;
  switch (entry.kind) {
    case 'bootstrap': return probeLibp2p(entry.value, FAST_DHT_PROTOCOL);
    case 'relay': return probeLibp2p(entry.value, RELAY_HOP_PROTOCOL);
    case 'stun': return probeStun(entry.value);
    case 'turn': return probeTurn(entry.value, username, credential);
    case 'onion-bootstrap':
      return { skip: true, detail: `run: KIYEOVO_E2E_ONION_BOOTSTRAP='${entry.value}' npx playwright test e2e/tor-deployed-infra.spec.ts` };
    default: return { ok: false, detail: `unknown kind '${entry.kind}'` };
  }
}

const entries = await readInput(inputPath);
const results = await Promise.all(entries.map(async (e) => ({ entry: e, ...(await probeEntry(e)) })));

if (jsonOut) {
  console.log(JSON.stringify(results.map((r) => ({ node: r.entry.node, kind: r.entry.kind, ok: r.ok ?? null, skip: !!r.skip, detail: r.detail })), null, 2));
} else {
  const byNode = new Map();
  for (const r of results) {
    const node = r.entry.node ?? '(unlabeled)';
    if (!byNode.has(node)) byNode.set(node, []);
    byNode.get(node).push(r);
  }
  for (const [node, rows] of byNode) {
    console.log(`\n${node}`);
    for (const r of rows) {
      const mark = r.skip ? '›' : (r.ok ? '✓' : '✗');
      console.log(`  ${mark} ${r.entry.kind.padEnd(16)} ${r.detail}`);
    }
  }
}

const failed = results.filter((r) => !r.skip && !r.ok);
if (!jsonOut) {
  const dialed = results.filter((r) => !r.skip);
  console.log(`\n${dialed.length - failed.length}/${dialed.length} dialed checks passed` +
    (results.some((r) => r.skip) ? ` (${results.filter((r) => r.skip).length} onion entries: run the printed command)` : ''));
}
process.exit(failed.length > 0 ? 1 : 0);
