/**
 * Electron's display-media request handler uses the OS picker on supported
 * macOS versions and the trusted desktopCapturer-backed in-app picker on
 * Linux and Windows.
 */
export function isScreenShareSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}
