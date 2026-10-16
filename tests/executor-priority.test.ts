import { expect, it } from "vitest";
import { createGate } from "../services/executor/src/gate.js";

it("admits immediately while a slot is free", async () => {
  const gate = createGate(1);
  await expect(gate.enter(false)).resolves.toBe("ok");
  expect(gate.active).toBe(1);
  gate.leave();
  expect(gate.active).toBe(0);
});

it("lets a query jump ahead of waiting background jobs", async () => {
  const gate = createGate(1);
  await gate.enter(false); // slot held by a running ingest
  const order: string[] = [];
  const a = gate.enter(false).then(() => order.push("ingest-a"));
  const q = gate.enter(true).then(() => order.push("query"));
  const b = gate.enter(false).then(() => order.push("ingest-b"));
  gate.leave(); // running ingest finishes: the query goes first
  await q;
  gate.leave(); // query finishes: ingest-a next (FIFO)
  await a;
  gate.leave();
  await b;
  expect(order).toEqual(["query", "ingest-a", "ingest-b"]);
});

it("keeps FIFO within each class", async () => {
  const gate = createGate(1);
  await gate.enter(false);
  const order: string[] = [];
  const q1 = gate.enter(true).then(() => order.push("query-1"));
  const q2 = gate.enter(true).then(() => order.push("query-2"));
  gate.leave();
  await q1;
  gate.leave();
  await q2;
  expect(order).toEqual(["query-1", "query-2"]);
});

it("refuses past the waiter cap, either class", async () => {
  const gate = createGate(1, 2);
  await gate.enter(false); // holder
  const p1 = gate.enter(false);
  const p2 = gate.enter(false);
  await expect(gate.enter(false)).resolves.toBe("full");
  await expect(gate.enter(true)).resolves.toBe("full");
  gate.leave(); // holder done: p1 admitted
  await p1;
  gate.leave(); // p1 done: p2 admitted
  await p2;
  gate.leave(); // p2 done: idle
  expect(gate.active).toBe(0);
  expect(gate.waiting).toBe(0);
});
