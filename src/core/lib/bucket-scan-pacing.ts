/**
 * Pure helpers for the "shuffled + paced offline-bucket scan" metadata
 * mitigation (see OFFLINE_BUCKET_SCAN_PACING_* in constants.ts).
 *
 * A reconnect/periodic offline sweep otherwise fetches every DHT bucket for
 * the scan (direct peers, or group `groupId x keyVersion x sender` buckets)
 * in one fixed-order back-to-back burst - an identifiable fingerprint to a
 * network observer. These helpers randomize the fetch ORDER (Fisher-Yates)
 * and stagger each fetch's START time with a small random delay, capped so
 * the total added spread never exceeds a fixed budget no matter how many
 * buckets are involved. What is fetched, and the result each fetch returns,
 * is unchanged - only order and timing.
 *
 * Kept dependency-free (no ChatNode/database imports) so it is trivially
 * unit-testable and shared verbatim by both the direct and group scan paths.
 */

export interface PacedBatchResult<R> {
  /** Results aligned 1:1 with the ORIGINAL (pre-shuffle) input order. */
  results: R[];
  /** Number of items paced (== items.length). */
  bucketCount: number;
  /** The largest start-delay actually assigned, in ms (0 when unpaced). */
  totalSpreadMs: number;
}

/** Fisher-Yates shuffle over a COPY of `items`; the input array is untouched. */
export function shuffleCopy<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

/**
 * Per-item random start-delay (ms), one draw per item, each independently
 * uniform in [0, totalBudgetMs]. Bounding every draw to the same fixed budget
 * (rather than, say, `totalBudgetMs / count`) is what keeps the total spread
 * capped at `totalBudgetMs` regardless of how many buckets there are - a
 * count of 3 or 300 both spread across the same window, they just pack more
 * or less densely.
 *
 * Below `minCount` buckets, pacing would meaningfully hurt recovery latency
 * for essentially no anti-fingerprinting benefit (a burst of 1-2 requests is
 * not a distinctive pattern), so delay is zero.
 */
export function computeBucketPacingDelaysMs(
  count: number,
  totalBudgetMs: number,
  random: () => number = Math.random,
  minCount = 2,
): number[] {
  const safeCount = Math.max(0, Math.floor(count));
  if (safeCount <= minCount || totalBudgetMs <= 0) {
    return new Array<number>(safeCount).fill(0);
  }
  return Array.from({ length: safeCount }, () => Math.round(random() * totalBudgetMs));
}

/**
 * Shuffle `items`, assign each a bounded random start-delay, and execute
 * `execute` for all of them concurrently with those staggered starts (not a
 * sequential blocking wait - items still run concurrently once their delay
 * elapses, so total wall time is roughly `max(delay) + slowest fetch`, not
 * `sum(delay)`). Results are returned aligned to the ORIGINAL item order.
 */
export async function shuffleAndPaceExecute<T, R>(
  items: readonly T[],
  execute: (item: T) => Promise<R>,
  options: {
    totalBudgetMs: number;
    random?: (() => number) | undefined;
    minCount?: number | undefined;
    sleep?: ((ms: number) => Promise<void>) | undefined;
  },
): Promise<PacedBatchResult<R>> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const order = shuffleCopy(items, random);
  const delays = computeBucketPacingDelaysMs(order.length, options.totalBudgetMs, random, options.minCount ?? 2);

  const resultByIndex = new Map<number, R>();
  const originalIndexOf = new Map<T, number[]>();
  items.forEach((item, index) => {
    const bucket = originalIndexOf.get(item) ?? [];
    bucket.push(index);
    originalIndexOf.set(item, bucket);
  });

  await Promise.all(order.map(async (item, orderIndex) => {
    const delayMs = delays[orderIndex] ?? 0;
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    const result = await execute(item);
    // Items may not be unique by value identity for primitives that repeat;
    // consume one original-index slot per execution so duplicates line up 1:1.
    const slots = originalIndexOf.get(item);
    const originalIndex = slots?.shift();
    if (originalIndex !== undefined) {
      resultByIndex.set(originalIndex, result);
    }
  }));

  const results = items.map((_, index) => resultByIndex.get(index) as R);
  const totalSpreadMs = delays.length > 0 ? Math.max(...delays) : 0;

  return { results, bucketCount: order.length, totalSpreadMs };
}
