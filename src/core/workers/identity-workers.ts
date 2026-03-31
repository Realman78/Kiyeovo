import { parentPort } from 'worker_threads';
import { scrypt } from '@noble/hashes/scrypt.js';
import { gcm } from '@noble/ciphers/aes.js';
import { errStr } from '../utils/general-error.js';

interface ScryptParams {
  N: number
  r: number
  p: number
  dkLen: number
}

interface IdentityDecryptWorkerRequest {
  operation: 'decrypt'
  password: Uint8Array
  salt: Uint8Array
  nonce: Uint8Array
  encryptedData: Uint8Array
  scryptParams: ScryptParams
}

interface IdentityEncryptWorkerRequest {
  operation: 'encrypt'
  password: Uint8Array
  salt: Uint8Array
  nonce: Uint8Array
  plaintextData: Uint8Array
  scryptParams: ScryptParams
}

type IdentityCryptoWorkerRequest = IdentityDecryptWorkerRequest | IdentityEncryptWorkerRequest

if (!parentPort) {
  throw new Error('Identity decrypt worker must be run as a worker thread');
}

parentPort.on('message', (request: IdentityCryptoWorkerRequest) => {
  let passwordBytes: Uint8Array | null = null;
  let key: Uint8Array | null = null;
  let decrypted: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  let encrypted: Uint8Array | null = null;

  try {
    passwordBytes = new Uint8Array(request.password);
    key = scrypt(passwordBytes, request.salt, request.scryptParams);

    if (request.operation === 'decrypt') {
      const aes = gcm(key, request.nonce);
      decrypted = aes.decrypt(request.encryptedData);
      parentPort?.postMessage({
        ok: true,
        decrypted: Buffer.from(decrypted),
      });
    } else {
      plaintext = request.plaintextData;
      const aes = gcm(key, request.nonce);
      encrypted = aes.encrypt(plaintext);
      parentPort?.postMessage({
        ok: true,
        encrypted: Buffer.from(encrypted),
      });
    }
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: errStr(error, 'Failed to decrypt identity'),
    });
  } finally {
    if (passwordBytes) passwordBytes.fill(0);
    if (key) key.fill(0);
    if (decrypted) decrypted.fill(0);
    if (plaintext) plaintext.fill(0);
    if (encrypted) encrypted.fill(0);
  }
});
