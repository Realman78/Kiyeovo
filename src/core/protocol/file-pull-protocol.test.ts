import assert from 'node:assert/strict';
import test from 'node:test';
import { ed25519 } from '@noble/curves/ed25519';
import {
  MAX_FILE_CHUNK_DATA_LENGTH,
  PullChallengeStore,
  createFilePullAuthSignaturePayload,
  createFilePullChallenge,
  evaluateFilePullAuth,
  isFileChunk,
  isFilePullAuth,
  isFilePullInit,
  isFileTransferConfirm,
  type FilePullAuth,
} from './file-pull-protocol.js';

const requesterPrivateKey = new Uint8Array(32).fill(11);
const requesterPublicKey = Buffer.from(ed25519.getPublicKey(requesterPrivateKey)).toString('base64');
const wrongPublicKey = Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(12))).toString('base64');

const SENDER = 'sender_peer';
const REQUESTER = 'requester_peer';
const OFFER = 'offer_1';
const CHALLENGE = 'Y2hhbGxlbmdl';

function verifySignature(signature: string, payload: object, signingKey: string): boolean {
  return ed25519.verify(
    Buffer.from(signature, 'base64'),
    new TextEncoder().encode(JSON.stringify(payload)),
    Buffer.from(signingKey, 'base64'),
  );
}

function signedAuth(overrides: Partial<FilePullAuth> = {}): FilePullAuth {
  const base = {
    type: 'file_pull_auth' as const,
    offerId: OFFER,
    senderPeerId: SENDER,
    requesterPeerId: REQUESTER,
    challenge: CHALLENGE,
    ...overrides,
  };
  const payload = createFilePullAuthSignaturePayload(base);
  const signature = overrides.signature
    ?? Buffer.from(ed25519.sign(new TextEncoder().encode(JSON.stringify(payload)), requesterPrivateKey)).toString('base64');
  return { ...base, signature };
}

function evaluate(auth: FilePullAuth, opts: {
  offerExists?: boolean;
  authorizedSigningKey?: string | undefined;
  remotePeerId?: string;
  consumeChallenge?: (offerId: string, challenge: string) => boolean;
} = {}) {
  return evaluateFilePullAuth({
    auth,
    offerExists: opts.offerExists ?? true,
    authorizedSigningKey: 'authorizedSigningKey' in opts ? opts.authorizedSigningKey : requesterPublicKey,
    localSenderPeerId: SENDER,
    remotePeerId: opts.remotePeerId ?? REQUESTER,
    consumeChallenge: opts.consumeChallenge ?? ((offerId, challenge) => offerId === OFFER && challenge === CHALLENGE),
    verifySignature,
  });
}

test('createFilePullChallenge returns distinct 32-byte base64 values', () => {
  const a = createFilePullChallenge();
  const b = createFilePullChallenge();
  assert.notEqual(a, b);
  assert.equal(Buffer.from(a, 'base64').length, 32);
});

test('accepts a valid app-key-signed pull authorization', () => {
  assert.deepEqual(evaluate(signedAuth()), { ok: true, signingKey: requesterPublicKey });
});

test('rejects when the offer is not in the registry', () => {
  assert.deepEqual(evaluate(signedAuth(), { offerExists: false }), { ok: false, reason: 'unavailable' });
});

test('rejects when the Noise-authenticated dialer is not the named requester', () => {
  assert.deepEqual(
    evaluate(signedAuth(), { remotePeerId: 'someone_else' }),
    { ok: false, reason: 'unauthorized' },
  );
});

test('rejects a requester outside the authorization snapshot', () => {
  assert.deepEqual(
    evaluate(signedAuth(), { authorizedSigningKey: undefined }),
    { ok: false, reason: 'unauthorized' },
  );
});

test('rejects a signature that does not match the snapshotted app key', () => {
  assert.deepEqual(
    evaluate(signedAuth(), { authorizedSigningKey: wrongPublicKey }),
    { ok: false, reason: 'unauthorized' },
  );
});

