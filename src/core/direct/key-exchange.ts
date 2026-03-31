import { peerIdFromString } from '@libp2p/peer-id';
import type { PeerId } from '@libp2p/interface';
import type { Stream } from '@libp2p/interface';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import type { ChatNode, ConversationSession, AuthenticatedEncryptedMessage, MessageToVerify, PendingAcceptance, UserRegistration, KeyExchangeEvent, ContactRequestEvent, ContactRequestCancelledEvent, ChatCreatedEvent, KeyExchangeFailedEvent } from '../types.js';
import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import { SessionManager } from './session-manager.js';
import {
  KEY_EXCHANGE_MAX_FUTURE_SKEW_MS,
  KEY_EXCHANGE_RATE_LIMIT_DEFAULT,
  KEY_ROTATION_TIMEOUT,
  MAX_KEY_EXCHANGE_AGE,
  NETWORK_MODES,
  PENDING_KEY_EXCHANGE_EXPIRATION,
  RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW,
  ROTATION_COOLDOWN,
  getNetworkModeRuntime,
} from '../constants.js';
import { Chat, ChatDatabase, User } from '../db/database.js';
import { toBase64Url } from '../utils/miscellaneous.js';
import { UsernameRegistry } from '../username/username-registry.js';
import { StreamHandler } from '../transport/stream-handler.js';
import { MessageEncryption } from './message-encryption.js';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import { dialProtocolWithRelayFallback } from '../transport/protocol-dialer.js';
import { log } from '../../shared/logger.js';

/**
 * Handles authenticated key exchange protocol
 */
export class KeyExchange {
  private node: ChatNode;
  private usernameRegistry: UsernameRegistry;
  private sessionManager: SessionManager;
  private readonly KEY_ROTATION_THRESHOLD = 15; // Rotate keys every 15 messages
  private rotationPromises = new Map<string, { resolve: (value: boolean) => void; reject: (error: Error) => void }>();
  private rotationTimeouts = new Map<string, NodeJS.Timeout>();
  private keyExchangeAbortControllers = new Map<string, () => void>();
  private keyExchangeStreams = new Map<string, Stream>();
  private keyExchangeStartedAt = new Map<string, number>();
  private pendingKeyExchangeResults = new Map<string, {
    resolve: (user: User | null) => void;
    reject: (error: Error) => void;
  }>();
  private database: ChatDatabase;
  private pendingAcceptances = new Map<string, PendingAcceptance>();
  private onKeyExchangeSent: (data: KeyExchangeEvent) => void;
  private onContactRequestReceived: (data: ContactRequestEvent) => void;
  private onContactRequestCancelled: (data: ContactRequestCancelledEvent) => void;
  private onChatCreated: (data: ChatCreatedEvent) => void;
  private onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void;
  private onDirectLinkReset: (peerId: string) => void;
  private readonly offlineBucketPrefix: string;
  private readonly chatProtocol: string;

  private resolveLinkIntent(remoteId: string): 'initial' | 'resume' {
    return this.database.getChatByPeerId(remoteId) ? 'resume' : 'initial';
  }

  private getKeyExchangeResponseGraceMs(): number {
    return this.database.getSessionNetworkMode() === NETWORK_MODES.ANONYMOUS ? 60_000 : 15_000;
  }

  private getKeyExchangeDecisionExpiresAt(timestamp: number): number {
    return timestamp + PENDING_KEY_EXCHANGE_EXPIRATION;
  }

  private getKeyExchangeWaitExpiresAt(timestamp: number): number {
    return this.getKeyExchangeDecisionExpiresAt(timestamp) + this.getKeyExchangeResponseGraceMs();
  }

  private getKeyExchangeFollowupTimeoutMs(): number {
    return this.database.getSessionNetworkMode() === NETWORK_MODES.ANONYMOUS ? 10_000 : 5_000;
  }

  private buildKeyExchangeMessageToVerify(
    message: Pick<AuthenticatedEncryptedMessage,
      'content' |
      'ephemeralPublicKey' |
      'senderUsername' |
      'timestamp' |
      'encryptedMessageBody' |
      'encryptedMessageBodyType' |
      'encryptedMessageBodyKey' |
      'encryptedMessageBodyIv' |
      'linkIntent' |
      'linkDecision'>
  ): MessageToVerify {
    const payload: MessageToVerify = {
      type: 'key_exchange',
      content: message.content as MessageToVerify['content'],
      // Field is required by MessageToVerify and guaranteed by callers.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ephemeralPublicKey: message.ephemeralPublicKey!,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    };
    if (message.encryptedMessageBody !== undefined) payload.encryptedMessageBody = message.encryptedMessageBody;
    if (message.encryptedMessageBodyType !== undefined) payload.encryptedMessageBodyType = message.encryptedMessageBodyType;
    if (message.encryptedMessageBodyKey !== undefined) payload.encryptedMessageBodyKey = message.encryptedMessageBodyKey;
    if (message.encryptedMessageBodyIv !== undefined) payload.encryptedMessageBodyIv = message.encryptedMessageBodyIv;
    if (message.linkIntent !== undefined) payload.linkIntent = message.linkIntent;
    if (message.linkDecision !== undefined) payload.linkDecision = message.linkDecision;
    return payload;
  }

  constructor(
    node: ChatNode,
    usernameRegistry: UsernameRegistry,
    sessionManager: SessionManager,
    database: ChatDatabase,
    onKeyExchangeSent: (data: KeyExchangeEvent) => void,
    onContactRequestReceived: (data: ContactRequestEvent) => void,
    onContactRequestCancelled: (data: ContactRequestCancelledEvent) => void,
    onChatCreated: (data: ChatCreatedEvent) => void,
    onKeyExchangeFailed: (data: KeyExchangeFailedEvent) => void,
    onDirectLinkReset?: (peerId: string) => void
  ) {
    this.node = node;
    this.usernameRegistry = usernameRegistry;
    this.sessionManager = sessionManager;
    this.database = database;
    this.onKeyExchangeSent = onKeyExchangeSent;
    this.onContactRequestReceived = onContactRequestReceived;
    this.onContactRequestCancelled = onContactRequestCancelled;
    this.onChatCreated = onChatCreated;
    this.onKeyExchangeFailed = onKeyExchangeFailed;
    this.onDirectLinkReset = onDirectLinkReset ?? (() => undefined);
    const modeConfig = getNetworkModeRuntime(database.getSessionNetworkMode()).config;
    this.offlineBucketPrefix = modeConfig.dhtNamespaces.offline;
    this.chatProtocol = modeConfig.chatProtocol;
  }

  private async logPeerDialDiagnostics(targetPeerId: PeerId, context: string): Promise<void> {
    const targetPeerIdStr = targetPeerId.toString();
    const activeConnections = this.node
      .getConnections()
      .filter((conn) => conn.remotePeer.toString() === targetPeerIdStr)
      .map((conn) => conn.remoteAddr.toString());

    let knownAddrs: string[] = [];
    try {
      const peerData = await this.node.peerStore.get(targetPeerId);
      knownAddrs = (peerData.addresses ?? []).map((entry) => entry.multiaddr.toString());
    } catch {
      // Peer may not exist in peer store yet.
    }

    log(
      `[DIAL][${context}] target=${targetPeerIdStr} ` +
      `knownAddrs=${knownAddrs.length > 0 ? knownAddrs.join(',') : 'none'} ` +
      `activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'}`
    );
  }

  acceptPendingContact(senderPeerId: string): void {
    const promise = this.pendingAcceptances.get(senderPeerId);
    if (promise) {
      promise.resolve(true);
      this.pendingAcceptances.delete(senderPeerId);
    } else {
      this.onKeyExchangeFailed({
        username: "UNKNOWN",
        peerId: senderPeerId,
        error: 'No pending acceptance found. Something went wrong.',
      });
    }
  }

  rejectPendingContact(senderPeerId: string): void {
    const promise = this.pendingAcceptances.get(senderPeerId);
    if (promise) {
      promise.resolve(false);
      this.pendingAcceptances.delete(senderPeerId);
    } else {
      this.onKeyExchangeFailed({
        username: "UNKNOWN",
        peerId: senderPeerId,
        error: 'No pending acceptance found. Something went wrong.',
      });
    }
  }

  cancelPendingContact(senderPeerId: string): void {
    const promise = this.pendingAcceptances.get(senderPeerId);
    if (promise) {
      promise.reject(new Error('KEY_EXCHANGE_CANCELLED_BY_INITIATOR'));
      this.pendingAcceptances.delete(senderPeerId);
    }
    this.database.deleteContactAttemptsByPeerId(senderPeerId);
  }

  private rejectRotationPromise(remoteId: string, error: Error): void {
    const promise = this.rotationPromises.get(remoteId);
    if (promise) {
      promise.reject(error);
      this.rotationPromises.delete(remoteId);
    }

    // Clear associated timeout to prevent session clearing after successful rotation
    const timeoutId = this.rotationTimeouts.get(remoteId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.rotationTimeouts.delete(remoteId);
    }
  }

  private resolveRotationPromise(remoteId: string, success: boolean): void {
    const promise = this.rotationPromises.get(remoteId);
    if (promise) {
      promise.resolve(success);
      this.rotationPromises.delete(remoteId);
    }

    const timeoutId = this.rotationTimeouts.get(remoteId);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.rotationTimeouts.delete(remoteId);
    }
  }

  /**
   * Verify signature with DB data first, DHT fallback on failure.
   */
  private async verifySignatureWithFallback(
    signature: string,
    message: MessageToVerify,
    username: string,
    peerId: string
  ): Promise<{ valid: boolean; signingPublicKey: string | null }> {
    const dbUser = this.database.getUserByPeerId(peerId);
    if (dbUser?.signing_public_key) {
      const valid = EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature, message, dbUser.signing_public_key
      );

      if (valid) {
        return { valid: true, signingPublicKey: dbUser.signing_public_key };
      }
    }

