import { writeFile, readFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import type { PrivateKey, PeerId, Ed25519PrivateKey } from '@libp2p/interface';
import { log } from '../../shared/logger.js';
import { errStr } from '../utils/general-error.js';

export class PeerIdManager {
  static async loadOrCreate(filePath: string): Promise<{ peerId: PeerId; privateKey: PrivateKey }> {
    if (existsSync(filePath)) {
      try {
        const keyBytes = await readFile(filePath);
        // Keys written by older versions were created with the default umask
        await chmod(filePath, 0o600);

        const privateKey = privateKeyFromProtobuf(keyBytes) as Ed25519PrivateKey;
        
        const peerId = peerIdFromPrivateKey(privateKey);
        
        log(`Loaded peer ID: ${peerId.toString()}`);
        return { peerId, privateKey };
      } catch (err: unknown) {
        throw new Error(`Failed to load existing private key from ${filePath}: ${errStr(err)}`);
      }
    }

    log(`Creating new private key and saving to ${filePath}`);
    
    const privateKey = await generateKeyPair('Ed25519');
    const peerId = peerIdFromPrivateKey(privateKey);
    
    log(`Generated new peer ID: ${peerId.toString()}`);

    try {
      const keyBytes = privateKeyToProtobuf(privateKey);
      await writeFile(filePath, keyBytes, { mode: 0o600 });
      log(`Private key saved to ${filePath}`);
    } catch (err: unknown) {
      throw new Error(`Failed to save new private key to ${filePath}: ${errStr(err)}`);
    }

    return { peerId, privateKey };
  }
}
