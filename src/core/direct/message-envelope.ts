import { MAX_MESSAGE_CONTENT_LENGTH } from '../constants.js';

export const MESSAGE_ENVELOPE_VERSION = 1;
export const MAX_CID_LENGTH = 64;

export interface MessageEnvelope {
  v: number;
  cid: string;
  text: string;
  reply_to?: string;
}

/** The validated, normalized result of decoding a received envelope. */
export interface DecodedEnvelope {
  cid: string | undefined;
  text: string;
  replyToCid: string | undefined;
}

export function isValidCid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function encodeEnvelope(params: {
  cid: string;
  text: string;
  replyToCid?: string | null | undefined;
}): string {
  if (!isValidCid(params.cid)) {
    throw new Error(`encodeEnvelope: invalid cid ${JSON.stringify(params.cid)}`);
  }
  const envelope: MessageEnvelope = {
    v: MESSAGE_ENVELOPE_VERSION,
    cid: params.cid,
    text: params.text,
  };
  if (isValidCid(params.replyToCid)) {
    envelope.reply_to = params.replyToCid;
  }
  return JSON.stringify(envelope);
}

export function decodeEnvelope(plaintext: string): DecodedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    // Not JSON at all → legacy/plain body.
    return { cid: undefined, text: clampText(plaintext), replyToCid: undefined };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as MessageEnvelope).v !== MESSAGE_ENVELOPE_VERSION ||
    typeof (parsed as MessageEnvelope).text !== 'string'
  ) {
    // JSON, but not our envelope → fall back to the raw string as the body.
    return { cid: undefined, text: clampText(plaintext), replyToCid: undefined };
  }

  const env = parsed as MessageEnvelope;
  return {
    cid: isValidCid(env.cid) ? env.cid : undefined,
    text: clampText(env.text),
    replyToCid: isValidCid(env.reply_to) ? env.reply_to : undefined,
  };
}

function clampText(text: string): string {
  return text.length > MAX_MESSAGE_CONTENT_LENGTH
    ? text.slice(0, MAX_MESSAGE_CONTENT_LENGTH)
    : text;
}
