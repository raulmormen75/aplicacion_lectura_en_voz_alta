import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { crc32, deflateRawSync } from "node:zlib";
import { getEventListeners } from "node:events";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Compile in memory: no build output, real network, or user documents.
function load(file, mocks = {}, env = {}) {
  const cache = new Map();
  const visit = (path) => {
    if (cache.has(path)) return cache.get(path);
    const compiled = { exports: {} };
    const js = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (id) => {
      if (id in mocks) return mocks[id];
      if (id.startsWith("@/")) return visit(resolve("src", id.slice(2) + ".ts"));
      return require(id);
    };
    vm.runInNewContext(js, {
      module: compiled, exports: compiled.exports, require: localRequire,
      process: { env, cwd: () => process.cwd() },
      Buffer, Request, Response, File, FormData, URL, Uint8Array, AbortController,
      setTimeout, clearTimeout, console, crypto: globalThis.crypto,
    }, { filename: path });
    cache.set(path, compiled.exports);
    return compiled.exports;
  };
  return visit(resolve(file));
}

const safety = load("src/lib/server/http-safety.ts");
const publicIp = { address: "93.184.216.34", family: 4 };
function network(replies, addresses = [publicIp]) {
  const calls = [];
  const dnsCalls = [];
  const transport = (url, options, callback) => {
    const request = new EventEmitter();
    request.end = (body) => {
      calls.push({ url: url.href, options, body });
      queueMicrotask(() => {
        const reply = replies.shift() ?? {};
        if (reply.error) { request.emit("error", Error(reply.error)); return; }
        const response = new PassThrough();
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        callback(response);
        if (reply.hang) {
          options.signal.addEventListener("abort", () => response.destroy(Error("aborted")), { once: true });
          return;
        }
        for (const chunk of reply.chunks ?? ["ok"]) response.write(Buffer.from(chunk));
        response.end();
      });
    };
    return request;
  };
  const reader = safety.createRemoteReader({
    lookup: async (host) => { dnsCalls.push(host); return typeof addresses === "function" ? addresses(host) : addresses; },
    httpRequest: transport, httpsRequest: transport,
  });
  return { reader, calls, dnsCalls };
}

test("reject special/private IPv4 and IPv6, allow ordinary global addresses", () => {
  const denied = ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "192.0.2.1", "198.18.0.1", "198.51.100.2", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fc00::1", "ff02::1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "2001::1", "3fff::1", "garbage"];
  for (const ip of denied) assert.equal(safety.isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(safety.isPublicAddress(ip), true, ip);
});

test("adversarial URL spellings never reach transport", async () => {
  for (const url of ["http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:127.0.0.1]/", "file:///etc/passwd", "data:text/plain,hello", "ftp://example.com", "https://user:pass@example.com/", "http://[fe80::1%25eth0]/"]) {
    const mock = network([]);
    await assert.rejects(mock.reader(url), undefined, url);
    assert.equal(mock.calls.length, 0, url);
  }
});

test("reject DNS private records, including mixed public/private answers", async () => {
  for (const records of [[], [{ address: "127.0.0.1", family: 4 }], [publicIp, { address: "::1", family: 6 }]]) {
    const mock = network([], records);
    await assert.rejects(mock.reader("https://example.test"));
    assert.equal(mock.calls.length, 0);
  }
});

test("pin validated DNS while preserving hostname and disabling connection reuse", async () => {
  const mock = network([{}]);
  await mock.reader("https://example.test/a");
  assert.equal(mock.dnsCalls.length, 1);
  const { options, url } = mock.calls[0];
  assert.equal(url, "https://example.test/a");
  assert.equal(options.agent, false);
  options.lookup("example.test", {}, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, publicIp.address); assert.equal(family, 4);
  });
  options.lookup("example.test", { all: true }, (error, records) => {
    assert.equal(error, null); assert.equal(records[0].address, publicIp.address);
  });
});

