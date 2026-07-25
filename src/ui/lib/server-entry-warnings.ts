/**
 * Setup-page misconfiguration warnings — pure, renderer-side heuristics.
 *
 * Grew out of a real field incident: a bootstrap multiaddr was pasted into the
 * relay server list. Nothing complained at input time; message sends later
 * failed deep in libp2p ("protocol selection failed", failed relay
 * reservations) because bootstrap and relay are different services even
 * though both are configured as multiaddrs. These checks catch that class of
 * mistake — and the softer "wrong port for this role" case — right where the
 * address is entered or reviewed, without blocking the save.
 */

export type ServerListKind = 'bootstrap' | 'relay' | 'stun' | 'turn' | 'turns';

export type ServerEntryWarningCode = 'cross-list-duplicate' | 'port-heuristic' | 'wrong-format';

export interface ServerEntryWarning {
  code: ServerEntryWarningCode;
  message: string;
}

/** The `otherListsContents` argument: the OTHER kind's saved address strings. */
export type OtherListsContents = Partial<Record<'bootstrap' | 'relay', readonly string[]>>;

// Kiyeovo's own infra convention (see predefined-nodes.ts / the bootstrap and
// relay entrypoints): bootstrap listens on 9000, relay on 4002. Self-hosters
// may use any port, so a match here is a hint, not an error.
const BOOTSTRAP_CONVENTION_PORT = '9000';
const RELAY_CONVENTION_PORT = '4002';

interface ParsedMultiaddr {
  host: string;
  port: string;
  peerId: string | null;
}

const HOST_PROTOCOLS = new Set(['ip4', 'ip6', 'dns', 'dns4', 'dns6', 'dnsaddr']);

/**
 * Minimal multiaddr parser: pulls out the dialable host, port, and /p2p/ peer
 * ID with simple segment scanning (mirrors the parsing `SetupNodesView`
 * already does for display). Not a full multiaddr implementation — good
 * enough for the host/port/peerId comparisons these warnings need.
 */
export function parseMultiaddr(address: string): ParsedMultiaddr | null {
  const segments = address.trim().split('/').filter((segment) => segment.length > 0);
  let host: string | null = null;
  let port: string | null = null;
  let peerId: string | null = null;

  for (let i = 0; i < segments.length; i += 1) {
    const proto = segments[i];
    const value = segments[i + 1];
    if (!value) continue;

    if (proto === 'onion3') {
      // Onion addresses embed the port after a colon in the same segment
      // (e.g. `/onion3/<addr>:9000/p2p/...`) instead of a separate /tcp/.
      const [onionHost, onionPort] = value.split(':');
      if (onionHost && !host) host = onionHost;
      if (onionPort && !port) port = onionPort;
    } else if (!host && HOST_PROTOCOLS.has(proto ?? '')) {
      host = value;
    } else if (!port && (proto === 'tcp' || proto === 'udp')) {
      port = value;
    } else if (proto === 'p2p' || proto === 'ipfs') {
      peerId = value;
    }
  }

  if (!host || !port) return null;
  return { host, port, peerId };
}

function sameHostPort(a: ParsedMultiaddr, b: ParsedMultiaddr): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port;
}

function crossListDuplicateMessage(listKind: 'bootstrap' | 'relay'): string {
  return listKind === 'bootstrap'
    ? "This address is already configured as a relay server — bootstrap and relay are different services (a relay address here will not work as a bootstrap)."
    : "This address is already configured as a bootstrap server — bootstrap and relay are different services (a bootstrap address here will not work as a relay).";
}

function portHeuristicMessage(listKind: 'bootstrap' | 'relay'): string {
  return listKind === 'relay'
    ? "Port 9000 is Kiyeovo's bootstrap convention — if this is a Kiyeovo infra node, its relay runs on port 4002."
    : "Port 4002 is Kiyeovo's relay convention — if this is a Kiyeovo infra node, its bootstrap runs on port 9000.";
}

function getBootstrapOrRelayWarning(
  entryValue: string,
  listKind: 'bootstrap' | 'relay',
  otherLists: OtherListsContents,
): ServerEntryWarning | null {
  const parsed = parseMultiaddr(entryValue);
  if (!parsed) return null;

  const otherKind = listKind === 'bootstrap' ? 'relay' : 'bootstrap';
  const otherValues = otherLists[otherKind] ?? [];
  const isCrossListDuplicate = otherValues.some((other) => {
    const otherParsed = parseMultiaddr(other);
    if (!otherParsed) return false;
    if (parsed.peerId && otherParsed.peerId && parsed.peerId === otherParsed.peerId) return true;
    return sameHostPort(parsed, otherParsed);
  });
  if (isCrossListDuplicate) {
    return { code: 'cross-list-duplicate', message: crossListDuplicateMessage(listKind) };
  }

  const conventionPort = listKind === 'relay' ? BOOTSTRAP_CONVENTION_PORT : RELAY_CONVENTION_PORT;
  if (parsed.port === conventionPort) {
    return { code: 'port-heuristic', message: portHeuristicMessage(listKind) };
  }

  return null;
}

// A pasted libp2p multiaddr (the exact incident this feature exists for, just
// aimed at the STUN/TURN field instead) is unambiguously the wrong shape for
// a `stun:`/`turn:`/`turns:` URL — flag it without building out a general
// STUN/TURN validation framework.
function getIceEntryWarning(entryValue: string): ServerEntryWarning | null {
  if (entryValue.startsWith('/') && /\/(tcp|udp)\//.test(entryValue)) {
    return {
      code: 'wrong-format',
      message: 'This looks like a bootstrap/relay multiaddr, not a STUN/TURN URL — STUN/TURN entries use a stun:/turn:/turns: URL (e.g. stun:host:3478).',
    };
  }
  return null;
}

/**
 * Given a server-list entry, which list it belongs to, and the contents of
 * the other bootstrap/relay list, return a dismissable warning to show next
 * to the entry, or null if nothing looks off. Never blocks saving — this is
 * advisory only.
 */
export function getServerEntryWarning(
  entryValue: string,
  listKind: ServerListKind,
  otherLists: OtherListsContents,
): ServerEntryWarning | null {
  const value = entryValue.trim();
  if (!value) return null;

  if (listKind === 'stun' || listKind === 'turn' || listKind === 'turns') {
    return getIceEntryWarning(value);
  }

  return getBootstrapOrRelayWarning(value, listKind, otherLists);
}
