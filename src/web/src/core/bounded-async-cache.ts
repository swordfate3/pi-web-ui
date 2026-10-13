/** LRU results plus bounded in-flight work. Failed loads are retryable, never cached. */
export function createBoundedAsyncCache<V>({
  maxEntries,
  maxWeight,
  maxPending,
  weight,
}: {
  maxEntries: number;
  maxWeight: number;
  maxPending: number;
  weight: (value: V, key: string) => number;
}) {
  const results = new Map<string, { value: V; weight: number }>();
  const pending = new Map<string, Promise<V | undefined>>();
  let totalWeight = 0;

  function get(key: string): V | undefined {
    const result = results.get(key);
    if (!result) return undefined;
    results.delete(key);
    results.set(key, result);
    return result.value;
  }

  function load(key: string, loader: () => Promise<V>): Promise<V | undefined> {
    const cached = get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = pending.get(key);
    if (running) return running;
    // A busy batch degrades to plain text, rather than retaining an unbounded queue.
    if (pending.size >= maxPending) return Promise.resolve(undefined);
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        const size = weight(value, key);
        if (size <= maxWeight) {
          while (results.size >= maxEntries || totalWeight + size > maxWeight) {
            const oldest = results.keys().next().value;
            if (oldest === undefined) break;
            totalWeight -= results.get(oldest)?.weight ?? 0;
            results.delete(oldest);
          }
          results.set(key, { value, weight: size });
          totalWeight += size;
        }
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  }

  return { get, load };
}
