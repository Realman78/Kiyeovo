/**
 * Per-service runtime metadata for the bootstrap/relay servers.
 *
 * Each server process (one role per process) writes a single public-only JSON
 * file describing what it is and how clients reach it. The `kiyeovo-infra` CLI
 * reads these files for its `status` / `addresses` commands instead of scraping
 * logs. The file contains no secrets (never the private key or TURN credential).
 *
 * Lifecycle (see callers in bootstrap.ts / relay.ts):
 *   1. remove any stale file on startup, before the node is healthy;
 *   2. write fresh metadata once the node has started and addresses are known;
 *   3. remove the file again on graceful shutdown.
 *
 * Writes are atomic (temp file + rename within the same directory) so a reader
 * never observes a half-written file.
 *
 * The output path comes from `KIYEOVO_RUNTIME_FILE`. When unset, no file is
 * written and the lifecycle helpers are no-ops, keeping local dev runs clean.
 */

import { writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { errStr } from '../utils/general-error.js';

export const RUNTIME_METADATA_SCHEMA_VERSION = 1 as const;

export type ServiceRole = 'bootstrap' | 'relay';
export type ServiceNetworkMode = 'fast' | 'anonymous';

export interface ServiceRuntimeMetadata {
  schemaVersion: typeof RUNTIME_METADATA_SCHEMA_VERSION;
  role: ServiceRole;
  networkMode: ServiceNetworkMode;
  peerId: string;
  /** Configured announce multiaddrs (no `/p2p/` suffix). */
  announceAddrs: string[];
  /** Full dialable multiaddrs clients paste into Kiyeovo (`<announce>/p2p/<peerId>`). */
  clientAddrs: string[];
  /** Independent infra server version; `unknown` until the release pipeline sets it. */
  version: string;
  /** ISO-8601 timestamp of when this process became healthy. */
  startedAt: string;
}

/** Path the current process should write its runtime metadata to, if any. */
export function getRuntimeMetadataPath(): string | undefined {
  const raw = process.env.KIYEOVO_RUNTIME_FILE?.trim();
  return raw ? raw : undefined;
}

/** Infra server version, baked in via env at image build time. */
export function getServerVersion(): string {
  const raw = process.env.KIYEOVO_SERVER_VERSION?.trim();
  return raw ? raw : 'unknown';
}

/** Build the full `/p2p/<peerId>` multiaddrs clients dial from the announce list. */
export function buildClientAddrs(announceAddrs: string[], peerId: string): string[] {
  return announceAddrs.map((addr) => `${addr}/p2p/${peerId}`);
}

export interface RuntimeMetadataIoOptions {
  /**
   * When `true`, an I/O failure throws instead of being logged. Deployment mode
   * uses this for the startup remove + healthy write, because the JSON file is
   * the CLI's control-plane contract: a service that is "up" but whose metadata
   * is stale or absent is a failure the operator must see. Defaults to `false`
   * (best-effort), used for shutdown cleanup and for lenient local runs.
   */
  required?: boolean;
}

/**
 * Write runtime metadata atomically (temp file + rename within the same dir, so
 * a reader never sees a half-written file). Best-effort by default; pass
 * `{ required: true }` (deployment mode) to abort on failure instead.
 */
export async function writeRuntimeMetadata(
  filePath: string,
  metadata: ServiceRuntimeMetadata,
  options: RuntimeMetadataIoOptions = {}
): Promise<void> {
  const tempPath = `${filePath}.tmp`;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (err: unknown) {
    await unlink(tempPath).catch(() => undefined);
    const message = `[RUNTIME] failed to write runtime metadata to ${filePath}: ${errStr(err)}`;
    if (options.required) {
      throw new Error(message);
    }
    console.warn(message);
  }
}

/**
 * Remove the runtime metadata file if present. A missing file is always a
 * success (nothing to remove). Best-effort by default; pass `{ required: true }`
 * (deployment mode) to abort when an existing file cannot be removed.
 */
export async function removeRuntimeMetadataFile(
  filePath: string,
  options: RuntimeMetadataIoOptions = {}
): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return;
    }
    const message = `[RUNTIME] failed to remove runtime metadata at ${filePath}: ${errStr(err)}`;
    if (options.required) {
      throw new Error(message);
    }
    console.warn(message);
  }
}
