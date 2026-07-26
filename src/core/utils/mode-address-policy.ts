import { NETWORK_MODES } from '../constants.js';

import type { Component, Multiaddr } from '@multiformats/multiaddr';
import type { NetworkMode } from '../types.js';

// Multiaddr protocol code for /onion3 (Tor v3 hidden service).
const ONION3_CODE = 445;

/**
 * Is this multiaddr allowed to be stored/dialed in the given network mode?
 *
 * In `anonymous` mode the answer is "only /onion3 addresses". Everything else —
 * /ip4, /ip6, /dns*, /unix — is rejected, because dialing any of them leaves the
 * machine outside Tor and discloses the real IP.
 *
 * This has to be enforced where addresses are *consumed*, not only where they are
 * published. `UsernameRegistry.getPublishableAddresses` already filters our own
 * announced addresses to /onion3, but a peer's addresses arrive from sources we do
 * not control — the `multiaddrs` field of a signed username DHT record, and the
 * self-declared `listenAddrs` in an identify message. Both are attacker-chosen, and
 * a signature on the record proves only that the attacker owns that peer ID, not
 * that the address is safe to dial.
 *
 * The reason a clearnet address is dangerous rather than merely useless: libp2p
 * picks a transport by walking the registered transports in insertion order and
 * taking the first whose `dialFilter` matches (`transport-manager.js`
 * `dialTransportForMultiaddr`). Anonymous mode registers plain `tcp()` first (it
 * owns the loopback listener the onion service forwards to), and @libp2p/tcp claims
 * every TCP-family address, so a /ip4 address never reaches TorTransport at all —
 * it is dialed directly. The default address sorter also ranks direct addresses
 * ahead of /onion3, so a clearnet address is tried first.
 *
 * `fast` mode is intentionally unrestricted here. It legitimately dials relay
 * circuits, hole-punched direct addresses and bootstraps, and narrowing that set
 * needs its own analysis.
 */
export function isAddressAllowedForMode(ma: Multiaddr, networkMode: NetworkMode): boolean {
  if (networkMode !== NETWORK_MODES.ANONYMOUS) return true;
  return ma.getComponents().some((c: Component) => c.code === ONION3_CODE);
}

/** Convenience wrapper: keep only the addresses allowed in `networkMode`. */
export function filterAddressesForMode(
  multiaddrs: Multiaddr[],
  networkMode: NetworkMode,
): Multiaddr[] {
  return multiaddrs.filter((ma) => isAddressAllowedForMode(ma, networkMode));
}
