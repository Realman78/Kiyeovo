/**
 * A counting gate with both a global and a per-peer cap, handing out **owned, idempotent leases**.
 *
 * `tryAcquire` is synchronous and all-or-nothing: it takes a global slot *and* a per-peer slot, or
 * neither — it never holds one while failing the other. The returned `Lease.release()` is bound to
 * the slot it took and is idempotent: calling it more than once (e.g. from overlapping error and
 * `finally` paths) decrements exactly once, so counts can never drift.
 *
 * Used twice in the serve path: a pre-auth gate (bounding unauthenticated handshake streams) and
 * the post-auth serve pool. On successful authentication the handler releases the pre-auth lease
 * and acquires a serve lease (the hand-off).
 */
export interface Lease {
  release(): void;
}

export class LeasePool {
  private globalCount = 0;
  private perPeerCount = new Map<string, number>();

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerPeer: number,
  ) {}

  /** Take a global + per-peer slot atomically, or return null if either cap is full. */
  tryAcquire(peerId: string): Lease | null {
    const peerCount = this.perPeerCount.get(peerId) ?? 0;
    if (this.globalCount >= this.maxGlobal || peerCount >= this.maxPerPeer) {
      return null;
    }
    this.globalCount += 1;
    this.perPeerCount.set(peerId, peerCount + 1);

    let released = false;
    return {
      release: () => {
        if (released) {
          return; // idempotent: a lease only ever frees the one slot it took
        }
        released = true;
        this.globalCount -= 1;
        const current = this.perPeerCount.get(peerId) ?? 0;
        if (current <= 1) {
          this.perPeerCount.delete(peerId);
        } else {
          this.perPeerCount.set(peerId, current - 1);
        }
      },
    };
  }

  get activeCount(): number {
    return this.globalCount;
  }

  peerCount(peerId: string): number {
    return this.perPeerCount.get(peerId) ?? 0;
  }
}
