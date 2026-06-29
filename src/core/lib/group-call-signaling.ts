import { NETWORK_MODES } from '../constants.js';
import type { ChatDatabase } from '../db/database.js';
import { EncryptedUserIdentity } from '../identity/encrypted-user-identity.js';
import type {
  AdmissionToken,
  GroupCallControlSignalMessage,
  GroupCallControlSignalWithoutSignature,
  GroupCallHint,
  GroupCallHintWithoutSignature,
  GroupCallPairSignalMessage,
  GroupCallPairSignalWithoutSignature,
  GroupCallParticipant,
} from '../types.js';

export const GROUP_CALL_SIGNAL_MAX_AGE_MS = 5 * 60 * 1000;
export const GROUP_CALL_SIGNAL_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;
export const GROUP_CALL_SIGNAL_DEDUPE_TTL_MS = 10 * 60 * 1000;
export const GROUP_CALL_SIGNAL_DEDUPE_MAX_ENTRIES = 1500;
export const GROUP_CALL_CONTROL_STALE_TOLERANCE_MS = 2000;

export type GroupCallHintSystemPayload = {
  type: 'GROUP_CALL_HINT';
  groupId: string;
};

type SignedGroupCallSignal = GroupCallControlSignalMessage | GroupCallPairSignalMessage | GroupCallHint;
type UnsignedGroupCallSignal =
  | GroupCallControlSignalWithoutSignature
  | GroupCallPairSignalWithoutSignature
  | GroupCallHintWithoutSignature;
type UnsignedAdmissionToken = Omit<AdmissionToken, 'signature'>;

type SignalAllowedAssertion = (signal: SignedGroupCallSignal) => void;

