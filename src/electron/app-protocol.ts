import { protocol } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import { APP_PROTOCOL_HOST, APP_PROTOCOL_SCHEME } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_UI_DIR = path.join(__dirname, '..', '..', 'dist-ui');

let appProtocolSchemeRegistered = false;
let appProtocolHandlerRegistered = false;

export function getPackagedAppEntryUrl(): string {
  return `${APP_PROTOCOL_SCHEME}://${APP_PROTOCOL_HOST}/index.html`;
}

export function registerAppProtocolScheme(): void {
  if (appProtocolSchemeRegistered) {
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
  ]);

  appProtocolSchemeRegistered = true;
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
