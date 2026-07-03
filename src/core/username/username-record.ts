import { ed25519 } from '@noble/curves/ed25519';
import { peerIdFromString } from '@libp2p/peer-id';
import type { UserRegistration } from '../types.js';

type UsernameRecordKind = 'active' | 'released';
type UsernameRegistrationSignedFields = Omit<UserRegistration, 'signature' | 'peerBinding'>;

type UsernameRecordPayload = {
  peerID: string;
  username: string;
  signingPublicKey: string;
  offlinePublicKey: string;
  timestamp: number;
  kind?: UsernameRecordKind;
};

const TEXT_ENCODER = new TextEncoder();
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64_RE.test(value)) return null;
  return Buffer.from(value, 'base64');
}

export function isUsernameRegistrationRecord(value: unknown): value is UserRegistration {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  const kind = candidate.kind;
  const kindValid = kind == null || kind === 'active' || kind === 'released';

  return typeof candidate.peerID === 'string'
    && candidate.peerID.length > 0
    && typeof candidate.username === 'string'
    && candidate.username.length >= 3
    && typeof candidate.signingPublicKey === 'string'
    && typeof candidate.offlinePublicKey === 'string'
    && typeof candidate.timestamp === 'number'
    && Number.isFinite(candidate.timestamp)
    && candidate.timestamp > 0
    && typeof candidate.signature === 'string'
    && candidate.signature.length > 0
    && typeof candidate.peerBinding === 'string'
    && candidate.peerBinding.length > 0
    && kindValid;
}

export function canonicalUsernameRegistrationPayload(
  registration: UsernameRegistrationSignedFields,
): UsernameRecordPayload {
  const payload: UsernameRecordPayload = {
    peerID: registration.peerID,
    username: registration.username,
    signingPublicKey: registration.signingPublicKey,
    offlinePublicKey: registration.offlinePublicKey,
    timestamp: registration.timestamp,
  };
  if (registration.kind != null) {
    payload.kind = registration.kind;
  }
  return payload;
}

export function canonicalUsernameRegistrationPayloadJson(
  registration: UsernameRegistrationSignedFields,
): string {
  return JSON.stringify(canonicalUsernameRegistrationPayload(registration));
}

function canonicalUsernameRegistrationPayloadBytes(
  registration: UsernameRegistrationSignedFields,
): Uint8Array {
  return TEXT_ENCODER.encode(canonicalUsernameRegistrationPayloadJson(registration));
}

export function signUsernameRegistrationPayload(
  registration: UsernameRegistrationSignedFields,
  sign: (payloadJson: string) => Uint8Array,
): string {
  const signature = sign(canonicalUsernameRegistrationPayloadJson(registration));
  return Buffer.from(signature).toString('base64');
}

export async function signUsernameRegistrationPeerBinding(
  registration: UsernameRegistrationSignedFields,
  sign: (payloadBytes: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<string> {
  const signature = await sign(canonicalUsernameRegistrationPayloadBytes(registration));
  return Buffer.from(signature).toString('base64');
}

export function verifyUsernameRegistrationSignature(registration: UserRegistration): boolean {
  try {
    const payloadBytes = canonicalUsernameRegistrationPayloadBytes(registration);
    const signatureBytes = Buffer.from(registration.signature, 'base64');
    const publicKeyBytes = Buffer.from(registration.signingPublicKey, 'base64');
    return ed25519.verify(signatureBytes, payloadBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

export function verifyUsernameRegistrationPeerBinding(registration: UserRegistration): boolean {
  try {
    const peerId = peerIdFromString(registration.peerID);
    if (peerId.publicKey?.type !== 'Ed25519') return false;

    const signatureBytes = decodeBase64(registration.peerBinding);
    if (!signatureBytes || signatureBytes.length !== 64) return false;

    const publicKeyBytes = peerId.publicKey.raw;
    if (publicKeyBytes.length !== 32) return false;

    return ed25519.verify(
      signatureBytes,
      canonicalUsernameRegistrationPayloadBytes(registration),
      publicKeyBytes,
    );
  } catch {
    return false;
  }
}
