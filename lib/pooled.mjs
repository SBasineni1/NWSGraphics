/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Shared by the publisher and the pre-build probe gate so both bound their pressure on
 * api.weather.gov the same way. Kept as its own module rather than exported from
 * office-probe.mjs because it knows nothing about offices.
 */
export async function pooled(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}
