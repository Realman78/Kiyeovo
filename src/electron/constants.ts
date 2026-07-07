import { PREDEFINED_NODES_README_URL } from '../core/predefined-nodes.js';

export const APP_PROTOCOL_SCHEME = 'kiyeovo';
export const APP_PROTOCOL_HOST = 'app';
export const MEDIA_PROTOCOL_SCHEME = 'kiyeovo-media';
export const MEDIA_PROTOCOL_HOST = 'media';
export const DEV_SERVER_URL = 'http://localhost:3000/';

export const ALLOWED_EXTERNAL_URLS = new Set([
  'https://github.com/Realman78/Kiyeovo',
  'https://github.com/Realman78/Kiyeovo/issues',
  // Predefined-nodes README (offering + sunset). The value lives in one place
  // (core/predefined-nodes.ts); it MUST be the canonical https form (lowercase
  // host, no trailing slash) so it equals normalizeExternalUrl() of itself.
  PREDEFINED_NODES_README_URL,
]);

export const ALLOWED_RENDERER_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'speaker-selection',
  'clipboard-sanitized-write',
]);
