/**
 * In-RAM, process-bound registry of files this peer is currently serving (pull model).
 *
 * Ownership of the sender-side cap lives here: at most `maxPerChat` live entries per chat
 * (decision 8). The cap is enforced by `reserve`, which is a **synchronous** count-and-insert so
 * it can run before any `await` in the offer path — two concurrent sends therefore cannot both
 * pass the check during an `await` gap and exceed the cap.
 *
 * Entries are never persisted; they die with the process (a pull against a gone offer fails
 * `unavailable`). An entry exists in two states:
 *   - reserved  — a slot is held but metadata is not yet known (file still being read);
 *   - finalized — fully populated and pullable.
 * Both states occupy a chat slot. `release` removes either (rollback, withdrawal, consumption,
 * terminal NACK, lifecycle cleanup).
 */

interface ServedFile {
  offerId: string;
  fileId: string;
  filePath: string;
  size: number;
  checksum: string;
  /** peerId → app Ed25519 signing pubkey (base64), snapshotted at offer time. */
  authorizedPullers: Map<string, string>;
  chatId: number;
  isGroup: boolean;
}

/** Serving metadata exposed to callers — never the live authorization map. */
export type ServedFileMeta = {
  offerId: string;
  fileId: string;
  filePath: string;
  size: number;
  checksum: string;
  chatId: number;
  isGroup: boolean;
  authorizedPullerCount: number;
};

type RegistryEntry =
  | { finalized: false; offerId: string; chatId: number }
  | { finalized: true; served: ServedFile };

export type FinalizeServedFile = {
  fileId: string;
  filePath: string;
  size: number;
  checksum: string;
  authorizedPullers: Map<string, string>;
  isGroup: boolean;
};

export class ServedFileRegistry {
  private entries = new Map<string, RegistryEntry>();

  constructor(public readonly maxPerChat: number) {}

  /**
   * Synchronous cap reservation. Returns false (without mutating) if the offerId is already known
   * or the chat is at capacity. Must be the first step of the offer path, before any `await`.
   */
  reserve(offerId: string, chatId: number): boolean {
    if (this.entries.has(offerId)) {
      return false;
    }
    if (this.countForChat(chatId) >= this.maxPerChat) {
      return false;
    }
    this.entries.set(offerId, { finalized: false, offerId, chatId });
    return true;
  }

  /**
   * Populate a reserved entry with serving metadata. Throws if the offer was not reserved or was
   * already finalized. The authorization map is *cloned* so the snapshot is immune to later caller
   * mutation of the passed-in Map.
   */
  finalize(offerId: string, data: FinalizeServedFile): void {
    const entry = this.entries.get(offerId);
    if (!entry) {
      throw new Error(`ServedFileRegistry.finalize: offer ${offerId} was not reserved`);
    }
    if (entry.finalized) {
      throw new Error(`ServedFileRegistry.finalize: offer ${offerId} is already finalized`);
    }
    this.entries.set(offerId, {
      finalized: true,
      served: {
        offerId,
        chatId: entry.chatId,
        fileId: data.fileId,
        filePath: data.filePath,
        size: data.size,
        checksum: data.checksum,
        isGroup: data.isGroup,
        authorizedPullers: new Map(data.authorizedPullers),
      },
    });
  }

  /** Remove an entry (rollback / withdrawal / consumption / terminal NACK). */
  release(offerId: string): boolean {
    return this.entries.delete(offerId);
  }

  /** True for both reserved and finalized entries (either occupies a slot). */
  has(offerId: string): boolean {
    return this.entries.has(offerId);
  }

  /**
   * Serving metadata for a finalized, pullable offer (never the live authorization map). A
   * reserved-but-not-finalized entry returns undefined.
   */
  getMeta(offerId: string): ServedFileMeta | undefined {
    const served = this.finalizedServed(offerId);
    if (!served) {
      return undefined;
    }
    return {
      offerId: served.offerId,
      fileId: served.fileId,
      filePath: served.filePath,
      size: served.size,
      checksum: served.checksum,
      chatId: served.chatId,
      isGroup: served.isGroup,
      authorizedPullerCount: served.authorizedPullers.size,
    };
  }

  /** Snapshotted app signing key authorized to pull this offer as `peerId`, if any. */
  getAuthorizedKey(offerId: string, peerId: string): string | undefined {
    return this.finalizedServed(offerId)?.authorizedPullers.get(peerId);
  }

  private finalizedServed(offerId: string): ServedFile | undefined {
    const entry = this.entries.get(offerId);
    return entry && entry.finalized ? entry.served : undefined;
  }

  countForChat(chatId: number): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      const entryChatId = entry.finalized ? entry.served.chatId : entry.chatId;
      if (entryChatId === chatId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Group consumption/decline: drop one authorized puller; release the whole entry once the last
   * puller is gone (a single member's pull/decline never frees the slot for the rest).
   */
  removePuller(offerId: string, peerId: string): { removed: boolean; emptied: boolean } {
    const served = this.finalizedServed(offerId);
    if (!served) {
      return { removed: false, emptied: false };
    }
    const removed = served.authorizedPullers.delete(peerId);
    const emptied = served.authorizedPullers.size === 0;
    if (emptied) {
      this.entries.delete(offerId);
    }
    return { removed, emptied };
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
