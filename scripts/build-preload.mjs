#!/usr/bin/env node
import { build } from 'esbuild';

await build({
  entryPoints: ['src/electron/preload.cts'],
  outfile: 'dist-electron/electron/preload.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  sourcemap: true,
  external: ['electron'],
});
