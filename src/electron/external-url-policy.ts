import { ALLOWED_EXTERNAL_URLS } from './constants.js';

export function normalizeExternalUrl(targetUrl: string): string | null {
  try {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      return null;
    }

    const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    return `${parsedUrl.origin}${normalizedPathname}`;
  } catch {
    return null;
  }
}

export function resolveAllowedExternalUrl(targetUrl: string): string | null {
  const normalizedUrl = normalizeExternalUrl(targetUrl);
  if (!normalizedUrl || !ALLOWED_EXTERNAL_URLS.has(normalizedUrl)) {
    return null;
  }
  return normalizedUrl;
}
