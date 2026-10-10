import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Run the real modules in memory, with transport/DNS supplied by local fixtures.
function load(file, mocks = {}, globals = {}) {
  const cache = new Map();
  const visit = (path) => {
    if (cache.has(path)) return cache.get(path);
    const compiled = { exports: {} };
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(code, {
      module: compiled, exports: compiled.exports,
      require: (id) => id in mocks ? mocks[id] : id.startsWith("@/") ? visit(resolve("src", id.slice(2) + ".ts")) : require(id),
      process: { env: {}, cwd: () => process.cwd() },
      Buffer, Request, Response, URL, Uint8Array, AbortController,
      setTimeout, clearTimeout, console, ...globals,
    }, { filename: path });
    cache.set(path, compiled.exports);
    return compiled.exports;
  };
  return visit(resolve(file));
}

const safety = load("src/lib/server/http-safety.ts");
const hf = load("src/lib/server/huggingface-speech.ts", { "@/lib/server/http-safety": safety });
const mexico = hf.HF_VOICES["hf-mexico"].origin;
const dora = hf.HF_VOICES["hf-dora"].origin;
const fileUrl = (origin) => `${origin}/gradio_api/file=/tmp/synthetic/generated.wav`;
const reference = (origin = mexico) => ({
  path: "/tmp/synthetic/reference.wav", url: `${origin}/gradio_api/file=/tmp/synthetic/reference.wav`,
  orig_name: "reference.wav", mime_type: "audio/wav", is_stream: false, meta: { _type: "gradio.FileData" },
});

function wav(samples = 2) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8);
  bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(22050, 24); bytes.writeUInt32LE(44100, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(index % 2 ? -100 : 100, 44 + index * 2);
  return bytes;
}

const json = (value) => ({ headers: { "content-type": "application/json" }, chunks: [JSON.stringify(value)] });
const events = (value) => ({ headers: { "content-type": "text/event-stream; charset=utf-8" }, chunks: [value] });
const complete = (output) => `event: heartbeat\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([output])}\n\n`;

function flow(voice, { configValue = reference(), output, audio = wav(), mime = "audio/wav", eventId = "synthetic_1", sse } = {}) {
  const origin = voice === "hf-mexico" ? mexico : dora;
  const replies = [json({ event_id: eventId }), events(sse ?? complete(output ?? { url: fileUrl(origin), is_stream: false })),
    { headers: { "content-type": mime }, chunks: [audio] }];
  if (voice === "hf-mexico") replies.unshift(json({ components: [
    { type: "audio", props: { label: "Some other audio", value: reference(dora) } },
    { type: "audio", props: { label: "Reference Audio File (Optional)", value: configValue } },
  ] }));
  return replies;
}

function network(replies, addresses = [{ address: "93.184.216.34", family: 4 }]) {
  const calls = [];
  const lookups = [];
  const transport = (url, options, callback) => {
    const request = new EventEmitter();
    request.end = (body) => {
      calls.push({ url: url.href, options, body });
      queueMicrotask(() => {
        const reply = replies.shift();
        if (!reply) { request.emit("error", new Error("Unexpected fixture request")); return; }
        const response = new PassThrough();
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        callback(response);
        for (const chunk of reply.chunks ?? []) response.write(Buffer.from(chunk));
        response.end();
      });
    };
    return request;
  };
  const safeReader = safety.createRemoteReader({
    lookup: async (hostname) => { lookups.push(hostname); return addresses; },
    httpRequest: transport, httpsRequest: transport,
  });
  const reads = [];
  return {
    calls, reads, lookups,
    reader: (url, options) => { reads.push({ url, options }); return safeReader(url, options); },
  };
}

test("SSE ignores progress, handles CRLF and multiline data, and returns the complete result", () => {
  const input = "event: generating\r\ndata: null\r\n\r\nevent: complete\r\ndata: [\r\ndata: {\"url\":\"/gradio_api/file=/tmp/synthetic.wav\"}\r\ndata: ]\r\n\r\n";
  assert.equal(JSON.stringify(hf.parseGradioResult(input)), '[{"url":"/gradio_api/file=/tmp/synthetic.wav"}]');
});

test("SSE error is terminal and missing or malformed completion cannot yield audio", () => {
  for (const sse of ["event: error\ndata: upstream details\n\n", "event: heartbeat\ndata: null\n\n", "event: complete\ndata: {}\n\n"]) {
    assert.throws(() => hf.parseGradioResult(sse), { status: 503 });
  }
  assert.throws(() => hf.parseGradioResult("event: error\ndata: failure\n\n" + complete({ url: fileUrl(dora) })), { status: 503 });
  assert.throws(() => hf.parseGradioResult("event: complete\ndata: [invalid JSON]\n\n"));
});

