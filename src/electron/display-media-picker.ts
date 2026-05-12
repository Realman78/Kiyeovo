import type { BrowserWindow } from 'electron';
import { desktopCapturer } from 'electron';
import { randomUUID } from 'crypto';
import { IPC_CHANNELS } from '../shared/ipc/channels.js';
import type { ScreenShareSource } from '../shared/kiyeovo-api.js';
import type { IpcMainHandleRegistrar, MainWindowGetter } from './trusted-ipc.js';

type PendingDisplayMediaRequest = {
  resolve: (source: Electron.Video | null) => void;
  sources: Map<string, Electron.Video>;
  timeout: ReturnType<typeof setTimeout>;
};

const PICKER_TIMEOUT_MS = 60_000;

function getSourceType(sourceId: string): ScreenShareSource['sourceType'] {
  return sourceId.startsWith('screen:') ? 'screen' : 'window';
}

function toThumbnailDataUrl(source: Electron.DesktopCapturerSource): string | null {
  try {
    if (source.thumbnail.isEmpty()) {
      return null;
    }
    return source.thumbnail.resize({ width: 320 }).toDataURL();
  } catch {
    return null;
  }
}

function serializeSource(source: Electron.DesktopCapturerSource): ScreenShareSource {
  return {
    id: source.id,
    name: source.name,
    sourceType: getSourceType(source.id),
    thumbnailDataUrl: toThumbnailDataUrl(source),
    displayId: source.display_id || null,
  };
}

export function setupDisplayMediaPicker(
  ipcMain: IpcMainHandleRegistrar,
  getMainWindow: MainWindowGetter,
): { selectDisplayMediaSource: () => Promise<Electron.Video | null> } {
  const pendingRequests = new Map<string, PendingDisplayMediaRequest>();

  const settleRequest = (requestId: string, sourceId: string | null): { success: boolean; error: string | null } => {
    const pending = pendingRequests.get(requestId);
    if (!pending) {
      return { success: false, error: 'Screen share source request expired' };
    }

    pendingRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(sourceId ? pending.sources.get(sourceId) ?? null : null);
    return { success: true, error: null };
  };

  ipcMain.handle(IPC_CHANNELS.SCREEN_SHARE_SOURCE_SELECT, async (_event, requestId: string, sourceId: string | null) => {
    if (typeof requestId !== 'string' || !requestId) {
      return { success: false, error: 'Invalid screen share request' };
    }
    if (sourceId !== null && typeof sourceId !== 'string') {
      return { success: false, error: 'Invalid screen share source' };
    }

    return settleRequest(requestId, sourceId);
  });

  return {
    async selectDisplayMediaSource(): Promise<Electron.Video | null> {
      const win: BrowserWindow | null = getMainWindow();
      if (!win || win.isDestroyed()) {
        return null;
      }

      const capturedSources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      });

      const sources = capturedSources.map((source) => ({
        id: source.id,
        name: source.name,
      }));
      const sourceMap = new Map(sources.map((source) => [source.id, source]));

      const requestId = randomUUID();
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingRequests.delete(requestId);
          resolve(null);
        }, PICKER_TIMEOUT_MS);

        pendingRequests.set(requestId, {
          resolve,
          sources: sourceMap,
          timeout,
        });

        win.webContents.send(IPC_CHANNELS.SCREEN_SHARE_SOURCE_REQUEST, {
          requestId,
          sources: capturedSources.map(serializeSource),
        });
      });
    },
  };
}
