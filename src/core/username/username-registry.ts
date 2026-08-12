import { ChatDatabase, User } from '../db/database.js';
import type { ChatNode, NetworkMode, UserRegistration } from '../types.js';
import {
  ERRORS,
  NETWORK_MODES,
  REGISTRATION_ADDRESS_CHECK_INTERVAL,
  REGISTRATION_ADDRESS_STABLE_ROUNDS,
  REREGISTRATION_INTERVAL,
  USERNAME_MAX_FUTURE_SKEW_MS,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_REGEX,
  getNetworkModeRuntime,
} from '../constants.js';
import { peerIdFromString } from '@libp2p/peer-id';
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import { hashUsingSha256 } from '../utils/crypto.js';
import { QueryEvent } from '@libp2p/kad-dht';
import {
  isUsernameRegistrationRecord,
  signUsernameRegistrationPayload,
  signUsernameRegistrationPeerBinding,
  verifyUsernameRegistrationPeerBinding,
  verifyUsernameRegistrationSignature,
} from './username-record.js';
import { log } from '../../shared/logger.js';

type UsernamePublishResult = {
  errorCount: number;
  acceptedCount: number;
  rejectedCount: number;
};

type UsernameRegistrationContext = {
  username: string;
  myPeerId: string;
  usernameKey: Uint8Array;
  peerIdKey: Uint8Array;
  registration: UserRegistration;
  registrationJson: string;
  valueBytes: Uint8Array;
  previousUsername: string | null;
};

type StoredUsernameState = {
  autoRegister: string | null;
  userDb: User | null;
  lastUsername: string | null;
};

export class UsernameRegistry {
  private static readonly TEXT_ENCODER = new TextEncoder();
  private static readonly TEXT_DECODER = new TextDecoder();
  private static readonly MAX_REGISTRATION_AGE = REREGISTRATION_INTERVAL * 2;
  private static readonly FAST_PUBLISH_EARLY_RETURN_MS = 10_000;
  private static readonly FAST_PUBLISH_POLL_MS = 1000;
  // Hard upper bound on one DHT publish. Without it, a put whose query neither
  // completes nor draws a single PEER_RESPONSE leaves publishRecord's wait loop
  // spinning forever: register() never settles, and RegisterDialog's button
  // stays disabled with no error and nothing logged. Observed against a DHT
  // whose closest peers were all unreachable — DIAL_PEER/QUERY_ERROR past 78s,
  // zero PEER_RESPONSE. Anonymous mode gets the longer budget for the same
  // reason its ping timeout does: onion circuits are legitimately slower.
  private static readonly FAST_PUBLISH_HARD_TIMEOUT_MS = 30_000;
  private static readonly ANONYMOUS_PUBLISH_HARD_TIMEOUT_MS = 60_000;
  private static readonly LOOKUP_RETRYABLE_ERRORS = [
    'Could not send correction',
    'No peers found',
    'all peers errored',
    'query timed out',
    'DHT is not started',
  ];

  private node: ChatNode;
  private currentUsername: string | null = null;
  private userIdentity: EncryptedUserIdentity | null = null;
  public reregistrationInterval: NodeJS.Timeout | null = null;
  // Address-drift watcher: re-publish the record when our own dial addresses
  // change (e.g. relay handoff), so a looker-up always gets a reachable address.
  public addressCheckInterval: NodeJS.Timeout | null = null;
  private lastPublishedAddrs: string[] = [];
  private pendingAddrCandidate: string[] | null = null;
  private pendingAddrRounds = 0;
  private database: ChatDatabase;
  private readonly networkMode: NetworkMode;
  private readonly usernameDhtPrefix: string;
  private readonly autoRegisterSettingKey: string;
  private readonly isFastMode: boolean;
  private registerInFlight: Promise<boolean> | null = null;

  constructor(node: ChatNode, database: ChatDatabase) {
    this.node = node;
    this.database = database;
    const runtime = getNetworkModeRuntime(database.getSessionNetworkMode());
    this.networkMode = runtime.mode;
    this.usernameDhtPrefix = runtime.config.dhtNamespaces.username;
    this.autoRegisterSettingKey = `auto_register_${this.networkMode}`;
    this.isFastMode = this.networkMode === NETWORK_MODES.FAST;
  }

