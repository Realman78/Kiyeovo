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

    // // Per-connection diagnostics: shows whether a peer's connection is relayed
    // // (/p2p-circuit, "limited") or a direct upgrade — i.e. whether DCUtR hole-
    // // punching is succeeding. A relayed OPEN followed by a direct OPEN (+ relayed
    // // CLOSE) for the same peer = DCUtR worked; staying relayed = stuck on the relay.
    // const describeConnection = (conn: any): string => {
    //   const peer = conn?.remotePeer?.toString?.().slice(-8) ?? '?';
    //   const addr = conn?.remoteAddr?.toString?.() ?? 'unknown';
    //   const limited = conn?.limits != null;
    //   const relayed = limited || addr.includes('/p2p-circuit');
    //   return `peer=${peer} id=${conn?.id ?? '?'} type=${relayed ? 'relayed' : 'direct'} limited=${String(limited)} addr=${addr}`;
    // };
    // const connectionOpenHandler = (evt: any) => {
    //   log(`[CONN][OPEN] ${describeConnection(evt.detail)}`);
    // };
    // const connectionCloseHandler = (evt: any) => {
    //   log(`[CONN][CLOSE] ${describeConnection(evt.detail)}`);
    // };

    node.addEventListener('peer:connect', connectHandler);
    node.addEventListener('peer:disconnect', disconnectHandler);
    // DEBUG
    // node.addEventListener('connection:open', connectionOpenHandler);
    // node.addEventListener('connection:close', connectionCloseHandler);

    return () => {
      node.removeEventListener('peer:connect', connectHandler);
      node.removeEventListener('peer:disconnect', disconnectHandler);
      // DEBUG
      // node.removeEventListener('connection:open', connectionOpenHandler);
      // node.removeEventListener('connection:close', connectionCloseHandler);
    };
  }
}
