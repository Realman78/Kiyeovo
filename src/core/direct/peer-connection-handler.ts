/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from '../../shared/logger.js';
import type { ChatNode } from '../types.js';
import type { SessionManager } from './session-manager.js';

export interface PeerConnectionHandlerOptions {
  onPeerConnect?: (peerId: string) => void;
  onPeerDisconnect?: (peerId: string) => void;
}

export class PeerConnectionHandler {
  static setupPeerEvents(
    node: ChatNode,
    sessionManager: SessionManager,
    options: PeerConnectionHandlerOptions = {},
  ): () => void {
    const connectHandler = (evt: any) => {
      const peerId = evt.detail.toString();
      log(`Connected to peer: ${peerId}`);
      options.onPeerConnect?.(peerId);
    };

    const disconnectHandler = (evt: any) => {
      const peerId = evt.detail.toString();
      log(`Disconnected from peer: ${peerId}`);
      sessionManager.clearSession(peerId);
      options.onPeerDisconnect?.(peerId);
    };

    node.addEventListener('peer:connect', connectHandler);
    node.addEventListener('peer:disconnect', disconnectHandler);

    return () => {
      node.removeEventListener('peer:connect', connectHandler);
      node.removeEventListener('peer:disconnect', disconnectHandler);
    };
  }
}
