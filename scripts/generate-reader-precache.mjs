import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const ORIGIN = "https://reader-build.invalid";
export const SHELL_PATH = "/reader-assets/offline-shell.html";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function createPrecacheManifest({ html, buildId, buildManifest, workerSource, readAsset, writeAsset }) {
  if (!buildId.trim()) throw new Error("Missing Next build ID.");
  const dom = new JSDOM(html, { url: ORIGIN });
  const urls = new Map([[SHELL_PATH, "html"]]);
  const add = (input, expectedKind) => {
    const url = new URL(input, ORIGIN);
    if (url.origin !== ORIGIN || url.hash || url.username || url.password) throw new Error("Offline core must be same-origin.");
    const path = url.pathname;
    let kind;
    if (path.startsWith("/_next/static/")) {
      if (path.endsWith(".js")) kind = "js";
      else if (path.endsWith(".css")) kind = "css";
      else if (/\.woff2?$/.test(path)) kind = "font";
    } else if (path === "/manifest.webmanifest") kind = "json";
    else if (path === "/favicon.ico" || path.startsWith("/icons/") && /\.(?:ico|png)$/.test(path)) kind = "icon";
    if (!kind || expectedKind && kind !== expectedKind) throw new Error(`Unsupported offline core resource: ${path}`);
    urls.set(url.pathname + url.search, kind);
  };
  try {
    for (const element of dom.window.document.querySelectorAll("script[src]")) add(element.getAttribute("src"), "js");
    for (const element of dom.window.document.querySelectorAll("link[href]")) {
      const rel = element.rel.toLowerCase().split(/\s+/);
      if (rel.includes("stylesheet")) add(element.getAttribute("href"), "css");
      else if (rel.includes("modulepreload")) add(element.getAttribute("href"), "js");
      else if (rel.includes("preload") && ["script", "style", "font"].includes(element.getAttribute("as"))) {
        add(element.getAttribute("href"), { script: "js", style: "css", font: "font" }[element.getAttribute("as")]);
      } else if (rel.includes("icon") || rel.includes("apple-touch-icon") || rel.includes("manifest")) add(element.getAttribute("href"));
    }
    for (const file of [...(buildManifest.rootMainFiles ?? []), ...(buildManifest.polyfillFiles ?? [])]) add(`/_next/${file}`, "js");
    add("/manifest.webmanifest", "json");
    const webmanifest = JSON.parse((await readAsset("/manifest.webmanifest")).toString());
    for (const icon of webmanifest.icons ?? []) add(icon.src, "icon");
    if (![...urls.values()].includes("js") || ![...urls.values()].includes("css")) throw new Error("Build has no core JS/CSS.");
    if (urls.size > 128) throw new Error("Too many offline core resources.");
    const entries = [];
    let total = 0;
    for (const [url, kind] of urls) {
      const bytes = url === SHELL_PATH ? Buffer.from(html) : await readAsset(url);
      if (!bytes.length || bytes.length > 2_000_000) throw new Error(`Offline resource outside byte budget: ${url}`);
      total += bytes.length;
      if (total > 12_000_000) throw new Error("Offline core exceeds 12 MB.");
      const entry = { url, kind, bytes: bytes.length, sha256: sha256(bytes) };
      if (kind === "js") {
        entry.fetchUrl = `/reader-assets/offline/${entry.sha256}.js`;
        // Publish exact build bytes outside Next's runtime transformation paths.
        await writeAsset?.(entry.fetchUrl, bytes);
      }
      entries.push(entry);
    }
    const version = sha256(JSON.stringify({ buildId, entries, worker: sha256(workerSource) }));
    return { version, buildId, entries };
  } finally {
    dom.window.close();
  }
}

export async function generateReaderPrecache(root) {
  const prerender = JSON.parse(await readFile(join(root, ".next/prerender-manifest.json"), "utf8"));
  if (prerender.routes?.["/"]?.initialRevalidateSeconds !== false) {
    throw new Error("Offline shell requires a statically prerendered root, without ISR or user data.");
  }
  const html = await readFile(join(root, ".next/server/app/index.html"), "utf8");
  const buildId = (await readFile(join(root, ".next/BUILD_ID"), "utf8")).trim();
  const buildManifest = JSON.parse(await readFile(join(root, ".next/build-manifest.json"), "utf8"));
  const workerSource = await readFile(join(root, "public/sw.js"), "utf8");
  const readAsset = async (url) => {
    const pathname = decodeURIComponent(new URL(url, ORIGIN).pathname);
    const base = join(root, pathname.startsWith("/_next/static/") ? ".next" : "public");
    const relative = pathname.startsWith("/_next/static/") ? pathname.slice("/_next/".length) : pathname.slice(1);
    const file = resolve(base, relative);
    if (!file.startsWith(resolve(base) + sep)) throw new Error("Invalid offline resource path.");
    if (pathname === "/favicon.ico") return readFile(join(root, ".next/server/app/favicon.ico.body"));
    return readFile(file);
  };
  const directory = join(root, "public/reader-assets");
  await mkdir(join(directory, "offline"), { recursive: true });
  const manifest = await createPrecacheManifest({
    html, buildId, buildManifest, workerSource, readAsset,
    writeAsset: (url, bytes) => writeFile(join(root, "public", url.slice(1)), bytes),
  });
  await writeFile(join(directory, "offline-shell.html"), html);
  // Publish the manifest last; mixed-deployment bytes fail the worker's digest checks.
  await writeFile(join(directory, "offline-manifest.js"), `self.__READER_PRECACHE = ${JSON.stringify(manifest)};\n`);
  console.log(`Offline core: ${manifest.entries.length} resources, ${manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0)} bytes; build ${buildId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await generateReaderPrecache(fileURLToPath(new URL("../", import.meta.url)));
}
