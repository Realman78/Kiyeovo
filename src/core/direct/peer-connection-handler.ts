/* eslint-disable @typescript-eslint/no-explicit-any */
import { log } from '../../shared/logger.js';
import type { ChatNode } from '../types.js';
import type { SessionManager } from './session-manager.js';

export class PeerConnectionHandler {
  static setupPeerEvents(node: ChatNode, sessionManager: SessionManager): () => void {
    const connectHandler = (evt: any) => {
      const peer = evt.detail;
      log(`Connected to peer: ${peer.toString()}`);
    };

    const disconnectHandler = (evt: any) => {
      const peerId = evt.detail.toString();
      log(`Disconnected from peer: ${peerId}`);
      sessionManager.clearSession(peerId);
    };

    node.addEventListener('peer:connect', connectHandler);
    node.addEventListener('peer:disconnect', disconnectHandler);

    return () => {
      node.removeEventListener('peer:connect', connectHandler);
      node.removeEventListener('peer:disconnect', disconnectHandler);
    };
  }
}
