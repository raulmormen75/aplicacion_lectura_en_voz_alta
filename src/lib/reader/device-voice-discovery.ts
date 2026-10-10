import { spanishDeviceVoices } from "./device-voices.ts";

type VoiceCatalog = Pick<SpeechSynthesis, "getVoices"> &
  Partial<Pick<SpeechSynthesis, "addEventListener" | "removeEventListener">>;

type DiscoveryOptions = {
  signal?: AbortSignal;
  onUpdate?: (voices: SpeechSynthesisVoice[]) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
  keepWatching?: boolean;
};

export const VOICE_DISCOVERY_TIMEOUT_MS = 5_000;

/** Only read the catalog the browser exposes; never speak to initialize it. */
export function readDeviceVoices(synthesis?: VoiceCatalog): SpeechSynthesisVoice[] {
  try {
    return [...(synthesis?.getVoices?.() ?? [])];
  } catch {
    // An initializing/unavailable system engine must not crash the document UI.
    return [];
  }
}

/** Browser catalogs can arrive late, even without a voiceschanged event. */
export function discoverSpanishDeviceVoices(
  synthesis: VoiceCatalog | undefined,
  { signal, onUpdate, timeoutMs = VOICE_DISCOVERY_TIMEOUT_MS, pollIntervalMs = 250, keepWatching = false }: DiscoveryOptions = {},
): Promise<SpeechSynthesisVoice[]> {
  if (signal?.aborted || !synthesis?.getVoices) return Promise.resolve([]);

  return new Promise((resolve) => {
    let settled = false;
    let latest: SpeechSynthesisVoice[] = [];

    const finish = (voices: SpeechSynthesisVoice[]) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      synthesis.removeEventListener?.("voiceschanged", check);
      signal?.removeEventListener("abort", cancel);
      resolve(voices);
    };
    const cancel = () => finish([]);
    const check = () => {
      if (settled) return;
      latest = readDeviceVoices(synthesis);
      if (settled) return;
      onUpdate?.(latest);
      if (!keepWatching && spanishDeviceVoices(latest).length > 0) finish(latest);
    };

    signal?.addEventListener("abort", cancel, { once: true });
    const interval = setInterval(check, pollIntervalMs);
    const timeout = setTimeout(() => {
      check();
      finish(latest);
    }, timeoutMs);
    // Listen before the first query; timers already exist if initialization
    // delivers an event immediately while this listener is being registered.
    synthesis.addEventListener?.("voiceschanged", check);
    check();
  });
}
