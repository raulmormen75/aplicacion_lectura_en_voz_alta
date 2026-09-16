"use client";

import { z } from "zod";
import type { ReaderDocument, StoredReaderState } from "./types";

const STORAGE_KEY = "lector-documental-raul:v1";
const CHECKPOINT_KEY = "lector-documental-raul:v2";
const DATABASE_NAME = "lector-documental-raul";
const DOCUMENT_STORE = "documents";
const DEFAULT_BROWSER_VOICE_ID = "browser-default";

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
    voiceId: DEFAULT_BROWSER_VOICE_ID,
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
  rate: z.union([z.literal(1), z.literal(0.85), z.literal(0.75), z.literal(0.5)]),
  theme: z.enum(["warm-paper", "night"]),
  readingMode: z.enum(["standard", "focus"]),
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
  documentKey: identifier.nullable(),
  documentId: identifier.nullable(),
  progress: progressSchema,
  preferences: preferencesSchema,
  session: sessionSchema,
});

type DocumentWrite = {
  reference: ReaderDocument;
  id: string;
  key: string;
  ready: boolean;
  pending: Promise<ReaderStorageResult>;
};
let documentWrite: DocumentWrite | undefined;
let saveSequence = 0;
let isClearing = false;

function defaults(): StoredReaderState {
  return structuredClone(DEFAULT_READER_STATE);
}

function failure(code: "invalid" | "storage" | "unavailable" | "superseded", error: string): ReaderStorageResult {
  return { ok: false, code, error };
}

// Resolve only after transaction completion, not after the put request succeeds.
function documentOperation(operation: "get" | "put" | "clear", key?: string, value?: ReaderDocument): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let database: IDBDatabase | undefined;
    let transaction: IDBTransaction | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      database?.close();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error("IndexedDB no respondio a tiempo."));
      try { transaction?.abort(); } catch { /* The transaction may already be closed. */ }
    }, 10_000);
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
          const item = operation === "get" ? store.get(key!) : operation === "put" ? store.put(value!, key!) : store.clear();
          transaction.oncomplete = () => finish(undefined, item.result);
          transaction.onabort = () => finish(transaction?.error ?? new Error("Transaccion cancelada."));
          transaction.onerror = () => finish(transaction?.error ?? new Error("Error de IndexedDB."));
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
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
  let state = defaults();
  try {
    const raw = window.localStorage.getItem(CHECKPOINT_KEY);
    if (raw !== null) {
      const parsed = checkpointSchema.safeParse(JSON.parse(raw));
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
      state = restored;
      documentWrite = document ? {
        reference: document, id: document.id, key: checkpoint.documentKey!, ready: true,
        pending: Promise.resolve({ ok: true }),
      } : undefined;
      return { ok: true, state };
    }
    const legacy = window.localStorage.getItem(STORAGE_KEY);
    if (legacy === null) return { ok: true, state };
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
  if (typeof window === "undefined") return failure("unavailable", "Almacenamiento no disponible.");
  try {
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
        };
        const writing = entry;
        documentWrite = writing;
        writing.pending = documentOperation("put", writing.key, parsed.data).then(
          () => { writing.ready = true; return { ok: true } as const; },
          () => {
            if (documentWrite === writing) documentWrite = undefined;
            return failure("storage", "No se pudo guardar el documento en IndexedDB.");
          },
        );
      }
      if (!entry.ready) {
        const result = await entry.pending;
        if (!result.ok) return result;
      }
    }
    if (sequence !== saveSequence) return failure("superseded", "Una solicitud posterior reemplazo este guardado.");
    const checkpoint = small.data;
    checkpoint.documentKey = entry?.key ?? null;
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint));
    return { ok: true };
  } catch {
    return failure("storage", "No se pudo guardar el avance. Revisa permisos y espacio disponible.");
  }
}

/** Reset v2 explicitly; retain v1 and a null checkpoint so legacy data cannot reappear. */
export async function clearReaderState(): Promise<ReaderStorageResult> {
  if (isClearing) return failure("storage", "Ya hay un borrado en curso.");
  ++saveSequence;
  documentWrite = undefined;
  if (typeof window === "undefined") return failure("unavailable", "Almacenamiento no disponible.");
  isClearing = true;
  try {
    const empty = defaults();
    window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify({
      version: 2, documentKey: null, documentId: null,
      progress: empty.progress, preferences: empty.preferences, session: empty.session,
    }));
    await documentOperation("clear");
    return { ok: true };
  } catch {
    return failure("storage", "No se pudo borrar todo el estado guardado.");
  } finally {
    isClearing = false;
  }
}
