import { read } from 'read';
import { scrypt } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { gcm } from '@noble/ciphers/aes.js';
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ed25519 } from '@noble/curves/ed25519';
import type { PrivateKey, PeerId } from '@libp2p/interface';
import { generateKeyPairSync, hkdfSync } from 'crypto';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Worker } from 'worker_threads';
import type { ChatDatabase, EncryptedUserIdentityDb } from '../db/database.js';
import type { NetworkMode, PasswordResponse } from '../types.js';
import { CRYPTO_TIMEOUT, IDENTITY_SCRYPT_N } from '../constants.js';
import { log } from '../../shared/logger.js';

// Try to import keytar for OS keychain support
let keytar: any = null;
let keytarLoaded = false;

async function loadKeytar() {
    if (keytarLoaded) return keytar;

    try {
        const keytarModule = await import('keytar');
        keytar = keytarModule.default || keytarModule;
        keytarLoaded = true;
        return keytar;
    } catch {
        log('OS keychain not available, falling back to password prompts');
        return null;
    }
}


interface DecryptedUserIdentityData {
    id: string
    created: string
    libp2pPrivateKey: string
    signingPrivateKey: string
    signingPublicKey: string
    offlinePrivateKey: string
    offlinePublicKey: string
    notificationsPublicKey: string
    notificationsPrivateKey: string
}

interface ScryptParams {
    N: number    // CPU/memory cost parameter
    r: number    // block size parameter
    p: number    // parallelization parameter
    dkLen: number // derived key length
}

interface PasswordValidationResult {
    valid: boolean
    message?: string
}

interface IdentityDecryptWorkerResponse {
    ok: boolean
    decrypted?: Uint8Array
    encrypted?: Uint8Array
    error?: string
}

export class EncryptedUserIdentity {
    public readonly id: string;
    public readonly identity: PeerId;
    public readonly libp2pPrivateKey: PrivateKey;
    public readonly signingPrivateKey: Uint8Array;
    public readonly signingPublicKey: Uint8Array;
    public readonly offlinePrivateKey: string;
    public readonly offlinePublicKey: string;
    public readonly notificationsPublicKey: string;
    public readonly notificationsPrivateKey: string;

    private static readonly SCRYPT_PARAMS: ScryptParams = {
        N: IDENTITY_SCRYPT_N,
        r: 8,        // standard value
        p: 1,        // single thread
        dkLen: 32    // 256-bit key for AES-256-GCM
    };

    protected constructor(
        id: string,
        identity: PeerId,
        libp2pPrivateKey: PrivateKey,
        signingPrivateKey: Uint8Array,
        signingPublicKey: Uint8Array,
        offlinePrivateKey: string,
        offlinePublicKey: string,
        notificationsPublicKey: string,
        notificationsPrivateKey: string,
    ) {
        this.id = id;
        this.identity = identity;
        this.libp2pPrivateKey = libp2pPrivateKey;
        this.signingPrivateKey = signingPrivateKey;
        this.signingPublicKey = signingPublicKey;
        this.offlinePrivateKey = offlinePrivateKey;
        this.offlinePublicKey = offlinePublicKey;
        this.notificationsPublicKey = notificationsPublicKey;
        this.notificationsPrivateKey = notificationsPrivateKey;
    }

    static async createEncrypted(): Promise<EncryptedUserIdentity> {
        // Generate persistent Ed25519 key for libp2p peer identity
        const libp2pPrivateKey = await generateKeyPair('Ed25519');
        const identity = peerIdFromPrivateKey(libp2pPrivateKey);

        // Generate Ed25519 keys for application-level signing
        const signingPrivateKey = ed25519.utils.randomSecretKey();
        const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);

