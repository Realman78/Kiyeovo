import { log } from '../../shared/logger.js';
import type { ConnectionGater } from '../types.js';
import { ChatDatabase } from '../db/database.js';
import type { PeerId } from '@libp2p/interface';

export function createConnectionGater(database: ChatDatabase): Partial<ConnectionGater> {
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
