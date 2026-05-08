import type { CloudSpeechProvider } from "./types";

const STORAGE_KEY = "lector-documental-raul:cloud-speech-usage:v1";
export const DEFAULT_AZURE_TTS_MONTHLY_LIMIT = 500_000;

export type CloudSpeechUsage = {
  monthKey: string;
  azureCharacters: number;
  updatedAt: string;
  source?: "local" | "server";
};

export function getCurrentMonthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function getCloudSpeechUsageWindow(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const endExclusive = new Date(date.getFullYear(), date.getMonth() + 1, 1);

  return {
    monthKey: getCurrentMonthKey(date),
    start,
    endExclusive,
  };
}

export function loadCloudSpeechUsage(): CloudSpeechUsage {
  const emptyUsage = createEmptyUsage();

  if (typeof window === "undefined") return emptyUsage;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyUsage;

    const parsed = JSON.parse(raw) as Partial<CloudSpeechUsage>;
    if (parsed.monthKey !== emptyUsage.monthKey) return emptyUsage;

    return {
      monthKey: emptyUsage.monthKey,
      azureCharacters: Number(parsed.azureCharacters ?? 0),
      updatedAt: parsed.updatedAt ?? emptyUsage.updatedAt,
      source: "local",
    };
  } catch {
    return emptyUsage;
  }
}

export function saveCloudSpeechUsage(usage: CloudSpeechUsage) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
}

export function addCloudSpeechUsage(provider: CloudSpeechProvider, characters: number) {
  if (provider !== "azure") return loadCloudSpeechUsage();

  const usage = loadCloudSpeechUsage();
  const nextUsage: CloudSpeechUsage = {
    ...usage,
    azureCharacters: usage.azureCharacters + characters,
    updatedAt: new Date().toISOString(),
    source: "local",
  };

  saveCloudSpeechUsage(nextUsage);
  return nextUsage;
}

function createEmptyUsage(): CloudSpeechUsage {
  return {
    monthKey: getCurrentMonthKey(),
    azureCharacters: 0,
    updatedAt: new Date(0).toISOString(),
    source: "local",
  };
}
