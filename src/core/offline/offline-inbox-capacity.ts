import {
  GROUP_MAX_MESSAGES_PER_SENDER,
  GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
  MAX_MESSAGES_PER_STORE,
  OFFLINE_ACK_RESERVE,
  OFFLINE_CONTROL_MESSAGE_RESERVE,
} from '../constants.js';
import type { ChatDatabase, OfflineMessageCategory } from '../db/database.js';
import type {
  DirectOfflineInboxCapacitySnapshot,
  GroupOfflineInboxCapacitySnapshot,
  OfflineInboxCapacitySnapshot,
  OfflineMessage,
} from '../types.js';
import type { KeyExchange } from '../direct/key-exchange.js';
import type { GroupOfflineManager } from '../group/runtime/group-offline-manager.js';

const DIRECT_USER_CAPACITY = Math.max(
  0,
  MAX_MESSAGES_PER_STORE - OFFLINE_CONTROL_MESSAGE_RESERVE - OFFLINE_ACK_RESERVE,
);

interface OfflineInboxCapacityServiceDeps {
  database: ChatDatabase;
  keyExchange: KeyExchange;
  groupOfflineManager: GroupOfflineManager;
  myPeerId: string;
}

type ChatDetails = NonNullable<ReturnType<ChatDatabase['getChatByIdWithUsernameAndLastMsg']>>;

export class OfflineInboxCapacityService {
  private readonly deps: OfflineInboxCapacityServiceDeps;

  constructor(deps: OfflineInboxCapacityServiceDeps) {
    this.deps = deps;
  }

  getSnapshot(chatId: number): OfflineInboxCapacitySnapshot | null {
    const chat = this.deps.database.getChatByIdWithUsernameAndLastMsg(chatId, this.deps.myPeerId);
    if (!chat) {
      return null;
    }

    if (chat.type === 'group' && chat.group_id) {
      return this.getGroupSnapshot(chat);
    }

    return this.getDirectSnapshot(chat);
  }

  private getDirectSnapshot(chat: ChatDetails): DirectOfflineInboxCapacitySnapshot {
    const peerId = chat.other_peer_id ?? null;
    const bucketKey = chat.offline_bucket_secret
      ? this.deps.keyExchange.constructWriteBucketKey(chat.offline_bucket_secret)
      : null;

    let regularStored = 0;
    let controlStored = 0;
    let ackStored = 0;
    let regularPending = 0;

    if (bucketKey) {
      const liveMessages = this.getLiveDirectMessages(bucketKey);
      const categoryById = new Map(
        this.deps.database.getOfflineSentMessageCategories(bucketKey).map(entry => [entry.message_id, entry.category]),
      );

      for (const message of liveMessages) {
        const category = this.resolveDirectMessageCategory(message, categoryById.get(message.id));
        if (category === 'control') {
          controlStored++;
        } else if (category === 'ack') {
          ackStored++;
        } else {
          regularStored++;
        }
      }

      regularPending = this.deps.database.countActivePendingOfflineSendsByBucket(bucketKey);

      // TEMP_LOG: trace the exact direct counts the capacity panel is reading.
      console.log(
        `[TEMP_LOG][OFFLINE][CAPACITY][SNAPSHOT] chatId=${chat.id} peer=${peerId?.slice(-8) ?? 'unknown'} bucket=*${bucketKey.slice(-12)} regularStored=${regularStored} controlStored=${controlStored} ackStored=${ackStored} regularPending=${regularPending}`
      );
    }

    const mainUsed = regularStored + regularPending;

    return {
      kind: 'direct',
      chatId: chat.id,
      peerId,
      totalCapacity: MAX_MESSAGES_PER_STORE,
      mainUsed,
      mainLimit: DIRECT_USER_CAPACITY,
      mainRatio: DIRECT_USER_CAPACITY > 0 ? mainUsed / DIRECT_USER_CAPACITY : 0,
      regular: {
        stored: regularStored,
        pending: regularPending,
        total: mainUsed,
        limit: DIRECT_USER_CAPACITY,
      },
      control: {
        stored: controlStored,
        total: controlStored,
        limit: OFFLINE_CONTROL_MESSAGE_RESERVE,
      },
      ack: {
        stored: ackStored,
        total: ackStored,
        limit: OFFLINE_ACK_RESERVE,
      },
    };
  }

  private getGroupSnapshot(chat: ChatDetails): GroupOfflineInboxCapacitySnapshot {
    const groupId = chat.group_id!;
    const currentKeyVersion = chat.key_version ?? 0;
    const currentUsage = currentKeyVersion > 0
      ? this.deps.groupOfflineManager.getLocalBucketUsage(
        this.deps.groupOfflineManager.getOwnBucketKey(groupId, currentKeyVersion),
      )
      : {
        messageCountUsed: 0,
        messageCountLimit: GROUP_MAX_MESSAGES_PER_SENDER,
        compressedBytesUsed: 0,
        compressedBytesLimit: GROUP_OFFLINE_STORE_MAX_COMPRESSED_BYTES,
        fullnessRatio: 0,
      };

    return {
      kind: 'group',
      chatId: chat.id,
      groupId,
      currentKeyVersion,
      mainUsed: currentUsage.messageCountUsed,
      mainLimit: currentUsage.messageCountLimit,
      mainRatio: currentUsage.fullnessRatio,
      mainCompressedBytesUsed: currentUsage.compressedBytesUsed,
      mainCompressedBytesLimit: currentUsage.compressedBytesLimit,
    };
  }

  private getLiveDirectMessages(bucketKey: string): OfflineMessage[] {
    const now = Date.now();
    return this.deps.database.getOfflineSentMessages(bucketKey).messages
      .filter(message => message.expires_at > now)
      .map((message) => {
        const { bucket_key, ...clean } = message;
        return clean;
      });
  }

  private resolveDirectMessageCategory(
    message: OfflineMessage,
    storedCategory?: OfflineMessageCategory,
  ): OfflineMessageCategory {
    if (message.signed_payload?.ack_only === true) {
      return 'ack';
    }
    return storedCategory ?? 'regular';
  }
}
