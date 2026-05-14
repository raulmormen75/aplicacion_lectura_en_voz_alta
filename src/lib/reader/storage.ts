"use client";

import type { StoredReaderState } from "./types";

const STORAGE_KEY = "lector-documental-raul:v1";
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

export function loadReaderState(): StoredReaderState {
  if (typeof window === "undefined") return DEFAULT_READER_STATE;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_READER_STATE;
    const parsed = JSON.parse(raw) as Partial<StoredReaderState>;

    return {
      ...DEFAULT_READER_STATE,
      ...parsed,
      progress: {
        ...DEFAULT_READER_STATE.progress,
        ...parsed.progress,
      },
      preferences: {
        ...DEFAULT_READER_STATE.preferences,
        ...parsed.preferences,
      },
      session: {
        ...DEFAULT_READER_STATE.session,
        ...parsed.session,
      },
    };
  } catch {
    return DEFAULT_READER_STATE;
  }
}

export function saveReaderState(state: StoredReaderState) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearReaderState() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}
