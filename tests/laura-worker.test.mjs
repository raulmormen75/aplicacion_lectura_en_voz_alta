import assert from "node:assert/strict";
import { test } from "node:test";
import { createLauraWorkerSession } from "../src/lib/reader/laura-worker-client.ts";
import { createPiperEngine } from "../src/lib/reader/piper-engine.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
const stages = { preparing: { stage: "preparing", message: "Laura" }, generating: { stage: "generating", message: "Laura" } };
class FakeWorker {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(data) { this.onmessage({ data }); }
}

test("worker proxy prepares once, forwards statuses and transfers actual Blob results", async () => {
  const worker = new FakeWorker(), events = [];
  const prepared = createLauraWorkerSession(s => events.push(s), () => {}, () => worker);
  assert.deepEqual(worker.messages, [{ id: 1, type: "prepare" }]);
  worker.reply({ id: 1, type: "status", update: stages.preparing });
  worker.reply({ id: 1, type: "ready" });
  const session = await prepared;
  const output = session.predict("texto");
  assert.deepEqual(worker.messages[1], { id: 2, type: "predict", text: "texto" });
  const audio = new Blob(["wav"], { type: "audio/wav" });
  worker.reply({ id: 2, type: "audio", audio });
  assert.equal(await output, audio);
  worker.reply({ id: 1, type: "status", update: stages.generating });
  assert.deepEqual(events, [stages.preparing]);
});

test("worker initialization error terminates instance; runtime fatal rejects pending work", async () => {
  const first = new FakeWorker();
  const preparation = createLauraWorkerSession(() => {}, () => {}, () => first);
  first.reply({ id: 1, type: "error", message: "network failure" });
  await assert.rejects(preparation, /network failure/);
  assert.equal(first.terminated, true);
  const worker = new FakeWorker();
  let invalidated = 0;
  const prepared = createLauraWorkerSession(() => {}, () => { invalidated++; }, () => worker);
  worker.reply({ id: 1, type: "ready" });
  const session = await prepared;
  const pending = session.predict("texto");
  worker.onerror({ message: "native crashed", preventDefault() {} });
  await assert.rejects(pending, /native crashed/);
  await assert.rejects(session.predict("retry"), /native crashed/);
  assert.equal(worker.terminated, true);
  assert.equal(invalidated, 1);
});

test("worker message and synchronous post errors reject instead of hanging", async () => {
  const worker = new FakeWorker();
  const prepared = createLauraWorkerSession(() => {}, () => {}, () => worker);
  worker.onmessageerror();
  await assert.rejects(prepared, /recibir el audio/);
  const broken = new FakeWorker();
  broken.postMessage = () => { throw Error("clone failed"); };
  await assert.rejects(createLauraWorkerSession(() => {}, () => {}, () => broken), /clone failed/);
  assert.equal(broken.terminated, true);
});

for (const mode of ["abort", "timeout"]) test(`worker ${mode} rejects on main thread, silences callbacks and retains singleflight lock`, async () => {
  const worker = new FakeWorker();
  let prepared;
  const synthesize = createPiperEngine(report => {
    prepared ??= createLauraWorkerSession(report, () => {}, () => worker);
    return prepared;
  }, stages);
  const controller = new AbortController(), events = [];
  const first = synthesize({ text: "first", signal: controller.signal, timeoutMs: mode === "timeout" ? 15 : 5000, onStatus: s => events.push(s) });
  worker.reply({ id: 1, type: "ready" });
  await tick();
  assert.equal(worker.messages[1].text, "first");
  if (mode === "abort") controller.abort();
  await assert.rejects(first, mode === "abort" ? { name: "AbortError" } : /tardo demasiado/);
  const count = events.length;
  const second = synthesize({ text: "second" });
  await tick();
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.terminated, false);
  worker.reply({ id: 2, type: "status", update: stages.generating });
  assert.equal(events.length, count);
  worker.reply({ id: 2, type: "audio", audio: new Blob(["discarded"]) });
  await tick();
  assert.equal(worker.messages[2].text, "second");
  worker.reply({ id: 3, type: "audio", audio: new Blob(["valid"]) });
  assert.equal(await (await second).audio.text(), "valid");
  assert.equal(events.length, count);
});
