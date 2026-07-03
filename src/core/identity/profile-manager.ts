import { scrypt } from '@noble/hashes/scrypt';
import { randomBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import { ed25519 } from '@noble/curves/ed25519';
import { writeFile, readFile } from 'fs/promises';
import type { UserProfilePlaintext, EncryptedUserProfile } from '../types.js';
import type { EncryptedUserIdentity } from './encrypted-user-identity.js';
import { errStr, generalErrorHandler } from '../utils/general-error.js';
import { toBase64Url } from '../utils/miscellaneous.js';
import { sha256 } from '@noble/hashes/sha2';
import { ChatDatabase } from '../db/database.js';
import { PROFILE_SCRYPT_N } from '../constants.js';
import { log } from '../../shared/logger.js';

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  dkLen: number;
}

export class ProfileManager {
  private static readonly SCRYPT_PARAMS: ScryptParams = {
    N: PROFILE_SCRYPT_N,
    r: 8,
    p: 1,
    dkLen: 32
  };

  private static readonly PROFILE_VERSION = 1; // If I need to change the profile format
  private static readonly EXPIRES_WARNING_DAYS = 14;

  static async exportProfileDesktop(
    userIdentity: EncryptedUserIdentity,
    username: string,
    peerId: string,
    filename: string,
    password: string,
    sharedSecret: string
  ): Promise<{
    success: boolean;
    error?: string;
    filePath?: string;
    fingerprint?: string;
  }> {
    try {
      const defaultInboxKey = sharedSecret;
      const createdAt = Date.now();

      // Create profile data structure
      const profileData: Omit<UserProfilePlaintext, 'signature'> = {
        version: ProfileManager.PROFILE_VERSION,
        username,
        peerId,
        signingPublicKey: Buffer.from(userIdentity.signingPublicKey).toString('base64'),
        // Encode RSA keys as base64 to match DHT format
        offlinePublicKey: Buffer.from(userIdentity.offlinePublicKey, 'utf8').toString('base64'),
        notificationsPublicKey: Buffer.from(userIdentity.notificationsPublicKey, 'utf8').toString('base64'),
        defaultInboxKey,
        createdAt
      };

      // Sign the profile with Ed25519
      const dataToSign = JSON.stringify(profileData);
      const signature = userIdentity.sign(dataToSign);

      const profile: UserProfilePlaintext = {
        ...profileData,
        signature: Buffer.from(signature).toString('base64')
      };

      // Encrypt the profile
      const encryptedProfile = await ProfileManager.encryptProfile(profile, password.trim());

      // Write to file
      await writeFile(filename, JSON.stringify(encryptedProfile, null, 2), 'utf8');

      const fingerprint = ProfileManager.calculateFingerprint(profile);
      const expiresWarningAt = createdAt + (ProfileManager.EXPIRES_WARNING_DAYS * 24 * 60 * 60 * 1000);
      log(`\nProfile expires warning: ${new Date(expiresWarningAt).toLocaleString()}`);

      return {
        success: true,
        filePath: filename,
        fingerprint
      };
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to export profile');
      return {
        success: false,
        error: errStr(error, 'Failed to export profile')
      };
    }
  }

  // Import and verify user profile from encrypted file
  static async importProfile(
    filename: string,
    password: string
  ): Promise<UserProfilePlaintext> {
    try {
      const fileContent = await readFile(filename, 'utf8');
      const encryptedProfile: EncryptedUserProfile = JSON.parse(fileContent);

      const profile = await ProfileManager.decryptProfile(encryptedProfile, password);

      if (!ProfileManager.verifyProfileSignature(profile)) {
        throw new Error('Invalid profile signature - profile may be tampered');
      }

      const age = Date.now() - profile.createdAt;
      const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
      const expiresWarningAt = profile.createdAt + (ProfileManager.EXPIRES_WARNING_DAYS * 24 * 60 * 60 * 1000);

      if (Date.now() > expiresWarningAt) {
        console.warn(`\nWARNING: Profile is ${ageDays} days old (created ${new Date(profile.createdAt).toLocaleString()})`);
        console.warn(`Recommend getting a fresh profile from the sender.`);
      }

      return profile;
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to import profile');
      throw error;
    }
  }

