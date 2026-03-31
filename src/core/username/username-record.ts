import { ed25519 } from '@noble/curves/ed25519';
import type { UserRegistration } from '../types.js';

type UsernameRecordKind = 'active' | 'released';

type UsernameRecordPayload = {
  peerID: string;
  username: string;
  signingPublicKey: string;
  offlinePublicKey: string;
  timestamp: number;
  kind?: UsernameRecordKind;
};

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
    && kindValid;
}

export function canonicalUsernameRegistrationPayload(
  registration: Omit<UserRegistration, 'signature'>,
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
  registration: Omit<UserRegistration, 'signature'>,
): string {
  return JSON.stringify(canonicalUsernameRegistrationPayload(registration));
}

export function signUsernameRegistrationPayload(
  registration: Omit<UserRegistration, 'signature'>,
  sign: (payloadJson: string) => Uint8Array,
): string {
  const signature = sign(canonicalUsernameRegistrationPayloadJson(registration));
  return Buffer.from(signature).toString('base64');
}

export function verifyUsernameRegistrationSignature(registration: UserRegistration): boolean {
  try {
    const payloadJson = canonicalUsernameRegistrationPayloadJson(registration);
    const payloadBytes = new TextEncoder().encode(payloadJson);
    const signatureBytes = Buffer.from(registration.signature, 'base64');
    const publicKeyBytes = Buffer.from(registration.signingPublicKey, 'base64');
    return ed25519.verify(signatureBytes, payloadBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
