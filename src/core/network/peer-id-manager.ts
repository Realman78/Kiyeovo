import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey, PeerId, Ed25519PrivateKey } from '@libp2p/interface';
import { log } from '../../shared/logger.js';

export interface LoadOrCreateOptions {
  /**
   * Fail-closed identity handling for deployments. When `true`, an existing
   * identity file that cannot be read/decoded aborts (throws) instead of
   * silently generating a new key and overwriting the file — which would
   * rotate the node's Peer ID. A genuinely absent file is still created.
   * Defaults to `false`, preserving the lenient desktop/dev recovery behaviour.
   */
  failClosed?: boolean;
}

export class PeerIdManager {
  static async loadOrCreate(
    filePath: string,
    options: LoadOrCreateOptions = {}
  ): Promise<{ peerId: PeerId; privateKey: PrivateKey }> {
    const failClosed = options.failClosed ?? false;

    let privateKey: PrivateKey;
    let peerId: PeerId;
    let loadedExisting = false;

    if (existsSync(filePath)) {
      try {
        const keyBytes = await readFile(filePath);

        privateKey = privateKeyFromProtobuf(keyBytes) as Ed25519PrivateKey;

        peerId = peerIdFromPrivateKey(privateKey);

        loadedExisting = true;
        log(`Loaded peer ID: ${peerId.toString()}`);
      } catch (err: any) {
        if (failClosed) {
          throw new Error(
            `Refusing to start: identity file "${filePath}" exists but could not be ` +
              `read or decoded (${err?.message ?? err}). Not regenerating, to avoid ` +
              `rotating the Peer ID. Fix or deliberately remove the file, then retry.`
          );
        }

        console.warn('Failed to load saved private key, generating a new peer ID:', err);

        privateKey = await generateKeyPair('Ed25519');
        peerId = peerIdFromPrivateKey(privateKey);

        log(`Generated new peer ID: ${peerId.toString()}`);
      }
    } else {
      log(`Creating new private key and saving to ${filePath}`);

      privateKey = await generateKeyPair('Ed25519');
      peerId = peerIdFromPrivateKey(privateKey);

      log(`Generated new peer ID: ${peerId.toString()}`);
    }

    // In fail-closed mode, never rewrite a file we successfully loaded — only
    // persist a freshly generated key (genuine first run). The lenient default
    // keeps the original always-write behaviour.
    if (!failClosed || !loadedExisting) {
      try {
        const keyBytes = privateKeyToProtobuf(privateKey);
        await writeFile(filePath, keyBytes);
        log(`Private key saved to ${filePath}`);
      } catch (err: any) {
        // Fail-closed: a first-run key that cannot be persisted would start with
        // an ephemeral Peer ID and rotate on the next restart (e.g. a missing or
        // unwritable bind mount). Abort instead of running with a key on disk
        // nowhere. The lenient default keeps the original warn-and-continue.
        if (failClosed) {
          throw new Error(
            `Refusing to start: generated a new identity but could not save it to ` +
              `"${filePath}" (${err?.message ?? err}). Refusing to run with an ` +
              `ephemeral Peer ID that would rotate on restart. Fix the path/permissions, then retry.`
          );
        }
        console.warn(`Failed to save private key: ${err.message}`);
      }
    }

    return { peerId, privateKey };
  }
}