test("revalidate redirects, cap loops and reject HTTPS downgrade", async () => {
  for (const location of ["http://127.0.0.1/", "https://[::1]/", "http://example.test/", "file:///etc/passwd"]) {
    const mock = network([{ status: 302, headers: { location } }]);
    await assert.rejects(mock.reader("https://example.test/"));
    assert.equal(mock.calls.length, 1);
  }
  const loop = network(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/again" } })));
  await assert.rejects(loop.reader("https://example.test"));
  assert.equal(loop.calls.length, 4);
  const ok = network([{ status: 302, headers: { location: "/next" } }, { chunks: ["final"] }]);
  assert.equal((await ok.reader("https://example.test")).body.toString(), "final");
  assert.equal(ok.dnsCalls.length, 2);
});

test("limit response bytes even without or with dishonest content-length", async () => {
  for (const reply of [{ headers: { "content-length": "100" } }, { chunks: ["123", "456"] }, { headers: { "content-length": "1" }, chunks: ["123456"] }, { headers: { "content-encoding": "gzip" } }]) {
    const mock = network([reply]);
    await assert.rejects(mock.reader("https://example.test", { maxBytes: 5 }));
  }
});

test("reject bad status and missing/incompatible content-type before consuming body", async () => {
  for (const reply of [
    { status: 404, headers: { "content-type": "text/html" } },
    { status: 500, headers: { "content-type": "text/html" } },
    { status: 304 }, { status: 200 },
    { headers: { "content-type": "application/octet-stream" } },
  ]) {
    const mock = network([{ ...reply, hang: true }]);
    await assert.rejects(mock.reader("https://example.test", { allowedContentTypes: ["text/html"], timeoutMs: 50 }), { status: 502 });
  }
  const mock = network([{ headers: { "content-type": "Text/HTML; charset=utf-8" }, chunks: ["hello"] }]);
  assert.equal((await mock.reader("https://example.test", { allowedContentTypes: ["text/html"] })).body.toString(), "hello");
});

test("redirect to a hostname with private DNS is denied on the next hop", async () => {
  const alternate = network([{ status: 302, headers: { location: "https://internal.test/" } }],
    (host) => host === "internal.test" ? [{ address: "10.0.0.1", family: 4 }] : [publicIp]);
  await assert.rejects(alternate.reader("https://example.test"));
  assert.equal(alternate.calls.length, 1);
  assert.deepEqual(alternate.dnsCalls, ["example.test", "internal.test"]);
});

test("deadline includes DNS lookup and stalled response bodies", async () => {
  const dns = safety.createRemoteReader({ lookup: () => new Promise(() => {}), httpRequest: () => assert.fail(), httpsRequest: () => assert.fail() });
  await assert.rejects(dns("https://example.test", { timeoutMs: 10 }), { status: 504 });
  const mock = network([{ hang: true }]);
  await assert.rejects(mock.reader("https://example.test", { timeoutMs: 10 }), { status: 504 });
});

test("trusted inference endpoint permits loopback but never forwards POST redirects", async () => {
  const mock = network([{ status: 307, headers: { location: "https://other.test" } }]);
  await assert.rejects(mock.reader("http://127.0.0.1:8080", { trustedEndpoint: true, method: "POST", body: "synthetic" }));
  assert.equal(mock.calls.length, 1);
});

test("bound request stream and return safe JSON errors", async () => {
  const req = (body, headers = {}) => new Request("http://test", { method: "POST", body, headers });
  await assert.rejects(safety.readBoundedBody(req("123456"), 5), { status: 413 });
  await assert.rejects(safety.readBoundedBody(req("1", { "content-length": "6" }), 5), { status: 413 });
  await assert.rejects(safety.readBoundedJson(req("{")), { status: 400 });
  assert.equal(Buffer.from(await safety.readBoundedBody(req("12345"), 5)).toString(), "12345");
});

const jsonRequest = (payload, headers = {}) => new Request("http://test", { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json", origin: "http://test", ...headers } });
test("reconstruct validates inputs without contacting inference", async () => {
  const route = load("src/app/api/text/reconstruct/route.ts", { "@/lib/server/http-safety": { ...safety, readRemote: () => assert.fail("network") } });
  for (const [text, status] of [["", 400], ["   ", 400], [42, 400], ["a".repeat(24_001), 413]]) {
    assert.equal((await route.POST(jsonRequest({ text }))).status, status);
  }
  assert.equal((await route.POST(new Request("http://test", { method: "POST", body: "{", headers: { "content-type": "application/json", origin: "http://test" } }))).status, 400);
  assert.equal((await (await route.POST(jsonRequest({ text: "Texto sintetico." }))).json()).mode, "clean-only");
});

test("reconstruct safely falls back for upstream errors, malformed/empty/truncated output", async () => {
  for (const reply of [Error("secret connection details"), { status: 503, body: Buffer.from("secret") }, { status: 200, body: Buffer.from("not-json") }, ...[{}, { text: 42 }, { text: " " }, { text: "a".repeat(48_001) }, { choices: [{ text: "inicio", finish_reason: "length" }] }].map((obj) => ({ status: 200, body: Buffer.from(JSON.stringify(obj)) }))]) {
    const route = load("src/app/api/text/reconstruct/route.ts", { "@/lib/server/http-safety": { ...safety, readRemote: async () => { if (reply instanceof Error) throw reply; return reply; } } }, { GPT_OSS_ENDPOINT: "http://localhost:8080" });
    const response = await route.POST(jsonRequest({ text: "Texto sintetico completo." }));
    const data = await response.json();
    assert.equal(response.status, 200); assert.equal(data.mode, "clean-only");
    assert.equal(data.text, "Texto sintetico completo.");
    assert.ok(!JSON.stringify(data).includes("secret"));
  }
});

test("reconstruct retains successful response contract", async () => {
  const route = load("src/app/api/text/reconstruct/route.ts", { "@/lib/server/http-safety": { ...safety, readRemote: async (_url, options) => {
    assert.equal(options.method, "POST"); assert.equal(options.maxRedirects, 0);
    return { status: 200, body: Buffer.from(JSON.stringify({ choices: [{ message: { content: "Texto corregido." }, finish_reason: "stop" }] })) };
  } } }, { GPT_OSS_ENDPOINT: "http://localhost:8080" });
  const response = await route.POST(jsonRequest({ text: "Texto sintetico." }));
  const data = await response.json();
  assert.equal(data.mode, "reconstructed"); assert.equal(data.text, "Texto corregido.");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("documents retains pasted text and multipart contracts with safe errors", async () => {
  const route = load("src/app/api/documents/process/route.ts", { "@/lib/server/http-safety": { ...safety, readRemote: async () => { throw Error("secret-host-path"); } } });
  let response = await route.POST(jsonRequest({ source: "pastedText", text: "Texto sintetico completo." }));
  assert.equal(response.status, 200); assert.ok((await response.json()).document.cleanText);
  const form = new FormData(); form.append("file", new File(["Texto sintetico."], "sample.txt", { type: "text/plain" }));
  response = await route.POST(new Request("http://test", { method: "POST", body: form, headers: { origin: "http://test" } }));
  assert.equal(response.status, 200); assert.ok((await response.json()).document);
  response = await route.POST(new Request("http://test", { method: "POST", body: "{", headers: { "content-type": "application/json", origin: "http://test" } }));
  assert.equal(response.status, 400);
  response = await route.POST(jsonRequest({ source: "pastedText", text: "a".repeat(300_001) }));
  assert.equal(response.status, 413);
  response = await route.POST(jsonRequest({ source: "website", url: "https://example.test" }));
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes("secret-host-path"));
});

const fileRequest = (body, name, type) => {
  const form = new FormData(); form.append("file", new File([body], name, { type }));
  return new Request("http://test", { method: "POST", body: form, headers: { origin: "http://test" } });
};

test("documents rejects oversized multipart and unsupported old Word format", async () => {
  const route = load("src/app/api/documents/process/route.ts");
  assert.equal((await route.POST(fileRequest("x".repeat(4_000_001), "big.txt", "text/plain"))).status, 413);
  assert.equal((await route.POST(fileRequest("old binary format", "old.doc", "application/msword"))).status, 415);
  assert.equal((await route.POST(fileRequest("", "empty.txt", "text/plain"))).status, 400);
});

test("documents bounds serialized output, including metadata amplification", async () => {
  const text = load("src/lib/reader/text.ts");
  const route = load("src/app/api/documents/process/route.ts", {
    "@/lib/reader/text": { ...text, createDocumentFromText: () => ({ originalText: "a".repeat(4_000_001) }) },
  });
  const response = await route.POST(jsonRequest({ source: "pastedText", text: "Texto." }));
  assert.equal(response.status, 413);
  assert.ok((await response.text()).length < 1000);
});

test("PDF compatibility: text, no text, page cap and cleanup on parser failure", async () => {
  for (const scenario of ["text", "empty", "pages", "failure"]) {
    let destroyed = 0; let cleaned = 0;
    const pdf = {
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({ numPages: scenario === "pages" ? 201 : 1, getPage: async () => ({
          getTextContent: async () => {
            if (scenario === "failure") throw Error("private parser detail");
            return { items: scenario === "empty" ? [] : [{ str: "Documento sintetico con texto seleccionable.", hasEOL: true }] };
          },
          cleanup: () => { cleaned++; },
        }) }),
        destroy: async () => { destroyed++; },
      }),
    };
    const route = load("src/app/api/documents/process/route.ts", { "pdfjs-dist/legacy/build/pdf.mjs": pdf });
    const response = await route.POST(fileRequest("%PDF-synthetic", "sample.pdf", "application/pdf"));
    assert.equal(response.status, { text: 200, empty: 422, pages: 413, failure: 500 }[scenario]);
    assert.equal(destroyed, 1); assert.equal(cleaned, scenario === "pages" ? 0 : 1);
    assert.ok(!(await response.text()).includes("private parser detail"));
  }
});

test("DOCX parser contract remains compatible", async () => {
  const route = load("src/app/api/documents/process/route.ts", { mammoth: {
    images: require("mammoth").images,
    convertToHtml: async (_input, options) => {
      assert.equal(options.externalFileAccess, false);
      assert.ok(options.convertImage);
      return { value: "<p>Texto Word sintetico.</p>", messages: [] };
    },
  } });
  const response = await route.POST(fileRequest(docxZip(), "sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).document.cleanText, "Texto Word sintetico.");
});

function docxZip(entries = [
  { name: "[Content_Types].xml", content: "<Types/>" },
  { name: "word/document.xml", content: "<document>Texto sintetico.</document>" },
]) {
  const files = []; const directory = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const content = Buffer.from(entry.content);
    const method = entry.method ?? 8;
    const compressed = method === 0 ? content : deflateRawSync(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc32(content), 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.claimedSize ?? content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.claimedSize ?? content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    files.push(local, name, compressed); directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const index = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}

test("external cancellation stops DNS/body work and removes signal listeners", async () => {
  const dnsController = new AbortController();
  const dns = safety.createRemoteReader({ lookup: () => new Promise(() => {}), httpRequest: () => assert.fail(), httpsRequest: () => assert.fail() });
  const pendingDns = dns("https://example.test", { signal: dnsController.signal, timeoutMs: 100 });
  dnsController.abort();
  await assert.rejects(pendingDns, { status: 499 });
  assert.equal(getEventListeners(dnsController.signal, "abort").length, 0);

  const bodyController = new AbortController(); const body = network([{ hang: true }]);
  const pendingBody = body.reader("https://example.test", { signal: bodyController.signal, timeoutMs: 100 });
  await new Promise(resolve => setImmediate(resolve)); bodyController.abort();
  await assert.rejects(pendingBody, { status: 499 });
  assert.equal(body.calls[0].options.signal.aborted, true);
  assert.equal(getEventListeners(bodyController.signal, "abort").length, 0);

  const completed = new AbortController(); const success = network([{}]);
  await success.reader("https://example.test", { signal: completed.signal });
  assert.equal(getEventListeners(completed.signal, "abort").length, 0);
  completed.abort(); assert.equal(success.calls[0].options.signal.aborted, false);
  const alreadyCancelled = network([]);
  await assert.rejects(alreadyCancelled.reader("https://example.test", { signal: completed.signal }), { status: 499 });
  assert.equal(alreadyCancelled.dnsCalls.length, 0);
});

test("stalled request body is cancelled once and unlocked after its deadline", async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const request = new Request("http://test", { method: "POST", body, duplex: "half" });
  await assert.rejects(safety.readBoundedBody(request, 5, 10), { status: 408 });
  assert.equal(cancelled, 1); assert.equal(body.locked, false);
});

test("guard rejects origin, MIME and declared size before inference or processing", async () => {
  for (const path of ["src/app/api/text/reconstruct/route.ts", "src/app/api/documents/process/route.ts"]) {
    const route = load(path, { "@/lib/server/http-safety": { ...safety, readRemote: () => assert.fail("network") } });
    for (const [headers, status] of [
      [{ origin: "https://evil.test" }, 403], [{ origin: "null" }, 403], [{ origin: "" }, 403],
      [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-type": "text/plain" }, 415],
      [{ "content-type": "" }, 415], [{ "content-length": "4000001" }, 413], [{ "content-length": "bogus" }, 413],
    ]) {
      const response = await route.POST(jsonRequest({ text: "Texto.", source: "pastedText" }, headers));
      assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});

test("guard uses the public Host authority when Next has an internal URL", () => {
  const guard = load("src/lib/server/request-guard.ts");
  const policy = { scope: "origin-regression", contentTypes: ["application/json"], maxBodyBytes: 100, maxRequests: 20, windowMs: 10_000, maxConcurrent: 2 };
  const acquire = guard.createRequestGuard();
  const request = (url, host, origin, extra = {}) => new Request(url, {
    method: "POST", body: "{}", headers: { "content-type": "application/json", ...(host !== null ? { host } : {}), origin, ...extra },
  });
  for (const [url, host, origin, headers] of [
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "http://127.0.0.1:3018"],
    ["http://127.0.0.1:3018/api/speech", "localhost:3018", "http://localhost:3018"],
    ["https://internal.vercel.app/api/speech", "aplicacionparaleerenvozalta.vercel.app", "https://aplicacionparaleerenvozalta.vercel.app"],
    ["http://localhost:3018/api/speech", "[::1]:3018", "http://[::1]:3018"],
    ["http://localhost:3018/api/speech", null, "http://localhost:3018"],
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "http://127.0.0.1:3018", { "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" }],
  ]) acquire(request(url, host, origin, headers), policy)();

  for (const [url, host, origin, headers] of [
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "http://localhost:3018"],
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "http://127.0.0.1:3019"],
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "https://127.0.0.1:3018"],
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "https://evil.test", { "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" }],
    ["http://localhost:3018/api/speech", null, "https://evil.test", { "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" }],
    ["http://localhost:3018/api/speech", "127.0.0.1:3018", "http://127.0.0.1:3018", { "sec-fetch-site": "cross-site" }],
    ...["", "user@127.0.0.1:3018", "127.0.0.1:3018/path", "127.0.0.1:3018,evil.test", "127.0.0.1:3018?query", "127.0.0.1:3018\\path"].map(host => ["http://127.0.0.1:3018/api/speech", host, "http://127.0.0.1:3018"]),
  ]) assert.throws(() => acquire(request(url, host, origin, headers), policy), { status: 403 });
});

test("guard enforces quota, expiry, idempotent release, global cap and bounded capacity", () => {
  const guard = load("src/lib/server/request-guard.ts"); let time = 1_000;
  const acquire = guard.createRequestGuard({ now: () => time, maxEntries: 4 });
  const policy = { scope: "synthetic", contentTypes: ["application/json"], maxBodyBytes: 100, maxRequests: 2, maxGlobalRequests: 3, windowMs: 10_000, maxConcurrent: 1 };
  const release = acquire(jsonRequest({}), policy);
  assert.throws(() => acquire(jsonRequest({}), policy), { status: 429, retryAfterSeconds: 1 });
  release(); release(); acquire(jsonRequest({}), policy)();
  assert.throws(() => acquire(jsonRequest({}), policy), { status: 429, retryAfterSeconds: 10 });
  acquire(jsonRequest({}, { "x-forwarded-for": "8.8.8.8" }), policy)();
  assert.throws(() => acquire(jsonRequest({}, { "x-forwarded-for": "1.1.1.1" }), policy), { status: 429 });
  time += 10_000; acquire(jsonRequest({}), policy)();
  acquire(jsonRequest({}, { "x-forwarded-for": "8.8.8.8" }), { ...policy, maxGlobalRequests: 100 })();
  acquire(jsonRequest({}, { "x-forwarded-for": "1.1.1.1" }), { ...policy, maxGlobalRequests: 100 })();
  assert.throws(() => acquire(jsonRequest({}, { "x-forwarded-for": "9.9.9.9" }), { ...policy, maxGlobalRequests: 100 }), { status: 429 });
  time += 10_000; acquire(jsonRequest({}, { "x-forwarded-for": "9.9.9.9" }), policy)();
});

test("reconstruct returns 429/Retry-After and releases slots on fallback and errors", async () => {
  const route = load("src/app/api/text/reconstruct/route.ts");
  for (let index = 0; index < 6; index++) assert.equal((await route.POST(jsonRequest({ text: "Texto." }))).status, 200);
  const limited = await route.POST(jsonRequest({ text: "Texto." }));
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(limited.headers.get("cache-control"), "no-store");
});

test("DOCX expansion and corrupt archives are rejected before Mammoth", async () => {
  const route = load("src/app/api/documents/process/route.ts", { mammoth: { convertToHtml: () => assert.fail("Mammoth must not open rejected ZIP") } });
  for (const [archive, status] of [
    [Buffer.from("PK-broken"), 415],
    [docxZip([{ name: "[Content_Types].xml", content: "<Types/>" }, { name: "word/document.xml", content: "x".repeat(50_000) }]), 413],
    [docxZip([{ name: "[Content_Types].xml", content: "<Types/>" }, { name: "word/document.xml", content: "x".repeat(9 * 1024 * 1024), claimedSize: 1_000_000 }]), 413],
    [docxZip([{ name: "[Content_Types].xml", content: "x" }, { name: "[Content_Types].xml", content: "x" }]), 415],
  ]) assert.equal((await route.POST(fileRequest(archive, "sample.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))).status, status);
});

test("PDF item, text and coordinate bounds run before geometry and clean up on rejection", async () => {
  for (const [items, status] of [
    [Array.from({ length: 8_001 }, () => ({ str: "x" })), 413],
    [[{ str: "x".repeat(300_001) }], 413],
    [[{ str: "Texto", transform: [1, 0, 0, 1, Infinity, 0] }], 422],
    [[{ str: "Texto", width: NaN }], 422],
  ]) {
    let cleaned = 0; let destroyed = 0;
    const route = load("src/app/api/documents/process/route.ts", { "pdfjs-dist/legacy/build/pdf.mjs": {
      GlobalWorkerOptions: {}, getDocument: () => {
        return { promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items }), cleanup: () => cleaned++ }) }), destroy: async () => destroyed++ };
      },
    } });
    assert.equal((await route.POST(fileRequest("%PDF-synthetic", "sample.pdf", "application/pdf"))).status, status);
    assert.equal(cleaned, 1); assert.equal(destroyed, 1);
  }
});
