import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserWindow } from 'electron';
import {
  assertTrustedRendererEvent,
  createTrustedIpcMainHandle,
} from './trusted-ipc.js';

type TrustedEvent = Parameters<typeof assertTrustedRendererEvent>[0];
type RegisteredHandler = (event: TrustedEvent, ...args: unknown[]) => Promise<unknown>;

type FakeFrame = {
  processId: number;
  frameToken: string;
  url: string;
};

type FakeWebContents = {
  mainFrame: FakeFrame;
  getURL(): string;
};

type FakeWindow = {
  webContents: FakeWebContents;
  isDestroyed(): boolean;
};

function createFakeWindow(destroyed = false): FakeWindow {
  const mainFrame: FakeFrame = {
    processId: 7,
    frameToken: 'main-frame-token',
    url: 'kiyeovo://app/index.html',
  };
  const webContents: FakeWebContents = {
    mainFrame,
    getURL: () => mainFrame.url,
  };
  return {
    webContents,
    isDestroyed: () => destroyed,
  };
}

function toBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

function toTrustedEvent(event: { sender: FakeWebContents; senderFrame?: FakeFrame }): TrustedEvent {
  return event as unknown as TrustedEvent;
}

async function withoutConsoleWarn<T>(fn: () => Promise<T>): Promise<T> {
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test('trusted IPC handle invokes listeners for the main window main frame', async () => {
  const mainWindow = createFakeWindow();
  let registered: RegisteredHandler | null = null;
  const ipcMain: Parameters<typeof createTrustedIpcMainHandle>[0] = {
    handle(_channel, listener) {
      registered = listener as unknown as RegisteredHandler;
    },
  };

  const trustedIpcMain = createTrustedIpcMainHandle(ipcMain, () => toBrowserWindow(mainWindow));
  trustedIpcMain.handle('secure:channel', (_event, ...args: unknown[]) => args.join(':'));

  assert.ok(registered);
  assert.equal(await registered(toTrustedEvent({
    sender: mainWindow.webContents,
    senderFrame: mainWindow.webContents.mainFrame,
  }), 'alpha', 'beta'), 'alpha:beta');
});

test('trusted IPC accepts equivalent main-frame identity from process id and frame token', () => {
  const mainWindow = createFakeWindow();
  const equivalentFrame: FakeFrame = {
    processId: mainWindow.webContents.mainFrame.processId,
    frameToken: mainWindow.webContents.mainFrame.frameToken,
    url: mainWindow.webContents.mainFrame.url,
  };

  assert.doesNotThrow(() => assertTrustedRendererEvent(
    toTrustedEvent({
      sender: mainWindow.webContents,
      senderFrame: equivalentFrame,
    }),
    () => toBrowserWindow(mainWindow),
    'secure:channel',
  ));
});

test('trusted IPC rejects wrong sender, missing frame, and destroyed window', async () => {
  const mainWindow = createFakeWindow();
  const otherWindow = createFakeWindow();

  await withoutConsoleWarn(async () => {
    assert.throws(() => assertTrustedRendererEvent(
      toTrustedEvent({
        sender: otherWindow.webContents,
        senderFrame: otherWindow.webContents.mainFrame,
      }),
      () => toBrowserWindow(mainWindow),
      'secure:channel',
    ), /Unauthorized IPC sender/);

    assert.throws(() => assertTrustedRendererEvent(
      toTrustedEvent({ sender: mainWindow.webContents }),
      () => toBrowserWindow(mainWindow),
      'secure:channel',
    ), /Unauthorized IPC sender/);

    assert.throws(() => assertTrustedRendererEvent(
      toTrustedEvent({
        sender: mainWindow.webContents,
        senderFrame: mainWindow.webContents.mainFrame,
      }),
      () => toBrowserWindow(createFakeWindow(true)),
      'secure:channel',
    ), /Unauthorized IPC sender/);
  });
});
