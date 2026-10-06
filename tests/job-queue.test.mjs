// The headless service's queue (src/job-queue.ts): one job at a time, a bounded queue, callers that left are skipped.
import test from "node:test";
import assert from "node:assert/strict";
import { Busy, Gone, JobQueue } from "../src/job-queue.ts";

const deferred = () => { let done; const p = new Promise((ok) => { done = ok; }); return { p, done }; };
const stay = () => new AbortController().signal;

test("jobs run one at a time, in order", async () => {
  const q = new JobQueue(4);
  const order = [];
  const a = deferred();
  const first = q.add(async () => { order.push("a start"); await a.p; order.push("a end"); return "a"; }, stay());
  const second = q.add(async () => { order.push("b"); return "b"; }, stay());
  await new Promise((ok) => setTimeout(ok, 10));
  assert.deepEqual(order, ["a start"]);
  assert.equal(q.status().queued, 2);
  a.done();
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(order, ["a start", "a end", "b"]);
  assert.deepEqual(q.status(), { queued: 0, runningMs: 0, skipped: 0 });
});

test("a full queue refuses at once and accepts again once there is room", async () => {
  const q = new JobQueue(2);
  const a = deferred();
  const first = q.add(() => a.p, stay());
  const second = q.add(async () => "b", stay());
  await assert.rejects(q.add(async () => "c", stay()), Busy);
  a.done("a");
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.equal(await q.add(async () => "d", stay()), "d");
});

test("a caller that leaves before its turn frees its slot and its job never runs", async () => {
  const q = new JobQueue(2);
  const a = deferred();
  let ran = false;
  const first = q.add(() => a.p, stay());
  const leaving = new AbortController();
  const skipped = q.add(async () => { ran = true; }, leaving.signal);
  await assert.rejects(q.add(async () => "full", stay()), Busy);
  leaving.abort();
  assert.equal(q.status().queued, 1, "the slot is free as soon as the caller leaves");
  const later = q.add(async () => "later", stay());
  a.done("a");
  assert.equal(await first, "a");
  await assert.rejects(skipped, Gone);
  assert.equal(await later, "later");
  assert.equal(ran, false);
  assert.deepEqual(q.status(), { queued: 0, runningMs: 0, skipped: 1 });
});

test("a running job whose caller leaves still finishes and holds its slot until then", async () => {
  const q = new JobQueue(1);
  const a = deferred();
  const leaving = new AbortController();
  const first = q.add(() => a.p, leaving.signal);
  await new Promise((ok) => setTimeout(ok, 10));
  leaving.abort();
  assert.ok(q.status().runningMs >= 0);
  await assert.rejects(q.add(async () => "b", stay()), Busy);
  a.done("a");
  assert.equal(await first, "a");
  assert.equal(q.status().queued, 0);
});

test("a failing job does not stop the queue", async () => {
  const q = new JobQueue(2);
  const bad = q.add(async () => { throw new Error("boom"); }, stay());
  const good = q.add(async () => "ok", stay());
  await assert.rejects(bad, /boom/);
  assert.equal(await good, "ok");
  assert.equal(q.status().queued, 0);
});
