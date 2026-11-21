// items handled at once: an item can cost a tridant id call, each up to its 5 s timeout.
const BATCH_SIZE = 10;

/** runs `run` over `items` ten at a time, answering in order. */
export async function inBatches<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    results.push(...(await Promise.all(items.slice(i, i + BATCH_SIZE).map(run))));
  }
  return results;
}