  async initialize(userIdentity: EncryptedUserIdentity, onRestoreUsername: (username: string) => void): Promise<void> {
    this.userIdentity = userIdentity;
    // Invariant: the `users` table always contains a row for the local identity,
    // registered or not. Chat-creation paths (`createChat`,
    // `createTrustedDirectContact`) assert `created_by` exists in `users`, and
    // `created_by` is always our own peer ID for self-initiated chats — so
    // without a self-row an UNREGISTERED user cannot import a trusted profile
    // or accept an inbound contact request (both create a self-owned chat).
    // Previously the self-row was only inserted by `persistRegisteredUser` after
    // a successful username registration; seed it here at identity-ready time so
    // those flows work before (or without) registration. Registration later
    // updates the username in place (see `persistRegisteredUser`).
    await this.ensureSelfUserRow();
    const autoRegister = this.database.getSetting(this.autoRegisterSettingKey);

    if (autoRegister === 'never') {
      log('Auto-registration is disabled. Use "register <username>" to register a username.');
      return;
    }

    const storedUsernameState = this.readStoredUsernameState(autoRegister);

    if (storedUsernameState.autoRegister === 'true'
      && storedUsernameState.lastUsername
      && storedUsernameState.userDb) {
      log(`Auto-registering as '${storedUsernameState.lastUsername}' in background...`);
      void this.restoreStoredUsername(storedUsernameState.userDb, onRestoreUsername).catch((error: unknown) => {
        generalErrorHandler(error);
      });
    }
  }

  async register(username: string, isRenewal: boolean = false, rememberMe: boolean = false): Promise<boolean> {
    if (this.registerInFlight) {
      return this.registerInFlight;
    }

    const registerPromise = this.registerInternal(username, isRenewal, rememberMe);
    this.registerInFlight = registerPromise;
    try {
      return await registerPromise;
    } finally {
      if (this.registerInFlight === registerPromise) {
        this.registerInFlight = null;
      }
    }
  }

  private async registerInternal(username: string, isRenewal: boolean = false, rememberMe: boolean = false): Promise<boolean> {
    log(`Registering username: ${username} with rememberMe: ${rememberMe}`);
    if (!this.proceedWithRegistration(username, isRenewal)) {
      return true;
    }

    const registrationContext = await this.createRegistrationContext(username);

    await this.ensureUsernameAvailableForRegistration(
      registrationContext.usernameKey,
      registrationContext.myPeerId,
    );

    this.pausePreviousRegistration(registrationContext.previousUsername, username);
    try {
      await this.publishRegistrationPair(registrationContext);
    } catch (error: unknown) {
      this.restorePreviousRegistrationState(registrationContext.previousUsername);
      throw error;
    }

    await this.finalizeRegistration(registrationContext, rememberMe);
    return true;
  }

  async attemptAutoRegister(): Promise<string | null> {
    const storedUsernameState = this.readStoredUsernameState();
    if (storedUsernameState.autoRegister !== 'true') {
      return null;
    }

    if (!storedUsernameState.lastUsername || !storedUsernameState.userDb) {
      return null;
    }

    if (this.currentUsername === storedUsernameState.lastUsername) {
      return storedUsernameState.lastUsername;
    }

    if (!this.hasConnectedPeersForRegistration()) {
      return null;
    }

    const success = await this.renewUsername(storedUsernameState.lastUsername);
    return success ? storedUsernameState.lastUsername : null;
  }

