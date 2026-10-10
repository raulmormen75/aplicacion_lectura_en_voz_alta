import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

test("Vercel runtime can load the actual HTML parser and extract an article", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.env.NODE_OPTIONS, "--experimental-require-module");
  const result = spawnSync(process.execPath, ["-e", `
    const { JSDOM } = require('jsdom');
    const { Readability } = require('@mozilla/readability');
    const dom = new JSDOM('<article><h1>Prueba</h1><p>Contenido conservado.</p></article>');
    try {
      if (!new Readability(dom.window.document).parse()?.textContent.includes('Contenido conservado.')) process.exitCode = 1;
    } finally { dom.window.close(); }
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, NODE_OPTIONS: config.env.NODE_OPTIONS },
    timeout: 10_000,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

function configuredHeaders(environment) {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const js = ts.transpileModule(readFileSync(new URL("../next.config.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiled = { exports: {} };
  vm.runInNewContext(js, { module: compiled, exports: compiled.exports, process: { env: { NODE_ENV: environment } } });
  const rules = compiled.exports.default.headers();
  return Object.fromEntries(rules.find(rule => rule.source === "/:path*").headers.map(({ key, value }) => [key.toLowerCase(), value]));
}

test("production headers retain PWA/OCR/audio resources and restrict script/object/frame origins", () => {
  const headers = configuredHeaders("production");
  const directives = Object.fromEntries(headers["content-security-policy"].split(";").map(part => {
    const [key, ...values] = part.trim().split(/\s+/); return [key, values];
  }));
  assert.deepEqual(directives["default-src"], ["'self'"]);
  assert.ok(directives["script-src"].includes("'wasm-unsafe-eval'"));
  assert.ok(!directives["script-src"].includes("'unsafe-eval'"));
  assert.deepEqual(directives["worker-src"], ["'self'", "blob:"]);
  assert.ok(directives["media-src"].includes("blob:"));
  assert.deepEqual(directives["object-src"], ["'none'"]);
  assert.deepEqual(directives["frame-ancestors"], ["'none'"]);
  assert.ok(!headers["content-security-policy"].includes("*"));
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "same-origin");
  const laura = readFileSync(new URL("../src/lib/reader/laura.ts", import.meta.url), "utf8");
  for (const source of laura.matchAll(/https:\/\/cdn\.jsdelivr\.net[^"`\s]*/g)) {
    const origin = new URL(source[0]).origin;
    assert.ok(directives["script-src"].includes(origin));
    assert.ok(directives["connect-src"].includes(origin));
  }
  assert.ok(!directives["connect-src"].some(source => source.includes("hf.space")));
});

test("development CSP allows React debugging and local hot reload", () => {
  const policy = configuredHeaders("development")["content-security-policy"];
  assert.ok(policy.includes("'unsafe-eval'"));
  assert.ok(policy.includes("ws: wss:"));
  assert.ok(!policy.includes("upgrade-insecure-requests"));
});
