import { log } from '../../shared/logger.js';
import { MAX_KEY_EXCHANGE_AGE, MINUTE } from '../constants.js';
import type { ConversationSession, PendingKeyExchange } from '../types.js';

export class SessionManager {
  private conversationSessions: Map<string, ConversationSession> = new Map();
  private pendingKeyExchanges: Map<string, PendingKeyExchange> = new Map();
  private sessionPins: Map<string, number> = new Map();
  private readonly SESSION_TIMEOUT = 5 * MINUTE;

  getSession(peerId: string): ConversationSession | null {
    return this.conversationSessions.get(peerId) ?? null;
  }

  getSessionsLength(): number {
    return this.conversationSessions.size;
  }

  storeSession(peerId: string, session: ConversationSession): void {
    this.conversationSessions.set(peerId, session);
  }

  storePendingKeyExchange(peerId: string, exchange: PendingKeyExchange): void {
    this.pendingKeyExchanges.set(peerId, exchange);
  }

  getPendingKeyExchange(peerId: string): PendingKeyExchange | undefined {
    return this.pendingKeyExchanges.get(peerId);
  }

  getPendingKeyExchangesLength(): number {
    return this.pendingKeyExchanges.size;
  }

  removePendingKeyExchange(peerId: string): void {
    const pending = this.pendingKeyExchanges.get(peerId);
    if (pending) {
      pending.ephemeralPrivateKey.fill(0);
      pending.ephemeralPublicKey.fill(0);
      this.pendingKeyExchanges.delete(peerId);
    }
  }

  clearSession(peerId: string): void {
    const session = this.conversationSessions.get(peerId);
    if (session) {
      session.ephemeralPrivateKey.fill(0);
      session.sendingKey.fill(0);
      session.receivingKey.fill(0);
      this.conversationSessions.delete(peerId);
    }
    this.sessionPins.delete(peerId);
  }

  /**
   * Update session usage timestamp
   */
  updateSessionUsage(peerId: string): void {
    const session = this.conversationSessions.get(peerId);
    if (session) {
      session.lastUsed = Date.now();
    }
  }

  /**
   * Increment message count for a session
   */
  incrementMessageCount(peerId: string): void {
    const session = this.conversationSessions.get(peerId);
    if (session) {
      session.messageCount++;
    }
  }

  /**
   * Reset message count for a session (used after key rotation)
   */
  resetMessageCount(peerId: string): void {
    const session = this.conversationSessions.get(peerId);
    if (session) {
      session.messageCount = 0;
    }
  }

  pinSession(peerId: string): boolean {
    if (!this.conversationSessions.has(peerId)) {
      return false;
    }
    this.sessionPins.set(peerId, (this.sessionPins.get(peerId) ?? 0) + 1);
    return true;
  }

  unpinSession(peerId: string): void {
    const current = this.sessionPins.get(peerId) ?? 0;
    if (current <= 1) {
      this.sessionPins.delete(peerId);
      return;
    }
    this.sessionPins.set(peerId, current - 1);
  }

  isSessionPinned(peerId: string): boolean {
    return (this.sessionPins.get(peerId) ?? 0) > 0;
  }

  cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [peerId, session] of this.conversationSessions.entries()) {
      if (this.isSessionPinned(peerId)) {
        continue;
      }
      if (now - session.lastUsed > this.SESSION_TIMEOUT) {
        log(`Cleaning up expired session for ${peerId.slice(0, 8)}...`);
        this.clearSession(peerId);
      }
    }
  }
  cleanupExpiredPendingKX(): void {
    const now = Date.now();
    for (const [peerId, pendingKx] of this.pendingKeyExchanges.entries()) {
      if (now - pendingKx.timestamp > MAX_KEY_EXCHANGE_AGE) {
        log(`Cleaning up expired pending key exchange for ${peerId.slice(0, 8)}...`);
        this.removePendingKeyExchange(peerId);
      }
    }
  }

  /**
   * Get all active session peer IDs
   */
  getActiveSessionPeerIds(): string[] {
    return Array.from(this.conversationSessions.keys());
  }

  /**
   * Check if a session exists for a peer
   */
  hasSession(peerId: string): boolean {
    return this.conversationSessions.has(peerId);
  }

  /**
   * Get session timeout value
   */
  getSessionTimeout(): number {
    return this.SESSION_TIMEOUT;
  }

  /**
   * Clear all sessions and pending exchanges
   */
  clearAll(): void {
    for (const peerId of this.conversationSessions.keys()) {
      this.clearSession(peerId);
    }
    for (const peerId of this.pendingKeyExchanges.keys()) {
      this.removePendingKeyExchange(peerId);
    }
    this.sessionPins.clear();
  }

  /**
   * Secure shutdown - clear all sensitive data
   */
  secureShutdown(): void {
    log('Securely clearing all sensitive data...');
    this.clearAll();
  }
} 
