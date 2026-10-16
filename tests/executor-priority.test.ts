import { expect, it } from "vitest";
import { createGate } from "../services/executor/src/gate.js";

it("admits immediately while a slot is free", async () => {
  const gate = createGate(1);
  await expect(gate.enter(false)).resolves.toBe("ok");
  expect(gate.active).toBe(1);
  gate.leave(false);
  expect(gate.active).toBe(0);
});

it("keeps a slot free for queries: a second background job waits", async () => {
  const gate = createGate(2);
  await expect(gate.enter(false)).resolves.toBe("ok"); // bulk profile running
  // A slot is free, but background work is capped at 1.
  let second: string | undefined;
  const queued = gate.enter(false).then((r) => (second = r));
  await Promise.resolve();
  expect(second).toBeUndefined();
  expect(gate.active).toBe(1);
  // The reserved slot serves a query at once — it never waits for the profile.
  await expect(gate.enter(true)).resolves.toBe("ok");
  expect(gate.active).toBe(2);
  gate.leave(true);
  // With only the profile left, the queued background job still waits.
  await Promise.resolve();
  expect(second).toBeUndefined();
  gate.leave(false);
  await queued;
  expect(second).toBe("ok");
});

it("lets a query jump ahead of waiting background jobs", async () => {
  const gate = createGate(1);
  await gate.enter(false); // slot held, and cap is 1
  const order: string[] = [];
  const a = gate.enter(false).then(() => order.push("ingest-a"));
  const q = gate.enter(true).then(() => order.push("query"));
  const b = gate.enter(false).then(() => order.push("ingest-b"));
  gate.leave(false); // the running ingest finishes: the query goes first
  await q;
  gate.leave(true);
  await a;
  gate.leave(false);
  await b;
  expect(order).toEqual(["query", "ingest-a", "ingest-b"]);
});

it("keeps FIFO within each class", async () => {
  const gate = createGate(1);
  await gate.enter(true);
  const order: string[] = [];
  const q1 = gate.enter(true).then(() => order.push("query-1"));
  const q2 = gate.enter(true).then(() => order.push("query-2"));
  gate.leave(true);
  await q1;
  gate.leave(true);
  await q2;
  expect(order).toEqual(["query-1", "query-2"]);
});

it("refuses past the waiter cap, either class", async () => {
  const gate = createGate(1, 2);
  await gate.enter(false);
  const p1 = gate.enter(false);
  const p2 = gate.enter(false);
  await expect(gate.enter(false)).resolves.toBe("full");
  await expect(gate.enter(true)).resolves.toBe("full");
  gate.leave(false);
  await p1;
  gate.leave(false);
  await p2;
  gate.leave(false);
  expect(gate.active).toBe(0);
  expect(gate.activeBackground).toBe(0);
  expect(gate.waiting).toBe(0);
});