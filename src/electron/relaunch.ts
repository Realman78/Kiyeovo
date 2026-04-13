import { app } from 'electron';
import { spawn } from 'node:child_process';

type RelaunchableApp = typeof app & {
  __kiyeovoRelaunchScheduled?: boolean;
};

export function scheduleAppRelaunch(): void {
  const relaunchableApp = app as RelaunchableApp;
  if (relaunchableApp.__kiyeovoRelaunchScheduled) {
    return;
  }

  const args = process.argv.slice(1);
  relaunchableApp.__kiyeovoRelaunchScheduled = true;

  if (!app.isPackaged) {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      env: process.env,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  app.relaunch({
    execPath: process.execPath,
    args,
  });
}