test("audio URL accepts the configured file origin and blocks alternate origins, credentials and traversal", () => {
  assert.equal(hf.validateAudioUrl(fileUrl(dora), dora), fileUrl(dora));
  assert.equal(hf.validateAudioUrl("/gradio_api/file=/tmp/synthetic.wav", dora), `${dora}/gradio_api/file=/tmp/synthetic.wav`);
  const denied = [
    undefined, null, 42, "a".repeat(2049),
    "http://127.0.0.1/gradio_api/file=x", "http://169.254.169.254/gradio_api/file=x", "https://[::1]/gradio_api/file=x",
    "https://example.test/gradio_api/file=x", "//example.test/gradio_api/file=x", `${dora.replace("https://", "https://user:pass@")}/gradio_api/file=x`,
    `${dora}:444/gradio_api/file=x`, `${dora.replace("https://", "http://")}/gradio_api/file=x`,
    `${dora}/config`, `${dora}/gradio_api/file=/../../config`, `${dora}/gradio_api/%66ile=x`,
    "data:audio/wav;base64,UklGRg==", "file:///etc/passwd", "javascript:alert(1)",
  ];
  for (const value of denied) assert.throws(() => hf.validateAudioUrl(value, dora), { status: 502 }, String(value));
});

test("Dora uses the fixed public endpoint, preserves cancellation and returns a real WAV", async () => {
  const expected = wav();
  const mock = network(flow("hf-dora", { audio: expected }));
  const controller = new AbortController();
  assert.deepEqual(await hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Texto sintético.", controller.signal), expected);
  assert.deepEqual(mock.calls.map((call) => call.url), [
    `${dora}/gradio_api/call/predict`, `${dora}/gradio_api/call/predict/synthetic_1`, fileUrl(dora),
  ]);
  assert.deepEqual(JSON.parse(mock.calls[0].body).data, ["Texto sintético.", "ef_dora", 1]);
  for (const { options } of mock.reads) {
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.signal, controller.signal);
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 42000);
    assert.equal(options.trustedEndpoint, undefined);
    assert.equal(options.headers?.authorization, undefined);
  }
  assert.deepEqual(Array.from(mock.reads[2].options.allowedContentTypes), ["application/octet-stream", "audio/wav", "audio/x-wav"]);
  assert.equal(mock.reads[2].options.maxBytes, 5 * 1024 * 1024);
  assert.equal(mock.calls[0].options.agent, false);
});

test("Mexican voice loads its non-null dynamic FileData reference from /config and reuses metadata", async () => {
  const first = flow("hf-mexico");
  const second = flow("hf-mexico");
  second.shift();
  const mock = network([...first, ...second]);
  const speech = hf.createHuggingFaceSpeech(mock.reader);
  await speech("hf-mexico", "Primera prueba.");
  await speech("hf-mexico", "Segunda prueba.");
  assert.equal(mock.calls.filter((call) => call.url === `${mexico}/config`).length, 1);
  const posted = mock.calls.filter((call) => call.options.method === "POST").map((call) => JSON.parse(call.body).data);
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[0], ["Primera prueba.", reference(), 0.5, 0.8, 0, 0.5]);
  assert.deepEqual(posted[1], ["Segunda prueba.", reference(), 0.5, 0.8, 0, 0.5]);
  assert.equal(mock.reads[0].options.maxBytes, 500000);
});

test("Mexican metadata expires and missing or foreign references never start generation", async () => {
  let now = 1000;
  const timed = load("src/lib/server/huggingface-speech.ts", { "@/lib/server/http-safety": safety }, { Date: { now: () => now } });
  const mock = network([...flow("hf-mexico"), ...flow("hf-mexico")]);
  const speech = timed.createHuggingFaceSpeech(mock.reader);
  await speech("hf-mexico", "Primera prueba.");
  now += 30 * 60000 + 1;
  await speech("hf-mexico", "Prueba posterior.");
  assert.equal(mock.calls.filter((call) => call.url === `${mexico}/config`).length, 2);
  for (const value of [null, reference(dora), { ...reference(), meta: { _type: "Unexpected" } }]) {
    const denied = network(flow("hf-mexico", { configValue: value }));
    await assert.rejects(hf.createHuggingFaceSpeech(denied.reader)("hf-mexico", "Prueba."));
    assert.equal(denied.calls.length, 1);
  }
});

