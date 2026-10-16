// Admission gate for /execute: interactive queries keep capacity for
// themselves instead of queueing behind bulk work.
//
// Two rules, both needed:
//   1. At most `backgroundCap` background (ingest/export) jobs run at once, so
//      with concurrency 2 a bulk profile cannot occupy both slots and a query
//      never waits for one to finish. (Reordering alone is not enough: a query
//      arriving while an ingest runs cannot preempt it, and a wide-table
//      profile holds its slot for about a minute.)
//   2. When several jobs wait, a query goes ahead of a background job; FIFO
//      holds within each class, so neither starves the other.
export function createGate(
  concurrency: number,
  maxWaiters = 50,
  backgroundCap = Math.max(1, concurrency - 1),
) {
  let active = 0;
  let activeBackground = 0;
  const waiters: { resolve: () => void; priority: boolean }[] = [];
  const admissible = (priority: boolean) =>
    active < concurrency && (priority || activeBackground < backgroundCap);

  const admit = (priority: boolean) => {
    active++;
    if (!priority) activeBackground++;
  };

  return {
    get active() {
      return active;
    },
    get activeBackground() {
      return activeBackground;
    },
    get waiting() {
      return waiters.length;
    },
    enter(priority: boolean): Promise<"ok" | "full"> {
      if (admissible(priority)) {
        admit(priority);
        return Promise.resolve("ok");
      }
      if (waiters.length >= maxWaiters) return Promise.resolve("full");
      return new Promise<"ok">((resolve) => {
        const waiter = { resolve: () => resolve("ok"), priority };
        // Queries go ahead of waiting background jobs, behind waiting queries.
        const idx = waiter.priority
          ? waiters.findIndex((w) => !w.priority)
          : waiters.length;
        waiters.splice(idx === -1 ? waiters.length : idx, 0, waiter);
      });
    },
    leave(priority: boolean) {
      active--;
      if (!priority) activeBackground--;
      // Hand the freed capacity to the first waiter allowed to use it.
      const next = waiters.findIndex((w) => admissible(w.priority));
      if (next === -1) return;
      const [waiter] = waiters.splice(next, 1);
      admit(waiter.priority);
      waiter.resolve();
    },
  };
}