        // Generate RSA keys for offline message encryption
        const rsaKeyPair = generateKeyPairSync('rsa', {
            modulusLength: 3072,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
            }
        });

        // Generate RSA keys for notifications
        const notificationsRsaKeyPair = generateKeyPairSync('rsa', {
            modulusLength: 3072,
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem',
            }
        });

        return new EncryptedUserIdentity(
            identity.toString(),
            identity,
            libp2pPrivateKey,
            signingPrivateKey,
            signingPublicKey,
            rsaKeyPair.privateKey,
            rsaKeyPair.publicKey,
            notificationsRsaKeyPair.publicKey,
            notificationsRsaKeyPair.privateKey
        );
    }

    static async loadOrCreateEncryptedForMode(
        database: ChatDatabase,
        mode: NetworkMode,
        customPasswordPrompt: (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => Promise<PasswordResponse>,
        sendStatus: (message: string, stage: any) => void
    ): Promise<EncryptedUserIdentity> {
        let passwordBytes: Uint8Array | null = null;
        try {
            const encryptedUserIdentity = database.getEncryptedUserIdentityForMode(mode, 'primary');
            if (encryptedUserIdentity) {
                return await EncryptedUserIdentity.loadEncrypted(encryptedUserIdentity, mode, customPasswordPrompt, sendStatus, database);
            } else {
                const identity = await EncryptedUserIdentity.createEncrypted();
                const recoveryPhrase = EncryptedUserIdentity.generateRecoveryPhrase();
                const keychainIdentityId = EncryptedUserIdentity.getModeScopedKeychainAccount(mode, identity.id);

                const response = await EncryptedUserIdentity.getPasswordFromKeychain(
                    keychainIdentityId,
                    'Create a strong password for your new identity',
                    true,
                    customPasswordPrompt,
                    recoveryPhrase,
                    undefined,
                    undefined,
                    false
                );
                passwordBytes = new TextEncoder().encode(response.password);
                await identity.saveEncrypted(database, mode, passwordBytes, sendStatus, recoveryPhrase);
                return identity;
            }
        } catch (error) {
            console.error('[IDENTITY] Failed to load or create identity');
            generalErrorHandler(error);
            throw error;
        } finally {
            if (passwordBytes) passwordBytes.fill(0);
        }
    }

    static async loadOrCreateEncrypted(
        database: ChatDatabase,
        customPasswordPrompt: (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => Promise<PasswordResponse>,
        sendStatus: (message: string, stage: any) => void
    ): Promise<EncryptedUserIdentity> {
        return this.loadOrCreateEncryptedForMode(
            database,
            database.getSessionNetworkMode(),
            customPasswordPrompt,
            sendStatus
        );
    }

    static async loadEncrypted(
        encryptedUserIdentity: EncryptedUserIdentityDb,
        mode: NetworkMode,
        customPasswordPrompt: (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => Promise<PasswordResponse>,
        sendStatus: (message: string, stage: any) => void,
        database: ChatDatabase
    ): Promise<EncryptedUserIdentity> {
        let passwordBytes: Uint8Array | null = null;
        let decryptedBytes: Uint8Array | null = null;
        let errorMessage: string | undefined = undefined;
        let showRecoveryOption = false;
        const keytarInstance = await loadKeytar();


        for (let i = 0; i < 100; i++) { // 100 attempts -> avoiding infinite loops
            try {
                const cooldown = database.checkLoginCooldown(encryptedUserIdentity.peer_id, mode);
                const keychainIdentityId = EncryptedUserIdentity.getModeScopedKeychainAccount(mode, encryptedUserIdentity.peer_id);

                const response = await EncryptedUserIdentity.getPasswordFromKeychain(
                    keychainIdentityId,
                    'Enter password for identity',
                    false,
                    customPasswordPrompt,
                    undefined, // no recovery phrase when loading
                    errorMessage,
                    cooldown.isLocked ? cooldown.remainingSeconds : undefined,
                    showRecoveryOption,
                    keytarInstance
                );

                // Check if user submitted recovery phrase
                if (response.useRecoveryPhrase) {
                    log('Attempting recovery phrase login...');
                    sendStatus('Verifying recovery phrase...', 'loadEncrypted');

                    try {
                        const identity = await EncryptedUserIdentity.loadWithRecoveryPhrase(
                            mode,
                            encryptedUserIdentity.peer_id,
                            response.password, // This is the recovery phrase
                            database
                        );

                        // Success - clear login attempts
                        database.clearLoginAttempts(encryptedUserIdentity.peer_id, mode);
                        return identity;
                    } catch (error: unknown) {
                        if (error instanceof Error) {
                            errorMessage = `Recovery phrase failed: ${error.message}`;
                            database.recordFailedLoginAttempt(encryptedUserIdentity.peer_id, mode);
                            showRecoveryOption = true;
                            continue;
                        }
                        throw error;
                    }
                }

                // Normal password attempt
                passwordBytes = new TextEncoder().encode(response.password);
                sendStatus('Decrypting identity...', 'loadEncrypted');
                decryptedBytes = await EncryptedUserIdentity.decryptIdentityPayloadInWorker(
                    passwordBytes,
                    encryptedUserIdentity
                );
                const decryptedJson = new TextDecoder().decode(decryptedBytes);
                const parsedData = JSON.parse(decryptedJson);

                // Validate structure before using
                if (!EncryptedUserIdentity.isValidIdentityData(parsedData)) {
                    throw new Error('Invalid identity data structure - corrupted or tampered data');
                }

                const identityData: DecryptedUserIdentityData = parsedData;
                const identity = EncryptedUserIdentity.reconstructFromData(identityData);

                if (keytarInstance && response.rememberMe && response.password && !response.useRecoveryPhrase) {
                    try {
                        await keytarInstance.setPassword('kiyeovo', keychainIdentityId, response.password);
                    } catch (error) {
                        console.warn('[IDENTITY] Failed to store password in OS keychain:', errStr(error));
                    }
                }

                // Clear sensitive data and login attempts
                if (passwordBytes) passwordBytes.fill(0);
                if (decryptedBytes) decryptedBytes.fill(0);
                database.clearLoginAttempts(encryptedUserIdentity.peer_id, mode);

                return identity;
            } catch (error: unknown) {
                // Clean up sensitive data
                if (passwordBytes) passwordBytes.fill(0);
                if (decryptedBytes) decryptedBytes.fill(0);

                if (!(error instanceof Error)) {
                    throw new Error('Failed to decrypt identity');
                }

                // Check if it's a wrong password error
                if (error.message.includes('authentication') || error.message.includes('ghash tag')) {
                    database.recordFailedLoginAttempt(encryptedUserIdentity.peer_id, mode);

                    const cooldown = database.checkLoginCooldown(encryptedUserIdentity.peer_id, mode);
                    const attempt = database.getLoginAttempt(encryptedUserIdentity.peer_id, mode);

                    if (cooldown.isLocked) {
                        errorMessage = `Incorrect password. Too many attempts. Wait ${Math.ceil(cooldown.remainingSeconds / 60)} minutes.`;
                    } else {
                        errorMessage = `Incorrect password. Attempt ${attempt?.attempt_count || 1}.`;
                    }
                    showRecoveryOption = true;
                    log(`[IDENTITY] Wrong password attempt=${attempt?.attempt_count ?? 'unknown'}`);

                    // Ask for password again
                    continue;
                }

                // For other errors (corruption, etc.), don't retry
                throw new Error(`Failed to decrypt identity: ${error.message}`);
            }
        }
        throw new Error('Failed to load encrypted identity after 100 attempts');
    }

    private static async decryptIdentityPayloadInWorker(
        passwordBytes: Uint8Array,
        encryptedUserIdentity: EncryptedUserIdentityDb
    ): Promise<Uint8Array> {
        return await new Promise((resolve, reject) => {
            const worker = new Worker(
                new URL('../workers/identity-workers.js', import.meta.url)
            );
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                void worker.terminate();
                reject(new Error('Identity decryption timed out'));
            }, CRYPTO_TIMEOUT); // if 60 seconds is not enough, either lower the IDENTITY_SCRYPT_N or buy a new PC

            const finish = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                callback();
            };

            worker.once('message', (message: IdentityDecryptWorkerResponse) => {
                finish(() => {
                    void worker.terminate();
                    if (!message.ok) {
                        reject(new Error(message.error || 'Failed to decrypt identity'));
                        return;
                    }
                    if (!message.decrypted) {
                        reject(new Error('Identity worker returned empty payload'));
                        return;
                    }
                    resolve(new Uint8Array(message.decrypted));
                });
            });

            worker.once('error', (error: Error) => {
                finish(() => {
                    void worker.terminate();
                    reject(error);
                });
            });

            worker.once('exit', (code: number) => {
                if (settled || code === 0) return;
                finish(() => {
                    reject(new Error(`Identity worker exited with code ${code}`));
                });
            });

            worker.postMessage({
                operation: 'decrypt',
                password: passwordBytes,
                salt: encryptedUserIdentity.salt,
                nonce: encryptedUserIdentity.nonce,
                encryptedData: encryptedUserIdentity.encrypted_data,
                scryptParams: EncryptedUserIdentity.SCRYPT_PARAMS
            });
        });
    }

    private static async encryptIdentityPayloadInWorker(
        passwordBytes: Uint8Array,
        plaintext: Uint8Array,
        salt: Uint8Array,
        nonce: Uint8Array
    ): Promise<Uint8Array> {
        return await new Promise((resolve, reject) => {
            const worker = new Worker(
                new URL('../workers/identity-workers.js', import.meta.url)
            );
            let settled = false;

            const timeout = setTimeout(() => {
                if (settled) return;
                settled = true;
                void worker.terminate();
                reject(new Error('Identity encryption timed out'));
            }, CRYPTO_TIMEOUT);

            const finish = (callback: () => void): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                callback();
            };

            worker.once('message', (message: IdentityDecryptWorkerResponse) => {
                finish(() => {
                    void worker.terminate();
                    if (!message.ok) {
                        reject(new Error(message.error || 'Failed to encrypt identity'));
                        return;
                    }
                    if (!message.encrypted) {
                        reject(new Error('Identity worker returned empty encrypted payload'));
                        return;
                    }
                    resolve(new Uint8Array(message.encrypted));
                });
            });

            worker.once('error', (error: Error) => {
                finish(() => {
                    void worker.terminate();
                    reject(error);
                });
            });

            worker.once('exit', (code: number) => {
                if (settled || code === 0) return;
                finish(() => {
                    reject(new Error(`Identity worker exited with code ${code}`));
                });
            });

            worker.postMessage({
                operation: 'encrypt',
                password: passwordBytes,
                salt,
                nonce,
                plaintextData: plaintext,
                scryptParams: EncryptedUserIdentity.SCRYPT_PARAMS
            });
        });
    }

    async saveEncrypted(
        database: ChatDatabase,
        mode: NetworkMode,
        password: Uint8Array,
        sendStatus: (message: string, stage: any) => void,
        recoveryPhrase?: string
    ): Promise<void> {
        let plaintext: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;
        let recoveryPassword: Uint8Array | null = null;

        try {
            const salt = randomBytes(32);
            const nonce = randomBytes(12);

            sendStatus("Encrypting identity...", "Save encrypted")

            const identityData: DecryptedUserIdentityData = {
                id: this.id,
                created: new Date().toISOString(),
                libp2pPrivateKey: this.getLibp2pPrivateKeyBase64(),
                signingPrivateKey: Buffer.from(this.signingPrivateKey).toString('base64'),
                signingPublicKey: Buffer.from(this.signingPublicKey).toString('base64'),
                offlinePrivateKey: this.offlinePrivateKey,
                offlinePublicKey: this.offlinePublicKey,
                notificationsPublicKey: this.notificationsPublicKey,
                notificationsPrivateKey: this.notificationsPrivateKey
            };

            plaintext = new TextEncoder().encode(JSON.stringify(identityData));
            ciphertext = await EncryptedUserIdentity.encryptIdentityPayloadInWorker(
                password,
                plaintext,
                salt,
                nonce
            );
            password.fill(0);

            const encryptedUserIdentity = {
                peer_id: this.id,
                salt: Buffer.from(salt),
                nonce: Buffer.from(nonce),
                encrypted_data: Buffer.from(ciphertext),
            };

            database.createEncryptedUserIdentityForMode(mode, 'primary', encryptedUserIdentity);

            // Save a second copy encrypted with phrase-derived password
            if (recoveryPhrase) {
                recoveryPassword = EncryptedUserIdentity.derivePasswordFromPhrase(recoveryPhrase, mode);
                await this.saveRecoveryCopy(database, mode, recoveryPassword, identityData);
            }
        } catch (error: unknown) {
            generalErrorHandler(error);
            throw error;
        } finally {
            if (password) password.fill(0);
            if (plaintext) plaintext.fill(0);
            if (ciphertext) ciphertext.fill(0);
            if (recoveryPassword) recoveryPassword.fill(0);
        }
    }

    private async saveRecoveryCopy(
        database: ChatDatabase,
        mode: NetworkMode,
        recoveryPassword: Uint8Array,
        identityData: DecryptedUserIdentityData
    ): Promise<void> {
        let plaintext: Uint8Array | null = null;
        let ciphertext: Uint8Array | null = null;

        try {
            const salt = randomBytes(32);
            const nonce = randomBytes(12);

            plaintext = new TextEncoder().encode(JSON.stringify(identityData));
            ciphertext = await EncryptedUserIdentity.encryptIdentityPayloadInWorker(
                recoveryPassword,
                plaintext,
                salt,
                nonce
            );

            const recoveryIdentity = {
                peer_id: this.id,
                salt: Buffer.from(salt),
                nonce: Buffer.from(nonce),
                encrypted_data: Buffer.from(ciphertext),
            };

            database.createEncryptedUserIdentityForMode(mode, 'recovery', recoveryIdentity);
        } finally {
            if (plaintext) plaintext.fill(0);
            if (ciphertext) ciphertext.fill(0);
        }
    }

    static generateRecoveryPhrase(): string {
        return generateMnemonic(wordlist, 256);
    }

    static derivePasswordFromPhrase(mnemonic: string, mode: NetworkMode): Uint8Array {
        const seed = mnemonicToSeedSync(mnemonic);
        const derived = hkdfSync(
            'sha256',
            seed,
            Buffer.from('kiyeovo-recovery-salt', 'utf8'),
            Buffer.from(`kiyeovo-recovery:${mode}`, 'utf8'),
            32
        );
        return new Uint8Array(Buffer.from(derived));
    }

    static validateRecoveryPhrase(mnemonic: string): boolean {
        return validateMnemonic(mnemonic, wordlist);
    }

    static async loadWithRecoveryPhrase(
        mode: NetworkMode,
        peerId: string,
        mnemonic: string,
        database: ChatDatabase
    ): Promise<EncryptedUserIdentity> {
        if (!EncryptedUserIdentity.validateRecoveryPhrase(mnemonic)) {
            throw new Error('Invalid recovery phrase');
        }

        const password = EncryptedUserIdentity.derivePasswordFromPhrase(mnemonic, mode);
        
        try {
            const recoveryData = database.getEncryptedUserIdentityForMode(mode, 'recovery');
            if (!recoveryData) {
                throw new Error('No recovery data found for this identity');
            }
            if (recoveryData.peer_id !== peerId) {
                throw new Error('Recovery data does not match requested identity');
            }

            const key = scrypt(password, recoveryData.salt, EncryptedUserIdentity.SCRYPT_PARAMS);
            const aes = gcm(key, recoveryData.nonce);
            const decryptedBytes = aes.decrypt(recoveryData.encrypted_data);
            const decryptedJson = new TextDecoder().decode(decryptedBytes);
            const parsedData = JSON.parse(decryptedJson);

            if (!EncryptedUserIdentity.isValidIdentityData(parsedData)) {
                throw new Error('Invalid identity data structure');
            }

            return EncryptedUserIdentity.reconstructFromData(parsedData);
        } finally {
            password.fill(0);
        }
    }

    private static getModeScopedKeychainAccount(mode: NetworkMode, identityId: string): string {
        return `${mode}:${identityId}`;
    }

    sign(message: string): Uint8Array {
        try {
            const messageBytes = new TextEncoder().encode(message);
            return ed25519.sign(messageBytes, this.signingPrivateKey);
        } catch (error: unknown) {
            generalErrorHandler(error);
            throw error;
        }
    }

    static verifyKeyExchangeSignature(
        signature: string,
        expectedFields: object,
        publicKey: string
    ): boolean {
        const messageToVerify = JSON.stringify(expectedFields);
        const signatureBytes = Buffer.from(signature, 'base64');
        return this.verify(messageToVerify, signatureBytes, publicKey);
    }

    private static verify(message: string, signature: Uint8Array, publicKeyBase64: string): boolean {
        try {
            const messageBytes = new TextEncoder().encode(message);
            const publicKey = Buffer.from(publicKeyBase64, 'base64');
            return ed25519.verify(signature, messageBytes, publicKey);
        } catch (error: unknown) {
            generalErrorHandler(error);
            return false;
        }
    }

    getLibp2pPrivateKey(): PrivateKey {
        return this.libp2pPrivateKey;
    }

    static async getPasswordFromKeychain(
        identityId: string,
        prompt: string,
        validateStrength: boolean = false,
        customPasswordPrompt: (prompt: string, isNew: boolean, recoveryPhrase?: string, prefilledPassword?: string, errorMessage?: string, cooldownSeconds?: number, showRecoveryOption?: boolean, keychainAvailable?: boolean) => Promise<PasswordResponse>,
        recoveryPhrase?: string,
        errorMessage?: string,
        cooldownSeconds?: number,
        showRecoveryOption?: boolean,
        keytarInstance: any = null
    ): Promise<PasswordResponse> {
        if (!keytarInstance) {
            keytarInstance = await loadKeytar();
        }
        const keychainAvailable = keytarInstance !== null;
        let prefilledPassword: string | undefined = undefined;

        if (keytarInstance) {
            try {
                const storedPassword = await keytarInstance.getPassword('kiyeovo', identityId);
                if (storedPassword) {
                    prefilledPassword = storedPassword;
                }
            } catch (error) {
                console.warn('[IDENTITY] Failed to access OS keychain:', errStr(error));
            }
        }

        const response = await customPasswordPrompt(prompt, validateStrength, recoveryPhrase, prefilledPassword, errorMessage, cooldownSeconds, showRecoveryOption, keychainAvailable);

        if (keytarInstance && response.rememberMe && response.password && !response.useRecoveryPhrase && validateStrength) {
            try {
                await keytarInstance.setPassword('kiyeovo', identityId, response.password);
            } catch (error) {
                console.warn('[IDENTITY] Failed to store password in OS keychain:', errStr(error));
            }
        }

        return response;
    }

    private getLibp2pPrivateKeyBase64(): string {
        const keyBytes = privateKeyToProtobuf(this.libp2pPrivateKey);
        return Buffer.from(keyBytes).toString('base64');
    }

    private static reconstructFromData(identityData: DecryptedUserIdentityData): EncryptedUserIdentity {
        const libp2pKeyBytes = Buffer.from(identityData.libp2pPrivateKey, 'base64');
        const libp2pPrivateKey = privateKeyFromProtobuf(libp2pKeyBytes);
        const identity = peerIdFromPrivateKey(libp2pPrivateKey);

        if (identity.toString() !== identityData.id) {
            throw new Error('Peer ID mismatch - corrupted identity data');
        }

        return new EncryptedUserIdentity(
            identityData.id,
            identity,
            libp2pPrivateKey,
            Buffer.from(identityData.signingPrivateKey, 'base64'),
            Buffer.from(identityData.signingPublicKey, 'base64'),
            identityData.offlinePrivateKey,
            identityData.offlinePublicKey,
            identityData.notificationsPublicKey,
            identityData.notificationsPrivateKey
        );
    }

    private static isValidIdentityData(data: any): data is DecryptedUserIdentityData {
        return (
            typeof data === 'object' &&
            data !== null &&
            typeof data.id === 'string' &&
            typeof data.created === 'string' &&
            typeof data.libp2pPrivateKey === 'string' &&
            typeof data.signingPrivateKey === 'string' &&
            typeof data.signingPublicKey === 'string' &&
            typeof data.offlinePrivateKey === 'string' &&
            typeof data.offlinePublicKey === 'string' &&
            typeof data.notificationsPublicKey === 'string' &&
            typeof data.notificationsPrivateKey === 'string'
        );
    }

    static validatePasswordStrength(password: string): PasswordValidationResult {
        if (password.length < 12) {
            return {
                valid: false,
                message: 'Password must be at least 12 characters long'
            };
        }

        const hasLowercase = /[a-z]/.test(password);
        const hasUppercase = /[A-Z]/.test(password);
        const hasDigit = /\d/.test(password);
        const hasSpecial = /[^a-zA-Z0-9]/.test(password);

        const diversity = [hasLowercase, hasUppercase, hasDigit, hasSpecial].filter(Boolean).length;

        if (diversity < 4) {
            return {
                valid: false,
                message: 'Password must contain at least: lowercase, uppercase, numbers, special character'
            };
        }

        return { valid: true };
    }
} 
