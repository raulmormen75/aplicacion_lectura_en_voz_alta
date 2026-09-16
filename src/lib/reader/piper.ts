import type { Progress, TtsSession, VoiceId } from "@realtimex/piper-tts-web";
import { createPiperEngine } from "./piper-engine";

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

type PiperModule = typeof import("@realtimex/piper-tts-web");

const PIPER_VOICE_ID = "es_MX-claude-high" satisfies VoiceId;
const PIPER_TIMEOUT_MS = 90_000;

let sessionPromise: Promise<TtsSession> | null = null;

const synthesize = createPiperEngine<PiperStatusUpdate>(async (report) => {
  await configureOnnxRuntimeForBrowser();
  const tts = await import("@realtimex/piper-tts-web");
  report({ stage: "initializing", message: "Preparando voz", detail: "Cargando los archivos necesarios." });
  return getPiperSession(tts, report);
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

async function getPiperSession(
  tts: PiperModule,
  onStatus?: (update: PiperStatusUpdate) => void,
) {
  if (!sessionPromise) {
    sessionPromise = tts.TtsSession.create({
      voiceId: PIPER_VOICE_ID,
      allowLocalModels: true,
      fallbackStrategy: "cdn",
      progress: (progress) => reportPiperProgress(progress, onStatus),
      logger: (message) => reportPiperLog(message, onStatus),
    });
    // Failed initialization remains in the library singleton too. Recreating
    // it cannot recover that native session; a page reload is required.
  }

  return sessionPromise;
}

async function configureOnnxRuntimeForBrowser() {
  const ort = await import("onnxruntime-web");
  ort.env.wasm.numThreads = 1;
}

function reportPiperProgress(
  progress: Progress,
  onStatus?: (update: PiperStatusUpdate) => void,
) {
  const percent =
    progress.total > 0 ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;
  onStatus?.({
    stage: "downloading",
    message: "Descargando voz",
    progress: percent,
    detail: `${formatBytes(progress.loaded)} de ${formatBytes(progress.total)}`,
  });
}

function reportPiperLog(message: string, onStatus?: (update: PiperStatusUpdate) => void) {
  const normalized = message.toLowerCase();
  if (normalized.includes("loading model for voice")) {
    onStatus?.({
      stage: "downloading",
      message: "Preparando voz",
      detail: "Buscando los archivos de la voz.",
    });
    return;
  }

  if (normalized.includes("loading model config")) {
    onStatus?.({
      stage: "downloading",
      message: "Preparando voz",
      detail: "Cargando los ajustes de la voz.",
    });
    return;
  }

  if (normalized.includes("wasm") || normalized.includes("onnx")) {
    onStatus?.({
      stage: "initializing",
      message: "Preparando voz",
      detail: "Cargando los archivos necesarios.",
    });
  }
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
