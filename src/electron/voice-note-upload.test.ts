import assert from 'node:assert/strict';
import test from 'node:test';
import { VOICE_NOTE_MAX_DURATION_MS_WIRE } from '../core/constants.js';
import { prepareVoiceNoteUpload } from './voice-note-upload.js';

const audioBytes = new Uint8Array([1, 2, 3, 4]);

test('prepareVoiceNoteUpload accepts well-formed bytes/filename/duration', () => {
  const result = prepareVoiceNoteUpload(audioBytes, 'voice-note-20260101-000000.webm', 12_000, 1024);

  assert.equal(result.success, true);
  assert.equal(result.fileName, 'voice-note-20260101-000000.webm');
  assert.deepEqual(result.bytes, Buffer.from(audioBytes));
  assert.equal(result.durationMs, 12_000);
  assert.equal(result.error, null);
});

test('prepareVoiceNoteUpload rejects missing or empty audio bytes', () => {
  assert.equal(prepareVoiceNoteUpload(undefined, 'note.webm', 1000, 1024).error, 'Voice note audio is required');
  assert.equal(prepareVoiceNoteUpload(new Uint8Array(0), 'note.webm', 1000, 1024).error, 'Voice note audio is required');
  assert.equal(prepareVoiceNoteUpload('not-bytes', 'note.webm', 1000, 1024).error, 'Voice note audio is required');
});

test('prepareVoiceNoteUpload rejects path-like, reserved, malformed, and wrong-extension filenames', () => {
  assert.equal(prepareVoiceNoteUpload(audioBytes, '../note.webm', 1000, 1024).error, 'Voice note filename must not contain a path');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'nested/note.webm', 1000, 1024).error, 'Voice note filename must not contain a path');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'CON.webm', 1000, 1024).error, 'Voice note filename is reserved by the operating system');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'bad:name.webm', 1000, 1024).error, 'Voice note filename contains unsupported characters');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'note.mp3', 1000, 1024).error, 'Voice note filename must end in .webm');
  assert.equal(prepareVoiceNoteUpload(audioBytes, '.webm', 1000, 1024).error, 'Voice note filename is invalid');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'a'.repeat(252) + '.webm', 1000, 1024).error, 'Voice note filename is too long');
});

test('prepareVoiceNoteUpload enforces the caller-resolved byte cap', () => {
  assert.equal(
    prepareVoiceNoteUpload(audioBytes, 'note.webm', 1000, 2).error,
    'Voice note exceeds the configured file-size limit (2 bytes)',
  );
});

test('prepareVoiceNoteUpload rejects non-positive, non-integer, and out-of-range durations', () => {
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'note.webm', 0, 1024).error, 'Invalid voice note duration');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'note.webm', -1000, 1024).error, 'Invalid voice note duration');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'note.webm', 1000.5, 1024).error, 'Invalid voice note duration');
  assert.equal(prepareVoiceNoteUpload(audioBytes, 'note.webm', '1000', 1024).error, 'Invalid voice note duration');
  assert.equal(
    prepareVoiceNoteUpload(audioBytes, 'note.webm', VOICE_NOTE_MAX_DURATION_MS_WIRE + 1, 1024).error,
    'Invalid voice note duration',
  );
  assert.equal(
    prepareVoiceNoteUpload(audioBytes, 'note.webm', VOICE_NOTE_MAX_DURATION_MS_WIRE, 1024).success,
    true,
  );
});
