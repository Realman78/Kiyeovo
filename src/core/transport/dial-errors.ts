import { errStr } from '../utils/general-error.js';

export const STALE_DIAL_ERROR_PATTERN = 'muxer closed|stream reset|the stream has been reset';

const STALE_DIAL_ERROR_REGEX = new RegExp(STALE_DIAL_ERROR_PATTERN, 'i');

export function isStaleDialError(error: unknown): boolean {
  return STALE_DIAL_ERROR_REGEX.test(errStr(error));
}
