"use client";

import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe2,
  Headphones,
  Home,
  Moon,
  Pause,
  Play,
  RotateCcw,
  ScanText,
  SkipBack,
  SkipForward,
  Sparkles,
  SunMedium,
  Type,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import {
  calculatePercentage,
  cleanTextWithoutInventing,
  countWords,
  createDocumentFromText,
  estimateRemainingSeconds,
  formatRemainingTime,
  segmentTextBlocks,
  tokenizeWords,
} from "@/lib/reader/text";
import {
  DEFAULT_READER_STATE,
  loadReaderState,
  saveReaderState,
} from "@/lib/reader/storage";
import { synthesizePiperSpeech } from "@/lib/reader/piper";
import type { PiperStage, PiperStatusUpdate } from "@/lib/reader/piper";
import type {
  PlaybackRate,
  ReaderDocument,
  ReaderPreferences,
  StoredReaderState,
  TextBlock,
  TextBlockKind,
} from "@/lib/reader/types";

type ProcessResponse = {
  document?: ReaderDocument;
  error?: string;
};

type IntegrationsStatus = {
  gptOssReady: boolean;
};

type VisibleTextPart = {
  id: string;
  text: string;
  type: "word" | "text";
  wordIndex?: number;
};

type VisibleTextBlock = {
  id: string;
  kind: TextBlockKind;
  parts: VisibleTextPart[];
};

type PiperWordTiming = {
  startsAt: number;
  wordIndex: number;
};

type VoiceStartupState = {
  visible: boolean;
  status: PiperStage;
  message: string;
  detail?: string;
  progress?: number;
};

type VoiceModelId = "browser-standard" | "piper-updated";

const SAMPLE_TEXT =
  "La lectura científica exige atención, ritmo y continuidad. Esta aplicación convierte documentos largos en una experiencia auditiva clara, con avance guardado, resaltado visual y controles diseñados para retomar el contenido sin perder el hilo.";
const MAX_CLIENT_UPLOAD_BYTES = 25 * 1024 * 1024;
const VOICE_LOAD_TIMEOUT_MS = 900;
const READER_WINDOW_BEFORE = 90;
const READER_WINDOW_AFTER = 180;
const STANDARD_VOICE_MODEL_ID: VoiceModelId = "browser-standard";
const PIPER_VOICE_MODEL_ID: VoiceModelId = "piper-updated";
const VOICE_MODELS: Array<{
  id: VoiceModelId;
  label: string;
  description: string;
}> = [
  {
    id: STANDARD_VOICE_MODEL_ID,
    label: "Voz estándar",
    description: "Usa la voz disponible en este navegador.",
  },
  {
    id: PIPER_VOICE_MODEL_ID,
    label: "Voz actualizada",
    description: "Usa Piper local con respaldo automático.",
  },
];

