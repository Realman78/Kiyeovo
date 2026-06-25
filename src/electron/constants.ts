export const APP_PROTOCOL_SCHEME = 'kiyeovo';
export const APP_PROTOCOL_HOST = 'app';
export const MEDIA_PROTOCOL_SCHEME = 'kiyeovo-media';
export const MEDIA_PROTOCOL_HOST = 'media';
export const DEV_SERVER_URL = 'http://localhost:3000/';

export const ALLOWED_EXTERNAL_URLS = new Set([
  'https://github.com/Realman78/Kiyeovo',
  'https://github.com/Realman78/Kiyeovo/issues',
]);

export const ALLOWED_RENDERER_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'speaker-selection',
  'clipboard-sanitized-write',
]);
