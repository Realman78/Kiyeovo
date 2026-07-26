import { log } from '../../shared/logger.js';
import type { ConnectionGater, NetworkMode } from '../types.js';
import { ChatDatabase } from '../db/database.js';
import { isAddressAllowedForMode } from '../utils/mode-address-policy.js';
import type { PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';

export function createConnectionGater(
  database: ChatDatabase,
  selfPeerId: PeerId,
  networkMode: NetworkMode,
): Partial<ConnectionGater> {
    const selfPeerIdStr = selfPeerId.toString();

    return {
      // Block outbound dials to blocked peers
      denyDialPeer: (peerId: PeerId) => {
        const peerIdStr = peerId.toString();
        const isBlocked = database.isBlocked(peerIdStr);

        if (isBlocked) {
          log(`[ConnectionGater] Blocked outbound dial to ${peerIdStr.slice(0, 8)}...`);
        }

        return isBlocked;
      },

      // Block outbound dials that resolve back to ourselves. kad-dht walks can hand
      // our own node back as a "closest peer" (peer id embedded in the /p2p/ suffix
      // of a bare multiaddr, so libp2p's peer-id-level self-check never fires). Over
      // Tor each such dial builds a full circuit + Noise handshake before the
      // upgrader discovers the remote is us and throws "Can not dial self" — burning
      // ~3s of the query's dial budget. denyDialMultiaddr runs before the transport
      // dial, so short-circuiting here prevents the wasted circuit entirely.
      denyDialMultiaddr: (multiaddr: Multiaddr) => {
        if (multiaddr.getPeerId() === selfPeerIdStr) {
          log(`[ConnectionGater] Blocked outbound dial to self (${selfPeerIdStr.slice(0, 8)}...)`);
          return true;
        }

        // Anonymous mode: never dial anything but an onion address. filterMultiaddrForPeer
        // below keeps clearnet out of the address book, which covers the two known
        // injectors (username-record merge, identify). This is the backstop for an
        // address that reaches the dialer by some other route: libp2p would otherwise
        // hand a /ip4 or /dns address to the plain TCP transport and connect directly,
        // outside Tor, disclosing the real IP.
        if (!isAddressAllowedForMode(multiaddr, networkMode)) {
          log(`[ConnectionGater] Blocked non-onion dial in anonymous mode (${multiaddr.toString()})`);
          return true;
        }

        return false;
      },
  
      // Block inbound connections from blocked/unknown peers (after handshake)
      denyInboundEncryptedConnection: (peerId: PeerId) => {
        const peerIdStr = peerId.toString();

        // Block if peer is explicitly blocked
        if (database.isBlocked(peerIdStr)) {
          log(`[ConnectionGater] Blocked inbound connection from ${peerIdStr.slice(0, 8)}... (blocked peer)`);
          return true;
        }

        // Block unknown peers if contact mode is 'block'
        if (database.getSetting('contact_mode') === 'block') {
          const chat = database.getChatByPeerId(peerIdStr);
          if (chat === null) {
            log(`[ConnectionGater] Rejected unknown peer ${peerIdStr.slice(0, 8)}... (block mode)`);
            return true;
          }
        }

        return false;
      },

      // Decide which addresses may be STORED for a peer. libp2p wires this as the
      // peer store's addressFilter, so it is the single choke point every peer-supplied
      // address passes through — the `multiaddrs` field of a signed username DHT record
      // and the self-declared listenAddrs in an identify message both land here. In
      // anonymous mode a clearnet address that gets stored will later be dialed directly
      // (plain TCP is registered ahead of TorTransport and claims every TCP-family
      // address), so the address must be rejected before it is ever written.
      //
      // NOTE: inverted polarity. Unlike every denyX above, this returns TRUE to ALLOW.
      filterMultiaddrForPeer: (peerId: PeerId, multiaddr: Multiaddr) => {
        if (isAddressAllowedForMode(multiaddr, networkMode)) {
          return true;
        }

        log(
          `[ConnectionGater] Rejected non-onion address for ${peerId.toString().slice(0, 8)}... ` +
          `in anonymous mode (${multiaddr.toString()})`,
        );
        return false;
      },

      // Block outbound connections to blocked peers (after socket creation but before handshake)
      denyOutboundConnection: (peerId: PeerId) => {
        const peerIdStr = peerId.toString();
        const isBlocked = database.isBlocked(peerIdStr);
        
        if (isBlocked) {
          log(`[ConnectionGater] Blocked outbound connection to ${peerIdStr.slice(0, 8)}...`);
        }
        
        return isBlocked;
      }
    };
  }
