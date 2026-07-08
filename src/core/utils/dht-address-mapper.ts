import { removePrivateAddressesMapper } from '@libp2p/kad-dht';

import type { PeerInfo } from '@libp2p/interface';
import type { Component, Multiaddr } from '@multiformats/multiaddr';

// Multiaddr protocol code for /p2p-circuit (relayed connections).
const P2P_CIRCUIT_CODE = 290;

/**
 * kad-dht peerInfoMapper that keeps only publicly-dialable, DIRECT addresses.
 *
 * `removePrivateAddressesMapper` drops private/loopback direct addresses, but it
 * only inspects the FIRST address tuple — so a relay (circuit) address such as
 * `/ip4/<public-relay-ip>/tcp/4002/p2p/<relay>/p2p-circuit/p2p/<peer>` begins
 * with the relay's public IP and is kept. In a NAT-heavy network almost every
 * client is reachable only via a relay, and admitting those relay-only peers to
 * the routing table makes PUT/GET walks stall dialing peers they can't reach
 * directly. Composing the private-address filter with a circuit filter leaves
 * only reachable infrastructure (public bootstraps / genuinely public peers) as
 * DHT routing + record-storage targets, so lookups and registration stay fast.
 *
 * A peer left with zero addresses is skipped by kad-dht's onPeerConnect, i.e.
 * it is not admitted to the routing table (but remains reachable via the
 * addresses in its own published records — routing-table membership is not
 * required for that).
 */
export const filterToDirectPublicAddressesMapper = (peer: PeerInfo): PeerInfo => {
    const publicOnly = removePrivateAddressesMapper(peer);
    return {
        ...publicOnly,
        multiaddrs: publicOnly.multiaddrs.filter((ma: Multiaddr) =>
            !ma.getComponents().some((c: Component) => c.code === P2P_CIRCUIT_CODE)),
    };
};
