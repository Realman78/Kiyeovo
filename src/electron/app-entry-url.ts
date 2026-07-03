import { APP_PROTOCOL_HOST, APP_PROTOCOL_SCHEME } from './constants.js';

export function getPackagedAppEntryUrl(): string {
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`;
}