  // Desktop version - accepts password and customName directly
  static async importTrustedUser(
    filename: string,
    password: string,
    myPeerId: string,
    database: ChatDatabase,
    customName?: string
  ): Promise<{
    success: boolean;
    error?: string;
    fingerprint?: string;
    chatId?: number;
    username?: string;
    peerId?: string;
  }> {
    try {
      // Import and decrypt profile
      const profile = await ProfileManager.importProfile(filename, password);

      if (profile.peerId === myPeerId) {
        return {
          success: false,
          error: 'Cannot import your own profile'
        };
      }

      const existingUser = database.getUserByPeerId(profile.peerId);
      if (existingUser) {
        log(`User ${existingUser.username} (${profile.peerId.slice(0, 12)}...) already exists in your contacts`);
        return {
          success: false,
          error: `User ${existingUser.username} already exists in your contacts`
        };
      }

      const localUsername = (customName ?? profile.username).trim();

      if (localUsername.length < 2 || localUsername.length > 64) {
        log('Username must be between 2 and 64 characters');
        return {
          success: false,
          error: 'Username must be between 2 and 64 characters'
        };
      }

      const chatId = await database.createTrustedDirectContact({
        peer_id: profile.peerId,
        username: localUsername,
        signing_public_key: profile.signingPublicKey,
        offline_public_key: profile.offlinePublicKey,
        signature: profile.signature
      }, {
        type: 'direct',
        name: profile.peerId,
        created_by: myPeerId,
        participants: [myPeerId, profile.peerId],
        offline_bucket_secret: profile.defaultInboxKey,
        notifications_bucket_key: toBase64Url(randomBytes(32)),
        offline_last_read_timestamp: 0,
        offline_last_ack_sent: 0,
        trusted_out_of_band: true,
        muted: false,
        key_version: 0,
        status: 'active',
        created_at: new Date()
      });

      const fingerprint = ProfileManager.calculateFingerprint(profile);

      return {
        success: true,
        fingerprint,
        chatId,
        username: localUsername,
        peerId: profile.peerId
      };
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to trust user');
      return {
        success: false,
        error: errStr(error, 'Failed to trust user')
      };
    }
  }

  private static async encryptProfile(
    profile: UserProfilePlaintext,
    password: string
  ): Promise<EncryptedUserProfile> {
    const salt = randomBytes(32);
    const nonce = randomBytes(12);

    const key = scrypt(
      new TextEncoder().encode(password),
      salt,
      ProfileManager.SCRYPT_PARAMS
    );

    const plaintext = new TextEncoder().encode(JSON.stringify(profile));
    const cipher = gcm(key, nonce);
    const ciphertext = cipher.encrypt(plaintext);

    return {
      version: ProfileManager.PROFILE_VERSION,
      salt: Buffer.from(salt).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
      encryptedData: Buffer.from(ciphertext).toString('base64')
    };
  }

  private static async decryptProfile(
    encryptedProfile: EncryptedUserProfile,
    password: string
  ): Promise<UserProfilePlaintext> {
    const salt = Buffer.from(encryptedProfile.salt, 'base64');
    const nonce = Buffer.from(encryptedProfile.nonce, 'base64');
    const ciphertext = Buffer.from(encryptedProfile.encryptedData, 'base64');

    const key = scrypt(
      new TextEncoder().encode(password),
      salt,
      ProfileManager.SCRYPT_PARAMS
    );

    try {
      const cipher = gcm(key, nonce);
      const plaintext = cipher.decrypt(ciphertext);
      const json = new TextDecoder().decode(plaintext);

      return JSON.parse(json);
    } catch (error) {
      throw new Error('Failed to decrypt profile - incorrect password or corrupted file');
    }
  }

  private static verifyProfileSignature(profile: UserProfilePlaintext): boolean {
    try {
      const { signature, ...dataToVerify } = profile;
      const dataBytes = new TextEncoder().encode(JSON.stringify(dataToVerify));
      const signatureBytes = Buffer.from(signature, 'base64');
      const publicKeyBytes = Buffer.from(profile.signingPublicKey, 'base64');

      return ed25519.verify(signatureBytes, dataBytes, publicKeyBytes);
    } catch (error: unknown) {
      generalErrorHandler(error, 'Failed to verify profile signature');
      return false;
    }
  }

  // Calculate profile fingerprint for out-of-band verification
  static calculateFingerprint(profile: UserProfilePlaintext): string {
    const data = `${profile.peerId}${profile.signingPublicKey}${profile.offlinePublicKey}`;
    const hash = Buffer.from(sha256(new TextEncoder().encode(data)));
    
    // Format as hex with spaces every 4 chars for readability
    const hex = hash.toString('hex').toUpperCase();
    return hex.match(/.{1,4}/g)?.join(' ') || hex;
  }
}
