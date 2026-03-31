import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import type { ChatNode, NetworkMode } from '../../types.js';
import {
  GROUP_INFO_REPUBLISH_MAX_ATTEMPTS,
  GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY,
  GROUP_INFO_REPUBLISH_RETRY_STEADY_DELAY,
} from '../../constants.js';
import { errStr, generalErrorHandler } from '../../utils/general-error.js';
import type { ChatDatabase, GroupPendingInfoPublish } from '../../db/database.js';
import type { GroupInfoLatest, GroupInfoVersioned, GroupInfoVersionedMetadata } from '../../group/types.js';
import { putJsonToDHT } from '../../group/dht/group-dht-publish.js';
import { decodeBase64Strict } from '../../utils/validators.js';
import { log } from '../../../shared/logger.js';

interface GroupInfoRepublisherDeps {
  node: ChatNode;
  database: ChatDatabase;
  networkMode: NetworkMode;
}

export class GroupInfoRepublisher {
  private readonly deps: GroupInfoRepublisherDeps;
  private inFlight = false;

  constructor(deps: GroupInfoRepublisherDeps) {
    this.deps = deps;
  }

  async runCycle(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const now = Date.now();
      const due = this.deps.database.getDuePendingGroupInfoPublishes(now, 100, this.deps.networkMode);
      if (due.length === 0) return;
      const connectedPeers = this.deps.node.getConnections().length;
      if (connectedPeers === 0) {
        log(`[GROUP-INFO][CYCLE][SKIP] due=${due.length} reason=no_connected_peers`);
        return;
      }

      let published = 0;
      let failed = 0;
      let removedInvalid = 0;
      let removedStale = 0;
      let removedCapped = 0;
      log(`[GROUP-INFO][CYCLE][START] due=${due.length} connectedPeers=${connectedPeers}`);

      for (const pending of due) {
        try {
          log(
            `[GROUP-INFO][ITEM][START] group=${pending.group_id} keyVersion=${pending.key_version} ` +
            `attempt=${pending.attempts + 1}/${GROUP_INFO_REPUBLISH_MAX_ATTEMPTS}`,
          );
          const pruneReason = this.getPruneReason(pending);
          if (pruneReason) {
            this.deps.database.removePendingGroupInfoPublish(
              pending.group_id,
              pending.key_version,
              this.deps.networkMode,
            );
            if (pruneReason === 'attempt_cap') removedCapped++;
            else removedStale++;
            log(
              `[GROUP-INFO][ITEM][REMOVE] group=${pending.group_id} keyVersion=${pending.key_version} reason=${pruneReason}`,
            );
            continue;
          }

          const parsed = this.parsePendingPayloads(pending);
          if (!parsed) {
            this.deps.database.removePendingGroupInfoPublish(
              pending.group_id,
              pending.key_version,
              this.deps.networkMode,
            );
            removedInvalid++;
            log(
              `[GROUP-INFO][ITEM][REMOVE] group=${pending.group_id} keyVersion=${pending.key_version} reason=invalid_payload`,
            );
            continue;
          }

          await putJsonToDHT(this.deps.node, parsed.versionedDhtKey, parsed.versionedRecord);
          await putJsonToDHT(this.deps.node, parsed.latestDhtKey, parsed.latestRecord);

          this.deps.database.updateGroupKeyStateHash(pending.group_id, pending.key_version, parsed.versionedRecord.stateHash);
          if (pending.key_version > 1) {
            const decryptedBoundaries = this.decryptSenderSeqBoundaries(
              pending.group_id,
              pending.key_version,
              parsed.versionedRecord,
            );
            if (decryptedBoundaries && Object.keys(decryptedBoundaries).length > 0) {
              this.deps.database.upsertGroupEpochBoundaries(
                pending.group_id,
                pending.key_version - 1,
                decryptedBoundaries,
                'creator_republish',
              );
            } else if (decryptedBoundaries === null) {
              console.warn(
                `[GROUP-INFO][ITEM][BOUNDARIES_SKIP] group=${pending.group_id} keyVersion=${pending.key_version} ` +
                `reason=missing_or_invalid_metadata_boundaries`,
              );
            }
            this.deps.database.markGroupKeyUsedUntil(pending.group_id, pending.key_version - 1, Date.now());
          }
          this.deps.database.removePendingGroupInfoPublish(
            pending.group_id,
            pending.key_version,
            this.deps.networkMode,
          );
          published++;
          log(
            `[GROUP-INFO][ITEM][DONE] group=${pending.group_id} keyVersion=${pending.key_version} ` +
            `attempt=${pending.attempts + 1}/${GROUP_INFO_REPUBLISH_MAX_ATTEMPTS}`,
          );
        } catch (error: unknown) {
          failed++;
          const errorText = errStr(error);
          const retryDelayMs = this.computeRetryDelay(pending.attempts);
          const nextRetryAt = Date.now() + retryDelayMs;
          const nextAttempt = pending.attempts + 1;
          this.deps.database.markPendingGroupInfoPublishAttempt(
            pending.group_id,
            pending.key_version,
            nextRetryAt,
            errorText,
            this.deps.networkMode,
          );
          console.warn(
            `[GROUP-INFO][ITEM][RETRY_SCHEDULED] group=${pending.group_id} keyVersion=${pending.key_version} ` +
            `attempt=${nextAttempt}/${GROUP_INFO_REPUBLISH_MAX_ATTEMPTS} nextRetryInMs=${retryDelayMs} reason=${errorText}`
          );
          generalErrorHandler(
            error,
            `[GROUP-INFO] Failed to republish group=${pending.group_id} keyVersion=${pending.key_version}`,
          );
        }
      }

      log(
        `[GROUP-INFO][CYCLE][DONE] published=${published} failed=${failed} removedInvalid=${removedInvalid} removedStale=${removedStale} removedCapped=${removedCapped}`,
      );
    } finally {
      this.inFlight = false;
    }
  }

  private parsePendingPayloads(pending: GroupPendingInfoPublish): {
    versionedDhtKey: string;
    latestDhtKey: string;
    versionedRecord: GroupInfoVersioned;
    latestRecord: GroupInfoLatest;
  } | null {
    try {
      const versionedRecord = JSON.parse(pending.versioned_payload) as GroupInfoVersioned;
      const latestRecord = JSON.parse(pending.latest_payload) as GroupInfoLatest;
      if (
        versionedRecord.groupId !== pending.group_id
        || versionedRecord.version !== pending.key_version
        || latestRecord.groupId !== pending.group_id
        || latestRecord.latestVersion !== pending.key_version
      ) {
        return null;
      }
      return {
        versionedDhtKey: pending.versioned_dht_key,
        latestDhtKey: pending.latest_dht_key,
        versionedRecord,
        latestRecord,
      };
    } catch (error: unknown) {
      log('[GROUP-INFO][ITEM][PARSE_FAIL] group=' + pending.group_id + ' keyVersion=' + String(pending.key_version) + ' reason=' + errStr(error));
      return null;
    }
  }

  private decryptSenderSeqBoundaries(
    groupId: string,
    keyVersion: number,
    versionedRecord: GroupInfoVersioned,
  ): Record<string, number> | null {
    const metadataKeyBase64 = this.deps.database.getGroupInfoMetadataKeyForEpoch(groupId, keyVersion);
    if (!metadataKeyBase64) {
      log('[GROUP-INFO][META][REPUBLISH_DECRYPT_SKIP] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' reason=missing_local_metadata_key');
      return null;
    }

    const metadataKeyBytes = decodeBase64Strict(metadataKeyBase64);
    if (!metadataKeyBytes || metadataKeyBytes.length !== 32) {
      log('[GROUP-INFO][META][REPUBLISH_DECRYPT_SKIP] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' reason=invalid_local_metadata_key');
      return null;
    }

    const nonce = decodeBase64Strict(versionedRecord.encryptedMetadataNonce);
    if (!nonce || nonce.length !== 24) {
      log('[GROUP-INFO][META][REPUBLISH_DECRYPT_SKIP] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' reason=invalid_nonce');
      return null;
    }

    const encrypted = decodeBase64Strict(versionedRecord.encryptedMetadata);
    if (!encrypted) {
      log('[GROUP-INFO][META][REPUBLISH_DECRYPT_SKIP] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' reason=invalid_ciphertext');
      return null;
    }

    try {
      const cipher = xchacha20poly1305(metadataKeyBytes, nonce);
      const decrypted = cipher.decrypt(encrypted);
      const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as GroupInfoVersionedMetadata;
      if (!parsed.senderSeqBoundaries || typeof parsed.senderSeqBoundaries !== 'object') {
        return {};
      }

      const boundaries: Record<string, number> = {};
      for (const [peerId, seq] of Object.entries(parsed.senderSeqBoundaries)) {
        if (!peerId || !Number.isFinite(seq)) continue;
        boundaries[peerId] = Math.max(0, Math.floor(seq));
      }
      log('[GROUP-INFO][META][REPUBLISH_DECRYPT_OK] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' boundaries=' + String(Object.keys(boundaries).length) + ' nonceBytes=' + String(nonce.length) + ' cipherBytes=' + String(encrypted.length));
      return boundaries;
    } catch (error: unknown) {
      log('[GROUP-INFO][META][REPUBLISH_DECRYPT_SKIP] group=' + groupId + ' keyVersion=' + String(keyVersion) + ' reason=decrypt_failed error=' + errStr(error));
      return null;
    }
  }

  private computeRetryDelay(attempts: number): number {
    const base = attempts <= 0
      ? GROUP_INFO_REPUBLISH_RETRY_BASE_DELAY
      : GROUP_INFO_REPUBLISH_RETRY_STEADY_DELAY;
    const jitter = base * (Math.random() * 0.2);
    return Math.floor(base + jitter);
  }

  private getPruneReason(pending: GroupPendingInfoPublish): 'attempt_cap' | 'group_missing' | 'epoch_missing' | null {
    if (pending.attempts >= GROUP_INFO_REPUBLISH_MAX_ATTEMPTS) {
      return 'attempt_cap';
    }

    const chat = this.deps.database.getChatByGroupId(pending.group_id, this.deps.networkMode);
    if (!chat || chat.type !== 'group') {
      return 'group_missing';
    }

    const keyExists = this.deps.database.getGroupKeyForEpoch(pending.group_id, pending.key_version);
    if (!keyExists) {
      return 'epoch_missing';
    }

    return null;
  }
}
