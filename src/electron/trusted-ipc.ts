import type { BrowserWindow, IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

export type MainWindowGetter = () => BrowserWindow | null;

export type IpcMainHandleRegistrar = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void;
};

type TrustedSenderEvent = Pick<IpcMainEvent, 'sender' | 'senderFrame'>;

function isTrustedRendererEvent(
  event: TrustedSenderEvent,
  getMainWindow: MainWindowGetter,
): boolean {
  const mainWindow = getMainWindow();
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (event.sender !== mainWindow.webContents) {
    return false;
  }

  if (!event.senderFrame) {
    return false;
  }

  const mainFrame = mainWindow.webContents.mainFrame;
  return event.senderFrame === mainFrame
    || (
      event.senderFrame.processId === mainFrame.processId
      && event.senderFrame.frameToken === mainFrame.frameToken
    );
}

export function assertTrustedRendererEvent(
  event: TrustedSenderEvent,
  getMainWindow: MainWindowGetter,
  channel: string,
): void {
  if (isTrustedRendererEvent(event, getMainWindow)) {
    return;
  }

  const mainWindow = getMainWindow();
  const senderUrl = event.senderFrame?.url || event.sender.getURL() || 'unknown';
  let expectedUrl = 'unknown';
  try {
    expectedUrl = mainWindow?.webContents.mainFrame.url || 'unknown';
  } catch {
    expectedUrl = 'unknown';
  }
  console.warn(
    `[IPC][SECURITY] Rejected IPC from untrusted sender channel=${channel} senderUrl=${senderUrl} expectedUrl=${expectedUrl}`,
  );
  throw new Error('Unauthorized IPC sender');
}

export function createTrustedIpcMainHandle(
  ipcMain: Pick<IpcMain, 'handle'>,
  getMainWindow: MainWindowGetter,
): IpcMainHandleRegistrar {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, async (event, ...args) => {
        assertTrustedRendererEvent(event, getMainWindow, channel);
        return listener(event, ...args);
      });
    },
  };
}
