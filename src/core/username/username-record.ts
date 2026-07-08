import { ed25519 } from '@noble/curves/ed25519';
import { peerIdFromString } from '@libp2p/peer-id';
import type { UserRegistration } from '../types.js';
import { isNetworkMode, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_REGEX } from '../constants.js';

type UsernameRecordKind = 'active' | 'released';
type UsernameRegistrationSignedFields = Omit<UserRegistration, 'signature' | 'peerBinding'>;

type UsernameRecordPayload = {
  peerID: string;
  networkMode: UserRegistration['networkMode'];
  username: string;
  signingPublicKey: string;
  offlinePublicKey: string;
  timestamp: number;
  kind?: UsernameRecordKind;
  multiaddrs?: string[];
};

const TEXT_ENCODER = new TextEncoder();
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const PEER_BINDING_DOMAIN = 'kiyeovo-username-peer-binding:v1:';
const PEER_BINDING_DOMAIN_BYTES = TEXT_ENCODER.encode(PEER_BINDING_DOMAIN);

function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64_RE.test(value)) return null;
  return Buffer.from(value, 'base64');
}

export function isUsernameRegistrationRecord(value: unknown): value is UserRegistration {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;

  const kind = candidate.kind;
  const kindValid = kind == null || kind === 'active' || kind === 'released';
  const username = candidate.username;

  const multiaddrs = candidate.multiaddrs;
  const multiaddrsValid = multiaddrs === undefined
    || (Array.isArray(multiaddrs) && multiaddrs.every((m) => typeof m === 'string' && m.length > 0));

  return multiaddrsValid
    && typeof candidate.peerID === 'string'
    && candidate.peerID.length > 0
    && isNetworkMode(candidate.networkMode)
    && typeof username === 'string'
    && username.length >= USERNAME_MIN_LENGTH
    && username.length <= USERNAME_MAX_LENGTH
    && USERNAME_REGEX.test(username)
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
    networkMode: registration.networkMode,
    username: registration.username,
    signingPublicKey: registration.signingPublicKey,
    offlinePublicKey: registration.offlinePublicKey,
    timestamp: registration.timestamp,
  };
  if (registration.kind != null) {
    payload.kind = registration.kind;
  }
  // Sort so the signed bytes are independent of getMultiaddrs() ordering, and
  // omit entirely when empty so records without addresses canonicalize exactly
  // as they did before this field existed (old signatures/records stay valid).
  if (registration.multiaddrs != null && registration.multiaddrs.length > 0) {
    payload.multiaddrs = [...registration.multiaddrs].sort();
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

function peerBindingPayloadBytes(registration: UsernameRegistrationSignedFields): Uint8Array {
  const canonicalBytes = canonicalUsernameRegistrationPayloadBytes(registration);
  const payloadBytes = new Uint8Array(PEER_BINDING_DOMAIN_BYTES.length + canonicalBytes.length);
  payloadBytes.set(PEER_BINDING_DOMAIN_BYTES);
  payloadBytes.set(canonicalBytes, PEER_BINDING_DOMAIN_BYTES.length);
  return payloadBytes;
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
  const signature = await sign(peerBindingPayloadBytes(registration));
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
      peerBindingPayloadBytes(registration),
      publicKeyBytes,
    );
  } catch {
    return false;
  }
}
