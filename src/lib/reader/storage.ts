"use client";

import { z } from "zod";
import type { ReaderDocument, StoredReaderState } from "./types";

const STORAGE_KEY = "lector-documental-raul:v1";
const CHECKPOINT_KEY = "lector-documental-raul:v2";
const DATABASE_NAME = "lector-documental-raul";
const DOCUMENT_STORE = "documents";

export const DEFAULT_READER_STATE: StoredReaderState = {
  document: null,
  progress: {
    documentId: null,
    currentWord: 0,
    currentTimeSeconds: 0,
    percentage: 0,
    estimatedRemainingSeconds: 0,
    updatedAt: new Date(0).toISOString(),
  },
  preferences: {
    voiceId: "browser-standard",
    rate: 1,
    theme: "warm-paper",
    readingMode: "standard",
  },
  session: {
    signedIn: false,
    userName: "Raul",
  },
};

export type ReaderStorageResult =
  | { ok: true }
  | { ok: false; code: "invalid" | "storage" | "unavailable" | "superseded"; error: string };

export type ReaderLoadResult = ReaderStorageResult & { state: StoredReaderState };

export type ReaderClearOptions =
  | { mode?: "reset"; recoverPending?: never }
  | { mode: "all"; recoverPending?: boolean };

const integer = z.number().int().nonnegative();
const identifier = z.string().min(1).max(256);
const timestamp = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)));
const language = z.enum(["es", "en", "mixed"]);
const progressSchema = z.object({
  documentId: identifier.nullable(),
  currentWord: integer,
  currentTimeSeconds: z.number().nonnegative(),
  percentage: z.number().min(0).max(100),
  estimatedRemainingSeconds: z.number().nonnegative(),
  updatedAt: timestamp,
});
const preferencesSchema = z.object({
  voiceId: identifier,
  rate: z.union([
    z.literal(1), z.literal(0.85), z.literal(0.75), z.literal(0.65), z.literal(0.5),
    z.literal(1.25), z.literal(1.5), z.literal(2),
  ]),
  theme: z.enum(["warm-paper", "night"]),
  readingMode: z.enum(["standard", "focus"]),
  language: z.enum(["auto", "es", "en"]).optional(),
  textScale: z.union([z.literal(0.9), z.literal(1), z.literal(1.1), z.literal(1.25)]).optional(),
  systemVoiceURI: identifier.optional(),
});
const sessionSchema = z.object({ signedIn: z.boolean(), userName: z.string().max(256) });
const documentSchema = z.object({
  id: identifier,
  title: z.string(),
  source: z.enum(["file", "pastedText", "website", "googleDoc"]),
  sourceLabel: z.string(),
  createdAt: timestamp,
  originalText: z.string(),
  cleanText: z.string(),
  blocks: z.array(z.object({
    id: identifier,
    kind: z.enum(["heading", "subheading", "paragraph", "bullet"]),
    text: z.string(), start: integer, end: integer, startWord: integer, wordCount: integer,
  })).optional(),
  chunks: z.array(z.object({
    id: identifier, text: z.string(), cleanText: z.string(),
    startWord: integer, wordCount: integer, language,
  })),
  wordCount: integer,
  detectedLanguage: language,
  quality: z.object({
    status: z.enum(["ready", "needs-ocr", "needs-review"]),
    message: z.string(), ocrAvailable: z.boolean(),
  }),
}).refine((doc) => {
  const words = (text: string) => {
    let count = 0;
    const pattern = /[\p{L}\p{M}\p{N}]+(?:['’´-][\p{L}\p{M}\p{N}]+)*/gu;
    while (pattern.exec(text) !== null) count++;
    return count;
  };
  if (words(doc.cleanText) !== doc.wordCount) return false;
  let cursor = 0;
  for (const chunk of doc.chunks) {
    if (chunk.startWord !== cursor || chunk.wordCount === 0 || words(chunk.cleanText) !== chunk.wordCount) return false;
    cursor += chunk.wordCount;
  }
  if (cursor !== doc.wordCount) return false;
  let end = 0;
  let word = 0;
  for (const block of doc.blocks ?? []) {
    if (block.start < end || block.end < block.start || block.end > doc.cleanText.length ||
        block.startWord !== word || block.text !== doc.cleanText.slice(block.start, block.end) ||
        words(block.text) !== block.wordCount) return false;
    end = block.end;
    word += block.wordCount;
  }
  return !doc.blocks?.length || word === doc.wordCount;
});
const checkpointSchema = z.object({
  version: z.literal(2),
  revision: identifier.optional(),
  pendingClear: z.boolean().optional(),
  documentKey: identifier.nullable(),
  documentId: identifier.nullable(),
  progress: progressSchema,
  preferences: preferencesSchema,
  session: sessionSchema,
});
// Keep only coordination metadata after an explicit privacy erase. Removing the key
// entirely would let a stale tab with a null baseline publish pre-erase data again.
const erasedCheckpointSchema = z.object({
  version: z.literal(2),
  revision: identifier,
  cleared: z.literal(true),
  pendingClear: z.boolean().optional(),
}).strict();

type DocumentWrite = {
  reference: ReaderDocument;
  id: string;
  key: string;
  ready: boolean;
  pending: Promise<ReaderStorageResult>;
  controller?: AbortController;
};
let documentWrite: DocumentWrite | undefined;
const pendingDocumentWrites = new Set<AbortController>();
let saveSequence = 0;
let isClearing = false;
// Only a successful load or this instance's own publication may advance this baseline.
let knownCheckpoint: string | null = null;
// Failed loads authorize explicit recovery only, never automatic saving.
let recoveryCheckpoint: string | null | undefined;
// Own failed erases can retry; a new instance requires explicit recoverPending consent.
let pendingPrivateClear: string | undefined;

function defaults(): StoredReaderState {
  return structuredClone(DEFAULT_READER_STATE);
}

function failure(code: "invalid" | "storage" | "unavailable" | "superseded", error: string): ReaderStorageResult {
  return { ok: false, code, error };
}

/** Stop pending publications when the UI enters temporary reading. Does not erase committed data. */
export function cancelPendingReaderSaves(): void {
  ++saveSequence;
  for (const controller of pendingDocumentWrites) controller.abort();
  if (documentWrite && !documentWrite.ready) {
    documentWrite = undefined;
  }
}

// Resolve only after transaction completion, not after the put request succeeds.
function documentOperation(
  operation: "get" | "put" | "checkpoint",
  key?: string,
  value?: ReaderDocument,
  publish?: (store: IDBObjectStore, stored: unknown) => ReaderStorageResult,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      database?.close();
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => {
      try { transaction?.abort(); } catch { /* A committed transaction cannot be undone. */ }
      finish(new Error("Guardado cancelado."));
    };
    const timer = setTimeout(() => {
      finish(new Error("IndexedDB no respondio a tiempo."));
      try { transaction?.abort(); } catch { /* The transaction may already be closed. */ }
    }, 10_000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try {
      const request = window.indexedDB.open(DATABASE_NAME, 1);
      request.onblocked = () => finish(new Error("IndexedDB esta bloqueado por otra ventana."));
      request.onerror = () => finish(request.error ?? new Error("No se pudo abrir IndexedDB."));
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains(DOCUMENT_STORE)) {
          request.result.createObjectStore(DOCUMENT_STORE);
        }
      };
      request.onsuccess = () => {
        database = request.result;
        if (settled) { database.close(); return; }
        database.onversionchange = () => database?.close();
        try {
          transaction = database.transaction(DOCUMENT_STORE, operation === "get" ? "readonly" : "readwrite");
          const store = transaction.objectStore(DOCUMENT_STORE);
          const item = operation === "put" ? store.put(value!, key!) : operation === "checkpoint"
            ? store.getKey(key ?? "__checkpoint_lock__") : store.get(key!);
          let result: ReaderStorageResult | undefined;
          if (operation === "checkpoint") {
            item.onsuccess = () => {
              try { result = publish!(store, item.result); }
              catch (error) {
                transaction?.abort();
                finish(error);
              }
            };
          }
          transaction.oncomplete = () => finish(undefined, operation === "checkpoint" ? result : item.result);
          transaction.onabort = () => finish(transaction?.error ?? new Error("Transaccion cancelada."));
          transaction.onerror = () => finish(transaction?.error ?? new Error("Error de IndexedDB."));
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
}

function conflict(): ReaderStorageResult {
  return failure("storage", "Otra pestana actualizo o borro el estado. Recarga para recuperar el avance mas reciente antes de guardar; no se sobrescribieron sus cambios.");
}

function hasPendingClear(raw: string | null): boolean {
  try { return raw !== null && JSON.parse(raw)?.pendingClear === true; }
  catch { return false; }
}

function hasPendingPrivateClear(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed = erasedCheckpointSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.pendingClear === true;
  } catch { return false; }
}

function pendingClearError(): ReaderStorageResult {
  return failure("storage", "Borrado pendiente en otra pestana. Espera a que termine y vuelve a cargar; no se puede guardar ni recuperar ese estado provisional.");
}

// The readwrite transaction serializes cooperating tabs, including reset. No book is rewritten here.
async function publishCheckpoint(
  checkpoint: z.infer<typeof checkpointSchema>,
  expected: string | null,
  sequence: number,
  clear?: "reset" | "all",
): Promise<ReaderStorageResult> {
  let published: string | undefined;
  let clearCommitted = false;
  const previousKnown = knownCheckpoint;
  const persisted = clear === "all" ? { version: 2, cleared: true } : checkpoint;
  try {
    const result = await documentOperation("checkpoint", checkpoint.documentKey ?? undefined, undefined, (store, stored) => {
      if (sequence !== saveSequence) return failure("superseded", "Una solicitud posterior reemplazo este guardado.");
      if (window.localStorage.getItem(CHECKPOINT_KEY) !== expected) return conflict();
      if (checkpoint.documentKey !== null && stored !== checkpoint.documentKey) {
        return failure("storage", "El documento ya no esta disponible. Recarga antes de volver a guardar.");
      }
      const raw = JSON.stringify({ ...persisted, revision: globalThis.crypto.randomUUID(), ...(clear ? { pendingClear: true } : {}) });
      window.localStorage.setItem(CHECKPOINT_KEY, raw);
      published = raw;
      if (!clear) knownCheckpoint = raw;
      // Publish first to detect quota failures; an abort restores this exact raw under the same lock.
      if (clear) store.clear();
      return { ok: true };
    }) as ReaderStorageResult;
    if (result.ok) {
      if (clear && published !== undefined) {
        clearCommitted = true;
        if (clear === "all") pendingPrivateClear = published;
        // Keep pending visible throughout the commit/finalization gap, never as recoverable corruption.
        const finalRaw = JSON.stringify({ ...persisted, revision: globalThis.crypto.randomUUID() });
        const finalized = await documentOperation("checkpoint", undefined, undefined, () => {
          if (window.localStorage.getItem(CHECKPOINT_KEY) !== published) return conflict();
          // Remove legacy only after the document clear commits. A failed clear
          // must never destroy the sole durable copy of a migrated v1 document.
          if (clear === "all") window.localStorage.removeItem(STORAGE_KEY);
          window.localStorage.setItem(CHECKPOINT_KEY, finalRaw);
          return { ok: true };
        }) as ReaderStorageResult;
        if (!finalized.ok) return finalized;
        knownCheckpoint = finalRaw;
        if (clear === "all") pendingPrivateClear = undefined;
      }
      recoveryCheckpoint = undefined;
    }
    return result;
  } catch (error) {
    if (published !== undefined && !clearCommitted) {
      try {
        await documentOperation("checkpoint", undefined, undefined, () => {
          // A queued writer may already have published: never roll it back.
          if (window.localStorage.getItem(CHECKPOINT_KEY) !== published) return conflict();
          if (expected === null) window.localStorage.removeItem(CHECKPOINT_KEY);
          else window.localStorage.setItem(CHECKPOINT_KEY, expected);
          return { ok: true };
        });
      } finally {
        if (knownCheckpoint === published) knownCheckpoint = previousKnown;
      }
    }
    throw error;
  }
}

function consistent(state: StoredReaderState) {
  const doc = state.document;
  return state.progress.documentId === (doc?.id ?? null) &&
    state.progress.currentWord <= (doc?.wordCount ?? 0);
}

/** On failure, show error and do not enable automatic saving of the fallback state. */
export async function loadReaderState(): Promise<ReaderLoadResult> {
  if (typeof window === "undefined") return { ...failure("unavailable", "Almacenamiento no disponible."), state: defaults() };
  if (isClearing) return { ...failure("storage", "Borrado en curso; vuelve a intentar la carga."), state: defaults() };
  const sequence = ++saveSequence;
  recoveryCheckpoint = undefined;
  let state = defaults();
  try {
    const raw = window.localStorage.getItem(CHECKPOINT_KEY);
    if (hasPendingClear(raw)) return { ...pendingClearError(), state };
    recoveryCheckpoint = raw;
    if (raw !== null) {
      const decoded: unknown = JSON.parse(raw);
      if (erasedCheckpointSchema.safeParse(decoded).success) {
        if (sequence !== saveSequence || window.localStorage.getItem(CHECKPOINT_KEY) !== raw) {
          return { ...conflict(), state };
        }
        knownCheckpoint = raw;
        recoveryCheckpoint = undefined;
        documentWrite = undefined;
        return { ok: true, state };
      }
      const parsed = checkpointSchema.safeParse(decoded);
      if (!parsed.success) return { ...failure("invalid", "Checkpoint invalido; no se modificaron los datos."), state };
      const checkpoint = parsed.data;
      let document: ReaderDocument | null = null;
      if (checkpoint.documentKey !== null) {
        const result = documentSchema.safeParse(await documentOperation("get", checkpoint.documentKey));
        if (!result.success || result.data.id !== checkpoint.documentId) {
          return { ...failure("invalid", "El documento guardado falta o no coincide con el checkpoint."), state };
        }
        document = result.data;
      } else if (checkpoint.documentId !== null) {
        return { ...failure("invalid", "El checkpoint no tiene documento asociado."), state };
      }
      const restored = { document, progress: checkpoint.progress, preferences: checkpoint.preferences, session: checkpoint.session };
      if (!consistent(restored)) return { ...failure("invalid", "El avance no corresponde al documento."), state };
      if (sequence !== saveSequence || window.localStorage.getItem(CHECKPOINT_KEY) !== raw) {
        return { ...conflict(), state };
      }
      knownCheckpoint = raw;
      recoveryCheckpoint = undefined;
      state = restored;
      documentWrite = document ? {
        reference: document, id: document.id, key: checkpoint.documentKey!, ready: true,
        pending: Promise.resolve({ ok: true }),
      } : undefined;
      return { ok: true, state };
    }
    const legacy = window.localStorage.getItem(STORAGE_KEY);
    if (window.localStorage.getItem(CHECKPOINT_KEY) !== null) return { ...conflict(), state };
    knownCheckpoint = null;
    if (legacy === null) {
      documentWrite = undefined;
      recoveryCheckpoint = undefined;
      return { ok: true, state };
    }
    const parsed = z.object({
      document: documentSchema.nullable().default(null),
      progress: progressSchema.partial().default({}),
      preferences: preferencesSchema.partial().default({}),
      session: sessionSchema.partial().default({}),
    }).safeParse(JSON.parse(legacy));
    if (!parsed.success) return { ...failure("invalid", "Estado v1 invalido; se conserva sin cambios."), state };
    const restored = {
      document: parsed.data.document,
      progress: { ...state.progress, ...parsed.data.progress },
      preferences: { ...state.preferences, ...parsed.data.preferences },
      session: { ...state.session, ...parsed.data.session },
    };
    if (!consistent(restored)) return { ...failure("invalid", "El avance v1 no corresponde al documento."), state };
    state = restored;
    // Keep v1 intact even after success; v2 takes precedence on subsequent loads.
    const migrated = await saveReaderState(state);
    return { ...migrated, state };
  } catch {
    return { ...failure("storage", "No se pudo recuperar el estado. Los datos existentes se conservaron."), state };
  }
}

/** Treat documents as immutable. Same reference/id writes only the small checkpoint. */
export async function saveReaderState(state: StoredReaderState): Promise<ReaderStorageResult> {
  if (isClearing) return failure("storage", "Borrado en curso; vuelve a intentar el guardado.");
  const sequence = ++saveSequence;
  const expected = knownCheckpoint;
  if (typeof window === "undefined") return failure("unavailable", "Almacenamiento no disponible.");
  try {
    const current = window.localStorage.getItem(CHECKPOINT_KEY);
    if (hasPendingClear(current)) return pendingClearError();
    if (current !== expected) return conflict();
    const small = checkpointSchema.safeParse({
      version: 2, documentKey: null, documentId: state.document?.id ?? null,
      progress: state.progress, preferences: state.preferences, session: state.session,
    });
    if (!small.success || !consistent(state)) return failure("invalid", "Documento o avance inconsistente; no se guardo.");
    let entry: DocumentWrite | undefined;
    if (state.document !== null) {
      if (documentWrite?.reference === state.document && documentWrite.id === state.document.id) {
        entry = documentWrite;
      } else {
        const parsed = documentSchema.safeParse(state.document);
        if (!parsed.success) return failure("invalid", "Documento invalido; no se guardo.");
        // Retain immutable versions: another tab may still reference an older checkpoint.
        // Cross-tab ownership is required before automatic garbage collection is safe.
        entry = {
          reference: state.document, id: state.document.id,
          key: globalThis.crypto.randomUUID(), ready: false,
          pending: Promise.resolve({ ok: true }),
          controller: new AbortController(),
        };
        const writing = entry;
        documentWrite = writing;
        pendingDocumentWrites.add(writing.controller!);
        // Check the revision under the same lock that writes the document. A
        // delayed open from a pre-erase tab must not recreate an orphaned book.
        writing.pending = documentOperation("checkpoint", undefined, undefined, (store) => {
          const latest = window.localStorage.getItem(CHECKPOINT_KEY);
          if (hasPendingClear(latest)) return pendingClearError();
          if (latest !== expected) return conflict();
          store.put(parsed.data, writing.key);
          return { ok: true };
        }, writing.controller!.signal).then(
          (value) => {
            const result = value as ReaderStorageResult;
            if (result.ok) writing.ready = true;
            else if (documentWrite === writing) documentWrite = undefined;
            return result;
          },
          () => {
            if (documentWrite === writing) documentWrite = undefined;
            if (writing.controller?.signal.aborted) return failure("superseded", "Una solicitud posterior reemplazo este guardado.");
            return failure("storage", "No se pudo guardar el documento en IndexedDB.");
          },
        ).finally(() => pendingDocumentWrites.delete(writing.controller!));
      }
      if (!entry.ready) {
        const result = await entry.pending;
        if (!result.ok) return result;
      }
    }
    if (sequence !== saveSequence) return failure("superseded", "Una solicitud posterior reemplazo este guardado.");
    const checkpoint = small.data;
    checkpoint.documentKey = entry?.key ?? null;
    return await publishCheckpoint(checkpoint, expected, sequence);
  } catch {
    return failure("storage", "No se pudo guardar el avance. Revisa permisos y espacio disponible.");
  }
}

/** Reset by default. Explicit all/recoverPending may complete an interrupted privacy erase. */
export async function clearReaderState(options: ReaderClearOptions = {}): Promise<ReaderStorageResult> {
  if (isClearing) return failure("storage", "Ya hay un borrado en curso.");
  const mode = options.mode ?? "reset";
  if (mode !== "reset" && mode !== "all") return failure("invalid", "Modo de borrado invalido.");
  if (options.recoverPending === true && mode !== "all") {
    return failure("invalid", "La recuperacion del borrado requiere el modo all explicito.");
  }
  const sequence = ++saveSequence;
  if (typeof window === "undefined") return failure("unavailable", "Almacenamiento no disponible.");
  isClearing = true;
  try {
    const current = window.localStorage.getItem(CHECKPOINT_KEY);
    const retryPrivateClear = mode === "all" && current !== null && (
      current === pendingPrivateClear || (options.recoverPending === true && hasPendingPrivateClear(current))
    );
    if (hasPendingClear(current) && !retryPrivateClear) return pendingClearError();
    const expected = retryPrivateClear ? current : recoveryCheckpoint !== undefined && current === recoveryCheckpoint
      ? recoveryCheckpoint : knownCheckpoint;
    const empty = defaults();
    const result = await publishCheckpoint({
      version: 2, documentKey: null, documentId: null,
      progress: empty.progress, preferences: empty.preferences, session: empty.session,
    }, expected, sequence, mode);
    if (result.ok) documentWrite = undefined;
    return result;
  } catch {
    return failure("storage", "No se pudo borrar todo el estado guardado.");
  } finally {
    isClearing = false;
  }
}
