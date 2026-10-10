import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { SafeHttpError } from "@/lib/server/http-safety";

export type ApiRequestPolicy = {
  scope: string;
  contentTypes: readonly string[];
  maxBodyBytes: number;
  maxRequests: number;
  windowMs: number;
  maxConcurrent: number;
  maxGlobalRequests?: number;
};

export class RequestGuardError extends SafeHttpError {
  constructor(message: string, status: number, readonly retryAfterSeconds?: number) {
    super(message, status);
  }
}

export function requestErrorHeaders(error?: unknown): Record<string, string> {
  return {
    "cache-control": "no-store",
    ...(error instanceof RequestGuardError && error.retryAfterSeconds
      ? { "retry-after": String(error.retryAfterSeconds) } : {}),
  };
}

type Window = { count: number; expiresAt: number };

function matchesRequestOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol)) return false;
  const host = request.headers.get("host");
  try {
    // Next's URL can use the internal listening hostname. Host is the HTTP
    // authority the browser requested (also preserved by Vercel). Forwarded
    // headers must never add an alternative origin to this comparison.
    if (host !== null && (!host || /[\s,/@\\?#]/.test(host))) return false;
    const expected = host === null ? url.origin : new URL(`${url.protocol}//${host}/`).origin;
    return request.headers.get("origin") === expected;
  } catch { return false; }
}

// Each process has its own bounded counters. Windows expire after windowMs
// (at most five minutes); restarts reset them. This is not a distributed quota.
export function createRequestGuard({ now = Date.now, maxEntries = 2_048 }: { now?: () => number; maxEntries?: number } = {}) {
  const windows = new Map<string, Window>();
  const active = new Map<string, number>();
  return function acquire(request: Request, policy: ApiRequestPolicy): () => void {
    if (!policy.scope || !Number.isInteger(policy.maxRequests) || policy.maxRequests < 1 ||
        !Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1 ||
        !Number.isInteger(policy.windowMs) || policy.windowMs < 1_000 || policy.windowMs > 300_000 ||
        !Number.isInteger(policy.maxBodyBytes) || policy.maxBodyBytes < 1 ||
        (policy.maxGlobalRequests !== undefined && (!Number.isInteger(policy.maxGlobalRequests) || policy.maxGlobalRequests < 1))) {
      throw new Error("Invalid API request policy");
    }
    if (!matchesRequestOrigin(request)) {
      throw new RequestGuardError("Esta solicitud debe iniciarse desde la aplicación.", 403);
    }
    const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!policy.contentTypes.includes(contentType)) {
      throw new RequestGuardError("El tipo de contenido de la solicitud no es compatible.", 415);
    }
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > policy.maxBodyBytes)) {
      throw new RequestGuardError("La solicitud supera el tamaño permitido.", 413);
    }

    const time = now();
    for (const [key, window] of windows) if (window.expiresAt <= time) windows.delete(key);
    // Forwarded IPs are only a best-effort client hint. The global window and
    // concurrency cap still apply if a caller can vary this header.
    const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",", 1)[0].trim();
    const client = isIP(forwarded) ? createHash("sha256").update(forwarded).digest("hex") : "unidentified";
    const clientKey = `${policy.scope}:client:${client}`;
    const globalKey = `${policy.scope}:global`;
    const clientWindow = windows.get(clientKey);
    const globalWindow = windows.get(globalKey);
    const throttled = (expiresAt: number) => new RequestGuardError(
      "Hay demasiadas solicitudes. Espera un momento e intenta nuevamente.", 429,
      Math.max(1, Math.ceil((expiresAt - time) / 1_000)),
    );
    if (clientWindow && clientWindow.count >= policy.maxRequests) throw throttled(clientWindow.expiresAt);
    if (globalWindow && globalWindow.count >= (policy.maxGlobalRequests ?? policy.maxRequests * 10)) throw throttled(globalWindow.expiresAt);
    if ((active.get(policy.scope) ?? 0) >= policy.maxConcurrent) throw throttled(time + 1_000);
    const missing = Number(!clientWindow) + Number(!globalWindow);
    if (windows.size + missing > maxEntries) {
      throw throttled(Math.min(...Array.from(windows.values(), (window) => window.expiresAt), time + policy.windowMs));
    }
    for (const key of [clientKey, globalKey]) {
      const window = windows.get(key) ?? { count: 0, expiresAt: time + policy.windowMs };
      window.count++;
      windows.set(key, window);
    }
    active.set(policy.scope, (active.get(policy.scope) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (active.get(policy.scope) ?? 1) - 1;
      if (remaining) active.set(policy.scope, remaining);
      else active.delete(policy.scope);
    };
  };
}

export const acquireApiRequest = createRequestGuard();