test("voice and text limits are validated before network, including exact accepted boundaries", async () => {
  const speech = hf.createHuggingFaceSpeech(() => assert.fail("invalid input reached the network"));
  for (const [voice, text] of [["unknown", "x"], ["hf-mexico", " "] , ["hf-mexico", "x".repeat(281)], ["hf-dora", "x".repeat(721)]]) {
    await assert.rejects(speech(voice, text), { status: 400 });
  }
  for (const [voice, size] of [["hf-mexico", 280], ["hf-dora", 720]]) {
    const mock = network(flow(voice));
    await hf.createHuggingFaceSpeech(mock.reader)(voice, "x".repeat(size));
    assert.equal(JSON.parse(mock.calls.find((call) => call.options.method === "POST").body).data[0].length, size);
  }
});

test("event identifiers, upstream errors and streaming outputs cannot trigger audio download", async () => {
  for (const eventId of ["../config", "?secret=1", "", "x".repeat(129), null]) {
    const mock = network(flow("hf-dora", { eventId }));
    await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."), { status: 503 });
    assert.equal(mock.calls.length, 1);
  }
  for (const options of [{ sse: "event: error\ndata: synthetic failure\n\n" }, { output: { url: fileUrl(dora), is_stream: true } }, { output: {} }]) {
    const mock = network(flow("hf-dora", options));
    await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."));
    assert.equal(mock.calls.length, 2);
  }
});

test("foreign audio URLs and redirects are rejected without following an extra destination", async () => {
  const foreign = network(flow("hf-dora", { output: { url: "http://127.0.0.1/gradio_api/file=x" } }));
  await assert.rejects(hf.createHuggingFaceSpeech(foreign.reader)("hf-dora", "Prueba."), { status: 502 });
  assert.equal(foreign.calls.length, 2);
  for (const redirectIndex of [0, 1, 2]) {
    const replies = flow("hf-dora");
    replies[redirectIndex] = { status: 302, headers: { location: "https://other.test/gradio_api/file=x" } };
    const mock = network(replies);
    await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."), { status: 502 });
    assert.equal(mock.calls.length, redirectIndex + 1);
  }
});

test("a configured public host that resolves privately is rejected before transport", async () => {
  const mock = network(flow("hf-dora"), [{ address: "127.0.0.1", family: 4 }]);
  await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."), { status: 400 });
  assert.equal(mock.lookups.length, 1);
  assert.equal(mock.calls.length, 0);
});

test("audio MIME and streaming byte limits reject HTML, compressed or oversized responses", async () => {
  for (const audioReply of [
    { headers: { "content-type": "text/html" }, chunks: [wav()] },
    { headers: { "content-type": "audio/mpeg" }, chunks: [wav()] },
    { headers: { "content-type": "audio/wav", "content-length": String(5 * 1024 * 1024 + 1) }, chunks: [] },
    { headers: { "content-type": "audio/wav", "content-length": "1" }, chunks: [Buffer.alloc(5 * 1024 * 1024), Buffer.from([1])] },
    { headers: { "content-type": "audio/wav", "content-encoding": "gzip" }, chunks: [wav()] },
  ]) {
    const replies = flow("hf-dora");
    replies[2] = audioReply;
    const mock = network(replies);
    await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."), { status: 502 });
  }
  const generic = network(flow("hf-dora", { mime: "application/octet-stream" }));
  assert.deepEqual(await hf.createHuggingFaceSpeech(generic.reader)("hf-dora", "Prueba."), wav());
});

test("WAV rejects wrong magic, truncated sample data, missing chunks and empty audio", async () => {
  const noChunks = Buffer.alloc(44);
  noChunks.write("RIFF", 0); noChunks.writeUInt32LE(36, 4); noChunks.write("WAVE", 8);
  for (const invalid of [Buffer.alloc(48), wav().subarray(0, 43), wav().subarray(0, 45), noChunks, wav(0)]) {
    const mock = network(flow("hf-dora", { audio: invalid }));
    await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."), { status: 502 });
  }
});

test("WAV accepts optional padded chunks and rejects inconsistent PCM frame metadata", async () => {
  const junk = Buffer.alloc(10);
  junk.write("JUNK", 0); junk.writeUInt32LE(1, 4); junk[8] = 7;
  const base = wav();
  const padded = Buffer.concat([base.subarray(0, 36), junk, base.subarray(36)]);
  padded.writeUInt32LE(padded.length - 8, 4);
  const valid = network(flow("hf-dora", { audio: padded }));
  assert.deepEqual(await hf.createHuggingFaceSpeech(valid.reader)("hf-dora", "Prueba."), padded);
  const invalid = [
    [22, 0, "writeUInt16LE"], [24, 0, "writeUInt32LE"], [28, 1, "writeUInt32LE"],
    [32, 3, "writeUInt16LE"], [34, 0, "writeUInt16LE"],
  ];
  for (const [offset, value, method] of invalid) {
    const broken = wav();
    broken[method](value, offset);
    const mock = network(flow("hf-dora", { audio: broken }));
    await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba."), { status: 502 });
  }
});

