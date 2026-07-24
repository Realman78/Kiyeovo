#!/usr/bin/env node
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';

function run(command, args = []) {
  return new Promise((resolve, reject) => {
    const executable = isWindows ? `${command}.cmd` : command;
    const child = spawn(executable, args, {
      stdio: 'inherit',
      // Node >=18.20/20.12 refuses to spawn .cmd/.bat shims without a shell
      // (CVE-2024-27980 hardening) and throws EINVAL, so on Windows the npm
      // .cmd shims must go through the shell. POSIX keeps shell:false.
      shell: isWindows,
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'null'}`));
    });
  });
}

const nodeRole = process.env.ROLE?.trim().toLowerCase();
const skipElectronRebuild = process.env.KIYEOVO_SKIP_ELECTRON_REBUILD === '1' || nodeRole === 'bootstrap' || nodeRole === 'relay';

if (skipElectronRebuild) {
  console.log('[postinstall] Skipping electron-rebuild (bootstrap/server mode).');
} else {
  console.log('[postinstall] Running electron-rebuild for better-sqlite3...');
  await run('electron-rebuild', ['-f', '-o', 'better-sqlite3']);
}

console.log('[postinstall] Applying patch-package patches...');
await run('patch-package');