export function ReaderApp() {
  const [state, setState] = useState<StoredReaderState>(DEFAULT_READER_STATE);
  const [activePanel, setActivePanel] = useState<"file" | "text" | "web">("file");
  const [pastedText, setPastedText] = useState(SAMPLE_TEXT);
  const [url, setUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [focusControlsVisible, setFocusControlsVisible] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Avance guardado en este dispositivo.");
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceStartup, setVoiceStartup] = useState<VoiceStartupState | null>(null);
  const [isVoiceMenuOpen, setIsVoiceMenuOpen] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationsStatus>({
    gptOssReady: false,
  });
  const [isHydrated, setIsHydrated] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const activeSegmentRef = useRef<{
    startWord: number;
    endWord: number;
    rate: PlaybackRate;
    textToSpeak?: string;
  } | null>(null);
  const intervalRef = useRef<number | null>(null);
  const piperProgressFrameRef = useRef<number | null>(null);
  const piperWordTimelineRef = useRef<PiperWordTiming[]>([]);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const playbackSessionRef = useRef(0);
  const shouldContinuePlaybackRef = useRef(false);
  const progressWordRef = useRef(0);
  const boundarySeenRef = useRef(false);
  const piperAudioRef = useRef<HTMLAudioElement | null>(null);
  const piperAudioUrlRef = useRef<string | null>(null);

  const document = state.document;
  const preferences = state.preferences;
  const selectedVoiceModel: VoiceModelId =
    preferences.voiceId === PIPER_VOICE_MODEL_ID ? PIPER_VOICE_MODEL_ID : STANDARD_VOICE_MODEL_ID;
  const selectedVoiceModelRef = useRef<VoiceModelId>(selectedVoiceModel);
  const shouldShowTextReview =
    document?.quality.status !== "ready" && document?.quality.ocrAvailable === true;

  const clearProgressTimer = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const clearPiperProgressTracker = useCallback(() => {
    if (piperProgressFrameRef.current) {
      window.cancelAnimationFrame(piperProgressFrameRef.current);
      piperProgressFrameRef.current = null;
    }
  }, []);

  const stopPiperAudio = useCallback(() => {
    clearPiperProgressTracker();
    piperAudioRef.current?.pause();
    piperAudioRef.current = null;
    piperWordTimelineRef.current = [];

    if (piperAudioUrlRef.current) {
      URL.revokeObjectURL(piperAudioUrlRef.current);
      piperAudioUrlRef.current = null;
    }
  }, [clearPiperProgressTracker]);

  const stopPlayback = useCallback(
    (advanceSession = true) => {
      shouldContinuePlaybackRef.current = false;
      if (advanceSession) playbackSessionRef.current += 1;
      window.speechSynthesis?.cancel();
      stopPiperAudio();
      clearProgressTimer();
      activeSegmentRef.current = null;
      setVoiceStartup(null);
    },
    [clearProgressTimer, stopPiperAudio],
  );

  const tokens = useMemo(
    () => tokenizeWords(document?.cleanText ?? ""),
    [document?.cleanText],
  );
  const textBlocks = useMemo(
    () => getDocumentBlocks(document),
    [document],
  );
  const currentWord = Math.min(state.progress.currentWord, document?.wordCount ?? 0);
  const paragraphNavigationTargets = useMemo(() => {
    const bodyBlocks = textBlocks.filter(isParagraphNavigationTarget);
    return bodyBlocks.length ? bodyBlocks : textBlocks.filter((block) => block.wordCount > 0);
  }, [textBlocks]);
  const visibleTextBlocks = useMemo(() => {
    if (!document || tokens.length === 0) return [];

    const startWord = Math.max(0, currentWord - READER_WINDOW_BEFORE);
    const endWord = Math.min(tokens.length, currentWord + READER_WINDOW_AFTER);
    const visibleWords = tokens.slice(startWord, endWord);
    const windowStart = visibleWords[0]?.start ?? 0;
    const windowEnd = visibleWords.at(-1)?.end ?? document.cleanText.length;

    return textBlocks
      .filter((block) => block.end > windowStart && block.start < windowEnd)
      .map((block) => ({
        id: block.id,
        kind: block.kind,
        parts: createVisibleTextParts({
          block,
          cleanText: document.cleanText,
          tokens: visibleWords,
          windowStart,
          windowEnd,
        }),
      }))
      .filter((block) => block.parts.length > 0);
  }, [currentWord, document, textBlocks, tokens]);
  const percentage = calculatePercentage(document?.wordCount ?? 0, currentWord);
  const remainingSeconds = estimateRemainingSeconds(
    document?.wordCount ?? 0,
    currentWord,
    preferences.rate,
  );
  useEffect(() => {
    window.queueMicrotask(() => {
      setState(loadReaderState());
      setIsHydrated(true);
    });

    const refreshVoices = () => setSystemVoices(window.speechSynthesis?.getVoices?.() ?? []);
    refreshVoices();
    window.speechSynthesis?.addEventListener?.("voiceschanged", refreshVoices);

    fetch("/api/integrations/status")
      .then((response) => response.json())
      .then((data: IntegrationsStatus) => setIntegrations(data))
      .catch(() => undefined);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => {
      window.speechSynthesis?.removeEventListener?.("voiceschanged", refreshVoices);
      stopPiperAudio();
      stopPlayback();
    };
  }, [stopPiperAudio, stopPlayback]);

  useEffect(() => {
    selectedVoiceModelRef.current = selectedVoiceModel;
  }, [selectedVoiceModel]);

  useEffect(() => {
    let revealTimer: number | null = null;

    if (preferences.readingMode !== "focus") {
      revealTimer = window.setTimeout(() => setFocusControlsVisible(true), 0);
      return () => {
        if (revealTimer) window.clearTimeout(revealTimer);
      };
    }

    revealTimer = window.setTimeout(() => setFocusControlsVisible(true), 0);
    return () => {
      if (revealTimer) window.clearTimeout(revealTimer);
    };
  }, [preferences.readingMode]);

  useEffect(() => {
    progressWordRef.current = currentWord;
  }, [currentWord]);

  useEffect(() => {
    const activeWord = globalThis.document.querySelector<HTMLSpanElement>(
      ".document-text .active-word",
    );
    activeWordRef.current = activeWord;
    if (!activeWord) return;

    const readingPane = activeWord.closest(".document-text") as HTMLElement | null;
    if (readingPane) {
      const paneRect = readingPane.getBoundingClientRect();
      const wordRect = activeWord.getBoundingClientRect();
      const nextTop =
        readingPane.scrollTop + wordRect.top - paneRect.top - readingPane.clientHeight * 0.46;

      readingPane.scrollTo({
        top: Math.max(0, nextTop),
        behavior: "smooth",
      });
      return;
    }

    activeWord.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [currentWord]);

  useEffect(() => {
    if (!isHydrated || preferences.readingMode !== "focus") return;

    const root = globalThis.document.documentElement;
    const body = globalThis.document.body;
    const scrollY = window.scrollY;
    const previousRootOverflow = root.style.overflow;
    const previousRootOverscroll = root.style.overscrollBehavior;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyOverscroll = body.style.overscrollBehavior;
    const previousBodyPosition = body.style.position;
    const previousBodyTop = body.style.top;
    const previousBodyWidth = body.style.width;

    root.classList.add("reader-focus-scroll-lock");
    body.classList.add("reader-focus-scroll-lock");
    root.style.overflow = "hidden";
    root.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";

    return () => {
      root.classList.remove("reader-focus-scroll-lock");
      body.classList.remove("reader-focus-scroll-lock");
      root.style.overflow = previousRootOverflow;
      root.style.overscrollBehavior = previousRootOverscroll;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehavior = previousBodyOverscroll;
      body.style.position = previousBodyPosition;
      body.style.top = previousBodyTop;
      body.style.width = previousBodyWidth;
      window.scrollTo(0, scrollY);
    };
  }, [isHydrated, preferences.readingMode]);

  useEffect(() => {
    if (!isHydrated) return;
    saveReaderState({
      ...state,
      progress: {
        ...state.progress,
        percentage,
        estimatedRemainingSeconds: remainingSeconds,
        updatedAt: new Date().toISOString(),
      },
    });
  }, [isHydrated, percentage, remainingSeconds, state]);

  function updatePreferences(next: Partial<ReaderPreferences>) {
    setState((current) => ({
      ...current,
      preferences: {
        ...current.preferences,
        ...next,
      },
    }));
  }

  function setDocument(nextDocument: ReaderDocument) {
    stopPlayback();
    setIsPlaying(false);

    setState((current) => ({
      ...current,
      document: nextDocument,
      progress: {
        documentId: nextDocument.id,
        currentWord: 0,
        currentTimeSeconds: 0,
        percentage: 0,
        estimatedRemainingSeconds: estimateRemainingSeconds(
          nextDocument.wordCount,
          0,
          current.preferences.rate,
        ),
        updatedAt: new Date().toISOString(),
      },
    }));
    setStatusMessage("Documento listo para escuchar.");
  }

  async function readProcessResponse(response: Response, fallbackMessage: string) {
    const contentType = response.headers.get("content-type") ?? "";

    if (contentType.includes("application/json")) {
      return (await response.json()) as ProcessResponse;
    }

    return {
      error: response.ok
        ? fallbackMessage
        : "El servidor no pudo procesar el contenido. Intenta de nuevo o revisa el despliegue.",
    } satisfies ProcessResponse;
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    void processFile(selectedFile);
  }

  async function processFile(file: File | null) {
    if (!file) return;

    if (file.size <= 0) {
      setStatusMessage("El archivo llegó vacío. En móvil, descarga el PDF desde Drive y vuelve a seleccionarlo.");
      return;
    }

    if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
      setStatusMessage("El archivo es demasiado grande. Usa un PDF menor a 25 MB.");
      return;
    }

    setIsProcessing(true);
    setStatusMessage("Extrayendo texto del archivo.");

    try {
      const formData = new FormData();
      formData.append("file", file, file.name || "documento.pdf");
      const response = await fetch("/api/documents/process", {
        method: "POST",
        body: formData,
      });
      const data = await readProcessResponse(response, "No se pudo procesar el archivo.");

      if (data.document) {
        setDocument(data.document);
        return;
      }

      setStatusMessage(data.error ?? "No se pudo procesar el archivo.");
    } catch {
      setStatusMessage("No se pudo conectar con el procesador de documentos.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function processText() {
    setIsProcessing(true);
    setStatusMessage("Limpiando texto pegado.");
    try {
      const response = await fetch("/api/documents/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "pastedText",
          title: "Texto pegado",
          text: pastedText,
        }),
      });
      const data = await readProcessResponse(response, "No se pudo procesar el texto.");

      if (data.document) {
        setPastedText(data.document.cleanText);
        setDocument(data.document);
      } else {
        setStatusMessage(data.error ?? "No se pudo procesar el texto.");
      }
    } catch {
      setStatusMessage("No se pudo conectar con el procesador de texto.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function processUrl() {
    const targetUrl = url;
    setIsProcessing(true);
    setStatusMessage("Leyendo sitio web.");
    try {
      const response = await fetch("/api/documents/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "website",
          url: targetUrl,
        }),
      });
      const data = await readProcessResponse(response, "No se pudo procesar la liga.");

      if (data.document) setDocument(data.document);
      else setStatusMessage(data.error ?? "No se pudo procesar la liga.");
    } catch {
      setStatusMessage("No se pudo conectar con el procesador de ligas.");
    } finally {
      setIsProcessing(false);
    }
  }

  function updateProgress(nextWord: number) {
    const safeWord = Math.max(0, Math.min(nextWord, document?.wordCount ?? 0));
    progressWordRef.current = safeWord;
    setState((current) => ({
      ...current,
      progress: {
        ...current.progress,
        documentId: document?.id ?? null,
        currentWord: safeWord,
        percentage: calculatePercentage(document?.wordCount ?? 0, safeWord),
        estimatedRemainingSeconds: estimateRemainingSeconds(
          document?.wordCount ?? 0,
          safeWord,
          current.preferences.rate,
        ),
        updatedAt: new Date().toISOString(),
      },
    }));
  }

  function getChunkForWord(wordIndex: number) {
    if (!document) return null;
    return (
      document.chunks.find(
        (chunk) => wordIndex >= chunk.startWord && wordIndex < chunk.startWord + chunk.wordCount,
      ) ??
      document.chunks.at(-1) ??
      null
    );
  }

  function getAvailableSpeechVoices() {
    return systemVoices.length ? systemVoices : window.speechSynthesis.getVoices();
  }

  function getPreferredSystemVoice(voices = getAvailableSpeechVoices()) {
    const availableVoices = voices;
    if (!availableVoices.length) return undefined;

    const documentLanguage = document?.detectedLanguage === "en" ? "en" : "es";
    const regionalLocale = documentLanguage === "en" ? "en-GB" : "es-MX";
    const exactRegionalVoices = availableVoices.filter((item) => item.lang === regionalLocale);
    const languageVoices = availableVoices.filter((item) =>
      item.lang.toLowerCase().startsWith(`${documentLanguage}-`),
    );
    const latinSpanishVoices =
      documentLanguage === "es" ? availableVoices.filter(isLatinSpanishVoice) : [];
    const mexicanNaturalVoice = exactRegionalVoices.find((item) => {
      const name = normalizeVoiceName(item.name);
      return name.includes("dalia") && (name.includes("natural") || name.includes("online"));
    });
    const britishNaturalVoice = exactRegionalVoices.find((item) => {
      const name = normalizeVoiceName(item.name);
      return (
        (name.includes("ada") || name.includes("sonia") || name.includes("libby")) &&
        (name.includes("natural") || name.includes("online"))
      );
    });
    const browserDefaultVoice =
      exactRegionalVoices.find((item) => item.default) ??
      exactRegionalVoices.find((item) => normalizeVoiceName(item.name).includes("default"));
    const naturalRegionalVoice = exactRegionalVoices.find((item) => {
      const name = normalizeVoiceName(item.name);
      return name.includes("natural") || name.includes("online");
    });
    const latinSpanishNaturalVoice = latinSpanishVoices.find((item) => {
      const name = normalizeVoiceName(item.name);
      return name.includes("natural") || name.includes("online") || name.includes("google");
    });

    return (
      (documentLanguage === "es" ? mexicanNaturalVoice : britishNaturalVoice) ??
      browserDefaultVoice ??
      naturalRegionalVoice ??
      exactRegionalVoices[0] ??
      latinSpanishNaturalVoice ??
      latinSpanishVoices.find((item) => item.default) ??
      latinSpanishVoices[0] ??
      (documentLanguage === "en"
        ? languageVoices.find((item) => item.default) ?? languageVoices[0]
        : undefined)
    );
  }

  async function waitForSpeechVoices() {
    const initialVoices = window.speechSynthesis.getVoices();
    if (initialVoices.length > 0) {
      setSystemVoices(initialVoices);
      return initialVoices;
    }

    return new Promise<SpeechSynthesisVoice[]>((resolve) => {
      let settled = false;
      const finish = (voices: SpeechSynthesisVoice[]) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        window.speechSynthesis?.removeEventListener?.("voiceschanged", handleVoicesChanged);
        setSystemVoices(voices);
        resolve(voices);
      };
      const handleVoicesChanged = () => {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) finish(voices);
      };
      const timeoutId = window.setTimeout(() => {
        finish(window.speechSynthesis.getVoices());
      }, VOICE_LOAD_TIMEOUT_MS);

      window.speechSynthesis?.addEventListener?.("voiceschanged", handleVoicesChanged);
    });
  }

  function normalizeVoiceName(name: string) {
    return name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  function isLatinSpanishVoice(voice: SpeechSynthesisVoice) {
    const lang = voice.lang.toLowerCase();
    const name = normalizeVoiceName(voice.name);
    if (lang === "es-mx" || lang === "es-us" || lang === "es-419") return true;
    if (lang === "es-es") return false;
    if (name.includes("dalia") || name.includes("mexico") || name.includes("mexican")) return true;
    if (name.includes("estados unidos") || name.includes("united states")) return true;
    if (name.includes("latin") || name.includes("latam") || name.includes("latino")) return true;
    return lang.startsWith("es-");
  }

  function getSpeechWindow(fromWord: number) {
    if (!document) return null;

    const safeFromWord = Math.max(0, Math.min(fromWord, document.wordCount));
    const chunk = getChunkForWord(safeFromWord);
    if (!chunk || safeFromWord >= document.wordCount) return null;

    const chunkTokens = tokenizeWords(chunk.cleanText);
    const localStartWord = Math.max(0, safeFromWord - chunk.startWord);
    const startChar = chunkTokens[localStartWord]?.start ?? 0;
    const textToSpeak = chunk.cleanText.slice(startChar).trim();
    const speechBaseWord = chunk.startWord + localStartWord;
    const chunkEndWord = Math.min(chunk.startWord + chunk.wordCount, document.wordCount);

    return {
      chunk,
      textToSpeak,
      speechBaseWord,
      chunkEndWord,
    };
  }

  function startProgressTimer(startWord: number, endWord: number, rate = preferences.rate) {
    clearProgressTimer();
    progressWordRef.current = startWord;
    const fallbackStartsAt = window.Date.now() + 1800;
    const wordsPerSecond = (105 * rate) / 60;
    const intervalMs = Math.max(650, Math.round(1000 / wordsPerSecond));

    intervalRef.current = window.setInterval(() => {
      if (boundarySeenRef.current || window.Date.now() < fallbackStartsAt) return;

      const nextWord = Math.min(progressWordRef.current + 1, endWord);
      if (!document || nextWord <= progressWordRef.current) {
        clearProgressTimer();
        return;
      }

      updateProgress(nextWord);

      if (nextWord >= endWord) {
        clearProgressTimer();
      }
    }, intervalMs);
  }

  function startPiperProgressTracker(
    audio: HTMLAudioElement,
    startWord: number,
    endWord: number,
    activeSession: number,
    textToSpeak?: string,
  ) {
    clearProgressTimer();
    clearPiperProgressTracker();

    const tick = () => {
      if (
        playbackSessionRef.current !== activeSession ||
        piperAudioRef.current !== audio ||
        audio.paused ||
        audio.ended
      ) {
        return;
      }

      const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
      if (hasDuration) {
        if (piperWordTimelineRef.current.length === 0) {
          piperWordTimelineRef.current = buildPiperWordTimeline(
            textToSpeak ?? "",
            startWord,
            endWord,
            audio.duration,
          );
        }

        const nextWord = getPiperWordForTime(
          piperWordTimelineRef.current,
          audio.currentTime + getPiperHighlightLead(audio.playbackRate),
          startWord,
          endWord,
        );
        if (nextWord > progressWordRef.current) {
          updateProgress(nextWord);
        }
      }

      piperProgressFrameRef.current = window.requestAnimationFrame(tick);
    };

    piperProgressFrameRef.current = window.requestAnimationFrame(tick);
  }

  async function startSpeech(
    fromWord = currentWord,
    sessionId?: number,
    rate = preferences.rate,
    voiceModel = selectedVoiceModelRef.current,
  ) {
    if (!document) return;

    const activeSession = sessionId ?? playbackSessionRef.current + 1;
    playbackSessionRef.current = activeSession;
    shouldContinuePlaybackRef.current = true;

    if (!sessionId) {
      window.speechSynthesis?.cancel();
      clearProgressTimer();
      clearPiperProgressTracker();
    }

    const speechWindow = getSpeechWindow(fromWord);
    if (!speechWindow) {
      clearProgressTimer();
      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedó guardado.");
      return;
    }

    const { textToSpeak, speechBaseWord, chunkEndWord } = speechWindow;

    if (!textToSpeak) {
      void startSpeech(chunkEndWord, activeSession, rate, voiceModel);
      return;
    }

    updateProgress(speechBaseWord);
    if (voiceModel === PIPER_VOICE_MODEL_ID) {
      await startPiperSpeech({
        textToSpeak,
        speechBaseWord,
        chunkEndWord,
        activeSession,
        rate,
        voiceModel,
      });
      return;
    }

    setIsPlaying(true);
    setStatusMessage("Buscando la mejor voz disponible en este navegador.");
    const availableVoices = await waitForSpeechVoices();
    if (playbackSessionRef.current !== activeSession) return;

    const preferredSystemVoice = getPreferredSystemVoice(availableVoices);
    startBrowserSpeech({
      textToSpeak,
      speechBaseWord,
      chunkEndWord,
      activeSession,
      rate,
      voiceModel,
      preferredSystemVoice,
    });
  }

  function startBrowserSpeech(params: {
    textToSpeak: string;
    speechBaseWord: number;
    chunkEndWord: number;
    activeSession: number;
    rate: PlaybackRate;
    voiceModel: VoiceModelId;
    preferredSystemVoice?: SpeechSynthesisVoice;
    statusMessage?: string;
  }) {
    const utterance = new SpeechSynthesisUtterance(params.textToSpeak);
    const preferredSystemVoice = params.preferredSystemVoice;
    const utteranceLanguage =
      preferredSystemVoice?.lang ?? (document?.detectedLanguage === "en" ? "en-GB" : "es-US");

    if (preferredSystemVoice) utterance.voice = preferredSystemVoice;
    utterance.lang = utteranceLanguage;
    utterance.rate = params.rate;
    utterance.pitch = document?.detectedLanguage === "en" ? 1 : 1.02;
    boundarySeenRef.current = false;
    activeSegmentRef.current = {
      startWord: params.speechBaseWord,
      endWord: params.chunkEndWord,
      rate: params.rate,
      textToSpeak: params.textToSpeak,
    };

    utterance.onboundary = (event) => {
      if (playbackSessionRef.current !== params.activeSession) return;
      if (event.name && event.name !== "word") return;
      boundarySeenRef.current = true;
      const spoken = params.textToSpeak.slice(0, event.charIndex);
      const nextWord = params.speechBaseWord + Math.max(0, countWords(spoken));
      updateProgress(Math.max(progressWordRef.current, nextWord));
    };
    utterance.onend = () => {
      clearProgressTimer();
      if (playbackSessionRef.current !== params.activeSession) return;

      updateProgress(Math.max(progressWordRef.current, params.chunkEndWord));

      if (shouldContinuePlaybackRef.current && document && params.chunkEndWord < document.wordCount) {
        void startSpeech(
          params.chunkEndWord,
          params.activeSession,
          params.rate,
          params.voiceModel,
        );
        return;
      }

      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedó guardado.");
    };
    utterance.onerror = () => {
      if (playbackSessionRef.current !== params.activeSession) return;
      clearProgressTimer();
      setIsPlaying(false);
      shouldContinuePlaybackRef.current = false;
      setStatusMessage("La voz del navegador se interrumpió. Intenta reproducir de nuevo.");
    };

    utteranceRef.current = utterance;
    updateProgress(params.speechBaseWord);
    window.speechSynthesis.speak(utterance);
    startProgressTimer(params.speechBaseWord, params.chunkEndWord, params.rate);
    setIsPlaying(true);
    setStatusMessage(
      params.statusMessage ??
        (preferredSystemVoice
          ? `Lectura iniciada con la voz del navegador: ${preferredSystemVoice.name}.`
          : document?.detectedLanguage === "en"
            ? "Lectura iniciada con la voz predeterminada del navegador."
            : "Este navegador no expone Dalia ni una voz de español latino. Se usará su voz predeterminada.")
    );
  }

  async function startPiperSpeech(params: {
    textToSpeak: string;
    speechBaseWord: number;
    chunkEndWord: number;
    activeSession: number;
    rate: PlaybackRate;
    voiceModel: VoiceModelId;
  }) {
    window.speechSynthesis?.cancel();
    stopPiperAudio();
    setIsPlaying(false);
    setStatusMessage("Preparando voz actualizada.");
    updateVoiceStartupStatus({
      stage: "preparing",
      message: "Preparando voz actualizada",
      detail: "La voz local se inicia en este navegador antes de comenzar la lectura.",
    });

    try {
      console.info("[Piper TTS] Inicio de lectura", {
        documentId: document?.id,
        title: document?.title,
        fromWord: params.speechBaseWord,
        words: countWords(params.textToSpeak),
      });

      const result = await synthesizePiperSpeech({
        text: params.textToSpeak,
        onStatus: updateVoiceStartupStatus,
      });

      if (playbackSessionRef.current !== params.activeSession) return;

      console.info("[Piper TTS] Audio generado", {
        engine: "piper",
        initMs: Math.round(result.initMs),
        generationMs: Math.round(result.generationMs),
        bytes: result.audio.size,
      });

      updateVoiceStartupStatus({
        stage: "playing",
        message: "Voz actualizada lista",
        detail: "Iniciando lectura.",
      });
      await startPiperAudioPlayback(params, result.audio);
    } catch (error) {
      await fallbackToBrowserVoice(params, error);
    }
  }

  async function startPiperAudioPlayback(
    params: {
      textToSpeak: string;
      speechBaseWord: number;
      chunkEndWord: number;
      activeSession: number;
      rate: PlaybackRate;
      voiceModel: VoiceModelId;
    },
    audioBlob: Blob,
  ) {
    stopPiperAudio();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.playbackRate = params.rate;
    piperAudioUrlRef.current = audioUrl;
    piperAudioRef.current = audio;
    utteranceRef.current = null;
    boundarySeenRef.current = false;
    activeSegmentRef.current = {
      startWord: params.speechBaseWord,
      endWord: params.chunkEndWord,
      rate: params.rate,
    };

    const cleanup = () => {
      if (piperAudioRef.current === audio) piperAudioRef.current = null;
      piperWordTimelineRef.current = [];
      if (piperAudioUrlRef.current === audioUrl) {
        URL.revokeObjectURL(audioUrl);
        piperAudioUrlRef.current = null;
      }
    };

    audio.onended = () => {
      cleanup();
      clearProgressTimer();
      clearPiperProgressTracker();
      if (playbackSessionRef.current !== params.activeSession) return;

      updateProgress(Math.max(progressWordRef.current, params.chunkEndWord));

      if (shouldContinuePlaybackRef.current && document && params.chunkEndWord < document.wordCount) {
        void startSpeech(
          params.chunkEndWord,
          params.activeSession,
          params.rate,
          params.voiceModel,
        );
        return;
      }

      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedÃ³ guardado.");
    };

    audio.onerror = () => {
      cleanup();
      clearProgressTimer();
      clearPiperProgressTracker();
      if (playbackSessionRef.current !== params.activeSession) return;
      void fallbackToBrowserVoice(
        params,
        new Error("El navegador no pudo reproducir el audio generado por Piper."),
      );
    };

    updateProgress(params.speechBaseWord);
    await audio.play();
    startPiperProgressTracker(
      audio,
      params.speechBaseWord,
      params.chunkEndWord,
      params.activeSession,
      params.textToSpeak,
    );
    setVoiceStartup(null);
    setIsPlaying(true);
    setStatusMessage("Lectura iniciada con Voz actualizada.");
  }

  async function fallbackToBrowserVoice(
    params: {
      textToSpeak: string;
      speechBaseWord: number;
      chunkEndWord: number;
      activeSession: number;
      rate: PlaybackRate;
      voiceModel: VoiceModelId;
    },
    cause: unknown,
  ) {
    if (playbackSessionRef.current !== params.activeSession) return;

    const errorMessage = cause instanceof Error ? cause.message : String(cause);
    console.warn("[Piper TTS] Error, usando voz estándar", {
      engine: "speechSynthesis",
      error: errorMessage,
    });

    updateVoiceStartupStatus({
      stage: "fallback",
      message: "Error, usando voz estándar",
      detail: errorMessage,
    });

    const availableVoices = await waitForSpeechVoices();
    if (playbackSessionRef.current !== params.activeSession) return;

    setVoiceStartup(null);
    const preferredSystemVoice = getPreferredSystemVoice(availableVoices);
    startBrowserSpeech({
      ...params,
      voiceModel: STANDARD_VOICE_MODEL_ID,
      preferredSystemVoice,
      statusMessage: "La Voz actualizada no pudo iniciar. Se usó Voz estándar.",
    });
  }

  function updateVoiceStartupStatus(update: PiperStatusUpdate) {
    console.info("[Piper TTS] Estado", update);
    setVoiceStartup({
      visible: true,
      status: update.stage,
      message: update.message,
      detail: update.detail,
      progress: update.progress,
    });
  }

  function togglePlayback() {
    if (!document) return;

    if (isPlaying) {
      if (piperAudioRef.current && !piperAudioRef.current.paused) {
        piperAudioRef.current.pause();
        clearPiperProgressTracker();
      } else {
        window.speechSynthesis.pause();
      }
      clearProgressTimer();
      setIsPlaying(false);
      setStatusMessage("Lectura pausada. Avance guardado.");
      return;
    }

    if (piperAudioRef.current?.paused && !piperAudioRef.current.ended) {
      if (selectedVoiceModelRef.current !== PIPER_VOICE_MODEL_ID) {
        stopPiperAudio();
      } else {
        shouldContinuePlaybackRef.current = true;
        void piperAudioRef.current
          .play()
          .then(() => {
            const activeSegment = activeSegmentRef.current;
            startPiperProgressTracker(
              piperAudioRef.current as HTMLAudioElement,
              activeSegment?.startWord ?? currentWord,
              Math.min(activeSegment?.endWord ?? document.wordCount, document.wordCount),
              playbackSessionRef.current,
              activeSegment?.textToSpeak,
            );
            setIsPlaying(true);
            setStatusMessage("Lectura reanudada con Voz actualizada.");
          })
          .catch((error: unknown) => {
            setIsPlaying(false);
            setStatusMessage(
              error instanceof Error
                ? `No se pudo reanudar la Voz actualizada: ${error.message}`
                : "No se pudo reanudar la Voz actualizada.",
            );
          });
        return;
      }
    }

    if (window.speechSynthesis.paused && utteranceRef.current) {
      shouldContinuePlaybackRef.current = true;
      window.speechSynthesis.resume();
      const chunk = getChunkForWord(currentWord);
      startProgressTimer(
        currentWord,
        Math.min((chunk?.startWord ?? currentWord) + (chunk?.wordCount ?? 0), document.wordCount),
      );
      setIsPlaying(true);
      setStatusMessage("Lectura reanudada.");
      return;
    }

    void startSpeech(currentWord);
  }

  function seek(seconds: number) {
    if (!document) return;
    const wasPlaying = isPlaying;
    const wordsToMove = Math.round(((155 * preferences.rate) / 60) * seconds);
    const nextWord = Math.max(0, Math.min(document.wordCount, currentWord + wordsToMove));

    stopPlayback();
    updateProgress(nextWord);
    setIsPlaying(false);

    if (wasPlaying) {
      void startSpeech(nextWord);
    }
  }

  function getParagraphNavigationWord(direction: -1 | 1) {
    if (!document || paragraphNavigationTargets.length === 0) return currentWord;

    if (direction > 0) {
      return (
        paragraphNavigationTargets.find((target) => target.startWord > currentWord)?.startWord ??
        currentWord
      );
    }

    const currentTargetIndex = paragraphNavigationTargets.findIndex(
      (target) =>
        currentWord >= target.startWord && currentWord < target.startWord + target.wordCount,
    );
    const currentTarget =
      currentTargetIndex >= 0 ? paragraphNavigationTargets[currentTargetIndex] : null;

    if (currentTarget && currentWord > currentTarget.startWord + 2) {
      return currentTarget.startWord;
    }

    const anchorWord = currentTarget?.startWord ?? currentWord;
    return (
      paragraphNavigationTargets
        .filter((target) => target.startWord < anchorWord)
        .at(-1)?.startWord ?? 0
    );
  }

  function jumpToParagraph(direction: -1 | 1) {
    if (!document) return;

    const targetWord = getParagraphNavigationWord(direction);
    if (targetWord === currentWord) return;

    const wasPlaying = isPlaying;
    const restartsCurrentParagraph =
      direction < 0 &&
      paragraphNavigationTargets.some(
        (target) =>
          target.startWord === targetWord &&
          currentWord > target.startWord &&
          currentWord < target.startWord + target.wordCount,
      );
    stopPlayback();
    updateProgress(targetWord);
    setIsPlaying(false);
    setStatusMessage(
      direction > 0
        ? "Avanzaste al siguiente párrafo."
        : restartsCurrentParagraph
          ? "Volviste al inicio del párrafo actual."
          : targetWord === 0
            ? "Volviste al inicio de la lectura."
            : "Retrocediste al párrafo anterior.",
    );

    if (wasPlaying) {
      void startSpeech(targetWord);
    }
  }

  function getLineNavigationWord(direction: -1 | 1) {
    if (!document) return currentWord;

    const readingPane =
      activeWordRef.current?.closest(".document-text") ??
      globalThis.document.querySelector(".document-text");
    if (!readingPane) return getFallbackLineNavigationWord(direction);

    const lineTargets = getRenderedLineTargets(readingPane);
    if (lineTargets.length === 0) return getFallbackLineNavigationWord(direction);

    const activeLineIndex = lineTargets.findIndex(
      (line) => currentWord >= line.startWord && currentWord <= line.endWord,
    );

    if (activeLineIndex < 0) return getFallbackLineNavigationWord(direction);

    const targetLine = lineTargets[activeLineIndex + direction];
    return targetLine?.startWord ?? currentWord;
  }

  function getFallbackLineNavigationWord(direction: -1 | 1) {
    if (!document) return currentWord;
    const estimatedLineWords = 9;
    return Math.max(
      0,
      Math.min(document.wordCount - 1, currentWord + estimatedLineWords * direction),
    );
  }

  function jumpToLine(direction: -1 | 1) {
    if (!document) return;

    const targetWord = getLineNavigationWord(direction);
    if (targetWord === currentWord) return;

    const wasPlaying = isPlaying;
    stopPlayback();
    updateProgress(targetWord);
    setIsPlaying(false);
    setStatusMessage(
      direction > 0 ? "Avanzaste una línea de texto." : "Retrocediste una línea de texto.",
    );

    if (wasPlaying) {
      void startSpeech(targetWord);
    }
  }

  function changeRate(rate: PlaybackRate) {
    updatePreferences({ rate });
    setStatusMessage(`Velocidad actualizada a ${rate === 1 ? "Normal" : rate}.`);
    if (piperAudioRef.current && !piperAudioRef.current.ended) {
      piperAudioRef.current.playbackRate = rate;
      if (activeSegmentRef.current) {
        activeSegmentRef.current = {
          ...activeSegmentRef.current,
          rate,
        };
      }

      if (!piperAudioRef.current.paused) {
        const activeSegment = activeSegmentRef.current;
        const safeEndWord = Math.min(
          activeSegment?.endWord ?? document?.wordCount ?? progressWordRef.current,
          document?.wordCount ?? progressWordRef.current,
        );
        startPiperProgressTracker(
          piperAudioRef.current,
          activeSegment?.startWord ?? progressWordRef.current,
          safeEndWord,
          playbackSessionRef.current,
          activeSegment?.textToSpeak,
        );
      }
      return;
    }

    if (isPlaying) {
      stopPlayback();
      setIsPlaying(false);
      void startSpeech(progressWordRef.current, undefined, rate);
    }
  }

  function handleRateButtonClick(event: MouseEvent<HTMLButtonElement>) {
    changeRate(Number(event.currentTarget.dataset.rate) as PlaybackRate);
  }

  function toggleFocusControlsFromReading() {
    if (preferences.readingMode !== "focus") return;
    setFocusControlsVisible((visible) => !visible);
  }

  function toggleFocusTheme() {
    updatePreferences({
      theme: preferences.theme === "night" ? "warm-paper" : "night",
    });
  }

  function changeVoiceModel(modelId: VoiceModelId) {
    selectedVoiceModelRef.current = modelId;
    const wasPlaying =
      isPlaying ||
      Boolean(piperAudioRef.current && !piperAudioRef.current.ended) ||
      Boolean(utteranceRef.current && window.speechSynthesis.speaking);
    const restartWord = currentWord;

    stopPlayback();
    setIsPlaying(false);
    if (wasPlaying) {
      window.setTimeout(() => {
        void startSpeech(restartWord, undefined, preferences.rate, modelId);
      }, 0);
    }

    updatePreferences({ voiceId: modelId });
    setIsVoiceMenuOpen(false);
    setStatusMessage(
      modelId === PIPER_VOICE_MODEL_ID
        ? "Voz actualizada seleccionada. Si no inicia, se usará Voz estándar."
        : "Voz estándar seleccionada.",
    );
  }

  function resetReading() {
    stopPlayback();
    setIsPlaying(false);
    updateProgress(0);
    setStatusMessage("Lectura reiniciada. Avance guardado.");
  }

  async function applyCleanOnly() {
    if (!document) return;
    const cleaned = cleanTextWithoutInventing(document.originalText);

    if (!cleaned.trim()) {
      setStatusMessage("No se pudo aplicar limpieza local porque no hay texto legible suficiente.");
      return;
    }

    setDocument(
      createDocumentFromText({
        title: document.title,
        source: document.source,
        sourceLabel: document.sourceLabel,
        text: cleaned,
        qualityStatus: "ready",
        qualityMessage: "Limpieza local aplicada sin inventar contenido.",
        ocrAvailable: false,
      }),
    );
    setStatusMessage("Limpieza local aplicada: se retiraron citas, símbolos y marcas visuales sin inventar contenido.");
  }

  async function reconstructLegibleText() {
    if (!document) return;
    setIsProcessing(true);
    setStatusMessage("Preparando reconstrucción legible del OCR.");
    const response = await fetch("/api/text/reconstruct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: document.originalText }),
    });
    const data = (await response.json()) as { text: string; message: string };
    setIsProcessing(false);
    setDocument(
      createDocumentFromText({
        title: document.title,
        source: document.source,
        sourceLabel: document.sourceLabel,
        text: data.text,
        qualityStatus: "ready",
        qualityMessage: data.message,
        ocrAvailable: false,
      }),
    );
    setStatusMessage(data.message);
  }

  async function toggleFocusMode() {
    const nextMode = preferences.readingMode === "focus" ? "standard" : "focus";
    setFocusControlsVisible(true);
    updatePreferences({ readingMode: nextMode });

    if (nextMode === "focus") {
      window.scrollTo(0, 0);
      await documentElementFullscreen();
    } else if (globalThis.document.fullscreenElement) {
      await globalThis.document.exitFullscreen();
    }
  }

  function renderPlayerControls() {
    return (
      <>
        <div className="progress-strip" aria-hidden="true">
          <span style={{ width: `${percentage}%` }} />
        </div>
        <div className="player-main-controls">
          <div className="player-info-nav-row">
            <div className="player-readout-row">
              <div className="time-pill">
                <span>{formatRemainingTime(remainingSeconds)} restantes</span>
                <strong>{percentage}%</strong>
              </div>
              {renderVoiceModelSelector()}
            </div>
            {renderTextNavigationControls("standard")}
          </div>

          <div className="player-action-row">
            <div className="transport">
              <button type="button" onClick={() => seek(-10)} aria-label="Retroceder 10 segundos">
                <ChevronLeft size={18} />
                10 s
              </button>
              <button type="button" onClick={() => seek(-5)} aria-label="Retroceder 5 segundos">
                <ChevronLeft size={18} />
                5 s
              </button>
              <button className="play-button" type="button" onClick={togglePlayback}>
                {isPlaying ? <Pause size={22} /> : <Play size={22} />}
                {isPlaying ? "Pausar" : "Reproducir"}
              </button>
              <button type="button" onClick={() => seek(5)} aria-label="Adelantar 5 segundos">
                5 s
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={() => seek(10)} aria-label="Adelantar 10 segundos">
                10 s
                <ChevronRight size={18} />
              </button>
            </div>

            <div className="speed-control" aria-label="Velocidad de lectura">
              {([1, 0.85, 0.75, 0.5] as PlaybackRate[]).map((rate) => (
                <button
                  key={rate}
                  type="button"
                  data-rate={rate}
                  className={preferences.rate === rate ? "active" : ""}
                  onClick={handleRateButtonClick}
                >
                  {rate === 1 ? "Normal" : rate}
                </button>
              ))}
            </div>

            <button className="reset-button" type="button" onClick={resetReading}>
              <RotateCcw size={18} />
              <span>Reiniciar</span>
            </button>
          </div>
        </div>
      </>
    );
  }

  function renderVoiceModelSelector(variant: "standard" | "focus" = "standard") {
    const activeModel =
      VOICE_MODELS.find((model) => model.id === selectedVoiceModel) ?? VOICE_MODELS[0];

    return (
      <div
        className={`voice-model-selector ${
          variant === "focus" ? "focus-voice-selector" : ""
        }`}
      >
        <button
          className={`voice-model-button ${
            variant === "focus" ? "focus-voice-button" : ""
          }`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={isVoiceMenuOpen}
          aria-label="Cambiar modelo de voz"
          title="Cambiar modelo de voz"
          onClick={() => setIsVoiceMenuOpen((isOpen) => !isOpen)}
        >
          <SpeakingLipsIcon size={19} />
          <span>{activeModel.label}</span>
        </button>

        {isVoiceMenuOpen ? (
          <div className="voice-model-menu" role="menu">
            {VOICE_MODELS.map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={selectedVoiceModel === model.id}
                className={selectedVoiceModel === model.id ? "active" : ""}
                onClick={() => changeVoiceModel(model.id)}
              >
                <span>{model.label}</span>
                <small>{model.description}</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderVoiceStartupOverlay() {
    if (!voiceStartup?.visible) return null;

    return (
      <div className="voice-startup-overlay" role="status" aria-live="polite">
        <div className="voice-startup-modal" data-voice-status={voiceStartup.status}>
          <div className="voice-startup-icon" aria-hidden="true">
            <SpeakingLipsIcon size={24} />
          </div>
          <div>
            <p className="tool-title">Modelo de voz</p>
            <h2>{voiceStartup.message}</h2>
          </div>
          {voiceStartup.detail ? <p>{voiceStartup.detail}</p> : null}
          {typeof voiceStartup.progress === "number" ? (
            <div
              className="voice-startup-progress"
              aria-label={`Descarga ${voiceStartup.progress}%`}
            >
              <span style={{ width: `${voiceStartup.progress}%` }} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function renderFocusControls() {
    return (
      <aside className="focus-control-dock" aria-label="Controles de lectura en pantalla completa">
        <div className="focus-readout-row">
          <div className="focus-readout" aria-label="Avance de lectura">
            <span>{formatRemainingTime(remainingSeconds)} restantes</span>
            <strong>{percentage}%</strong>
          </div>
          {renderVoiceModelSelector("focus")}
        </div>

        {renderTextNavigationControls("focus")}

        <div className="focus-transport" aria-label="Reproducción">
          <button type="button" onClick={() => seek(-10)} aria-label="Retroceder 10 segundos">
            <ChevronLeft size={15} />
            10 s
          </button>
          <button type="button" onClick={() => seek(-5)} aria-label="Retroceder 5 segundos">
            <ChevronLeft size={15} />
            5 s
          </button>
          <button className="focus-play-button" type="button" onClick={togglePlayback}>
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
            {isPlaying ? "Pausar" : "Leer"}
          </button>
          <button type="button" onClick={() => seek(5)} aria-label="Adelantar 5 segundos">
            5 s
            <ChevronRight size={15} />
          </button>
          <button type="button" onClick={() => seek(10)} aria-label="Adelantar 10 segundos">
            10 s
            <ChevronRight size={15} />
          </button>
        </div>

        <div className="focus-speed" aria-label="Velocidad">
          {([1, 0.85, 0.75, 0.5] as PlaybackRate[]).map((rate) => (
            <button
              key={rate}
              type="button"
              data-rate={rate}
              className={preferences.rate === rate ? "active" : ""}
              onClick={handleRateButtonClick}
            >
              {rate === 1 ? "Normal" : rate}
            </button>
          ))}
        </div>

        <button
          className="focus-theme-toggle"
          type="button"
          onClick={toggleFocusTheme}
          aria-label={
            preferences.theme === "night" ? "Cambiar a papel cálido" : "Cambiar a lectura nocturna"
          }
          title={
            preferences.theme === "night" ? "Cambiar a papel cálido" : "Cambiar a lectura nocturna"
          }
        >
          {preferences.theme === "night" ? <SunMedium size={16} /> : <Moon size={16} />}
          <span>{preferences.theme === "night" ? "Papel" : "Noche"}</span>
        </button>

        <button className="focus-exit-action" type="button" onClick={toggleFocusMode}>
          Salir
        </button>
      </aside>
    );
  }

  function renderTextNavigationControls(variant: "standard" | "focus") {
    const previousWord = getParagraphNavigationWord(-1);
    const nextWord = getParagraphNavigationWord(1);
    const previousDisabled = !document || previousWord === currentWord;
    const nextDisabled = !document || nextWord === currentWord;
    const className = variant === "focus" ? "focus-text-nav" : "text-nav";
    const iconSize = variant === "focus" ? 14 : 16;

    return (
      <div className={className} aria-label="Navegación por texto">
        <button
          type="button"
          onClick={() => jumpToParagraph(-1)}
          disabled={previousDisabled}
          aria-label="Párrafo anterior"
        >
          <SkipBack size={iconSize} />
          <span>Párrafo</span>
        </button>
        <button
          type="button"
          onClick={() => jumpToLine(-1)}
          disabled={!document}
          aria-label="Línea anterior"
        >
          <ChevronLeft size={iconSize} />
          <span>Línea</span>
        </button>
        <button
          type="button"
          onClick={() => jumpToLine(1)}
          disabled={!document}
          aria-label="Siguiente línea"
        >
          <span>Línea</span>
          <ChevronRight size={iconSize} />
        </button>
        <button
          type="button"
          onClick={() => jumpToParagraph(1)}
          disabled={nextDisabled}
          aria-label="Siguiente párrafo"
        >
          <span>Párrafo</span>
          <SkipForward size={iconSize} />
        </button>
      </div>
    );
  }

  function renderModeControls(className = "") {
    return (
      <div className={`tool-group mode-controls ${className}`.trim()}>
        <p className="tool-title">Modos</p>
        <button
          type="button"
          className={preferences.theme === "warm-paper" ? "mode-button active" : "mode-button"}
          onClick={() => updatePreferences({ theme: "warm-paper" })}
        >
          <SunMedium size={18} />
          Papel cálido
        </button>
        <button
          type="button"
          className={preferences.theme === "night" ? "mode-button active" : "mode-button"}
          onClick={() => updatePreferences({ theme: "night" })}
        >
          <Moon size={18} />
          Lectura nocturna
        </button>
        <button type="button" className="mode-button" onClick={toggleFocusMode}>
          <ScanText size={18} />
          Pantalla completa
        </button>
      </div>
    );
  }

  return (
    <main
      className={`reader-shell theme-${preferences.theme} mode-${preferences.readingMode} ${
        document ? "has-document" : "empty-state"
      }`}
    >
      <header className="reader-topbar">
        <div className="file-identity">
          <span className="file-icon">
            <Image
              src="/icons/lector-documental-icon-headphones.png"
              alt=""
              width={44}
              height={44}
              priority
            />
          </span>
          <div>
            <p className="eyeless-label">Archivo actual</p>
            <h1>{document?.title ?? "Lector Documental Raul"}</h1>
          </div>
        </div>

      </header>

      <section className="workspace-grid">
        <aside className="home-panel">
          <button className="home-title" type="button" onClick={() => setActivePanel("file")}>
            <Home size={18} />
            <span>Casa</span>
          </button>
          <button
            className={activePanel === "file" ? "home-action active" : "home-action"}
            type="button"
            onClick={() => setActivePanel("file")}
          >
            <FileText size={22} />
            <span>Subir archivo</span>
          </button>
          <button
            className={activePanel === "text" ? "home-action active" : "home-action"}
            type="button"
            onClick={() => setActivePanel("text")}
          >
            <Type size={22} />
            <span>Pegar texto</span>
          </button>
          <button
            className={activePanel === "web" ? "home-action active" : "home-action"}
            type="button"
            onClick={() => setActivePanel("web")}
          >
            <Globe2 size={22} />
            <span>Leer sitio web</span>
          </button>

        </aside>

        <section className="reader-center">
          <div className="import-panel">
            {activePanel === "file" ? (
              <div className="input-cluster">
                <label className="upload-drop">
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/x-pdf,application/acrobat,applications/vnd.pdf,application/octet-stream,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                    onChange={handleFileChange}
                  />
                  <FileText size={24} />
                  <span>Seleccionar PDF, Word o texto</span>
                </label>
              </div>
            ) : null}

            {activePanel === "text" ? (
              <div className="input-cluster">
                <textarea
                  value={pastedText}
                  onChange={(event) => setPastedText(event.target.value)}
                  placeholder="Pega aquí el texto que quieres escuchar."
                />
                <button className="primary-action" type="button" onClick={processText}>
                  Preparar lectura
                </button>
              </div>
            ) : null}

            {activePanel === "web" ? (
              <div className="inline-form">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://sitio.com/articulo"
                />
                <button type="button" onClick={processUrl}>
                  Leer sitio
                </button>
              </div>
            ) : null}
          </div>

          {document ? (
            <>
              <div className="mobile-player-slot" aria-label="Controles de lectura">
                <div className="player-dock mobile-player">{renderPlayerControls()}</div>
              </div>
              <div className="mobile-modes-slot" aria-label="Modos de lectura">
                {renderModeControls("mobile-mode-controls")}
              </div>
            </>
          ) : null}

          <div className="reader-stage" aria-live="polite">
            {document ? (
              <article className="reader-document">
                <div className="reading-metrics">
                  <span>{formatRemainingTime(remainingSeconds)} restantes</span>
                  <strong>{percentage}% leído</strong>
                </div>
                <div
                  className="document-text"
                  onClick={toggleFocusControlsFromReading}
                  title={
                    preferences.readingMode === "focus"
                      ? focusControlsVisible
                        ? "Ocultar controles"
                        : "Mostrar controles"
                      : undefined
                  }
                >
                  {visibleTextBlocks.map((block) =>
                    renderStructuredTextBlock(block, currentWord),
                  )}
                </div>
              </article>
            ) : (
              <div className="empty-reader">
                <Headphones size={44} />
                <h2>Escucha, lee y retoma tus documentos con precisión.</h2>
                <p>
                  Sube un archivo, pega texto o pega una liga de sitio web. La lectura se
                  limpiará antes de llegar a la voz.
                </p>
              </div>
            )}
          </div>
        </section>

        <aside className="library-panel">
          <div className="tool-group mode-controls desktop-mode-controls">
            <p className="tool-title">Modos</p>
            <button
              type="button"
              className={preferences.theme === "warm-paper" ? "mode-button active" : "mode-button"}
              onClick={() => updatePreferences({ theme: "warm-paper" })}
            >
              <SunMedium size={18} />
              Papel cálido
            </button>
            <button
              type="button"
              className={preferences.theme === "night" ? "mode-button active" : "mode-button"}
              onClick={() => updatePreferences({ theme: "night" })}
            >
              <Moon size={18} />
              Lectura nocturna
            </button>
            <button type="button" className="mode-button" onClick={toggleFocusMode}>
              <ScanText size={18} />
              Pantalla completa
            </button>
          </div>

          {shouldShowTextReview ? (
            <div className="ocr-card">
              <Sparkles size={18} />
              <h3>Texto difícil de leer</h3>
              <p>{document?.quality.message}</p>
              <button type="button" onClick={applyCleanOnly}>
                Limpiar sin inventar
              </button>
              <small>
                Limpieza local por reglas: quita citas, símbolos, emojis y marcas visuales sin inventar contenido.
              </small>
              {integrations.gptOssReady ? (
                <>
                  <button type="button" onClick={reconstructLegibleText}>
                    Reconstruir con IA ligera
                  </button>
                  <small>IA local ligera disponible para texto difícil.</small>
                </>
              ) : (
                <small>La reconstrucción con IA ligera es opcional y no está configurada.</small>
              )}
            </div>
          ) : null}

          <div className="status-rail">
            <span className={isProcessing ? "status-dot busy" : "status-dot"} />
            <p>{isProcessing ? "Procesando contenido." : statusMessage}</p>
          </div>
        </aside>
      </section>

      <footer className="player-dock desktop-player">
        {renderPlayerControls()}
      </footer>

      {renderVoiceStartupOverlay()}

      {preferences.readingMode === "focus" && focusControlsVisible ? renderFocusControls() : null}
    </main>
  );
}

function SpeakingLipsIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M3.75 11.25c1.32-1.9 2.72-2.85 4.2-2.85 1.12 0 1.82.44 2.44.83.53.33 1 .62 1.61.62s1.08-.29 1.61-.62c.62-.39 1.32-.83 2.44-.83 1.48 0 2.88.95 4.2 2.85"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M3.75 12.15c1.65 2.25 4.18 3.45 8.25 3.45s6.6-1.2 8.25-3.45c-1.78-.42-3.15-.34-4.46.08-1.29.42-2.25 1.02-3.79 1.02s-2.5-.6-3.79-1.02c-1.31-.42-2.68-.5-4.46-.08Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 9.85v3.4"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.7"
      />
      <path
        d="M20.2 7.2c.7.58 1.16 1.32 1.38 2.22M21.95 5.35c1.08.92 1.75 2.07 2 3.46"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getDocumentBlocks(document: ReaderDocument | null): TextBlock[] {
  if (!document) return [];
  if (document.blocks?.length) return document.blocks;
  return segmentTextBlocks(document.cleanText);
}

function isParagraphNavigationTarget(block: TextBlock) {
  return block.wordCount > 0 && (block.kind === "paragraph" || block.kind === "bullet");
}

function getRenderedLineTargets(readingPane: Element) {
  const renderedWords = Array.from(
    readingPane.querySelectorAll<HTMLSpanElement>(".word[data-word-index]"),
  )
    .map((element) => {
      const wordIndex = Number(element.dataset.wordIndex);
      const rect = element.getBoundingClientRect();
      return {
        wordIndex,
        left: rect.left,
        top: rect.top,
        height: rect.height,
      };
    })
    .filter(
      (word) =>
        Number.isFinite(word.wordIndex) &&
        word.height > 0 &&
        Number.isFinite(word.left) &&
        Number.isFinite(word.top),
    )
    .sort((a, b) => a.top - b.top || a.left - b.left);

  const lines: Array<{
    top: number;
    tolerance: number;
    words: typeof renderedWords;
  }> = [];

  for (const word of renderedWords) {
    const tolerance = Math.max(6, word.height * 0.52);
    const existingLine = lines.find((line) => Math.abs(line.top - word.top) <= line.tolerance);

    if (existingLine) {
      existingLine.words.push(word);
      existingLine.top = (existingLine.top + word.top) / 2;
      existingLine.tolerance = Math.max(existingLine.tolerance, tolerance);
      continue;
    }

    lines.push({
      top: word.top,
      tolerance,
      words: [word],
    });
  }

  return lines
    .map((line) => {
      const sortedWords = line.words.sort((a, b) => a.left - b.left);
      return {
        startWord: Math.min(...sortedWords.map((word) => word.wordIndex)),
        endWord: Math.max(...sortedWords.map((word) => word.wordIndex)),
      };
    })
    .sort((a, b) => a.startWord - b.startWord);
}

function buildPiperWordTimeline(
  text: string,
  startWord: number,
  endWord: number,
  durationSeconds: number,
): PiperWordTiming[] {
  const wordCount = Math.max(0, endWord - startWord);
  if (wordCount === 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const localTokens = tokenizeWords(text);
  const timingCount = Math.min(wordCount, localTokens.length || wordCount);
  const weights = Array.from({ length: timingCount }, (_, index) => {
    const token = localTokens[index];
    if (!token) return 1;

    const nextStart = localTokens[index + 1]?.start ?? text.length;
    const separator = text.slice(token.end, nextStart);
    const wordLength = Math.max(1, token.text.length);
    let weight = Math.max(0.82, Math.min(3.8, Math.sqrt(wordLength) * 0.96));

    if (/[.!?]/.test(separator)) weight += 1.25;
    if (/[;:]/.test(separator)) weight += 0.85;
    if (/,/.test(separator)) weight += 0.5;
    if (/\n{2,}/.test(separator)) weight += 1.05;
    if (/\n/.test(separator)) weight += 0.35;

    return weight;
  });

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || timingCount;
  const usableDuration = Math.max(0.1, durationSeconds);
  let elapsed = 0;

  return weights.map((weight, index) => {
    const timing = {
      startsAt: Math.min(usableDuration, elapsed),
      wordIndex: startWord + index,
    };
    elapsed += (weight / totalWeight) * usableDuration;
    return timing;
  });
}

function getPiperWordForTime(
  timeline: PiperWordTiming[],
  mediaTime: number,
  startWord: number,
  endWord: number,
) {
  if (timeline.length === 0) return startWord;

  let low = 0;
  let high = timeline.length - 1;
  let match = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (timeline[middle].startsAt <= mediaTime) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return Math.max(startWord, Math.min(endWord, timeline[match].wordIndex));
}

function getPiperHighlightLead(playbackRate: number) {
  if (playbackRate >= 1) return 0.2;
  if (playbackRate >= 0.85) return 0.16;
  if (playbackRate >= 0.75) return 0.13;
  return 0.1;
}

function createVisibleTextParts(params: {
  block: TextBlock;
  cleanText: string;
  tokens: ReturnType<typeof tokenizeWords>;
  windowStart: number;
  windowEnd: number;
}) {
  const blockStart = Math.max(params.block.start, params.windowStart);
  const blockEnd = Math.min(params.block.end, params.windowEnd);
  const blockTokens = params.tokens.filter(
    (token) => token.start >= blockStart && token.end <= blockEnd,
  );
  const parts: VisibleTextPart[] = [];
  let cursor = blockStart;

  for (const token of blockTokens) {
    if (token.start > cursor) {
      parts.push({
        id: `t-${cursor}-${token.start}`,
        text: params.cleanText.slice(cursor, token.start),
        type: "text",
      });
    }

    parts.push({
      id: token.id,
      text: token.text,
      type: "word",
      wordIndex: token.wordIndex,
    });
    cursor = token.end;
  }

  if (cursor < blockEnd) {
    parts.push({
      id: `t-${cursor}-${blockEnd}`,
      text: params.cleanText.slice(cursor, blockEnd),
      type: "text",
    });
  }

  return parts.filter((part) => part.text.length > 0);
}

function renderStructuredTextBlock(
  block: VisibleTextBlock,
  currentWord: number,
) {
  const content = block.parts.map((part) =>
    part.type === "word" ? (
      <span
        key={part.id}
        className={part.wordIndex === currentWord ? "word active-word" : "word"}
        data-word-index={part.wordIndex}
      >
        {part.text}
      </span>
    ) : (
      <span key={part.id}>{part.text}</span>
    ),
  );
  const className = `text-block text-block-${block.kind}`;

  if (block.kind === "heading") {
    return (
      <h2 key={block.id} className={className}>
        {content}
      </h2>
    );
  }

  if (block.kind === "subheading") {
    return (
      <h3 key={block.id} className={className}>
        {content}
      </h3>
    );
  }

  return (
    <p key={block.id} className={className}>
      {content}
    </p>
  );
}

async function documentElementFullscreen() {
  const root = document.documentElement;
  if (!document.fullscreenElement && root.requestFullscreen) {
    try {
      await root.requestFullscreen();
    } catch {
      // Some mobile browsers block fullscreen outside specific gestures.
    }
  }
}
