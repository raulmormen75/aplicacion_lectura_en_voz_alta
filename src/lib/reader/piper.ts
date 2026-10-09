import { createPiperEngine } from "./piper-engine";
import { createLauraWorkerSession } from "./laura-worker-client";

export type PiperStage =
  | "idle"
  | "preparing"
  | "downloading"
  | "initializing"
  | "generating"
  | "playing"
  | "fallback"
  | "ready"
  | "error";

export type PiperStatusUpdate = {
  stage: PiperStage;
  message: string;
  progress?: number;
  detail?: string;
};

export type PiperSynthesisResult = {
  audio: Blob;
  initMs: number;
  generationMs: number;
};

const PIPER_TIMEOUT_MS = 90_000;

let sessionPromise: ReturnType<typeof createLauraWorkerSession> | null = null;

const synthesize = createPiperEngine<PiperStatusUpdate>(async (report) => {
  if (!sessionPromise) {
    sessionPromise = createLauraWorkerSession(report, () => { sessionPromise = null; }).catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}, {
  preparing: { stage: "preparing", message: "Preparando voz", detail: "Preparando la voz en este dispositivo." },
  generating: { stage: "generating", message: "Generando audio", detail: "Preparando el audio en este dispositivo." },
});

export async function synthesizePiperSpeech({
  text,
  onStatus,
  timeoutMs = PIPER_TIMEOUT_MS,
  signal,
}: {
  text: string;
  onStatus?: (update: PiperStatusUpdate) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PiperSynthesisResult> {
  const speechText = text.trim();
  if (!speechText) throw new Error("No hay texto suficiente para preparar la voz.");
  if (typeof window === "undefined") {
    throw new Error("La voz solo puede prepararse en el navegador.");
  }

  return synthesize({ text: speechText, onStatus, timeoutMs, signal });
}
