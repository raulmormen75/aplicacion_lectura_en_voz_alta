import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import test from "node:test";

test("ambiguous author chains cannot hold the text cleaner past its bounded regression budget", { timeout: 10_000 }, async () => {
  // Isolate the call: a regression to exponential backtracking must not hang the test runner.
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.moduleUrl).then(({ cleanTextForSpeech, createDocumentFromText }) => {
      parentPort.once("message", (inputs) => {
        const started = performance.now();
        const output = inputs.map((input, index) => index < 3 ? cleanTextForSpeech(input)
          : createDocumentFromText({ title: "Regresión", source: "pastedText", sourceLabel: "Prueba", text: input }).cleanText);
        parentPort.postMessage({ output, elapsedMs: performance.now() - started });
      });
      parentPort.postMessage({ ready: true });
    });
  `, {
    eval: true,
    execArgv: ["--experimental-strip-types"],
    workerData: { moduleUrl: new URL("../src/lib/reader/text.ts", import.meta.url).href },
  });
  const inputs = [24, 32, 40].map((count) =>
    `La descripción (${Array(count).fill("A").join(" and ")}, 2020xx) sigue siendo necesaria.`);
  inputs.push(inputs[2].repeat(800));
  inputs.push(`${"'".repeat(100_000)}A ${"palabra ".repeat(150)}fin.`);
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error("Text worker did not initialize.")), 5_000);
      worker.on("error", reject);
      worker.on("message", (message) => {
        if (message.ready) {
          clearTimeout(timer);
          timer = setTimeout(() => reject(Error("Citation rejection exceeded 3 seconds.")), 3_000);
          worker.postMessage(inputs);
        } else {
          resolve(message);
        }
      });
    });
    assert.deepEqual(result.output, inputs);
    assert.ok(result.elapsedMs < 3_000);
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});
