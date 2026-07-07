import type { OfflineMessage } from '../types.js';

/**
 * Whether an offline message satisfies the field-consistency invariants the DHT
 * store validator enforces on every PUT (offline-message-validator.ts's
 * validateSingleMessage): the envelope's message_type/timestamp/expires_at must
 * agree with the signed payload, and message_type must be a known variant.
 *
 * These are the cheap structural checks only — NOT signature or content-hash
 * re-verification, which isn't the relevant failure mode for a bucket the
 * sender itself signed. A message failing any of these is rejected by the
 * bootstrap; and because the validator rejects the WHOLE bucket on the first
 * bad message, one such entry wedges every future write to that bucket. Older
 * client builds can produce such entries (e.g. before message_type was added
 * to the signed payload in commit 4dbf77c), so the write path prunes them
 * rather than let one stale message block delivery of everything else.
 */
export function isStructurallyStorableOfflineMessage(msg: OfflineMessage): boolean {
  const sp = msg.signed_payload;
  if (!sp || !msg.signature) return false;
  if (msg.message_type !== 'encrypted' && msg.message_type !== 'hybrid') return false;
  if (sp.message_type !== msg.message_type) return false;
  if (msg.timestamp !== sp.timestamp) return false;
  if (msg.expires_at !== sp.expires_at) return false;
  return true;
}