  async unregister(): Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }> {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    const result = {
      usernameUnregistered: false,
      peerIdUnregistered: false,
    }

    this.database.setSetting(this.autoRegisterSettingKey, 'never');

    const targetUsername = this.currentUsername?.trim();
    if (!targetUsername) {
      this.clearLocalRegistrationState();
      return result;
    }

    try {
      Object.assign(result, await this.publishCurrentUsernameReleases(targetUsername));
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to publish username release record');
    }

    this.clearLocalRegistrationState();
    return result;
  }

  async lookup(username: string): Promise<UserRegistration> {
    return this.#lookupByKey(
      this.buildUsernameByNameKey(username),
      username,
      ERRORS.USERNAME_NOT_FOUND,
      (reg) => reg.username === username,
    );
  }

  async lookupByPeerId(peerId: string): Promise<UserRegistration> {
    return this.#lookupByKey(
      this.buildUsernameByPeerIdKey(peerId),
      peerId,
      'Peer ID not found in DHT',
      (reg) => reg.peerID === peerId,
    );
  }

  /**
   * Looks up a key in the DHT and gets full user data
   * @param key - The key to look up
   * @returns The complete user registration data
   * @throws {Error} If username or peer ID not found or signature invalid
   */
  async #lookupByKey(
    key: Uint8Array,
    keyLabel: string,
    notFoundError: string,
    extraValidation?: (reg: UserRegistration) => boolean,
  ): Promise<UserRegistration> {
    const currentTime = Date.now();
    const result = await this.readRegistrationForKey(key, keyLabel, currentTime, extraValidation);
    if (result) {
      // Feed the record's addresses into the peerStore so the existing
      // dial(peerId) path can reach this peer via its own relay — no shared
      // relay needed, no dialer changes. Awaited so the addresses are stored
      // before the caller dials (otherwise an immediate dial races the merge
      // and hits the original NO_RESERVATION fallback).
      await this.applyRecordAddressesToPeerStore(result);
      log(`[USERNAME][LOOKUP][SLOW] key=${keyLabel} result=hit`);
      return result;
    }

    console.warn(`[USERNAME][LOOKUP][MISS] key=${keyLabel}`);
    throw new Error(notFoundError);
  }

  getCurrentUsername(): string | null {
    return this.currentUsername;
  }

  getUserIdentity(): EncryptedUserIdentity | null {
    return this.userIdentity;
  }

  cleanup(): void {
    // Clears the periodic republish AND the address-drift watcher (+ resets its
    // pending state) so neither timer survives a shutdown/restart.
    this.stopReregistration();
  }

  private readStoredUsernameState(autoRegister: string | null = this.database.getSetting(this.autoRegisterSettingKey)): StoredUsernameState {
    return {
      autoRegister,
      userDb: this.database.getUserByPeerId(this.node.peerId.toString()),
      lastUsername: this.database.getLastUsername(this.node.peerId.toString()),
    };
  }

  private hasConnectedPeersForRegistration(): boolean {
    return this.node.getConnections().length > 0;
  }

  private async renewUsername(username: string): Promise<boolean> {
    return this.register(username, true);
  }

  private async restoreStoredUsername(userDb?: User, onRestoreUsername?: (username: string) => void): Promise<void> {
    if (!userDb?.username || !userDb.peer_id || userDb.peer_id !== this.node.peerId.toString()) {
      return;
    }

    const { username } = userDb;
    log(`Attempting to restore username: ${username}`);

    if (!this.hasConnectedPeersForRegistration()) {
      log(`Skipping auto-registration for '${username}' - no DHT peers connected`);
      log(`Registration will be available once connected to the network`);
      return;
    }

    try {
      await this.renewUsername(username);
      log(`Successfully restored username: ${username}`);
      onRestoreUsername?.(username);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('already taken')) {
        log(`Username '${username}' is now taken by someone else`);
      } else {
        generalErrorHandler(err, "Failed to restore username");
      }
    }
  }

  /**
   * Re-publish the current registration after bootstrap connectivity is
   * (re)established. No-op unless a username is currently registered — reuses
   * the periodic re-registration path rather than any new publish machinery, so
   * failures log via the same generalErrorHandler backstop.
   */
  async republishRegistrationAfterReconnect(): Promise<void> {
    if (!this.currentUsername) {
      return;
    }
    await this.reregisterCurrentUsername();
  }

  private async reregisterCurrentUsername(): Promise<void> {
    try {
      log(`Re-registering username: ${this.currentUsername}`);

      if (!this.currentUsername) {
        console.error('Current username not set');
        return;
      }

      await this.renewUsername(this.currentUsername);
    } catch (err: unknown) {
      generalErrorHandler(err, 'Failed to re-register username');
    }
  }

  private startReregistration(): void {
    if (!this.currentUsername) {
      return;
    }
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
    }
    
    this.reregistrationInterval = setInterval(() => {
      void this.reregisterCurrentUsername();
    }, REREGISTRATION_INTERVAL);
    this.startAddressChangeWatcher();
  }

  private stopReregistration(): void {
    if (this.reregistrationInterval) {
      clearInterval(this.reregistrationInterval);
      this.reregistrationInterval = null;
    }
    this.stopAddressChangeWatcher();
  }

  /**
   * Our own publishable dial addresses (sorted, deduped): relay circuit
   * addresses in fast mode, the onion address in anonymous mode. These are what
   * we embed in the record so peers can reach us without a shared relay.
   */
  private getPublishableAddresses(): string[] {
    const all = (this.node.getMultiaddrs?.() ?? []).map((ma) => ma.toString());
    const filtered = this.isFastMode
      ? all.filter((addr) => addr.includes('/p2p-circuit'))
      : all.filter((addr) => addr.includes('/onion3/'));
    return [...new Set(filtered)].sort();
  }

  /** Merge a looked-up record's addresses into the peerStore so dial(peerId) can use them. */
  private async applyRecordAddressesToPeerStore(record: UserRegistration): Promise<void> {
    if (!record.multiaddrs || record.multiaddrs.length === 0) return;
    if (record.peerID === this.node.peerId.toString()) return; // never our own
    try {
      const peerId = peerIdFromString(record.peerID);
      const multiaddrs = record.multiaddrs
        .map((addr) => { try { return multiaddr(addr); } catch { return null; } })
        .filter((ma): ma is Multiaddr => ma !== null);
      if (multiaddrs.length > 0) {
        await this.node.peerStore.merge(peerId, { multiaddrs });
      }
    } catch { /* invalid peer id / addresses / merge failure — ignore, dial will fall back */ }
  }

  private startAddressChangeWatcher(): void {
    if (this.addressCheckInterval) return;
    this.addressCheckInterval = setInterval(() => {
      this.checkPublishedAddressDrift();
    }, REGISTRATION_ADDRESS_CHECK_INTERVAL);
  }

  private stopAddressChangeWatcher(): void {
    if (this.addressCheckInterval) {
      clearInterval(this.addressCheckInterval);
      this.addressCheckInterval = null;
    }
    this.pendingAddrCandidate = null;
    this.pendingAddrRounds = 0;
  }

  /**
   * Re-publish the record if our dial addresses have drifted from what we last
   * published — but only after the new set holds for REGISTRATION_ADDRESS_STABLE_ROUNDS
   * consecutive polls (avoids publishing a transient/empty set mid relay-handoff),
   * and never blindly: requires an active registration, DHT connectivity, no
   * in-flight publish, and a non-empty changed set.
   */
  private checkPublishedAddressDrift(): void {
    if (!this.currentUsername) return;
    if (this.registerInFlight) return; // don't stack on an in-flight publish
    if (!this.hasConnectedPeersForRegistration()) return;

    const current = this.getPublishableAddresses();
    // Never overwrite a good record with zero addresses (e.g. during a relay gap).
    if (current.length === 0) { this.resetPendingAddrChange(); return; }
    // No drift.
    if (UsernameRegistry.addressListsEqual(current, this.lastPublishedAddrs)) {
      this.resetPendingAddrChange();
      return;
    }
    // Drift: require the same new set across consecutive polls before acting.
    if (this.pendingAddrCandidate && UsernameRegistry.addressListsEqual(current, this.pendingAddrCandidate)) {
      this.pendingAddrRounds++;
    } else {
      this.pendingAddrCandidate = current;
      this.pendingAddrRounds = 1;
    }
    if (this.pendingAddrRounds < REGISTRATION_ADDRESS_STABLE_ROUNDS) return;

    this.resetPendingAddrChange();
    log(`[USERNAME][ADDR-DRIFT] republishing '${this.currentUsername}' — dial addresses changed`);
    void this.reregisterCurrentUsername();
  }

  private resetPendingAddrChange(): void {
    this.pendingAddrCandidate = null;
    this.pendingAddrRounds = 0;
  }

  private static addressListsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private proceedWithRegistration(username: string, isRenewal: boolean): boolean {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    if (username.length < USERNAME_MIN_LENGTH) {
      throw new Error(`Username must be at least ${USERNAME_MIN_LENGTH} characters`);
    }

    if (username.length > USERNAME_MAX_LENGTH) {
      throw new Error(`Username must be at most ${USERNAME_MAX_LENGTH} characters`);
    }

    if (!USERNAME_REGEX.test(username)) {
      throw new Error('Username can only contain alphanumerics and underscores');
    }

    if (this.currentUsername === username && !isRenewal) {
      log(`Username ${username} is already registered`);
      return false;
    }

    return true;
  }

  private async createRegistrationContext(username: string): Promise<UsernameRegistrationContext> {
    const myPeerId = this.node.peerId.toString();
    const registration = await this.#createRegistrationObject(username, 'active');
    const registrationJson = JSON.stringify(registration);

    return {
      username,
      myPeerId,
      usernameKey: this.buildUsernameByNameKey(username),
      peerIdKey: this.buildUsernameByPeerIdKey(myPeerId),
      registration,
      registrationJson,
      valueBytes: UsernameRegistry.TEXT_ENCODER.encode(registrationJson),
      previousUsername: this.currentUsername,
    };
  }

  private async ensureUsernameAvailableForRegistration(usernameKey: Uint8Array, myPeerId: string): Promise<void> {
    try {
      for await (const event of this.node.services.dht.get(usernameKey) as AsyncIterable<QueryEvent>) {
        if (event.name !== 'VALUE' || !event.value) {
          continue;
        }

        const rawData = UsernameRegistry.TEXT_DECODER.decode(event.value).trim();
        if (!rawData || rawData === '{}') {
          continue;
        }

        let existingRegistration: UserRegistration | null = null;
        try {
          const parsed = JSON.parse(rawData) as unknown;
          if (
            !isUsernameRegistrationRecord(parsed)
            || parsed.networkMode !== this.networkMode
            || !verifyUsernameRegistrationSignature(parsed)
            || !verifyUsernameRegistrationPeerBinding(parsed)
          ) {
            continue;
          }
          existingRegistration = parsed;
        } catch {
          continue;
        }

        if (!existingRegistration) {
          continue;
        }

        if ((existingRegistration.kind ?? 'active') === 'released') {
          continue;
        }

        const age = Date.now() - existingRegistration.timestamp;
        if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
          continue;
        }

        // Ignore future-dated records
        if (-age > USERNAME_MAX_FUTURE_SKEW_MS) {
          continue;
        }

        if (existingRegistration.peerID && existingRegistration.peerID !== myPeerId) {
          throw new Error(ERRORS.USERNAME_TAKEN);
        }

        return;
      }
    } catch (err: unknown) {
      const errMsg = errStr(err, '');
      const isExpectedError = errMsg.includes('not found')
        || errMsg.includes('No peers found')
        || errMsg.includes('Could not send correction');
      if (!isExpectedError) {
        generalErrorHandler(err, 'Failed to register username');
        throw err;
      }
    }
  }

  private pausePreviousRegistration(previousUsername: string | null, nextUsername: string): void {
    if (!previousUsername) return;

    log(`Changing username from ${previousUsername} to ${nextUsername}`);
    this.stopReregistration();
  }

  private restorePreviousRegistrationState(previousUsername: string | null): void {
    if (!previousUsername) return;

    this.currentUsername = previousUsername;
    this.startReregistration();
  }

  private clearLocalRegistrationState(): void {
    this.currentUsername = null;
    this.stopReregistration();
  }

  private getPublishFailureError(publish: UsernamePublishResult, label: string): Error | null {
    // Success requires at least one remote peer to have verifiably stored the
    // record. A publish whose walk reached zero storing peers used to fall
    // through to success here, leaving the record only in the local datastore
    // — unresolvable by anyone else — while the UI reported "registered"
    // (fast-mode-username-lookup-issue.md, key finding 1).
    if (publish.acceptedCount > 0) {
      return null;
    }

    if (publish.rejectedCount > 0) {
      return new Error(`${label} rejected by DHT validators (${publish.rejectedCount} peer(s) rejected)`);
    }

    if (publish.errorCount > 0) {
      return new Error(`${label} failed: all ${publish.errorCount} peers unreachable`);
    }

    return new Error(`${label} failed: no reachable DHT peers stored the record`);
  }

  private async rollbackPartiallyPublishedUsername(username: string): Promise<void> {
    try {
      const released = await this.releaseUsernameByName(username);
      if (!released) {
        console.warn(`Peer ID write failed and rollback release for '${username}' did not fully propagate.`);
      }
    } catch (rollbackError: unknown) {
      generalErrorHandler(rollbackError, `Failed rollback release for partially committed username '${username}'`);
    }
  }

  private async publishRegistrationPair(context: UsernameRegistrationContext): Promise<void> {
    const usernamePublish = await this.publishRecord(context.usernameKey, context.valueBytes);
    const usernamePublishError = this.getPublishFailureError(usernamePublish, 'Username registration');
    if (usernamePublishError) {
      throw usernamePublishError;
    }

    const peerPublish = await this.publishRecord(context.peerIdKey, context.valueBytes);
    const peerPublishError = this.getPublishFailureError(peerPublish, 'Peer ID registration');
    if (peerPublishError) {
      await this.rollbackPartiallyPublishedUsername(context.username);
      throw peerPublishError;
    }

    log(`Stored records: username:${context.username} → peerID:${context.myPeerId} → full user data`);
  }

  private async finalizeRegistration(
    context: UsernameRegistrationContext,
    rememberMe: boolean,
  ): Promise<void> {
    if (context.previousUsername && context.previousUsername !== context.username) {
      const released = await this.releaseUsernameByName(context.previousUsername);
      if (!released) {
        console.warn(`Failed to release old username '${context.previousUsername}'. It may remain reserved until stale.`);
      }
    }

    this.currentUsername = context.username;
    await this.persistRegisteredUser(context);

    if (rememberMe) {
      this.database.setSetting(this.autoRegisterSettingKey, 'true');
      log(`Registered username: ${context.username} and will auto-register on startup`);
    }

    this.startReregistration();
  }

  /**
   * Ensure a minimal self-row exists in `users` for the local identity so that
   * chat-creation paths asserting `created_by` exists succeed before the user
   * registers a username. No-ops if a row already exists (so a registered
   * user's real username is never clobbered on restart). The placeholder
   * username matches the unregistered-self display fallback used elsewhere
   * (`getInitiatorUsername`), so no on-wire/display behaviour changes; the row
   * carries the real identity keys and gets its username upgraded on
   * registration.
   */
  private async ensureSelfUserRow(): Promise<void> {
    if (!this.userIdentity) {
      return;
    }
    const myPeerId = this.node.peerId.toString();
    if (this.database.getUserByPeerId(myPeerId, this.networkMode)) {
      return;
    }
    try {
      await this.database.createUser({
        peer_id: myPeerId,
        username: `user_${myPeerId.slice(-8)}`,
        signing_public_key: Buffer.from(this.userIdentity.signingPublicKey).toString('base64'),
        offline_public_key: Buffer.from(this.userIdentity.offlinePublicKey).toString('base64'),
        signature: '',
        network_mode: this.networkMode,
      });
      log('Seeded minimal self-row in users for unregistered identity');
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to seed self-row in users');
    }
  }

  private async persistRegisteredUser(context: UsernameRegistrationContext): Promise<void> {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }

    try {
      const existingUser = this.database.getUserByPeerId(context.myPeerId);
      if (existingUser) {
        log(`User already exists in database with ID: ${existingUser.peer_id}`);
        if (existingUser.username !== context.username) {
          this.database.updateUsername(context.myPeerId, context.username);
          log(`Updated username in database: ${context.username}`);
        }
        return;
      }

      const peerId = await this.database.createUser({
        peer_id: context.myPeerId,
        username: context.username,
        signing_public_key: context.registration.signingPublicKey,
        offline_public_key: context.registration.offlinePublicKey,
        signature: context.registration.signature,
      });
      log(peerId ? `User registered in database with peerId: ${peerId}` : 'User may already exist in database');
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to save user to database');
    }
  }

  async #createRegistrationObject(username: string, kind: 'active' | 'released'): Promise<UserRegistration> {
    if (!this.userIdentity) {
      throw new Error('User identity not initialized');
    }
    const identity = this.userIdentity;

    // Only active registrations advertise dial addresses. A released/tombstone
    // record needs no addresses, and omitting them stops publishing a reachable
    // relay/onion address for a username the user just gave up.
    const publishAddrs = kind === 'active' ? this.getPublishableAddresses() : [];
    // Remember what we're about to publish so the drift watcher compares against
    // the record contents, not against whatever getMultiaddrs() returns moment to
    // moment. (Set here rather than after publish; a failed publish just means
    // the periodic republish/next attempt recomputes — see checkPublishedAddressDrift.)
    this.lastPublishedAddrs = publishAddrs;

    const registrationData: Omit<UserRegistration, 'signature' | 'peerBinding'> = {
      peerID: this.node.peerId.toString(),
      networkMode: this.networkMode,
      username,
      kind,
      signingPublicKey: Buffer.from(identity.signingPublicKey).toString('base64'),
      offlinePublicKey: Buffer.from(identity.offlinePublicKey).toString('base64'),
      timestamp: Date.now(),
      ...(publishAddrs.length > 0 ? { multiaddrs: publishAddrs } : {}),
    };

    const signature = signUsernameRegistrationPayload(registrationData, (payload) =>
      identity.sign(payload),
    );
    const peerBinding = await signUsernameRegistrationPeerBinding(registrationData, (payloadBytes) =>
      identity.libp2pPrivateKey.sign(payloadBytes),
    );

    return {
      ...registrationData,
      signature,
      peerBinding,
    };
  }

  async #createReleasedRegistrationObject(username: string): Promise<UserRegistration> {
    return this.#createRegistrationObject(username, 'released');
  }


  private isValidUserRegistration(registration: unknown): registration is UserRegistration {
    return isUsernameRegistrationRecord(registration);
  }

  private readLookupCandidate(
    value: Uint8Array,
    keyLabel: string,
    currentTime: number,
    extraValidation?: (reg: UserRegistration) => boolean,
  ): UserRegistration | null {
    const rawData = UsernameRegistry.TEXT_DECODER.decode(value).trim();

    if (!rawData || rawData === '{}') return null;

    const registration = JSON.parse(rawData) as unknown;
    if (!this.isValidUserRegistration(registration)) return null;
    if (registration.networkMode !== this.networkMode) return null;
    if (!verifyUsernameRegistrationSignature(registration)) return null;
    if (!verifyUsernameRegistrationPeerBinding(registration)) return null;

    // Check if registration is too old (replay attack prevention)
    const age = currentTime - registration.timestamp;
    if (age > UsernameRegistry.MAX_REGISTRATION_AGE) {
      log(`Discarding old registration for ${keyLabel} (age: ${Math.round(age / 1000)}s)`);
      return null;
    }

    // Discard future-dated records (negative age)
    if (-age > USERNAME_MAX_FUTURE_SKEW_MS) {
      log(`Discarding future-dated registration for ${keyLabel} (skew: ${Math.round(-age / 1000)}s)`);
      return null;
    }

    if (extraValidation && !extraValidation(registration)) return null;

    return registration;
  }

  private choosePreferredLookupRegistration(
    current: UserRegistration | null,
    candidate: UserRegistration,
  ): UserRegistration {
    if (current == null || candidate.timestamp > current.timestamp) {
      return candidate;
    }

    // Deterministic tie-break: prefer active over released on same timestamp.
    if (
      current.timestamp === candidate.timestamp &&
      (current.kind ?? 'active') === 'released' &&
      (candidate.kind ?? 'active') !== 'released'
    ) {
      return candidate;
    }

    return current;
  }

  private throwLookupReadFailure(keyLabel: string, dhtErr: unknown): never {
    log(`DHT get failed for ${keyLabel}:`, errStr(dhtErr));
    const dhtErrMessage = errStr(dhtErr);
    if (this.isRetryableLookupFailure(dhtErrMessage)) {
      throw new Error(`${ERRORS.USERNAME_LOOKUP_FAILED}: ${dhtErrMessage}`);
    }
    throw dhtErr instanceof Error
      ? dhtErr
      : new Error(`${ERRORS.USERNAME_LOOKUP_FAILED}: ${dhtErrMessage}`);
  }

  private async readRegistrationForKey(
    key: Uint8Array,
    keyLabel: string,
    currentTime: number,
    extraValidation?: (reg: UserRegistration) => boolean,
  ): Promise<UserRegistration | null> {
    const startedAt = Date.now();
    let newestRecord: UserRegistration | null = null;
    let eventCount = 0;
    let valueCount = 0;
    let firstValueAt: number | null = null;

    try {
      for await (const event of this.node.services.dht.get(key) as AsyncIterable<QueryEvent>) {
        eventCount++;
        if (event.name !== 'VALUE' || !event.value) continue;
        valueCount++;
        firstValueAt ??= Date.now();
        try {
          const lookupCandidate = this.readLookupCandidate(
            event.value,
            keyLabel,
            currentTime,
            extraValidation,
          );
          if (!lookupCandidate) {
            continue;
          }

          newestRecord = this.choosePreferredLookupRegistration(newestRecord, lookupCandidate);
        } catch (parseErr: unknown) {
          generalErrorHandler(parseErr, `Failed to parse DHT value for ${keyLabel}`);
        }
      }
    } catch (dhtErr: unknown) {
      this.throwLookupReadFailure(keyLabel, dhtErr);
    }

    log(
      `[USERNAME][LOOKUP][READ] ts=${new Date().toISOString()} key=${keyLabel} ` +
      `events=${eventCount} values=${valueCount} ` +
      `firstValueMs=${firstValueAt === null ? 'none' : String(firstValueAt - startedAt)} ` +
      `tookMs=${Date.now() - startedAt} found=${newestRecord ? 'yes' : 'no'}`,
    );

    if (!newestRecord) {
      return null;
    }

    if ((newestRecord.kind ?? 'active') === 'released') {
      return null;
    }

    return newestRecord;
  }

  private isRetryableLookupFailure(message: string): boolean {
    return UsernameRegistry.LOOKUP_RETRYABLE_ERRORS.some((needle) =>
      message.toLowerCase().includes(needle.toLowerCase()),
    );
  }

  private async publishRecord(
    key: Uint8Array,
    valueBytes: Uint8Array,
  ): Promise<UsernamePublishResult> {
    const startedAt = Date.now();
    let errorCount = 0;
    let acceptedCount = 0;
    let rejectedCount = 0;

    const publishBudgetMs = this.isFastMode
      ? UsernameRegistry.FAST_PUBLISH_HARD_TIMEOUT_MS
      : UsernameRegistry.ANONYMOUS_PUBLISH_HARD_TIMEOUT_MS;
    // Cancels the underlying query rather than abandoning it to keep dialing in
    // the background (same idiom as offline-message-manager's put).
    const putSignal = AbortSignal.timeout(publishBudgetMs);

    const consumePut = async (): Promise<void> => {
      for await (const event of this.node.services.dht.put(key, valueBytes, { signal: putSignal }) as AsyncIterable<QueryEvent>) {
        if (event.name === 'QUERY_ERROR') {
          errorCount++;
          continue;
        }

        if (event.name === 'PEER_RESPONSE') {
          const accepted = event.record != null
            && Buffer.from(event.record.value).equals(Buffer.from(valueBytes));
          if (accepted) acceptedCount++;
          else rejectedCount++;
        }
      }
    };

    let finished = false;
    let consumeError: unknown = null;
    const consumePromise = consumePut()
      .catch((error: unknown) => {
        // Exhausting the budget is an expected outcome, not a failure worth
        // throwing: fall through with whatever counts were gathered and let
        // wasPublishAccepted() judge them (0 accepted => the caller reports a
        // failed registration). Anything else is a real error.
        if (!putSignal.aborted) {
          consumeError = error;
        }
      })
      .finally(() => {
        finished = true;
      });

    if (this.isFastMode) {
      const deadline = startedAt + UsernameRegistry.FAST_PUBLISH_EARLY_RETURN_MS;
      // One poll interval past the budget, so the putSignal path above normally
      // wins and this only fires if the query ignores the abort entirely.
      const hardDeadline = startedAt + publishBudgetMs + UsernameRegistry.FAST_PUBLISH_POLL_MS;
      while (!finished) {
        if (Date.now() >= deadline && acceptedCount >= 1) {
          void consumePromise;
          return { errorCount, acceptedCount, rejectedCount };
        }

        if (Date.now() >= hardDeadline) {
          void consumePromise;
          return { errorCount, acceptedCount, rejectedCount };
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          setTimeout(resolve, UsernameRegistry.FAST_PUBLISH_POLL_MS);
        });
      }
    }

    await consumePromise;
    if (consumeError) {
      throw consumeError;
    }

    return { errorCount, acceptedCount, rejectedCount };
  }

  private wasPublishAccepted(publish: UsernamePublishResult): boolean {
    if (publish.acceptedCount === 0 && publish.rejectedCount > 0) return false;
    if (publish.errorCount > 0 && publish.acceptedCount === 0) return false;
    return publish.acceptedCount > 0;
  }

  private async createReleasedRegistrationValueBytes(username: string): Promise<Uint8Array> {
    const releaseRecord = await this.#createReleasedRegistrationObject(username);
    return UsernameRegistry.TEXT_ENCODER.encode(JSON.stringify(releaseRecord));
  }

  private async publishReleasedRegistrationForKey(key: Uint8Array, valueBytes: Uint8Array): Promise<boolean> {
    const publish = await this.publishRecord(key, valueBytes);
    return this.wasPublishAccepted(publish);
  }

  private async publishCurrentUsernameReleases(
    username: string,
  ): Promise<{ usernameUnregistered: boolean; peerIdUnregistered: boolean }> {
    const myPeerId = this.node.peerId.toString();
    const valueBytes = await this.createReleasedRegistrationValueBytes(username);
    const [usernameRelease, peerRelease] = await Promise.allSettled([
      this.publishReleasedRegistrationForKey(this.buildUsernameByNameKey(username), valueBytes),
      this.publishReleasedRegistrationForKey(this.buildUsernameByPeerIdKey(myPeerId), valueBytes),
    ]);

    return {
      usernameUnregistered: usernameRelease.status === 'fulfilled' ? usernameRelease.value : false,
      peerIdUnregistered: peerRelease.status === 'fulfilled' ? peerRelease.value : false,
    };
  }

  private async releaseUsernameByName(username: string): Promise<boolean> {
    return this.publishReleasedRegistrationForKey(
      this.buildUsernameByNameKey(username),
      await this.createReleasedRegistrationValueBytes(username),
    );
  }

  private buildUsernameByNameKey(username: string): Uint8Array {
    const hashed = hashUsingSha256(username);
    return UsernameRegistry.TEXT_ENCODER.encode(`${this.usernameDhtPrefix}/by-name/${hashed}`);
  }

  private buildUsernameByPeerIdKey(peerId: string): Uint8Array {
    const hashed = hashUsingSha256(peerId);
    return UsernameRegistry.TEXT_ENCODER.encode(`${this.usernameDhtPrefix}/by-peer/${hashed}`);
  }

}
