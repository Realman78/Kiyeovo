#!/usr/bin/env node
// Container healthcheck.
//
// "Healthy" = the process is up (this script runs inside the container), the
// server has published its runtime metadata (written only once it has started
// and its addresses are known), and the local listener accepts a TCP
// connection. It deliberately does NOT test external reachability — a node that
// is up but unreachable from the public internet is a firewall/NAT issue, not
// an unhealthy container.

import { readFile } from 'node:fs/promises';
import net from 'node:net';

const runtimeFile = process.env.KIYEOVO_RUNTIME_FILE;
const port = process.env.KIYEOVO_HEALTHCHECK_PORT;

const VALID_ROLES = new Set(['bootstrap', 'relay']);

function fail(message) {
  console.error(`[healthcheck] ${message}`);
  process.exit(1);
}

if (!runtimeFile) {
  fail('KIYEOVO_RUNTIME_FILE is not set');
}

let meta;
try {
  meta = JSON.parse(await readFile(runtimeFile, 'utf8'));
} catch (err) {
  fail(`runtime metadata missing or unreadable: ${err.message}`);
}

if (!meta || typeof meta !== 'object') {
  fail('runtime metadata is not an object');
}
if (meta.schemaVersion !== 1) {
  fail(`runtime metadata has unexpected schemaVersion: ${meta.schemaVersion}`);
}
if (!VALID_ROLES.has(meta.role)) {
  fail(`runtime metadata has unexpected role: ${meta.role}`);
}
if (typeof meta.peerId !== 'string' || meta.peerId.length === 0) {
  fail('runtime metadata has no peerId');
}
if (!Array.isArray(meta.clientAddrs) || meta.clientAddrs.length === 0) {
  fail('runtime metadata has no clientAddrs');
}

if (port) {
  await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    socket.setTimeout(3000);
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      fail(`listener on 127.0.0.1:${port} timed out`);
    });
    socket.once('error', (err) => {
      socket.destroy();
      fail(`listener on 127.0.0.1:${port}: ${err.message}`);
    });
  });
}

process.exit(0);