test('rejects an auth that names a different sender', () => {
  assert.deepEqual(
    evaluate(signedAuth({ senderPeerId: 'not_us' })),
    { ok: false, reason: 'unauthorized' },
  );
});

test('a challenge is one-time and bound to its offer (real store, not a stub)', () => {
  const store = new PullChallengeStore();
  const challenge = store.issue(OFFER);
  const auth = signedAuth({ challenge });

  // First use with the genuine store succeeds and consumes the challenge.
  assert.deepEqual(
    evaluate(auth, { consumeChallenge: (o, c) => store.consume(o, c) }),
    { ok: true, signingKey: requesterPublicKey },
  );
  // Replay of the identical, validly-signed auth now fails — the challenge is gone.
  assert.deepEqual(
    evaluate(auth, { consumeChallenge: (o, c) => store.consume(o, c) }),
    { ok: false, reason: 'unauthorized' },
  );
});

test('a bad signature does not burn an outstanding challenge', () => {
  const store = new PullChallengeStore();
  const challenge = store.issue(OFFER);
  // Wrong key ⇒ signature fails before consume runs.
  evaluate(signedAuth({ challenge }), {
    authorizedSigningKey: wrongPublicKey,
    consumeChallenge: (o, c) => store.consume(o, c),
  });
  // The challenge survives for the legitimate request.
  assert.equal(store.consume(OFFER, challenge), true);
});

test('a challenge issued for one offer cannot authorize another', () => {
  const store = new PullChallengeStore();
  const challenge = store.issue('other_offer');
  assert.deepEqual(
    evaluate(signedAuth({ challenge }), { consumeChallenge: (o, c) => store.consume(o, c) }),
    { ok: false, reason: 'unauthorized' },
  );
});

test('discard removes only one stream\'s challenge; concurrent same-offer streams survive', () => {
  const store = new PullChallengeStore();
  const streamA = store.issue(OFFER);
  const streamB = store.issue(OFFER);

  // Stream A times out and discards its own challenge.
  store.discard(OFFER, streamA);
  assert.equal(store.consume(OFFER, streamA), false); // A is gone
  assert.equal(store.consume(OFFER, streamB), true);  // B still pullable

  // dropOffer, by contrast, would invalidate every concurrent stream for the offer.
  const streamC = store.issue(OFFER);
  const streamD = store.issue(OFFER);
  store.dropOffer(OFFER);
  assert.equal(store.consume(OFFER, streamC), false);
  assert.equal(store.consume(OFFER, streamD), false);
});

test('strict frame guards reject malformed and oversized frames', () => {
  assert.equal(isFilePullInit({ type: 'file_pull_init', offerId: OFFER }), true);
  assert.equal(isFilePullInit({ type: 'file_pull_init', offerId: '../bad' }), false);
  assert.equal(isFilePullInit({ type: 'file_pull_init' }), false);

  assert.equal(isFilePullAuth(signedAuth()), true);
  assert.equal(isFilePullAuth({ ...signedAuth(), signature: '' }), false);
  assert.equal(isFilePullAuth({ ...signedAuth(), requesterPeerId: 123 }), false);

  const chunk = { type: 'file_chunk', offerId: OFFER, index: 0, data: 'x', hash: 'h' };
  assert.equal(isFileChunk(chunk), true);
  assert.equal(isFileChunk({ ...chunk, index: -1 }), false);
  assert.equal(isFileChunk({ ...chunk, data: 'a'.repeat(MAX_FILE_CHUNK_DATA_LENGTH + 1) }), false);
});

test('confirm guard enforces the success/reason invariant', () => {
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: OFFER, success: true }), true);
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: OFFER, success: false, reason: 'integrity' }), true);
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: OFFER, success: false, reason: 'disk' }), true);
  // success must NOT carry a reason…
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: OFFER, success: true, reason: 'integrity' }), false);
  // …and failure MUST carry a valid one.
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: OFFER, success: false }), false);
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: OFFER, success: false, reason: 'nope' }), false);
  assert.equal(isFileTransferConfirm({ type: 'file_transfer_confirm', offerId: '../bad', success: true }), false);
});