test("the 42 second deadline applies to the entire generation, not independently to each hop", async () => {
  let now = 1000;
  const timed = load("src/lib/server/huggingface-speech.ts", { "@/lib/server/http-safety": safety }, { Date: { now: () => now } });
  const reads = [];
  const speech = timed.createHuggingFaceSpeech(async (url, options) => {
    reads.push({ url, options });
    now += 42001;
    return { body: Buffer.from(JSON.stringify({ event_id: "synthetic_1" })) };
  });
  await assert.rejects(speech("hf-dora", "Prueba."), { status: 504 });
  assert.equal(reads.length, 1);
  assert.equal(reads[0].options.timeoutMs, 42000);
});

test("an already cancelled generation does not resolve DNS or start transport", async () => {
  const mock = network(flow("hf-dora"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(hf.createHuggingFaceSpeech(mock.reader)("hf-dora", "Prueba.", controller.signal), { status: 499 });
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.lookups.length, 0);
});

const request = (payload, headers = {}, signal) => new Request("http://test/api/speech", {
  method: "POST", body: JSON.stringify(payload), signal,
  headers: { "content-type": "application/json", origin: "http://test", ...headers },
});
function speechRoute(synthesize) {
  return load("src/app/api/speech/route.ts", {
    "@/lib/server/http-safety": safety,
    "@/lib/server/huggingface-speech": { HF_VOICES: hf.HF_VOICES, huggingFaceSpeech: synthesize },
  });
}

test("speech API returns no-store WAV without exposing upstream errors or using credentials", async () => {
  const received = [];
  const route = speechRoute(async (...args) => { received.push(args); return wav(); });
  const req = request({ voice: "hf-mexico", text: "Prueba sintética." });
  const response = await route.POST(req);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav());
  assert.equal(received[0][0], "hf-mexico");
  assert.equal(received[0][1], "Prueba sintética.");
  assert.equal(received[0][2], req.signal);
  const broken = speechRoute(async () => { throw new Error("synthetic private upstream detail"); });
  const failure = await broken.POST(request({ voice: "hf-dora", text: "Prueba." }));
  assert.equal(failure.status, 503);
  assert.equal(failure.headers.get("cache-control"), "no-store");
  assert.equal(JSON.stringify(await failure.json()).includes("private upstream"), false);
});

test("speech API rejects invalid input, body size, content type and cross-site origin before synthesis", async () => {
  const route = speechRoute(() => assert.fail("invalid request reached synthesis"));
  for (const payload of [null, {}, { voice: "unknown", text: "x" }, { voice: "hf-mexico", text: " " }, { voice: "hf-mexico", text: "x".repeat(281) }, { voice: "hf-dora", text: "x".repeat(721) }]) {
    assert.equal((await route.POST(request(payload))).status, 400);
  }
  assert.equal((await route.POST(request({ voice: "hf-dora", text: "x" }, { origin: "https://other.test" }))).status, 403);
  assert.equal((await route.POST(request({ voice: "hf-dora", text: "x" }, { "sec-fetch-site": "cross-site" }))).status, 403);
  assert.equal((await route.POST(request({ voice: "hf-dora", text: "x" }, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await route.POST(request({ voice: "hf-dora", text: "x" }, { "content-length": "5001" }))).status, 413);
  assert.equal((await route.POST(request({ extra: "x".repeat(5001) }))).status, 413);
  const malformed = new Request("http://test/api/speech", { method: "POST", body: "{", headers: { origin: "http://test", "content-type": "application/json" } });
  assert.equal((await route.POST(malformed)).status, 400);
});

test("speech API enforces concurrent and per-minute limits and releases slots after failure", async () => {
  const pending = [];
  const route = speechRoute(() => new Promise((resolve) => pending.push(resolve)));
  const running = Array.from({ length: 4 }, () => route.POST(request({ voice: "hf-dora", text: "Prueba." })));
  await new Promise((resolve) => setImmediate(resolve));
  const throttled = await route.POST(request({ voice: "hf-dora", text: "Prueba." }));
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get("retry-after"), "1");
  for (const resolve of pending) resolve(wav());
  assert.ok((await Promise.all(running)).every((response) => response.status === 200));
  const immediate = speechRoute(async () => { throw new safety.SafeHttpError("Synthetic failure", 502); });
  for (let index = 0; index < 24; index++) assert.equal((await immediate.POST(request({ voice: "hf-dora", text: "Prueba." }))).status, 502);
  const limited = await immediate.POST(request({ voice: "hf-dora", text: "Prueba." }));
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});
