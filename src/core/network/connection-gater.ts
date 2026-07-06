import { log } from '../../shared/logger.js';
import type { ConnectionGater } from '../types.js';
import { ChatDatabase } from '../db/database.js';
import type { PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';

export function createConnectionGater(database: ChatDatabase, selfPeerId: PeerId): Partial<ConnectionGater> {
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