export type GroupCallSignalVerificationContext = {
  localPeerId: string;
  getSigningPublicKey: (peerId: string) => string | null | undefined;
  // Always wire this up at the orchestrator level; it is optional here so
  // low-level fixtures can use the verifier without stubbing policy checks.
  assertSignalAllowed?: SignalAllowedAssertion;
  now?: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isBase64String(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveTimestamp(value: unknown): value is number {
  return Number.isFinite(value) && Number(value) > 0;
}

function isGroupCallParticipant(value: unknown): value is GroupCallParticipant {
  return isObject(value)
    && typeof value.peerId === 'string'
    && value.peerId.length > 0
    && Number.isFinite(value.joinedAt)
    && Number(value.joinedAt) >= 0;
}

function isAdmissionToken(value: unknown): value is AdmissionToken {
  return isObject(value)
    && typeof value.callId === 'string'
    && value.callId.length > 0
    && typeof value.admittedPeerId === 'string'
    && value.admittedPeerId.length > 0
    && Number.isFinite(value.issuedAt)
    && Number(value.issuedAt) > 0
    && typeof value.issuerPeerId === 'string'
    && value.issuerPeerId.length > 0
    && isBase64String(value.signature);
}

function hasLiveSignalEnvelope(value: Record<string, unknown>): boolean {
  return typeof value.groupId === 'string'
    && value.groupId.length > 0
    && typeof value.fromPeerId === 'string'
    && value.fromPeerId.length > 0
    && typeof value.toPeerId === 'string'
    && value.toPeerId.length > 0
    && isPositiveTimestamp(value.timestamp)
    && isBase64String(value.signature);
}

function hasCallEnvelope(value: Record<string, unknown>): boolean {
  return hasLiveSignalEnvelope(value)
    && typeof value.callId === 'string'
    && value.callId.length > 0;
}

export function isGroupCallHint(value: unknown): value is GroupCallHint {
  if (!isObject(value) || value.type !== 'GROUP_CALL_HINT') {
    return false;
  }

  return typeof value.groupId === 'string'
    && value.groupId.length > 0
    && typeof value.fromPeerId === 'string'
    && value.fromPeerId.length > 0
    && typeof value.toPeerId === 'string'
    && value.toPeerId.length > 0
    && isPositiveTimestamp(value.timestamp)
    && isBase64String(value.signature);
}

export function isGroupCallHintSystemPayload(value: unknown): value is GroupCallHintSystemPayload {
  return isObject(value)
    && value.type === 'GROUP_CALL_HINT'
    && typeof value.groupId === 'string'
    && value.groupId.length > 0;
}

export function isGroupCallControlSignalMessage(value: unknown): value is GroupCallControlSignalMessage {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'CALL_GROUP_STARTED':
    case 'CALL_GROUP_JOIN_REQUEST':
    case 'CALL_GROUP_LEAVE':
    case 'CALL_GROUP_ENDED':
      return hasCallEnvelope(value);
    case 'GROUP_CALL_QUERY':
      return hasLiveSignalEnvelope(value)
        && typeof value.requestId === 'string'
        && value.requestId.length > 0;
    case 'GROUP_CALL_QUERY_RESPONSE':
      if (
        !hasLiveSignalEnvelope(value)
        || typeof value.requestId !== 'string'
        || value.requestId.length === 0
        || typeof value.active !== 'boolean'
      ) {
        return false;
      }
      return value.active
        ? typeof value.callId === 'string'
          && value.callId.length > 0
          && Number.isInteger(value.rosterVersion)
          && Number(value.rosterVersion) >= 0
          && typeof value.writerPeerId === 'string'
          && value.writerPeerId.length > 0
          && Array.isArray(value.participants)
          && value.participants.every(isGroupCallParticipant)
        : true;
    case 'CALL_GROUP_JOIN_RESPONSE':
      if (!hasCallEnvelope(value) || typeof value.accepted !== 'boolean') {
        return false;
      }
      if (value.accepted) {
        return Number.isInteger(value.rosterVersion)
          && Number(value.rosterVersion) >= 0
          && typeof value.writerPeerId === 'string'
          && value.writerPeerId.length > 0
          && Array.isArray(value.participants)
          && value.participants.every(isGroupCallParticipant)
          && isAdmissionToken(value.admissionToken);
      }
      return value.reason === 'full'
        || value.reason === 'not_a_member'
        || value.reason === 'call_not_active'
        || value.reason === 'busy';
    case 'CALL_GROUP_ROSTER':
      return hasCallEnvelope(value)
        && Number.isInteger(value.rosterVersion)
        && Number(value.rosterVersion) >= 0
        && typeof value.writerPeerId === 'string'
        && value.writerPeerId.length > 0
        && Array.isArray(value.participants)
        && value.participants.every(isGroupCallParticipant);
    case 'CALL_GROUP_MUTE_STATE':
      return hasCallEnvelope(value) && typeof value.muted === 'boolean';
    default:
      return false;
  }
}

export function isGroupCallPairSignalMessage(value: unknown): value is GroupCallPairSignalMessage {
  if (!isObject(value) || typeof value.type !== 'string' || !hasCallEnvelope(value)) {
    return false;
  }

  switch (value.type) {
    case 'CALL_OFFER':
      return typeof value.offerSdp === 'string'
        && value.offerSdp.length > 0
        && value.mediaType === 'audio'
        && (value.admissionToken === undefined || isAdmissionToken(value.admissionToken));
    case 'CALL_ANSWER':
      return typeof value.answerSdp === 'string' && value.answerSdp.length > 0;
    case 'CALL_ICE':
      return typeof value.candidate === 'string'
        && (value.sdpMid === null || typeof value.sdpMid === 'string')
        && (value.sdpMLineIndex === null || Number.isInteger(value.sdpMLineIndex))
        && (value.usernameFragment === null || typeof value.usernameFragment === 'string');
    case 'CALL_CAMERA_STATE':
      return typeof value.cameraOn === 'boolean';
    default:
      return false;
  }
}

export function toUnsignedGroupCallSignalPayload(signal: UnsignedGroupCallSignal): Record<string, unknown> {
  if (signal.type === 'GROUP_CALL_HINT') {
    return {
      type: signal.type,
      groupId: signal.groupId,
      fromPeerId: signal.fromPeerId,
      toPeerId: signal.toPeerId,
      timestamp: signal.timestamp,
    };
  }

  if (signal.type === 'GROUP_CALL_QUERY') {
    return {
      type: signal.type,
      groupId: signal.groupId,
      requestId: signal.requestId,
      fromPeerId: signal.fromPeerId,
      toPeerId: signal.toPeerId,
      timestamp: signal.timestamp,
    };
  }

  switch (signal.type) {
    case 'CALL_GROUP_STARTED':
    case 'CALL_GROUP_JOIN_REQUEST':
    case 'CALL_GROUP_LEAVE':
    case 'CALL_GROUP_ENDED':
      return {
        type: signal.type,
        groupId: signal.groupId,
        callId: signal.callId,
        fromPeerId: signal.fromPeerId,
        toPeerId: signal.toPeerId,
        timestamp: signal.timestamp,
      };
    case 'GROUP_CALL_QUERY_RESPONSE':
      return signal.active
        ? {
          type: signal.type,
          groupId: signal.groupId,
          callId: signal.callId,
          requestId: signal.requestId,
          active: true,
          rosterVersion: signal.rosterVersion,
          writerPeerId: signal.writerPeerId,
          participants: signal.participants,
          fromPeerId: signal.fromPeerId,
          toPeerId: signal.toPeerId,
          timestamp: signal.timestamp,
        }
        : {
          type: signal.type,
          groupId: signal.groupId,
          requestId: signal.requestId,
          active: false,
          fromPeerId: signal.fromPeerId,
          toPeerId: signal.toPeerId,
          timestamp: signal.timestamp,
        };
    case 'CALL_GROUP_JOIN_RESPONSE':
      return signal.accepted
        ? {
          type: signal.type,
          groupId: signal.groupId,
          callId: signal.callId,
          accepted: true,
          rosterVersion: signal.rosterVersion,
          writerPeerId: signal.writerPeerId,
          participants: signal.participants,
          admissionToken: signal.admissionToken,
          fromPeerId: signal.fromPeerId,
          toPeerId: signal.toPeerId,
          timestamp: signal.timestamp,
        }
        : {
          type: signal.type,
          groupId: signal.groupId,
          callId: signal.callId,
          accepted: false,
          reason: signal.reason,
          fromPeerId: signal.fromPeerId,
          toPeerId: signal.toPeerId,
          timestamp: signal.timestamp,
        };
    case 'CALL_GROUP_ROSTER':
      return {
        type: signal.type,
        groupId: signal.groupId,
        callId: signal.callId,
        rosterVersion: signal.rosterVersion,
        writerPeerId: signal.writerPeerId,
        participants: signal.participants,
        fromPeerId: signal.fromPeerId,
        toPeerId: signal.toPeerId,
        timestamp: signal.timestamp,
      };
    case 'CALL_GROUP_MUTE_STATE':
      return {
        type: signal.type,
        groupId: signal.groupId,
        callId: signal.callId,
        muted: signal.muted,
        fromPeerId: signal.fromPeerId,
        toPeerId: signal.toPeerId,
        timestamp: signal.timestamp,
      };
    case 'CALL_OFFER':
      return signal.admissionToken
        ? {
          type: signal.type,
          groupId: signal.groupId,
          callId: signal.callId,
          offerSdp: signal.offerSdp,
          mediaType: signal.mediaType,
          admissionToken: signal.admissionToken,
          fromPeerId: signal.fromPeerId,
          toPeerId: signal.toPeerId,
          timestamp: signal.timestamp,
        }
        : {
          type: signal.type,
          groupId: signal.groupId,
          callId: signal.callId,
          offerSdp: signal.offerSdp,
          mediaType: signal.mediaType,
          fromPeerId: signal.fromPeerId,
          toPeerId: signal.toPeerId,
          timestamp: signal.timestamp,
        };
    case 'CALL_ANSWER':
      return {
        type: signal.type,
        groupId: signal.groupId,
        callId: signal.callId,
        answerSdp: signal.answerSdp,
        fromPeerId: signal.fromPeerId,
        toPeerId: signal.toPeerId,
        timestamp: signal.timestamp,
      };
    case 'CALL_ICE':
      return {
        type: signal.type,
        groupId: signal.groupId,
        callId: signal.callId,
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
        usernameFragment: signal.usernameFragment,
        fromPeerId: signal.fromPeerId,
        toPeerId: signal.toPeerId,
        timestamp: signal.timestamp,
      };
    case 'CALL_CAMERA_STATE':
      return {
        type: signal.type,
        groupId: signal.groupId,
        callId: signal.callId,
        cameraOn: signal.cameraOn,
        fromPeerId: signal.fromPeerId,
        toPeerId: signal.toPeerId,
        timestamp: signal.timestamp,
      };
  }
}

function toUnsignedAdmissionTokenPayload(token: UnsignedAdmissionToken): Record<string, unknown> {
  return {
    callId: token.callId,
    admittedPeerId: token.admittedPeerId,
    issuedAt: token.issuedAt,
    issuerPeerId: token.issuerPeerId,
  };
}

export function buildSignedGroupCallSignal<T extends UnsignedGroupCallSignal>(
  unsignedSignal: T,
  userIdentity: Pick<EncryptedUserIdentity, 'sign'>,
): T & { signature: string } {
  const signatureBytes = userIdentity.sign(JSON.stringify(toUnsignedGroupCallSignalPayload(unsignedSignal)));
  return {
    ...unsignedSignal,
    signature: Buffer.from(signatureBytes).toString('base64'),
  };
}

export function buildSignedAdmissionToken(
  unsignedToken: UnsignedAdmissionToken,
  userIdentity: Pick<EncryptedUserIdentity, 'sign'>,
): AdmissionToken {
  const signatureBytes = userIdentity.sign(JSON.stringify(toUnsignedAdmissionTokenPayload(unsignedToken)));
  return {
    ...unsignedToken,
    signature: Buffer.from(signatureBytes).toString('base64'),
  };
}

export function verifyAdmissionToken(
  token: AdmissionToken,
  getSigningPublicKey: (peerId: string) => string | null | undefined,
): { valid: boolean; error?: string } {
  const signingPublicKey = getSigningPublicKey(token.issuerPeerId);
  if (!signingPublicKey) {
    return { valid: false, error: 'Unknown admission-token issuer' };
  }

  const { signature, ...unsignedToken } = token;
  const signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
    signature,
    toUnsignedAdmissionTokenPayload(unsignedToken),
    signingPublicKey,
  );
  return signatureValid
    ? { valid: true }
    : { valid: false, error: 'Invalid admission token signature' };
}

