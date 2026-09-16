import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
