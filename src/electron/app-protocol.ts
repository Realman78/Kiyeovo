import { protocol } from 'electron';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import {
  APP_PROTOCOL_HOST,
  APP_PROTOCOL_SCHEME,
  MEDIA_PROTOCOL_HOST,
  MEDIA_PROTOCOL_SCHEME,
} from './constants.js';
export { getPackagedAppEntryUrl } from './app-entry-url.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_UI_DIR = path.join(__dirname, '..', '..', 'dist-ui');

let protocolSchemesRegistered = false;
let appProtocolHandlerRegistered = false;
let mediaProtocolHandlerRegistered = false;
const mediaPathByToken = new Map<string, string>();
const mediaTokenByPath = new Map<string, string>();

export function registerProtocolSchemes(): void {
  if (protocolSchemesRegistered) {
    return;
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
      },
    },
    {
      scheme: MEDIA_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);

  protocolSchemesRegistered = true;
}

export function mintMediaToken(canonicalPath: string): string {
  if (!path.isAbsolute(canonicalPath)) {
    throw new Error('Media capability path must be absolute');
  }

  const existingToken = mediaTokenByPath.get(canonicalPath);
  if (existingToken) {
    return existingToken;
  }

  const token = randomUUID();
  mediaPathByToken.set(token, canonicalPath);
  mediaTokenByPath.set(canonicalPath, token);
  return token;
}

function revokeMediaToken(token: string, canonicalPath: string): void {
  mediaPathByToken.delete(token);
  if (mediaTokenByPath.get(canonicalPath) === token) {
    mediaTokenByPath.delete(canonicalPath);
  }
}

function resolveAppAssetPath(requestUrl: URL): string | null {
  if (requestUrl.hostname !== APP_PROTOCOL_HOST) {
    return null;
  }

  const requestedPath = requestUrl.pathname === '/'
    ? 'index.html'
    : requestUrl.pathname.replace(/^\/+/, '');
  const normalizedPath = path.normalize(decodeURIComponent(requestedPath));
  const resolvedPath = path.resolve(DIST_UI_DIR, normalizedPath);
  const distUiRootWithSeparator = DIST_UI_DIR.endsWith(path.sep) ? DIST_UI_DIR : `${DIST_UI_DIR}${path.sep}`;

  if (resolvedPath !== DIST_UI_DIR && !resolvedPath.startsWith(distUiRootWithSeparator)) {
    return null;
  }

  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    return null;
  }

  return resolvedPath;
}

export function registerAppProtocolHandler(): void {
  if (appProtocolHandlerRegistered) {
    return;
  }

  protocol.handle(APP_PROTOCOL_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      const assetPath = resolveAppAssetPath(requestUrl);
      if (!assetPath) {
        return new Response('Not Found', { status: 404 });
      }

      const data = await fs.promises.readFile(assetPath);
      const contentType = mime.lookup(assetPath) || 'application/octet-stream';
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(data.length),
        },
      });
    } catch (error) {
      console.warn('[Electron][SECURITY] Failed to resolve custom protocol request:', error);
      return new Response('Bad Request', { status: 400 });
    }
  });

  appProtocolHandlerRegistered = true;
}

export function registerMediaProtocolHandler(): void {
  if (mediaProtocolHandlerRegistered) {
    return;
  }

  protocol.handle(MEDIA_PROTOCOL_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      const token = requestUrl.pathname.replace(/^\/+/, '');
      if (
        requestUrl.hostname !== MEDIA_PROTOCOL_HOST
        || !token
        || token.includes('/')
      ) {
        return new Response('Not Found', { status: 404 });
      }

      const canonicalPath = mediaPathByToken.get(token);
      if (!canonicalPath) {
        return new Response('Not Found', { status: 404 });
      }

      let currentCanonicalPath: string;
      try {
        currentCanonicalPath = await fs.promises.realpath(canonicalPath);
      } catch {
        revokeMediaToken(token, canonicalPath);
        return new Response('Not Found', { status: 404 });
      }

      if (currentCanonicalPath !== canonicalPath) {
        revokeMediaToken(token, canonicalPath);
        return new Response('Not Found', { status: 404 });
      }

      const fileStats = await fs.promises.stat(currentCanonicalPath);
      if (!fileStats.isFile()) {
        revokeMediaToken(token, canonicalPath);
        return new Response('Not Found', { status: 404 });
      }

      const contentType = mime.lookup(currentCanonicalPath);
      if (!contentType || !contentType.startsWith('image/')) {
        return new Response('Unsupported Media Type', { status: 415 });
      }

      const body = Readable.toWeb(fs.createReadStream(currentCanonicalPath)) as ReadableStream<Uint8Array>;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(fileStats.size),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      console.warn('[Electron][SECURITY] Failed to serve local media:', error);
      return new Response('Bad Request', { status: 400 });
    }
  });

  mediaProtocolHandlerRegistered = true;
}