export function verifyIncomingGroupCallSignal(
  remotePeerId: string,
  signal: SignedGroupCallSignal,
  context: GroupCallSignalVerificationContext,
): { valid: boolean; error?: string } {
  if (signal.fromPeerId !== remotePeerId) {
    return { valid: false, error: 'Sender peer mismatch' };
  }

  if (signal.toPeerId !== context.localPeerId) {
    return { valid: false, error: 'Group call signal target mismatch' };
  }

  const now = context.now ?? Date.now();
  if (signal.timestamp > now + GROUP_CALL_SIGNAL_MAX_FUTURE_SKEW_MS) {
    return { valid: false, error: 'Group call signal is future-dated' };
  }
  if (now - signal.timestamp > GROUP_CALL_SIGNAL_MAX_AGE_MS) {
    return { valid: false, error: 'Group call signal is too old' };
  }

  try {
    context.assertSignalAllowed?.(signal);
  } catch (error: unknown) {
    return { valid: false, error: error instanceof Error ? error.message : 'Group call signal not allowed' };
  }

  const signingPublicKey = context.getSigningPublicKey(signal.fromPeerId);
  if (!signingPublicKey) {
    return { valid: false, error: 'Unknown sender for group call signal' };
  }

  const { signature, ...unsignedSignal } = signal;
  const signatureValid = EncryptedUserIdentity.verifyKeyExchangeSignature(
    signature,
    toUnsignedGroupCallSignalPayload(unsignedSignal as UnsignedGroupCallSignal),
    signingPublicKey,
  );
  return signatureValid
    ? { valid: true }
    : { valid: false, error: 'Invalid group call signal signature' };
}

export function assertGroupCallSignalAllowed(
  database: ChatDatabase,
  localPeerId: string,
  signal: Pick<SignedGroupCallSignal, 'groupId' | 'fromPeerId'>,
): void {
  if (database.getSessionNetworkMode() !== NETWORK_MODES.FAST) {
    throw new Error('Group calls require fast mode');
  }

  const chat = database.getChatByGroupId(signal.groupId);
  if (!chat || chat.type !== 'group') {
    throw new Error('Unknown group for group call signal');
  }

  if (chat.group_status !== 'active' && chat.group_status !== 'rekeying') {
    throw new Error('Group is not eligible for call signaling');
  }

  const participantIds = new Set(
    database.getChatParticipants(chat.id).map((participant) => participant.peer_id),
  );
  if (!participantIds.has(localPeerId)) {
    throw new Error('Local user is not a current member of this group');
  }
  if (!participantIds.has(signal.fromPeerId)) {
    throw new Error('Sender is not a current member of this group');
  }
}
