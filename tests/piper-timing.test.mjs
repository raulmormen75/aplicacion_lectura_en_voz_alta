import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPiperTimeline, piperWordAtTime } from "../src/lib/reader/piper-timing.ts";

const words = ["hola", "hola", "hola"].map((text, i) => ({ text, start: i * 5, end: i * 5 + 4 }));

test("silence does not move words into leading, internal or trailing gaps", () => {
  const samples = new Float32Array(6000);
  samples.fill(0.2, 1000, 2000);
  samples.fill(0.2, 3000, 5000);
  const timeline = buildPiperTimeline(words, 20, 6, samples, 1000);
  assert.deepEqual(timeline.map(x => x.startsAt), [1, 3, 4]);
  assert.deepEqual(timeline.map(x => x.wordIndex), [20, 21, 22]);
  assert.equal(piperWordAtTime(timeline, 2.9, 20), 20);
  assert.equal(piperWordAtTime(timeline, 3, 20), 21);
});

test("all playback speeds share one media clock without extra multiplication", () => {
  const timeline = buildPiperTimeline(words, 10, 6);
  for (const speed of [1, 0.85, 0.75, 0.5]) {
    const wallTime = 2.2 / speed;
    assert.equal(piperWordAtTime(timeline, wallTime * speed, 10), 11);
  }
  assert.equal(piperWordAtTime(timeline, 6, 10), 12);
  assert.equal(piperWordAtTime(timeline, 0, 10), 10);
});

test("missing audio analysis falls back to bounded monotonic estimates", () => {
  assert.deepEqual(buildPiperTimeline([], 0, 3), []);
  assert.deepEqual(buildPiperTimeline(words, 0, NaN), []);
  const timeline = buildPiperTimeline(words, 7, 6, new Float32Array(20), 1000);
  assert.deepEqual(timeline.map(x => x.startsAt), [0, 2, 4]);
  assert.equal(piperWordAtTime([], 1, 7), 7);
});
