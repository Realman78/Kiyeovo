import { BrowserWindow, ipcMain } from 'electron';
import { PasswordResponse, IPC_CHANNELS, PasswordRequest } from '../core/types.js';

/**
 * Request password from the UI instead of terminal
 */
export function requestPasswordFromUI(
  window: BrowserWindow,
  prompt: string,
  isNewPassword: boolean = false,
  recoveryPhrase?: string,
  prefilledPassword?: string,
  errorMessage?: string,
  cooldownSeconds?: number,
  showRecoveryOption?: boolean,
  keychainAvailable?: boolean,
  onRequestStateChange?: (request: PasswordRequest | null) => void
): Promise<PasswordResponse> {
  return new Promise((resolve, reject) => {
    const request: PasswordRequest = {
      prompt,
      isNewPassword,
      ...(recoveryPhrase && { recoveryPhrase }),
      ...(prefilledPassword && { prefilledPassword }),
      ...(errorMessage && { errorMessage }),
      ...(cooldownSeconds !== undefined && { cooldownSeconds }),
      ...(cooldownSeconds !== undefined && { cooldownUntil: Date.now() + cooldownSeconds * 1000 }),
      ...(showRecoveryOption !== undefined && { showRecoveryOption }),
      ...(keychainAvailable !== undefined && { keychainAvailable }),
    };

    const handlePasswordResponse = (_event: any, response: PasswordResponse) => {
      cleanup();
      resolve(response);
    };

    const cleanup = () => {
      ipcMain.removeListener(IPC_CHANNELS.PASSWORD_RESPONSE, handlePasswordResponse);
      onRequestStateChange?.(null);
    };

    ipcMain.once(IPC_CHANNELS.PASSWORD_RESPONSE, handlePasswordResponse);

    onRequestStateChange?.(request);
    window.webContents.send(IPC_CHANNELS.PASSWORD_REQUEST, request);
  });
}
