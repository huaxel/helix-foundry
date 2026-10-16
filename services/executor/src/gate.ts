// Admission gate for /execute: interactive queries jump ahead of queued
// background (ingest/export) jobs. Rationale: a bulk import can hold the
// single slot for ~60s on a wide table, and an interactive dashboard query
// waiting behind it is the 12-20x contention measured live. Queries are
// short, so ingest waits a little longer instead of queries waiting a lot
// longer; FIFO holds within each class, so neither class starves the other
// while its own jobs keep arriving alone.
export function createGate(concurrency: number, maxWaiters = 50) {
  let active = 0;
  const waiters: { resolve: () => void; priority: boolean }[] = [];
  return {
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
    enter(priority: boolean): Promise<"ok" | "full"> {
      if (active < concurrency) {
        active++;
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
    leave() {
      // The slot transfers to the next waiter; only an idle gate decrements.
      const next = waiters.shift();
      if (next) next.resolve();
      else active--;
    },
  };
}