    // DB verification failed or no DB key -> DHT fallback
    try {
      const userRegistration = await this.usernameRegistry.lookup(username);
      if (userRegistration.peerID !== peerId) {
        return { valid: false, signingPublicKey: null };
      }

      const valid = EncryptedUserIdentity.verifyKeyExchangeSignature(
        signature, message, userRegistration.signingPublicKey
      );

      if (dbUser) {
        this.database.updateUserKeys({
          peer_id: peerId,
          signing_public_key: userRegistration.signingPublicKey,
          offline_public_key: userRegistration.offlinePublicKey,
          signature: userRegistration.signature
        });
      } else {
        await this.database.createUser({
          peer_id: peerId,
          username: username,
          signing_public_key: userRegistration.signingPublicKey,
          offline_public_key: userRegistration.offlinePublicKey,
          signature: userRegistration.signature
        });
      }

      return { valid, signingPublicKey: userRegistration.signingPublicKey };
    } catch (error: unknown) {
      generalErrorHandler(error);
      return { valid: false, signingPublicKey: null };
    }
  }

  // Derive directional send/receive keys from ECDH shared secret using HKDF-SHA256
  private deriveDirectionalKeys(
    localEphemeralPublicKey: Uint8Array,
    localEphemeralPrivateKey: Uint8Array,
    remoteEphemeralPublicKey: string,
    role: 'initiator' | 'responder'
  ): { sendingKey: Uint8Array; receivingKey: Uint8Array; sharedSecret: Uint8Array } {

    const remoteEphemeralKey = Buffer.from(remoteEphemeralPublicKey, 'base64');
    const sharedSecret = x25519.getSharedSecret(localEphemeralPrivateKey, remoteEphemeralKey);
    // Stable salt based on both public keys (sorted lexicographically)
    const a = Buffer.from(localEphemeralPublicKey);
    const b = remoteEphemeralKey;
    const [first, second] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
    const salt = sha256(new Uint8Array(Buffer.concat([first, second])));

    // Use constant info so both peers derive identical OKM; use role only for mapping
    const infoStr = 'kiyeovo-hkdf-v1';
    const info = new TextEncoder().encode(infoStr);

    const okm = hkdf(sha256, sharedSecret, salt, info, 64);
    const k1 = okm.slice(0, 32);
    const k2 = okm.slice(32, 64);
    if (role === 'initiator') {
      return { sendingKey: k1, receivingKey: k2, sharedSecret };
    } else {
      return { sendingKey: k2, receivingKey: k1, sharedSecret };
    }
  }

  private deriveOfflineBucketSecret(
    sharedSecret: Uint8Array,
    myPeerId: string,
    remotePeerId: string,
  ): string {
    const [first, second] = Buffer.compare(
      Buffer.from(myPeerId),
      Buffer.from(remotePeerId)) <= 0 ?
      [Buffer.from(myPeerId), Buffer.from(remotePeerId)] :
      [Buffer.from(remotePeerId), Buffer.from(myPeerId)];
    const salt = sha256(new Uint8Array(Buffer.concat([first, second])));

    // Use constant info so both peers derive identical OKM
    const infoStr = 'kiyeovo-hkdf-offline';
    const info = new TextEncoder().encode(infoStr);

    const secretBytes = hkdf(sha256, sharedSecret, salt, info, 32);
    return toBase64Url(secretBytes);
  }

  public constructWriteBucketKey(offlineBucketSecret: string): string {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }
    const ourPubKeyBase64url = toBase64Url(userIdentity.signingPublicKey);
    return `${this.offlineBucketPrefix}/${offlineBucketSecret}/${ourPubKeyBase64url}`;
  }

  public constructReadBucketKey(offlineBucketSecret: string, peerSigningPubKeyBase64: string): string {
    const peerPubKeyBytes = Buffer.from(peerSigningPubKeyBase64, 'base64');
    const peerPubKeyBase64url = toBase64Url(peerPubKeyBytes);
    return `${this.offlineBucketPrefix}/${offlineBucketSecret}/${peerPubKeyBase64url}`;
  }

  private deriveNotificationsBucketKey(
    sharedSecret: Uint8Array,
    myPeerId: string,
    remotePeerId: string,
  ): Uint8Array {
    const [first, second] = Buffer.compare(
      Buffer.from(myPeerId),
      Buffer.from(remotePeerId)) <= 0 ? [Buffer.from(myPeerId), Buffer.from(remotePeerId)] :
      [Buffer.from(remotePeerId), Buffer.from(myPeerId)];
    const salt = sha256(new Uint8Array(Buffer.concat([second, first])));

    // Use constant info so both peers derive identical OKM; use role only for mapping
    const infoStr = 'kiyeovo-hkdf-notifications';
    const info = new TextEncoder().encode(infoStr);

    const bucketKey = hkdf(sha256, sharedSecret, salt, info, 32);
    return bucketKey;
  }

  //Initiate a key exchange with a target peer
  async initiateKeyExchange(
    targetPeerId: PeerId,
    targetUsername: string,
    message: string,
    options?: { linkIntent?: 'initial' | 'resume'; recipientOfflinePublicKey?: string }
  ): Promise<User | null> {
    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('No user identity available');
    }

    const peerIdStr = targetPeerId.toString();
    const myUsername = this.getInitiatorUsername();
    const linkIntent = options?.linkIntent ?? this.resolveLinkIntent(peerIdStr);
    this.assertCanInitiateKeyExchange(peerIdStr, targetUsername);
    const startedAt = Date.now();

    const recipientOfflinePublicKeyBase64 = await this.resolveRecipientOfflinePublicKeyBase64(
      targetPeerId,
      targetUsername,
      options?.recipientOfflinePublicKey,
    );
    const {
      timestamp,
      keyExchangeMessage,
      pendingKeyExchange,
    } = this.createInitiatorKeyExchangeRequest(
      userIdentity,
      myUsername,
      message,
      recipientOfflinePublicKeyBase64,
      linkIntent,
    );

    const stream = await this.openKeyExchangeInitStream(targetPeerId);
    await this.sendInitiatorKeyExchangeRequest(stream, keyExchangeMessage);
    const cancelPromise = this.createKeyExchangeCancelPromise(peerIdStr);
    this.storeOutgoingKeyExchangeState(peerIdStr, stream, pendingKeyExchange, startedAt);
    const timeoutPromise = this.createKeyExchangeTimeoutPromise(timestamp);

    // Key exchange request successfully sent - notify frontend (dialog can close now)
    this.onKeyExchangeSent({
      username: targetUsername,
      peerId: peerIdStr,
      messageContent: message,
      expiresAt: this.getKeyExchangeWaitExpiresAt(timestamp)
    });

    try {
      const user = await Promise.race([
        this.waitForKeyExchangeResponse(peerIdStr, stream),
        timeoutPromise.then(() => null),
        cancelPromise
      ]);
      if (!user) {
        throw new Error('Key exchange timed out or failed');
      }
      this.keyExchangeAbortControllers.delete(peerIdStr);
      this.keyExchangeStreams.delete(peerIdStr);
      this.keyExchangeStartedAt.delete(peerIdStr);
      this.pendingKeyExchangeResults.delete(peerIdStr);
      return user;
    } catch (error: unknown) {
      const stream = this.keyExchangeStreams.get(peerIdStr);
      if (stream) {
        try {
          stream.abort(new Error('KEY_EXCHANGE_FINISHED'));
        } catch {
          // Stream may already be closed/reset.
        }
      }
      this.keyExchangeAbortControllers.delete(peerIdStr);
      this.keyExchangeStreams.delete(peerIdStr);
      this.keyExchangeStartedAt.delete(peerIdStr);
      this.pendingKeyExchangeResults.delete(peerIdStr);

      // Re-throw cancellation errors so they can be handled upstream
      if (error instanceof Error && error.message === 'KEY_EXCHANGE_CANCELLED') {
        log(`Key exchange with ${targetUsername} was cancelled by user`);
        throw error; // Propagate to message handler
      }

      generalErrorHandler(error);
      this.sessionManager.removePendingKeyExchange(peerIdStr);

      if (error instanceof Error && !error.message.includes('Rate limit')) {
        this.database.logFailedKeyExchange(peerIdStr, targetUsername, message, error.message);
      }

      const errorMessage = errStr(error, 'Unknown error');
      this.onKeyExchangeFailed({
        username: targetUsername,
        peerId: peerIdStr,
        error: errorMessage
      });

      throw error;
    }
  }

  private getInitiatorUsername(): string {
    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    return myUser?.username || `user_${myPeerId.slice(-8)}`;
  }

  private assertCanInitiateKeyExchange(peerIdStr: string, targetUsername: string): void {
    if (this.keyExchangeAbortControllers.has(peerIdStr)) {
      throw new Error(`Already waiting for ${targetUsername} to accept your message request`);
    }

    if (this.sessionManager.getPendingKeyExchange(peerIdStr)) {
      throw new Error(`Already waiting for ${targetUsername} to accept your message request`);
    }

    const recentFailure = this.database.getRecentFailedKeyExchange(peerIdStr, 5);
    if (recentFailure) {
      throw new Error(`Rate limit: You must wait before contacting ${targetUsername} again`);
    }
  }

  private async resolveRecipientOfflinePublicKeyBase64(
    targetPeerId: PeerId,
    targetUsername: string,
    candidate?: string,
  ): Promise<string> {
    const peerIdStr = targetPeerId.toString();
    let recipientOfflinePublicKeyBase64 = candidate;
    if (!recipientOfflinePublicKeyBase64) {
      recipientOfflinePublicKeyBase64 = this.database.getUserByPeerId(peerIdStr)?.offline_public_key;
    }
    if (!recipientOfflinePublicKeyBase64) {
      const registration = await this.usernameRegistry.lookupByPeerId(peerIdStr);
      recipientOfflinePublicKeyBase64 = registration.offlinePublicKey;
    }
    if (!recipientOfflinePublicKeyBase64) {
      throw new Error(`Missing offline public key for ${targetUsername}`);
    }
    return recipientOfflinePublicKeyBase64;
  }

  private createInitiatorKeyExchangeRequest(
    userIdentity: EncryptedUserIdentity,
    myUsername: string,
    message: string,
    recipientOfflinePublicKeyBase64: string,
    linkIntent: 'initial' | 'resume',
  ): {
    timestamp: number;
    keyExchangeMessage: AuthenticatedEncryptedMessage;
    pendingKeyExchange: { timestamp: number; ephemeralPrivateKey: Uint8Array; ephemeralPublicKey: Uint8Array };
  } {
    const recipientOfflinePublicKeyPem = Buffer.from(recipientOfflinePublicKeyBase64, 'base64').toString('utf8');
    const encryptedInitialMessage = MessageEncryption.encryptForRecipientOffline(
      message,
      recipientOfflinePublicKeyPem
    );

    const ephemeralPrivateKey = x25519.utils.randomSecretKey();
    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);
    const timestamp = Date.now();
    const signFields = {
      type: 'key_exchange' as const,
      content: 'key_exchange_init' as const,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
      senderUsername: myUsername,
      timestamp,
      encryptedMessageBody: encryptedInitialMessage.content,
      encryptedMessageBodyType: encryptedInitialMessage.messageType,
      ...(encryptedInitialMessage.encryptedAesKey !== undefined && { encryptedMessageBodyKey: encryptedInitialMessage.encryptedAesKey }),
      ...(encryptedInitialMessage.aesIv !== undefined && { encryptedMessageBodyIv: encryptedInitialMessage.aesIv }),
      linkIntent,
    };
    const signature = userIdentity.sign(JSON.stringify(signFields));

    return {
      timestamp,
      keyExchangeMessage: {
        signature: Buffer.from(signature).toString('base64'),
        ...signFields
      },
      pendingKeyExchange: {
        timestamp,
        ephemeralPrivateKey,
        ephemeralPublicKey
      }
    };
  }

  private async openKeyExchangeInitStream(targetPeerId: PeerId): Promise<Stream> {
    await this.logPeerDialDiagnostics(targetPeerId, 'key_exchange_init');
    return dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId,
      protocol: this.chatProtocol,
      context: 'key_exchange_init',
    });
  }

  private async sendInitiatorKeyExchangeRequest(
    stream: Stream,
    keyExchangeMessage: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(JSON.stringify(keyExchangeMessage))]);
  }

  private storeOutgoingKeyExchangeState(
    peerIdStr: string,
    stream: Stream,
    pendingKeyExchange: { timestamp: number; ephemeralPrivateKey: Uint8Array; ephemeralPublicKey: Uint8Array },
    startedAt: number,
  ): void {
    this.keyExchangeStreams.set(peerIdStr, stream);
    this.keyExchangeStartedAt.set(peerIdStr, startedAt);
    this.sessionManager.storePendingKeyExchange(peerIdStr, pendingKeyExchange);
  }

  private createPendingKeyExchangeResultPromise(peerIdStr: string): Promise<User | null> {
    return new Promise<User | null>((resolve, reject) => {
      this.pendingKeyExchangeResults.set(peerIdStr, { resolve, reject });
    });
  }

  private resolvePendingKeyExchangeResult(peerIdStr: string, user: User | null): void {
    const pendingResult = this.pendingKeyExchangeResults.get(peerIdStr);
    if (!pendingResult) {
      return;
    }

    pendingResult.resolve(user);
    this.pendingKeyExchangeResults.delete(peerIdStr);
  }

  private rejectPendingKeyExchangeResult(peerIdStr: string, error: Error): void {
    const pendingResult = this.pendingKeyExchangeResults.get(peerIdStr);
    if (!pendingResult) {
      return;
    }

    pendingResult.reject(error);
    this.pendingKeyExchangeResults.delete(peerIdStr);
  }

  private createKeyExchangeTimeoutPromise(timestamp: number): Promise<never> {
    const waitMs = Math.max(0, this.getKeyExchangeWaitExpiresAt(timestamp) - Date.now());
    return new Promise<never>((_, reject) =>
      setTimeout(() => { reject(new Error('Key exchange timeout')); }, waitMs)
    );
  }

  private createKeyExchangeCancelPromise(peerIdStr: string): Promise<never> {
    return new Promise<never>((_, reject) => {
      this.keyExchangeAbortControllers.set(peerIdStr, () => {
        reject(new Error('KEY_EXCHANGE_CANCELLED'));
      });
    });
  }

  private async writeSingleMessageToStream(stream: Stream, message: AuthenticatedEncryptedMessage): Promise<void> {
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(JSON.stringify(message))]);
    if (stream.closeWrite != null) {
      try {
        await stream.closeWrite();
      } catch {
        // Some stream implementations may already consider the write side closed.
      }
    }
  }

  private async closeStreamQuietly(stream: Stream): Promise<void> {
    try {
      await stream.close();
    } catch {
      // Stream may already be reset/closed remotely.
    }
  }

  /**
   * Handle incoming key exchange messages
   */
  async handleKeyExchange(remoteId: string, message: AuthenticatedEncryptedMessage, stream: Stream): Promise<void> {
    if (!message.ephemeralPublicKey) {
      console.error('Key exchange message missing ephemeral public key');
      return;
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      console.error('No user identity available for key exchange');
      return;
    }

    // Get my own username for responses
    const myPeerId = this.node.peerId.toString();
    const myUser = this.database.getUserByPeerId(myPeerId);
    const myUsername = this.usernameRegistry.getCurrentUsername() || myUser?.username || `user_${myPeerId.slice(-8)}`;

    try {
      if (message.content === 'key_exchange_init') {
        await this.handleKeyExchangeInit(remoteId, message, stream, userIdentity, myUsername);
      } else if (message.content === 'key_exchange_response') {
        await this.handleInboundAcceptedKeyExchangeResponse(remoteId, message, {
          stream,
          userIdentity,
          myUsername,
        });
      } else if (message.content === 'key_exchange_cancelled') {
        await this.handleInboundCancelledKeyExchange(remoteId, message);
      } else if (message.content === 'key_exchange_rejected') {
        await this.handleInboundRejectedKeyExchangeResponse(remoteId, message);
      } else if (message.content === 'key_rotation') {
        await this.handleKeyRotation(remoteId, message, userIdentity, myUsername);
      } else if (message.content === 'key_rotation_response') {
        await this.handleKeyRotationResponse(remoteId, message);
      }
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to handle key exchange message');
    }
  }

  //Validate key exchange init message fields and freshness
  private validateKeyExchangeInit(message: AuthenticatedEncryptedMessage): void {
    if (!message.signature || !message.senderUsername) {
      throw new Error('Key exchange init missing signature or sender username');
    }

    if (!message.ephemeralPublicKey) {
      throw new Error('Key exchange init missing ephemeral public key');
    }

    if (message.type !== 'key_exchange') {
      throw new Error('Key exchange init message has invalid type');
    }

    if (!message.encryptedMessageBody || !message.encryptedMessageBodyType) {
      throw new Error('Key exchange init missing encrypted initial message');
    }

    if (message.encryptedMessageBodyType !== 'encrypted' && message.encryptedMessageBodyType !== 'hybrid') {
      throw new Error('Key exchange init has invalid encrypted message type');
    }

    if (
      message.encryptedMessageBodyType === 'hybrid'
      && (!message.encryptedMessageBodyKey || !message.encryptedMessageBodyIv)
    ) {
      throw new Error('Key exchange init hybrid payload missing key or IV');
    }

    // Replay attack prevention
    const messageAge = Date.now() - message.timestamp;
    if (messageAge > MAX_KEY_EXCHANGE_AGE || messageAge < -KEY_EXCHANGE_MAX_FUTURE_SKEW_MS) {
      throw new Error('Key exchange message too old or future-dated');
    }
  }

  private decryptInitialMessageBody(
    message: AuthenticatedEncryptedMessage,
    offlinePrivateKeyPem: string
  ): string {
    if (!message.encryptedMessageBody || !message.encryptedMessageBodyType) {
      throw new Error('Missing encrypted initial message');
    }

    return MessageEncryption.decryptFromRecipientOffline(
      {
        messageType: message.encryptedMessageBodyType,
        content: message.encryptedMessageBody,
        ...(message.encryptedMessageBodyKey !== undefined && { encryptedAesKey: message.encryptedMessageBodyKey }),
        ...(message.encryptedMessageBodyIv !== undefined && { aesIv: message.encryptedMessageBodyIv }),
      },
      offlinePrivateKeyPem
    );
  }

  //Authorize contact request based on contact mode and existing relationship
  private async authorizeContactRequest(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    initialMessageBody: string,
    onPendingCreated?: () => Promise<void>,
  ): Promise<UserRegistration | User | null> {
    const senderUsername = message.senderUsername;

    // Check if sender is blocked (silent rejection - no error message)
    const isBlocked = this.database.isBlocked(remoteId);
    if (isBlocked) {
      log(`Blocked key exchange from ${senderUsername}`);
      return null;
    }

    // Check if we already have a chat with this person (auto-accept existing contacts)
    const existingChat = this.database.getChatByPeerId(remoteId);
    if (existingChat) {
      log(`Existing contact ${senderUsername} - auto-accepting key exchange`);
      const sender = this.database.getUserByPeerId(remoteId);
      if (!sender) {
        throw new Error('Sender not found in database.');
      }
      return sender;
    }

    // New contact - check contact mode
    const contactMode = this.database.getContactMode();

    if (contactMode === 'block') {
      log(`Contact mode is 'block' - ignoring request from ${senderUsername}`);
      return null;
    }

    // Check for duplicate pending requests
    const pendingKeyExchange = this.getPendingAcceptanceByPeerId(remoteId);
    if (pendingKeyExchange) {
      log(`Sender already has a pending key exchange`);
      return null;
    }

    // Check if user has contacted me recently
    if (this.didUserContactMeRecently(remoteId)) {
      log(`User has contacted me recently - rejecting contact request from ${senderUsername}`);
      return null;
    }

    // Rate limiting check
    if (this.isKeyExchangeRateLimitExceeded()) {
      log(`Rate limit exceeded - rejecting contact request from ${senderUsername}`);
      return null;
    }

    // Silent mode - just log the attempt
    const contactAttemptId = this.database.logContactAttempt({
      sender_peer_id: remoteId,
      sender_username: senderUsername,
      message: message.content || 'Contact request',
      message_body: initialMessageBody,
      timestamp: Date.now()
    });

    return await this.handleActiveContactRequest(remoteId, message, contactAttemptId, initialMessageBody, onPendingCreated);
  }

  // Handle contact request in active mode (with user prompt and timeout)
  private async handleActiveContactRequest(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    contactAttemptId: number,
    initialMessageBody: string,
    onPendingCreated?: () => Promise<void>,
  ): Promise<UserRegistration | User> {
    const senderUsername = message.senderUsername;
    const receivedAt = Date.now();

    if (!message.ephemeralPublicKey || !message.signature) {
      throw new Error('Key exchange missing signature or ephemeral public key - this should never happen');
    }

    this.emitIncomingContactRequest(remoteId, message, initialMessageBody);
    if (onPendingCreated) {
      try {
        await onPendingCreated();
      } catch (error) {
        console.warn(
          `[KEY-EXCHANGE][ACK][FAIL] ts=${new Date().toISOString()} ` +
          `peer=${remoteId} username=${senderUsername} error=${errStr(error)}`,
        );
      }
    }
    let result: boolean | null;
    try {
      result = await this.waitForContactRequestDecision(
        remoteId,
        senderUsername,
        initialMessageBody,
        receivedAt,
        this.getKeyExchangeDecisionExpiresAt(message.timestamp),
      );
    } catch (error) {
      this.database.deleteContactAttempt(contactAttemptId);
      if (error instanceof Error && error.message === 'KEY_EXCHANGE_CANCELLED_BY_INITIATOR') {
        log(`Contact request from ${senderUsername} cancelled by initiator`);
      }
      throw error;
    }

    this.database.deleteContactAttempt(contactAttemptId);
    if (result === null) {
      log(`Contact request from ${senderUsername} expired`);
      throw new Error('REJECTION_TIMEOUT');
    }

    if (!result) {
      log(`Contact request from ${senderUsername} rejected`);
      // Signal that rejection response needs to be sent
      throw new Error('REJECTION_NEEDED');
    }

    return this.resolveAcceptedContactRequestSender(remoteId, senderUsername);
  }

  private emitIncomingContactRequest(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    initialMessageBody: string,
  ): void {
    const senderUsername = message.senderUsername;
    const now = Date.now();
    const expiresAt = this.getKeyExchangeDecisionExpiresAt(message.timestamp);

    this.onContactRequestReceived({
      peerId: remoteId,
      username: senderUsername,
      message: message.content || senderUsername + ' wants to contact you',
      messageBody: initialMessageBody || senderUsername + ' wants to contact you',
      receivedAt: now,
      expiresAt
    });
  }

  private async waitForContactRequestDecision(
    remoteId: string,
    senderUsername: string,
    initialMessageBody: string,
    receivedAt: number,
    expiresAt: number,
  ): Promise<boolean | null> {
    const expiresInMs = Math.max(0, expiresAt - Date.now());
    log(
      `[KEY-EXCHANGE][PENDING][CREATE] ts=${new Date(receivedAt).toISOString()} ` +
      `peer=${remoteId} username=${senderUsername} expiresInMs=${expiresInMs}`,
    );
    const acceptancePromise = new Promise<boolean>((resolve, reject) => {
      this.pendingAcceptances.set(remoteId, {
        resolve,
        reject,
        timestamp: receivedAt,
        receivedAt,
        expiresAt,
        username: senderUsername,
        messageBody: initialMessageBody
      });
    });

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        log(
          `[KEY-EXCHANGE][PENDING][EXPIRE] ts=${new Date().toISOString()} ` +
          `peer=${remoteId} username=${senderUsername} ageMs=${Date.now() - receivedAt}`,
        );
        this.pendingAcceptances.delete(remoteId);
        resolve(null);
      }, expiresInMs);
    });

    const result = await Promise.race([acceptancePromise, timeoutPromise]);
    const activeConnections = this.node
      .getConnections()
      .filter((connection) => connection.remotePeer.toString() === remoteId)
      .map((connection) => connection.remoteAddr.toString());
    log(
      `[KEY-EXCHANGE][PENDING][RESOLVE] ts=${new Date().toISOString()} ` +
      `peer=${remoteId} username=${senderUsername} result=${result === null ? 'expired' : result ? 'accepted' : 'rejected'} ` +
      `ageMs=${Date.now() - receivedAt} activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'}`,
    );
    if (result !== null && timeoutId) {
      clearTimeout(timeoutId);
    }

    this.pendingAcceptances.delete(remoteId);
    return result;
  }

  private async resolveAcceptedContactRequestSender(
    remoteId: string,
    senderUsername: string,
  ): Promise<UserRegistration | User> {
    const existingAcceptedUser = this.database.getUserByPeerId(remoteId);
    if (
      existingAcceptedUser?.signing_public_key &&
      existingAcceptedUser.offline_public_key &&
      existingAcceptedUser.signature
    ) {
      log(
        `Accepted contact request from ${senderUsername} (using cached DB keys)`
      );
      return existingAcceptedUser;
    }

    try {
      const sender = await this.usernameRegistry.lookupByPeerId(remoteId);
      if (sender.peerID !== remoteId) {
        throw new Error(`Username/peer mismatch for ${senderUsername}`);
      }
      log(`Accepted contact request from ${senderUsername} (verified via DHT)`);
      return sender;
    } catch (error: unknown) {
      throw new Error(`Sender not in DHT: ${errStr(error)}`);
    }
  }

  //Verify signature for key exchange init message with DHT refresh fallback
  private async verifyKeyExchangeInitSignature(
    message: AuthenticatedEncryptedMessage,
    sender: UserRegistration | User,
    remoteId: string
  ): Promise<{ valid: boolean; keys: { signingPublicKey: string; offlinePublicKey: string; signature: string } }> {
    const verifyPayload: Pick<AuthenticatedEncryptedMessage,
      'content' |
      'ephemeralPublicKey' |
      'senderUsername' |
      'timestamp' |
      'encryptedMessageBody' |
      'encryptedMessageBodyType' |
      'encryptedMessageBodyKey' |
      'encryptedMessageBodyIv' |
      'linkIntent' |
      'linkDecision'> = {
      content: 'key_exchange_init',
      // validated in validateKeyExchangeInit
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      ephemeralPublicKey: message.ephemeralPublicKey!,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    };
    if (message.encryptedMessageBody !== undefined) verifyPayload.encryptedMessageBody = message.encryptedMessageBody;
    if (message.encryptedMessageBodyType !== undefined) verifyPayload.encryptedMessageBodyType = message.encryptedMessageBodyType;
    if (message.encryptedMessageBodyKey !== undefined) verifyPayload.encryptedMessageBodyKey = message.encryptedMessageBodyKey;
    if (message.encryptedMessageBodyIv !== undefined) verifyPayload.encryptedMessageBodyIv = message.encryptedMessageBodyIv;
    if (message.linkIntent !== undefined) verifyPayload.linkIntent = message.linkIntent;
    const messageToVerify = this.buildKeyExchangeMessageToVerify(verifyPayload);

    let signingPublicKey = '';
    let offlinePublicKey = '';
    let signature = '';

    // Extract keys from sender object (handles both UserRegistration and User types)
    if ('signingPublicKey' in sender) {
      signingPublicKey = sender.signingPublicKey;
      offlinePublicKey = sender.offlinePublicKey;
      signature = sender.signature;
    } else {
      signingPublicKey = sender.signing_public_key;
      offlinePublicKey = sender.offline_public_key;
      signature = sender.signature;
    }

    let signatureValid = false;
    if (signingPublicKey) {
      signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        message.signature!,
        messageToVerify,
        signingPublicKey
      );
    }

    // If signature verification fails, refresh keys from DHT and retry
    if (!signatureValid) {
      try {
        const refreshed = await this.usernameRegistry.lookupByPeerId(remoteId);
        if (refreshed.peerID === remoteId) {
          signingPublicKey = refreshed.signingPublicKey;
          offlinePublicKey = refreshed.offlinePublicKey;
          signature = refreshed.signature;
          signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            message.signature!,
            messageToVerify,
            signingPublicKey
          );
        }
      } catch {
        // DHT refresh failed, signature remains invalid
      }
    }

    return {
      valid: signatureValid,
      keys: { signingPublicKey, offlinePublicKey, signature }
    };
  }

  //Ensure user exists in database with proper keys
  private async ensureUserExistsWithKeys(
    remoteId: string,
    username: string,
    signingPublicKey: string,
    offlinePublicKey: string,
    signature: string
  ): Promise<void> {
    const existingUser = this.database.getUserByPeerId(remoteId);

    if (!existingUser) {
      await this.database.createUser({
        peer_id: remoteId,
        username: username,
        signing_public_key: signingPublicKey,
        offline_public_key: offlinePublicKey,
        signature: signature
      });
    } else if (!existingUser.signing_public_key ||
      existingUser.signing_public_key !== signingPublicKey ||
      existingUser.offline_public_key !== offlinePublicKey) {
      // Update placeholder/missing keys after successful verification
      this.database.updateUserKeys({
        peer_id: remoteId,
        signing_public_key: signingPublicKey,
        offline_public_key: offlinePublicKey,
        signature: signature
      });
    }
  }

  // Create responder session with ephemeral keys and derive encryption keys
  private createResponderSession(
    remoteId: string,
    remoteEphemeralPublicKey: string
  ): {
    session: ConversationSession;
    ephemeralPublicKey: Uint8Array;
    offlineBucketSecret: string;
    notificationsBucketKey: Uint8Array;
  } {
    const ephemeralPrivateKey = x25519.utils.randomSecretKey();
    const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);

    const { sendingKey, receivingKey, sharedSecret } = this.deriveDirectionalKeys(
      ephemeralPublicKey,
      ephemeralPrivateKey,
      remoteEphemeralPublicKey,
      'responder'
    );

    const offlineBucketSecret = this.deriveOfflineBucketSecret(
      sharedSecret,
      this.node.peerId.toString(),
      remoteId
    );
    const notificationsBucketKey = this.deriveNotificationsBucketKey(
      sharedSecret,
      this.node.peerId.toString(),
      remoteId
    );

    const session: ConversationSession = {
      peerId: remoteId,
      ephemeralPrivateKey,
      ephemeralPublicKey,
      sendingKey,
      receivingKey,
      messageCount: 0,
      lastUsed: Date.now()
    };

    return { session, ephemeralPublicKey, offlineBucketSecret, notificationsBucketKey };
  }

  private discardUncommittedSession(session: ConversationSession): void {
    session.ephemeralPrivateKey.fill(0);
    session.sendingKey.fill(0);
    session.receivingKey.fill(0);
  }

  private async sendKeyExchangeAck(
    stream: Stream,
    remoteId: string,
    myUsername: string,
    initiatorEphemeralPublicKey: string,
  ): Promise<void> {
    const ackMessage: AuthenticatedEncryptedMessage = {
      type: 'key_exchange',
      content: 'key_exchange_ack',
      ephemeralPublicKey: initiatorEphemeralPublicKey,
      senderUsername: myUsername,
      timestamp: Date.now(),
    };

    await this.writeSingleMessageToStream(stream, ackMessage);
    await this.closeStreamQuietly(stream);
    log(`[KEY-EXCHANGE][ACK][SENT] ts=${new Date().toISOString()} peer=${remoteId}`);
  }

  private createSignedKeyExchangeStreamResultMessage(
    content: 'key_exchange_confirmed' | 'key_exchange_cancelled',
    ephemeralPublicKey: string,
    myUsername: string,
    userIdentity: EncryptedUserIdentity,
  ): AuthenticatedEncryptedMessage {
    const messageToSign = {
      type: 'key_exchange' as const,
      content,
      ephemeralPublicKey,
      senderUsername: myUsername,
      timestamp: Date.now(),
    };

    const signature = userIdentity.sign(JSON.stringify(messageToSign));
    return {
      signature: Buffer.from(signature).toString('base64'),
      ...messageToSign,
    };
  }

  private async sendSignedKeyExchangeStreamResult(
    stream: Stream,
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    context: 'key_exchange_confirmed' | 'key_exchange_cancelled',
  ): Promise<void> {
    log(
      `[KEY-EXCHANGE][STREAM_RESULT][SEND][START] ts=${new Date().toISOString()} ` +
      `peer=${remoteId} context=${context}`,
    );
    await this.writeSingleMessageToStream(stream, message);
    log(
      `[KEY-EXCHANGE][STREAM_RESULT][SEND][DONE] ts=${new Date().toISOString()} ` +
      `peer=${remoteId} context=${context}`,
    );
  }

  private async sendKeyExchangeConfirmed(
    stream: Stream,
    remoteId: string,
    responderEphemeralPublicKey: string,
    myUsername: string,
    userIdentity: EncryptedUserIdentity,
  ): Promise<void> {
    const message = this.createSignedKeyExchangeStreamResultMessage(
      'key_exchange_confirmed',
      responderEphemeralPublicKey,
      myUsername,
      userIdentity,
    );
    await this.sendSignedKeyExchangeStreamResult(stream, remoteId, message, 'key_exchange_confirmed');
  }

  private async sendKeyExchangeCancelled(
    stream: Stream,
    remoteId: string,
    responderEphemeralPublicKey: string,
    myUsername: string,
    userIdentity: EncryptedUserIdentity,
  ): Promise<void> {
    const message = this.createSignedKeyExchangeStreamResultMessage(
      'key_exchange_cancelled',
      responderEphemeralPublicKey,
      myUsername,
      userIdentity,
    );
    await this.sendSignedKeyExchangeStreamResult(stream, remoteId, message, 'key_exchange_cancelled');
  }

  private async sendFreshKeyExchangeCancelled(
    remoteId: string,
    initiatorEphemeralPublicKey: string,
    myUsername: string,
    userIdentity: EncryptedUserIdentity,
  ): Promise<void> {
    const message = this.createSignedKeyExchangeStreamResultMessage(
      'key_exchange_cancelled',
      initiatorEphemeralPublicKey,
      myUsername,
      userIdentity,
    );
    await this.sendFreshKeyExchangeFollowup(remoteId, message, 'key_exchange_cancelled');
  }

  private async sendFreshKeyExchangeFollowup(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    context: 'key_exchange_response' | 'key_exchange_rejected' | 'key_exchange_cancelled',
  ): Promise<void> {
    const startedAt = Date.now();
    const activeConnections = this.node
      .getConnections()
      .filter((connection) => connection.remotePeer.toString() === remoteId)
      .map((connection) => connection.remoteAddr.toString());
    log(
      `[KEY-EXCHANGE][FOLLOWUP][SEND][START] ts=${new Date(startedAt).toISOString()} ` +
      `context=${context} peer=${remoteId} ` +
      `activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'}`,
    );

    const targetPeerId = peerIdFromString(remoteId);
    await this.logPeerDialDiagnostics(targetPeerId, context);
    const stream = await dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId,
      protocol: this.chatProtocol,
      context,
    });

    try {
      await this.writeSingleMessageToStream(stream, message);
      log(
        `[KEY-EXCHANGE][FOLLOWUP][SEND][DONE] ts=${new Date().toISOString()} ` +
        `context=${context} peer=${remoteId} durationMs=${Date.now() - startedAt}`,
      );
    } finally {
      await this.closeStreamQuietly(stream);
    }
  }

  private async assertKeyExchangeStreamResult(
    message: AuthenticatedEncryptedMessage,
    remoteId: string,
    expectedContent: 'key_exchange_confirmed' | 'key_exchange_cancelled',
    expectedEphemeralPublicKey: string,
  ): Promise<void> {
    if (message.type !== 'key_exchange' || message.content !== expectedContent) {
      throw new Error(`Unexpected key exchange stream result: ${message.content}`);
    }

    if (!message.signature || !message.senderUsername || !message.ephemeralPublicKey) {
      throw new Error(`Key exchange stream result missing signature, sender username or ephemeral public key`);
    }

    if (message.ephemeralPublicKey !== expectedEphemeralPublicKey) {
      throw new Error(`Key exchange stream result did not match the pending response`);
    }

    const messageToVerify = this.buildKeyExchangeMessageToVerify({
      content: expectedContent,
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    });

    const { valid } = await this.verifySignatureWithFallback(
      message.signature,
      messageToVerify,
      message.senderUsername,
      remoteId,
    );

    if (!valid) {
      throw new Error(`Key exchange ${expectedContent} signature verification failed`);
    }
  }

  private async waitForKeyExchangeFinalization(
    stream: Stream,
    remoteId: string,
    responderEphemeralPublicKey: string,
  ): Promise<void> {
    const startedAt = Date.now();
    log(
      `[KEY-EXCHANGE][FINALIZE][WAIT][START] ts=${new Date(startedAt).toISOString()} ` +
      `peer=${remoteId}`,
    );

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Key exchange follow-up timeout'));
      }, this.getKeyExchangeFollowupTimeoutMs());
    });

    const message = await Promise.race([
      StreamHandler.readMessageFromStream<AuthenticatedEncryptedMessage>(stream),
      timeoutPromise,
    ]);

    log(
      `[KEY-EXCHANGE][FINALIZE][WAIT][MESSAGE] ts=${new Date().toISOString()} ` +
      `peer=${remoteId} durationMs=${Date.now() - startedAt} content=${message.content}`,
    );

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (message.content === 'key_exchange_cancelled') {
      await this.assertKeyExchangeStreamResult(message, remoteId, 'key_exchange_cancelled', responderEphemeralPublicKey);
      throw new Error('Key exchange was cancelled by the initiator');
    }

    await this.assertKeyExchangeStreamResult(message, remoteId, 'key_exchange_confirmed', responderEphemeralPublicKey);
  }

  // Send key exchange response to initiator and wait for explicit initiator confirmation
  private async sendKeyExchangeResponseAndAwaitConfirmation(
    remoteId: string,
    ephemeralPublicKey: Uint8Array,
    myUsername: string,
    userIdentity: EncryptedUserIdentity,
    linkDecision: 'accepted' | 'reset_required' = 'accepted'
  ): Promise<void> {
    const responseMessageToSign = {
      type: 'key_exchange' as const,
      content: 'key_exchange_response' as const,
      ephemeralPublicKey: Buffer.from(ephemeralPublicKey).toString('base64'),
      senderUsername: myUsername,
      timestamp: Date.now(),
      linkDecision,
    };

    const responseSignature = userIdentity.sign(JSON.stringify(responseMessageToSign));
    const responseMessage: AuthenticatedEncryptedMessage = {
      signature: Buffer.from(responseSignature).toString('base64'),
      ...responseMessageToSign
    };

    const startedAt = Date.now();
    const targetPeerId = peerIdFromString(remoteId);
    await this.logPeerDialDiagnostics(targetPeerId, 'key_exchange_response');
    const stream = await dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId,
      protocol: this.chatProtocol,
      context: 'key_exchange_response',
    });

    try {
      await this.writeSingleMessageToStream(stream, responseMessage);
      log(
        `[KEY-EXCHANGE][FOLLOWUP][SEND][DONE] ts=${new Date().toISOString()} ` +
        `context=key_exchange_response peer=${remoteId} durationMs=${Date.now() - startedAt}`,
      );
      await this.waitForKeyExchangeFinalization(stream, remoteId, responseMessageToSign.ephemeralPublicKey);
    } finally {
      await this.closeStreamQuietly(stream);
    }
  }

  // Send rejection response to initiator
  private async sendRejectionResponse(
    remoteId: string,
    myUsername: string,
    userIdentity: EncryptedUserIdentity,
    initiatorEphemeralPublicKey: string,
    initiatorUsername: string,
  ): Promise<void> {
    const messageToSign = {
      type: 'key_exchange' as const,
      content: 'key_exchange_rejected' as const,
      ephemeralPublicKey: initiatorEphemeralPublicKey,
      senderUsername: myUsername,
      timestamp: Date.now(),
    };

    const signature = userIdentity.sign(JSON.stringify(messageToSign));
    const rejectionMessage: AuthenticatedEncryptedMessage = {
      signature: Buffer.from(signature).toString('base64'),
      ...messageToSign
    };

    try {
      await this.sendFreshKeyExchangeFollowup(remoteId, rejectionMessage, 'key_exchange_rejected');
      log(`Sent rejection response to ${initiatorUsername || remoteId.slice(0, 8)}`);
    } catch (sendError: unknown) {
      generalErrorHandler(sendError);
    }
  }

  //Handle key exchange init message (responder side)
  private async handleKeyExchangeInit(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    stream: Stream,
    userIdentity: EncryptedUserIdentity,
    myUsername: string
  ): Promise<void> {
    try {
      const linkHandling = this.getIncomingKeyExchangeLinkHandling(remoteId, message);
      const shouldContinue = await this.reconcileIncomingKeyExchangeInit(remoteId);
      if (!shouldContinue) {
        return;
      }

      let ackSent = false;
      const sendAckIfNeeded = async (): Promise<void> => {
        if (ackSent) {
          return;
        }

        ackSent = true;
        await this.sendKeyExchangeAck(stream, remoteId, myUsername, message.ephemeralPublicKey ?? '');
      };

      const verifiedInitiator = await this.authorizeAndVerifyIncomingInitiator(
        remoteId,
        message,
        userIdentity,
        sendAckIfNeeded,
      );
      if (!verifiedInitiator) {
        return;
      }

      await sendAckIfNeeded();

      // validated in authorizeAndVerifyIncomingInitiator
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const responderSession = this.createResponderSession(remoteId, message.ephemeralPublicKey!);

      try {
        await this.sendKeyExchangeResponseAndAwaitConfirmation(
          remoteId,
          responderSession.ephemeralPublicKey,
          myUsername,
          userIdentity,
          linkHandling.responseLinkDecision
        );
      } catch (error) {
        this.discardUncommittedSession(responderSession.session);
        throw error;
      }

      this.sessionManager.storeSession(remoteId, responderSession.session);
      await this.finalizeAcceptedKeyExchangeInit(
        remoteId,
        verifiedInitiator.sender.username,
        responderSession.offlineBucketSecret,
        responderSession.notificationsBucketKey,
        verifiedInitiator.keys.signingPublicKey,
        verifiedInitiator.keys.offlinePublicKey,
        verifiedInitiator.keys.signature,
        linkHandling.shouldForceResetLocalDirectChat,
        linkHandling.shouldTriggerRelinkCatchup,
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'REJECTION_NEEDED') {
        await this.sendRejectionResponse(
          remoteId,
          myUsername,
          userIdentity,
          message.ephemeralPublicKey ?? '',
          message.senderUsername
        );
        return;
      }

      if (error instanceof Error && error.message === 'KEY_EXCHANGE_CANCELLED_BY_INITIATOR') {
        return;
      }

      // Fire key exchange failed event
      const errorMessage = errStr(error, 'Unknown error');
      this.onKeyExchangeFailed({
        peerId: remoteId,
        username: message.senderUsername,
        error: errorMessage
      });

      generalErrorHandler(error);
      throw error;
    }
  }

  private getIncomingKeyExchangeLinkHandling(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
  ): {
    shouldForceResetLocalDirectChat: boolean;
    shouldTriggerRelinkCatchup: boolean;
    responseLinkDecision: 'accepted' | 'reset_required';
  } {
    const existingDirectChat = this.database.getChatByPeerId(remoteId);
    const incomingLinkIntent = message.linkIntent ?? 'resume';
    const shouldForceResetLocalDirectChat = Boolean(existingDirectChat) && incomingLinkIntent === 'initial';
    const shouldTriggerRelinkCatchup = !existingDirectChat && incomingLinkIntent !== 'initial';
    const responseLinkDecision: 'accepted' | 'reset_required' =
      !existingDirectChat && incomingLinkIntent !== 'initial'
        ? 'reset_required'
        : 'accepted';

    return {
      shouldForceResetLocalDirectChat,
      shouldTriggerRelinkCatchup,
      responseLinkDecision,
    };
  }

  private async reconcileIncomingKeyExchangeInit(remoteId: string): Promise<boolean> {
    const ourPendingKeyExchange = this.sessionManager.getPendingKeyExchange(remoteId);
    if (ourPendingKeyExchange) {
      const weWin = this.node.peerId.toString() < remoteId;
      if (weWin) {
        log(`Simultaneous KX detected - keeping ours`);
        return false;
      }

      log(`Simultaneous KX detected - cancelling ours`);
      await this.cancelPendingKeyExchange(remoteId);
    }

    const existingSession = this.sessionManager.getSession(remoteId);
    if (existingSession) {
      log(`Cleaning up existing session with ${remoteId.slice(0, 8)}... - they initiated a new KX`);
      this.sessionManager.clearSession(remoteId);
    }

    return true;
  }

  private async authorizeAndVerifyIncomingInitiator(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    userIdentity: EncryptedUserIdentity,
    onPendingCreated?: () => Promise<void>,
  ): Promise<{
    sender: UserRegistration | User;
    keys: { signingPublicKey: string; offlinePublicKey: string; signature: string };
  } | null> {
    this.validateKeyExchangeInit(message);
    const initialMessageBody = this.decryptInitialMessageBody(message, userIdentity.offlinePrivateKey);
    const authResult = await this.authorizeContactRequest(remoteId, message, initialMessageBody, onPendingCreated);
    if (!authResult) return null;

    const sender = authResult;
    const { valid, keys } = await this.verifyKeyExchangeInitSignature(message, sender, remoteId);
    if (!valid) {
      console.error('Key exchange init signature verification failed');
      this.onKeyExchangeFailed({
        peerId: remoteId,
        username: sender.username,
        error: 'Signature verification failed'
      });
      return null;
    }

    await this.ensureUserExistsWithKeys(
      remoteId,
      sender.username,
      keys.signingPublicKey,
      keys.offlinePublicKey,
      keys.signature
    );

    return { sender, keys };
  }

  private async finalizeAcceptedKeyExchangeInit(
    remoteId: string,
    username: string,
    offlineBucketSecret: string,
    notificationsBucketKey: Uint8Array,
    signingPublicKey: string,
    offlinePublicKey: string,
    signature: string,
    shouldForceResetLocalDirectChat: boolean,
    shouldTriggerRelinkCatchup: boolean,
  ): Promise<void> {
    await this._createUserAndChat(
      remoteId,
      username,
      offlineBucketSecret,
      notificationsBucketKey,
      signingPublicKey,
      offlinePublicKey,
      signature,
      shouldForceResetLocalDirectChat
    );
    if (shouldForceResetLocalDirectChat || shouldTriggerRelinkCatchup) {
      this.onDirectLinkReset(remoteId);
    }
  }

  private async waitForKeyExchangeResponse(peerId: string, stream: Stream): Promise<User | null> {
    const responsePromise = this.createPendingKeyExchangeResultPromise(peerId);
    void this.monitorInitialKeyExchangeStream(peerId, stream);
    return responsePromise;
  }

  private async monitorInitialKeyExchangeStream(
    peerId: string,
    stream: Stream,
  ): Promise<void> {
    const waitStartedAt = Date.now();
    const keyExchangeStartedAt = this.keyExchangeStartedAt.get(peerId);
    log(
      `[KEY-EXCHANGE][INIT_STREAM][START] ts=${new Date(waitStartedAt).toISOString()} peer=${peerId} ` +
      `sinceInitMs=${keyExchangeStartedAt === undefined ? 'unknown' : String(waitStartedAt - keyExchangeStartedAt)}`,
    );
    try {
      const message = await StreamHandler.readMessageFromStream<AuthenticatedEncryptedMessage>(stream);
      log(
        `[KEY-EXCHANGE][INIT_STREAM][MESSAGE] ts=${new Date().toISOString()} peer=${peerId} ` +
        `durationMs=${Date.now() - waitStartedAt} content=${message.content}`,
      );

      if (message.type !== 'key_exchange') {
        console.warn(`[KEY-EXCHANGE][INIT_STREAM][UNEXPECTED] peer=${peerId} type=${message.type}`);
        return;
      }

      if (message.content === 'key_exchange_ack') {
        return;
      }

      console.warn(`[KEY-EXCHANGE][INIT_STREAM][UNEXPECTED] peer=${peerId} content=${message.content}`);
    } catch (streamError: unknown) {
      const activeConnections = this.node
        .getConnections()
        .filter((connection) => connection.remotePeer.toString() === peerId)
        .map((connection) => connection.remoteAddr.toString());
      log(
        `[KEY-EXCHANGE][INIT_STREAM][FAIL] ts=${new Date().toISOString()} peer=${peerId} ` +
        `durationMs=${Date.now() - waitStartedAt} ` +
        `sinceInitMs=${keyExchangeStartedAt === undefined ? 'unknown' : String(Date.now() - keyExchangeStartedAt)} ` +
        `activeConns=${activeConnections.length > 0 ? activeConnections.join(',') : 'none'} ` +
        `error=${errStr(streamError)}`,
      );
    } finally {
      try {
        await stream.close();
      } catch {
        // Stream may already be reset/closed remotely.
      }
      this.keyExchangeStreams.delete(peerId);
    }
  }

  private async handleInboundAcceptedKeyExchangeResponse(
    peerId: string,
    message: AuthenticatedEncryptedMessage,
    streamSettlement: {
      stream: Stream;
      userIdentity: EncryptedUserIdentity;
      myUsername: string;
    },
  ): Promise<void> {
    const responderEphemeralPublicKey = message.ephemeralPublicKey;

    try {
      if (!this.pendingKeyExchangeResults.has(peerId) || !this.sessionManager.getPendingKeyExchange(peerId)) {
        log(`[KEY-EXCHANGE][RESPONSE][STALE] ts=${new Date().toISOString()} peer=${peerId}`);
        if (responderEphemeralPublicKey) {
          await this.sendKeyExchangeCancelled(
            streamSettlement.stream,
            peerId,
            responderEphemeralPublicKey,
            streamSettlement.myUsername,
            streamSettlement.userIdentity,
          );
        }
        return;
      }

      const confirmedResponderEphemeralPublicKey = await this.assertAcceptedKeyExchangeResponse(message, peerId);
      const { sharedSecret } = this.createAndStoreInitiatorSessionFromResponse(
        peerId,
        confirmedResponderEphemeralPublicKey,
      );
      await this.finalizeAcceptedKeyExchangeResponse(
        peerId,
        message.senderUsername,
        sharedSecret,
        message.linkDecision === 'reset_required',
      );
      await this.sendKeyExchangeConfirmed(
        streamSettlement.stream,
        peerId,
        confirmedResponderEphemeralPublicKey,
        streamSettlement.myUsername,
        streamSettlement.userIdentity,
      );
      this.resolvePendingKeyExchangeResult(peerId, this.database.getUserByPeerId(peerId));
    } catch (error: unknown) {
      const resolvedError = error instanceof Error ? error : new Error(String(error));
      this.rejectPendingKeyExchangeResult(peerId, resolvedError);
    } finally {
      await this.closeStreamQuietly(streamSettlement.stream);
    }
  }

  private async handleInboundCancelledKeyExchange(
    peerId: string,
    message: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    const hasPendingAcceptance = this.getPendingAcceptanceByPeerId(peerId) !== null;
    const hasContactAttempt = this.database.getContactAttemptsByPeerId(peerId).length > 0;
    if (!hasPendingAcceptance && !hasContactAttempt) {
      log(`[KEY-EXCHANGE][CANCELLED][STALE] ts=${new Date().toISOString()} peer=${peerId}`);
      return;
    }

    if (!message.signature || !message.senderUsername || !message.ephemeralPublicKey) {
      console.warn(`[KEY-EXCHANGE][CANCELLED][INVALID] peer=${peerId} reason=missing_required_fields`);
      return;
    }

    const messageToVerify = this.buildKeyExchangeMessageToVerify({
      content: 'key_exchange_cancelled',
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    });

    const { valid } = await this.verifySignatureWithFallback(
      message.signature,
      messageToVerify,
      message.senderUsername,
      peerId,
    );

    if (!valid) {
      console.warn(`[KEY-EXCHANGE][CANCELLED][INVALID] peer=${peerId} reason=signature_verification_failed`);
      return;
    }

    this.cancelPendingContact(peerId);
    this.onContactRequestCancelled({
      peerId,
      username: message.senderUsername,
    });
    log(`[KEY-EXCHANGE][CANCELLED][APPLY] ts=${new Date().toISOString()} peer=${peerId}`);
  }

  private async handleInboundRejectedKeyExchangeResponse(
    peerId: string,
    message: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    if (!this.pendingKeyExchangeResults.has(peerId) || !this.sessionManager.getPendingKeyExchange(peerId)) {
      log(`[KEY-EXCHANGE][REJECTION][STALE] ts=${new Date().toISOString()} peer=${peerId}`);
      return;
    }

    try {
      await this.handleRejectedKeyExchangeResponse(message, peerId);
    } catch (error: unknown) {
      const resolvedError = error instanceof Error ? error : new Error(String(error));
      this.rejectPendingKeyExchangeResult(peerId, resolvedError);
    }
  }

  private async handleRejectedKeyExchangeResponse(
    message: AuthenticatedEncryptedMessage,
    peerId: string,
  ): Promise<never> {
    if (!message.signature || !message.senderUsername || !message.ephemeralPublicKey) {
      throw new Error('Rejection message missing signature, sender username or ephemeral public key');
    }

    const messageToVerify = this.buildKeyExchangeMessageToVerify({
      content: 'key_exchange_rejected',
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    });

    const { valid } = await this.verifySignatureWithFallback(
      message.signature,
      messageToVerify,
      message.senderUsername,
      peerId
    );

    if (!valid) {
      console.warn('[KEY-EXCHANGE][REJECTION][INVALID] signature_verification_failed; remote user may be compromised');
    }

    throw new Error(`Contact request rejected by ${message.senderUsername}`);
  }

  private async assertAcceptedKeyExchangeResponse(
    message: AuthenticatedEncryptedMessage,
    peerId: string,
  ): Promise<string> {
    if (message.type !== 'key_exchange' || message.content !== 'key_exchange_response') {
      throw new Error('Unexpected message type during key exchange');
    }

    if (!message.signature || !message.senderUsername || !message.ephemeralPublicKey) {
      throw new Error('Key exchange response missing signature, sender username or ephemeral public key');
    }

    const verifyPayload: Pick<AuthenticatedEncryptedMessage,
      'content' |
      'ephemeralPublicKey' |
      'senderUsername' |
      'timestamp' |
      'encryptedMessageBody' |
      'encryptedMessageBodyType' |
      'encryptedMessageBodyKey' |
      'encryptedMessageBodyIv' |
      'linkIntent' |
      'linkDecision'> = {
      content: 'key_exchange_response',
      ephemeralPublicKey: message.ephemeralPublicKey,
      senderUsername: message.senderUsername,
      timestamp: message.timestamp,
    };
    if (message.linkDecision !== undefined) verifyPayload.linkDecision = message.linkDecision;
    const messageToVerify = this.buildKeyExchangeMessageToVerify(verifyPayload);

    const { valid } = await this.verifySignatureWithFallback(
      message.signature,
      messageToVerify,
      message.senderUsername,
      peerId
    );

    if (!valid) {
      throw new Error('Key exchange response signature verification failed');
    }

    return message.ephemeralPublicKey;
  }

  private createAndStoreInitiatorSessionFromResponse(
    peerId: string,
    remoteEphemeralPublicKey: string,
  ): { session: ConversationSession; sharedSecret: Uint8Array } {
    const pending = this.sessionManager.getPendingKeyExchange(peerId);
    if (!pending) {
      throw new Error('No pending key exchange found');
    }

    const { sendingKey, receivingKey, sharedSecret } = this.deriveDirectionalKeys(
      pending.ephemeralPublicKey,
      pending.ephemeralPrivateKey,
      remoteEphemeralPublicKey,
      'initiator'
    );

    const session: ConversationSession = {
      peerId: peerId,
      ephemeralPrivateKey: pending.ephemeralPrivateKey,
      ephemeralPublicKey: pending.ephemeralPublicKey,
      sendingKey,
      receivingKey,
      messageCount: 0,
      lastUsed: Date.now()
    };

    this.sessionManager.storeSession(peerId, session);
    this.sessionManager.removePendingKeyExchange(peerId);

    return { session, sharedSecret };
  }

  private async finalizeAcceptedKeyExchangeResponse(
    peerId: string,
    senderUsername: string,
    sharedSecret: Uint8Array,
    forceResetDirectChat: boolean,
  ): Promise<void> {
    const myPeerId = this.node.peerId.toString();
    const offlineBucketSecret = this.deriveOfflineBucketSecret(sharedSecret, myPeerId, peerId);
    const notificationsBucketKey = this.deriveNotificationsBucketKey(sharedSecret, myPeerId, peerId);

    const userFromDb = this.database.getUserByPeerId(peerId);
    await this._createUserAndChat(
      peerId,
      senderUsername,
      offlineBucketSecret,
      notificationsBucketKey,
      userFromDb?.signing_public_key,
      userFromDb?.offline_public_key,
      userFromDb?.signature,
      forceResetDirectChat
    );
    if (forceResetDirectChat) {
      this.onDirectLinkReset(peerId);
    }
  }

  /**
   * Handle key rotation message (receiver side)
   */
  private async handleKeyRotation(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
    userIdentity: EncryptedUserIdentity,
    myUsername: string
  ): Promise<void> {
    log(`Received key rotation from ${remoteId.slice(0, 8)}...`);

    const session = this.sessionManager.getSession(remoteId);
    if (!session) {
      console.error('No existing session for key rotation');
      return;
    }

    if (!this.hasValidIncomingRotationMessage(message)) {
      return;
    }

    if (!this.isValidRotationTimestamp(message.timestamp, 'kr_msg')) {
      return;
    }

    if (!await this.reconcileIncomingRotation(remoteId, message.senderUsername, session)) {
      return;
    }

    if (!await this.verifyIncomingRotationRequest(message, remoteId)) {
      console.warn('Key rotation signature verification failed');
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to signature verification failure`);
      return;
    }

    log(`Verified authentic key rotation from ${message.senderUsername}`);

    const responderRotation = this.createResponderRotation(message, userIdentity, myUsername);

    try {
      await this.sendRotationResponse(remoteId, responderRotation.rotationResponse);
      this.applyCompletedResponderRotation(session, responderRotation);
      log(`Key rotation completed with ${remoteId.slice(0, 8)}...`);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to send key rotation response');
      // Clear session to force re-key exchange on next message
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to rotation response send failure`);
    }
  }

  // Handle key rotation response message (initiator side)
  private async handleKeyRotationResponse(
    remoteId: string,
    message: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    log(`Received key rotation response from ${remoteId.slice(0, 8)}...`);

    const session = this.sessionManager.getSession(remoteId);
    if (!session) {
      console.error('No existing session for key rotation response');
      this.rejectRotationPromise(remoteId, new Error('No existing session for key rotation response'));
      return;
    }

    if (!this.hasValidIncomingRotationMessage(message, 'kr_resp')) {
      this.rejectRotationPromise(remoteId, new Error('Key rotation response missing required fields'));
      return;
    }

    if (!this.isValidRotationTimestamp(message.timestamp, 'kr_resp')) {
      this.rejectRotationPromise(remoteId, new Error('Key rotation response timestamp invalid'));
      return;
    }

    if (!await this.verifyIncomingRotationResponse(message, remoteId)) {
      console.error('Key rotation response signature verification failed');
      // Clear session since receiver may have already rotated keys
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to signature verification failure`);
      this.rejectRotationPromise(remoteId, new Error('Key rotation response signature verification failed'));
      return;
    }

    const pendingRotation = this.sessionManager.getPendingKeyExchange(remoteId);
    if (!pendingRotation) {
      console.error('No pending key rotation found - likely timeout already occurred');
      // Stale response: timeout already cleared the pending exchange
      // Clear session to force fresh key exchange since we're likely desynchronized
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to stale rotation response`);
      this.rejectRotationPromise(remoteId, new Error('No pending key rotation found'));
      return;
    }

    try {
      this.applyCompletedInitiatorRotation(remoteId, session, pendingRotation, message);
      log(`Key rotation completed with ${remoteId.slice(0, 8)}...`);
      this.resolveRotationPromise(remoteId, true);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Error completing key rotation');
      // Reject the promise
      this.rejectRotationPromise(remoteId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  async rotateSessionKeys(targetPeerId: PeerId): Promise<boolean> {
    const peerIdStr = targetPeerId.toString();

    if (this.sessionManager.getPendingKeyExchange(peerIdStr)) {
      console.warn(`Key rotation already in progress for ${peerIdStr.slice(0, 8)}...`);
      return false;
    }

    const session = this.sessionManager.getSession(peerIdStr);
    if (!session) {
      throw new Error('No existing session for key rotation');
    }

    const userIdentity = this.usernameRegistry.getUserIdentity();
    if (!userIdentity) {
      throw new Error('User identity not available');
    }

    const myUsername = this.getInitiatorUsername();
    const outgoingRotation = this.createOutgoingRotation(userIdentity, myUsername);

    this.sessionManager.storePendingKeyExchange(peerIdStr, outgoingRotation.pendingRotation);
    const rotationPromise = this.createRotationPromise(peerIdStr);

    try {
      await this.sendOutgoingRotation(targetPeerId, outgoingRotation.rotationMessage);
      log(`Key rotation message sent to ${peerIdStr.slice(0, 8)}...`);
    } catch (sendError: unknown) {
      // Send failed - clean up state immediately
      generalErrorHandler(sendError, 'Failed to send key rotation message');
      this.sessionManager.removePendingKeyExchange(peerIdStr);
      this.rotationPromises.delete(peerIdStr);
      return false;
    }

    return this.waitForRotationCompletion(peerIdStr, rotationPromise);
  }

  private hasValidIncomingRotationMessage(
    message: AuthenticatedEncryptedMessage,
    context: 'kr_msg' | 'kr_resp' = 'kr_msg',
  ): boolean {
    const valid = Boolean(message.ephemeralPublicKey && message.signature && message.senderUsername);
    if (!valid) {
      console.error(
        context === 'kr_resp'
          ? 'Key rotation response missing required fields'
          : 'Key rotation missing required fields'
      );
    }
    return valid;
  }

  private isValidRotationTimestamp(timestamp: number | undefined, context: 'kr_msg' | 'kr_resp' = 'kr_msg'): boolean {
    const messageAge = Date.now() - (timestamp || 0);
    const valid = messageAge <= MAX_KEY_EXCHANGE_AGE && messageAge >= -KEY_EXCHANGE_MAX_FUTURE_SKEW_MS;
    if (!valid) {
      console.error(
        context === 'kr_resp'
          ? 'Key rotation response too old or future-dated'
          : 'Key rotation message too old or future-dated'
      );
    }
    return valid;
  }

  private async reconcileIncomingRotation(
    remoteId: string,
    senderUsername: string,
    session: ConversationSession,
  ): Promise<boolean> {
    const lastRotation = session.lastRotated ?? 0;
    if (Date.now() - lastRotation < ROTATION_COOLDOWN) {
      console.warn(`Key rotation from ${senderUsername} too frequent - rate limited`);
      this.sessionManager.clearSession(remoteId);
      console.warn(`Cleared session for ${remoteId.slice(0, 8)}... due to rate-limited rotation`);
      return false;
    }

    const ourPendingRotation = this.sessionManager.getPendingKeyExchange(remoteId);
    if (!ourPendingRotation) {
      return true;
    }

    const weWin = this.node.peerId.toString() < remoteId;
    if (weWin) {
      log(`Simultaneous rotation detected with ${remoteId.slice(0, 8)}... - we initiated first, ignoring remote request`);
      return false;
    }

    log(`Simultaneous rotation detected with ${remoteId.slice(0, 8)}... - remote initiated first, canceling ours`);
    this.sessionManager.removePendingKeyExchange(remoteId);
    this.rejectRotationPromise(remoteId, new Error('Simultaneous rotation - remote wins'));
    return true;
  }

  private async verifyIncomingRotationRequest(
    message: AuthenticatedEncryptedMessage,
    remoteId: string,
  ): Promise<boolean> {
    const messageToVerify: MessageToVerify = {
      type: 'key_exchange',
      content: 'key_rotation',
      ephemeralPublicKey: message.ephemeralPublicKey ?? '',
      senderUsername: message.senderUsername ?? '',
      timestamp: message.timestamp,
    };

    const { valid } = await this.verifySignatureWithFallback(
      message.signature ?? '',
      messageToVerify,
      message.senderUsername ?? '',
      remoteId
    );

    return valid;
  }

  private createResponderRotation(
    message: AuthenticatedEncryptedMessage,
    userIdentity: EncryptedUserIdentity,
    myUsername: string,
  ): {
    newEphemeralPrivateKey: Uint8Array;
    newEphemeralPublicKey: Uint8Array;
    sendingKey: Uint8Array;
    receivingKey: Uint8Array;
    rotationResponse: AuthenticatedEncryptedMessage;
  } {
    const remoteEphemeralPublicKey = message.ephemeralPublicKey;
    if (!remoteEphemeralPublicKey) {
      throw new Error('Key rotation missing required fields');
    }

    const newEphemeralPrivateKey = x25519.utils.randomSecretKey();
    const newEphemeralPublicKey = x25519.getPublicKey(newEphemeralPrivateKey);

    const { sendingKey, receivingKey } = this.deriveDirectionalKeys(
      newEphemeralPublicKey,
      newEphemeralPrivateKey,
      remoteEphemeralPublicKey,
      'responder'
    );

    const responseTimestamp = Date.now();
    const responseMessageToSign = {
      type: 'key_exchange' as const,
      content: 'key_rotation_response' as const,
      ephemeralPublicKey: Buffer.from(newEphemeralPublicKey).toString('base64'),
      senderUsername: myUsername,
      timestamp: responseTimestamp,
    };

    const responseSignature = userIdentity.sign(JSON.stringify(responseMessageToSign));

    return {
      newEphemeralPrivateKey,
      newEphemeralPublicKey,
      sendingKey,
      receivingKey,
      rotationResponse: {
        signature: Buffer.from(responseSignature).toString('base64'),
        ...responseMessageToSign
      }
    };
  }

  private async sendRotationResponse(
    remoteId: string,
    rotationResponse: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    const targetPeerId = peerIdFromString(remoteId);
    await this.logPeerDialDiagnostics(targetPeerId, 'key_rotation_response');
    const responseStream = await dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId,
      protocol: this.chatProtocol,
      context: 'key_rotation_response',
    });
    const encoder = new TextEncoder();
    await responseStream.sink([encoder.encode(JSON.stringify(rotationResponse))]);
    log(`Key rotation response sent to ${remoteId.slice(0, 8)}...`);
  }

  private applyCompletedResponderRotation(
    session: ConversationSession,
    responderRotation: {
      newEphemeralPrivateKey: Uint8Array;
      newEphemeralPublicKey: Uint8Array;
      sendingKey: Uint8Array;
      receivingKey: Uint8Array;
    },
  ): void {
    session.ephemeralPrivateKey = responderRotation.newEphemeralPrivateKey;
    session.ephemeralPublicKey = responderRotation.newEphemeralPublicKey;
    session.sendingKey = responderRotation.sendingKey;
    session.receivingKey = responderRotation.receivingKey;
    session.messageCount = 0;
    session.lastUsed = Date.now();
    session.lastRotated = Date.now();
  }

  private async verifyIncomingRotationResponse(
    message: AuthenticatedEncryptedMessage,
    remoteId: string,
  ): Promise<boolean> {
    const messageToVerify: MessageToVerify = {
      type: 'key_exchange',
      content: 'key_rotation_response',
      ephemeralPublicKey: message.ephemeralPublicKey ?? '',
      senderUsername: message.senderUsername ?? '',
      timestamp: message.timestamp,
    };

    const { valid } = await this.verifySignatureWithFallback(
      message.signature ?? '',
      messageToVerify,
      message.senderUsername ?? '',
      remoteId
    );

    return valid;
  }

  private applyCompletedInitiatorRotation(
    remoteId: string,
    session: ConversationSession,
    pendingRotation: { ephemeralPrivateKey: Uint8Array; ephemeralPublicKey: Uint8Array },
    message: AuthenticatedEncryptedMessage,
  ): void {
    const remoteEphemeralPublicKey = message.ephemeralPublicKey;
    if (!remoteEphemeralPublicKey) {
      throw new Error('Key rotation response missing required fields');
    }

    const { sendingKey, receivingKey } = this.deriveDirectionalKeys(
      pendingRotation.ephemeralPublicKey,
      pendingRotation.ephemeralPrivateKey,
      remoteEphemeralPublicKey,
      'initiator'
    );

    session.ephemeralPrivateKey = pendingRotation.ephemeralPrivateKey;
    session.ephemeralPublicKey = pendingRotation.ephemeralPublicKey;
    session.sendingKey = sendingKey;
    session.receivingKey = receivingKey;
    session.messageCount = 0;
    session.lastUsed = Date.now();
    session.lastRotated = Date.now();
    this.sessionManager.removePendingKeyExchange(remoteId);
  }

  private createOutgoingRotation(
    userIdentity: EncryptedUserIdentity,
    myUsername: string,
  ): {
    pendingRotation: { timestamp: number; ephemeralPrivateKey: Uint8Array; ephemeralPublicKey: Uint8Array };
    rotationMessage: AuthenticatedEncryptedMessage;
  } {
    const newEphemeralPrivateKey = x25519.utils.randomSecretKey();
    const newEphemeralPublicKey = x25519.getPublicKey(newEphemeralPrivateKey);
    const timestamp = Date.now();

    const messageToSign = {
      type: 'key_exchange' as const,
      content: 'key_rotation' as const,
      ephemeralPublicKey: Buffer.from(newEphemeralPublicKey).toString('base64'),
      senderUsername: myUsername,
      timestamp,
    };
    const signature = userIdentity.sign(JSON.stringify(messageToSign));

    return {
      pendingRotation: {
        timestamp,
        ephemeralPrivateKey: newEphemeralPrivateKey,
        ephemeralPublicKey: newEphemeralPublicKey
      },
      rotationMessage: {
        signature: Buffer.from(signature).toString('base64'),
        ...messageToSign
      }
    };
  }

  private createRotationPromise(peerIdStr: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.rotationPromises.set(peerIdStr,
        { resolve: () => { resolve(true); }, reject: (_error: Error) => { resolve(false); } }
      );
    });
  }

  private async sendOutgoingRotation(
    targetPeerId: PeerId,
    rotationMessage: AuthenticatedEncryptedMessage,
  ): Promise<void> {
    await this.logPeerDialDiagnostics(targetPeerId, 'key_rotation');
    const stream = await dialProtocolWithRelayFallback({
      node: this.node,
      database: this.database,
      targetPeerId,
      protocol: this.chatProtocol,
      context: 'key_rotation',
    });
    const encoder = new TextEncoder();
    await stream.sink([encoder.encode(JSON.stringify(rotationMessage))]);
  }

  private waitForRotationCompletion(
    peerIdStr: string,
    rotationPromise: Promise<boolean>,
  ): Promise<boolean> {
    const timeoutPromise = new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        this.rotationPromises.delete(peerIdStr);
        this.rotationTimeouts.delete(peerIdStr);
        this.sessionManager.removePendingKeyExchange(peerIdStr);
        this.sessionManager.clearSession(peerIdStr);
        console.warn(`Key rotation timeout for ${peerIdStr.slice(0, 8)}... - cleared session`);
        resolve(false);
      }, KEY_ROTATION_TIMEOUT);
      this.rotationTimeouts.set(peerIdStr, timeoutId);
    });

    return Promise.race([rotationPromise, timeoutPromise]).catch((error: unknown) => {
      generalErrorHandler(error);
      this.sessionManager.removePendingKeyExchange(peerIdStr);
      this.rotationPromises.delete(peerIdStr);

      const timeoutId = this.rotationTimeouts.get(peerIdStr);
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.rotationTimeouts.delete(peerIdStr);
      }

      return false;
    });
  }


  private async _createUserAndChat(
    remoteId: string,
    username: string,
    offlineBucketSecret: string,
    notificationsBucketKey: Uint8Array,
    signing_public_key?: string,
    offline_public_key?: string,
    signature?: string,
    forceResetDirectChat = false
  ): Promise<void> {
    const otherUser = this.database.getUserByPeerId(remoteId);
    if (!otherUser) {
      // User doesn't exist - create with keys from DHT
      const peerId = await this.database.createUser({
        peer_id: remoteId,
        username: username,
        signing_public_key: signing_public_key ?? '',
        offline_public_key: offline_public_key ?? '',
        signature: signature ?? ''
      });
      if (peerId !== remoteId) {
        throw new Error('Peer ID mismatch - Something went horribly wrong');
      }
    } else if (signing_public_key || offline_public_key) {
      // User exists - update keys if we have DHT data and they're missing
      if (!otherUser.signing_public_key || !otherUser.offline_public_key) {
        log(`Updating missing keys for existing user ${username}`);
        this.database.updateUserKeys({
          peer_id: remoteId,
          signing_public_key: signing_public_key ?? otherUser.signing_public_key,
          offline_public_key: offline_public_key ?? otherUser.offline_public_key,
          signature: signature ?? otherUser.signature
        });
      }
    }
    const chat = this.database.getChatByPeerId(remoteId);
    if (!chat) {
      const chatId = await this.database.createChat({
        type: 'direct',
        created_by: this.node.peerId.toString(),
        participants: [this.node.peerId.toString(), remoteId],
        offline_bucket_secret: offlineBucketSecret,
        notifications_bucket_key: toBase64Url(notificationsBucketKey),
        offline_last_read_timestamp: 0,
        offline_last_ack_sent: 0,
        trusted_out_of_band: false,
        status: 'active',
        created_at: new Date()
      } as Omit<Chat, 'id' | 'updated_at'> & { participants: string[] });
      if (!chatId) {
        throw new Error('Failed to create chat');
      }

      log(`calling onChatCreated ${chatId} ${remoteId} ${username}`);
      this.onChatCreated({
        chatId,
        peerId: remoteId,
        username
      });
    } else if (chat.trusted_out_of_band || forceResetDirectChat) {
      if (forceResetDirectChat) {
        log(`Resetting direct chat ${chat.id} keys due to explicit key-exchange reset`);
      } else {
        log(`Upgrading chat ${chat.id} from out-of-band trust to ECDH-derived keys`);
      }
      this.database.updateChatEncryptionKeys(chat.id, {
        offline_bucket_secret: offlineBucketSecret,
        notifications_bucket_key: toBase64Url(notificationsBucketKey),
        trusted_out_of_band: false
      });
      this.database.updateOfflineLastReadTimestampByPeerId(remoteId, 0);
      this.database.updateOfflineLastAckSentByPeerId(remoteId, 0);
    }
  }

  private isKeyExchangeRateLimitExceeded(): boolean {
    let keyExchangeRateLimit = this.database.getSetting('key_exchange_rate_limit') ?? KEY_EXCHANGE_RATE_LIMIT_DEFAULT;
    if (isNaN(Number(keyExchangeRateLimit)) || Number(keyExchangeRateLimit) < 1 || Number(keyExchangeRateLimit) > 100) {
      console.warn(`Invalid key exchange rate limit value. Must be between 1 and 100. Using default value of ${KEY_EXCHANGE_RATE_LIMIT_DEFAULT}`);
      keyExchangeRateLimit = KEY_EXCHANGE_RATE_LIMIT_DEFAULT;
    }
    const recentAttemptsToMe = this.getRecentKeyExchangeAttempts();
    return recentAttemptsToMe >= Number(keyExchangeRateLimit);
  }

  private didUserContactMeRecently(peerId: string): boolean {
    const attempts = Array.from(this.pendingAcceptances.entries())
      .filter(([attemptPeerId, { receivedAt }]) =>
        attemptPeerId === peerId && receivedAt > Date.now() - RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW
      );
    const contactAttempts = this.database.getContactAttemptsByPeerId(peerId)
      .filter((attempt) => attempt.timestamp > Date.now() - RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW)
      .map((attempt) => attempt.sender_username);
    return attempts.length + contactAttempts.length > 0;
  }

  getKeyRotationThreshold(): number {
    return this.KEY_ROTATION_THRESHOLD;
  }

  getPendingAcceptanceByPeerId(peerId: string): PendingAcceptance | null {
    return this.pendingAcceptances.get(peerId) ?? null;
  }

  getPendingAcceptanceByUsername(username: string): (PendingAcceptance & { peerId: string }) | null {
    for (const [peerId, data] of this.pendingAcceptances.entries()) {
      if (data.username === username) {
        return { peerId, ...data };
      }
    }
    return null;
  }

  getPendingAcceptances(): PendingAcceptance[] {
    return Array.from(this.pendingAcceptances.entries())
      .map(([peerId, { resolve, reject, timestamp, receivedAt, expiresAt, username, messageBody }]) =>
        ({ peerId, resolve, reject, timestamp, receivedAt, expiresAt, username, messageBody })
      );
  }

  hasPendingRotation(peerId: string): boolean {
    return this.rotationPromises.has(peerId) || this.rotationTimeouts.has(peerId);
  }

  deletePendingAcceptanceByPeerId(peerId: string): void {
    this.pendingAcceptances.delete(peerId);
  }

  getRecentKeyExchangeAttempts(): number {
    const attempts = Array.from(this.pendingAcceptances.values())
      .filter(({ receivedAt }) => receivedAt > Date.now() - RECENT_KEY_EXCHANGE_ATTEMPTS_WINDOW);
    return attempts.length;
  }

  async cancelPendingKeyExchange(peerId: string): Promise<boolean> {
    const abortController = this.keyExchangeAbortControllers.get(peerId);
    const stream = this.keyExchangeStreams.get(peerId);
    if (abortController) {
      const pendingKeyExchange = this.sessionManager.getPendingKeyExchange(peerId);
      const initiatorEphemeralPublicKey = pendingKeyExchange
        ? Buffer.from(pendingKeyExchange.ephemeralPublicKey).toString('base64')
        : null;
      const userIdentity = this.usernameRegistry.getUserIdentity();
      const myUsername = this.getInitiatorUsername();

      if (stream) {
        log("closing stream", stream);
        try {
          stream.abort(new Error('KEY_EXCHANGE_CANCELLED'));
        } catch (err) {
          log(`Error closing stream during cancel: ${errStr(err)}`);
        }
        this.keyExchangeStreams.delete(peerId);
      }

      abortController();
      this.keyExchangeAbortControllers.delete(peerId);
      this.sessionManager.removePendingKeyExchange(peerId);
      if (initiatorEphemeralPublicKey && userIdentity) {
        try {
          await this.sendFreshKeyExchangeCancelled(
            peerId,
            initiatorEphemeralPublicKey,
            myUsername,
            userIdentity,
          );
        } catch (error) {
          console.warn(
            `[KEY-EXCHANGE][CANCELLED][SEND][FAIL] ts=${new Date().toISOString()} ` +
            `peer=${peerId} error=${errStr(error)}`,
          );
        }
      }
      log(`Cancelled pending key exchange with ${peerId.slice(0, 8)}...`);
      return true;
    }
    return false;
  }
} 
