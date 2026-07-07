import { ALLOWED_EXTERNAL_URLS } from './constants.js';

export function normalizeExternalUrl(targetUrl: string): string | null {
  try {
    const parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      return null;
    }

    const normalizedPathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    // Preserve the fragment (#anchor) so links to a specific README section
    // (e.g. #servers) survive. Fragments are client-side only, never sent to the
    // server, so this does not widen the allowlist's security surface: an
    // allowlisted URL without a fragment still matches only a target without a
    // fragment, and a fragment'd target must match an allowlisted fragment'd URL.
    return `${parsedUrl.origin}${normalizedPathname}${parsedUrl.hash}`;
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
