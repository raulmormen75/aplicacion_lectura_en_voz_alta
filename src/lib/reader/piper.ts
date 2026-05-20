import type { Progress, TtsSession, VoiceId } from "@realtimex/piper-tts-web";

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

export async function synthesizePiperSpeech({
  text,
  onStatus,
  timeoutMs = PIPER_TIMEOUT_MS,
}: {
  text: string;
  onStatus?: (update: PiperStatusUpdate) => void;
  timeoutMs?: number;
}): Promise<PiperSynthesisResult> {
  const speechText = text.trim();
  if (!speechText) throw new Error("No hay texto suficiente para preparar la voz.");
  if (typeof window === "undefined") {
    throw new Error("Piper solo puede inicializarse en el navegador.");
  }

  return withTimeout(
    runPiperSynthesis(speechText, onStatus),
    timeoutMs,
    "Piper tardo demasiado en preparar la voz.",
  );
}

async function runPiperSynthesis(
  text: string,
  onStatus?: (update: PiperStatusUpdate) => void,
): Promise<PiperSynthesisResult> {
  const initStart = performance.now();
  onStatus?.({
    stage: "preparing",
    message: "Preparando voz",
    detail: "Cargando el motor local en el navegador.",
  });

  await configureOnnxRuntimeForBrowser();
  const tts = await import("@realtimex/piper-tts-web");
  onStatus?.({
    stage: "initializing",
    message: "Inicializando motor",
    detail: "Conectando Piper con ONNX Runtime.",
  });

  const session = await getPiperSession(tts, onStatus);
  const initMs = performance.now() - initStart;

  onStatus?.({
    stage: "generating",
    message: "Generando audio",
    detail: "Procesando la muestra en este dispositivo.",
  });
  const generationStart = performance.now();
  const audio = await session.predict(text);
  const generationMs = performance.now() - generationStart;

  return {
    audio,
    initMs,
    generationMs,
  };
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
    }).catch((error) => {
      sessionPromise = null;
      throw error;
    });
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
    message: "Descargando modelo",
    progress: percent,
    detail: `${formatBytes(progress.loaded)} de ${formatBytes(progress.total)}`,
  });
}

function reportPiperLog(message: string, onStatus?: (update: PiperStatusUpdate) => void) {
  console.info("[Piper TTS]", message);

  const normalized = message.toLowerCase();
  if (normalized.includes("loading model for voice")) {
    onStatus?.({
      stage: "downloading",
      message: "Descargando modelo",
      detail: "Descargando o leyendo la voz es_MX Claude.",
    });
    return;
  }

  if (normalized.includes("loading model config")) {
    onStatus?.({
      stage: "downloading",
      message: "Descargando modelo",
      detail: "Leyendo la configuracion de la voz.",
    });
    return;
  }

  if (normalized.includes("wasm") || normalized.includes("onnx")) {
    onStatus?.({
      stage: "initializing",
      message: "Inicializando motor",
      detail: "Preparando los archivos WASM de Piper.",
    });
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeoutId: number | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) window.clearTimeout(timeoutId);
  });
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
