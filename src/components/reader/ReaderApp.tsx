"use client";

import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Globe2,
  Headphones,
  Speech,
  X,
  Moon,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  ScanText,
  SkipBack,
  SkipForward,
  Sparkles,
  SunMedium,
  Type,
} from "lucide-react";
import Image from "next/image";
import { flushSync } from "react-dom";
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
import { buildPiperTimeline, piperWordAtTime } from "@/lib/reader/piper-timing";
import { paginateBook, pageForWord } from "@/lib/reader/book";
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
    label: "Laura",
    description: "Español de México · voz local para uso personal.",
  },
];

export function ReaderApp() {
  const [state, setState] = useState<StoredReaderState>(DEFAULT_READER_STATE);
  const [activePanel, setActivePanel] = useState<"file" | "text" | "web">("file");
  const [importOpen, setImportOpen] = useState(false);
  const [spreadSize, setSpreadSize] = useState(1);
  const [pastedText, setPastedText] = useState(SAMPLE_TEXT);
  const [url, setUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [focusControlsVisible, setFocusControlsVisible] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Avance guardado en este dispositivo.");
  const [importError, setImportError] = useState<string | null>(null);
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceStartup, setVoiceStartup] = useState<VoiceStartupState | null>(null);
  const [isVoiceMenuOpen, setIsVoiceMenuOpen] = useState(false);
  const [integrations, setIntegrations] = useState<IntegrationsStatus>({
    gptOssReady: false,
  });
  const [isHydrated, setIsHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState("");
  const processingAbortRef = useRef<AbortController | null>(null);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const focusDockRef = useRef<HTMLElement | null>(null);
  const playerDockRef = useRef<HTMLElement | null>(null);
  const readerHeaderRef = useRef<HTMLElement | null>(null);
  const voiceDialogRef = useRef<HTMLDialogElement | null>(null);
  const storageEnabledRef = useRef(false);
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
  const hasDocument = Boolean(document);
  const preferences = state.preferences;
  const selectedVoiceModel: VoiceModelId =
    preferences.voiceId === PIPER_VOICE_MODEL_ID ? PIPER_VOICE_MODEL_ID : STANDARD_VOICE_MODEL_ID;
  const selectedVoiceModelRef = useRef<VoiceModelId>(selectedVoiceModel);
  const playbackRateRef = useRef<PlaybackRate>(preferences.rate);
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
    if (piperAudioRef.current) {
      piperAudioRef.current.onended = null;
      piperAudioRef.current.onerror = null;
      piperAudioRef.current.pause();
    }
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
      voiceAbortRef.current?.abort();
      voiceAbortRef.current = null;
      prefetchAbortRef.current?.abort();
      prefetchAbortRef.current = null;
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
  const bookPages = useMemo(() => paginateBook(textBlocks, tokens.length), [textBlocks, tokens.length]);
  const activePage = pageForWord(bookPages, currentWord);
  const spreadStart = Math.floor(activePage / spreadSize) * spreadSize;
  const visiblePages = useMemo(() => {
    if (!document || tokens.length === 0) return [];
    return bookPages.slice(spreadStart, spreadStart + spreadSize).map((page, offset) => {
    const { startWord, endWord } = page;
    const visibleWords = tokens.slice(startWord, endWord);
    const windowStart = startWord === 0 ? 0 : visibleWords[0]?.start ?? 0;
    // Include punctuation after the last visible word, including the document's ending.
    const windowEnd = tokens[endWord]?.start ?? document.cleanText.length;

    const blocks = textBlocks
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
    return { number: spreadStart + offset + 1, blocks };
    });
  }, [spreadStart, spreadSize, bookPages, document, textBlocks, tokens]);
  const percentage = calculatePercentage(document?.wordCount ?? 0, currentWord);
  const remainingSeconds = estimateRemainingSeconds(
    document?.wordCount ?? 0,
    currentWord,
    preferences.rate,
  );
  useEffect(() => {
    let mounted = true;
    void loadReaderState().then((result) => {
      if (!mounted) return;
      setState(result.state);
      storageEnabledRef.current = result.ok;
      setStorageWarning(result.ok ? "" : result.error);
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
      navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => undefined);
    }

    return () => {
      window.speechSynthesis?.removeEventListener?.("voiceschanged", refreshVoices);
      mounted = false;
      processingAbortRef.current?.abort();
      stopPiperAudio();
      stopPlayback();
    };
  }, [stopPiperAudio, stopPlayback]);

  useEffect(() => {
    selectedVoiceModelRef.current = selectedVoiceModel;
  }, [selectedVoiceModel]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 900px)");
    const resize = () => setSpreadSize(query.matches ? 2 : 1);
    resize();
    query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);

  useEffect(() => {
    const dock = playerDockRef.current;
    if (!dock) return;
    const root = globalThis.document.documentElement;
    const header = readerHeaderRef.current;
    const measure = () => {
      root.style.setProperty("--player-dock-height", `${dock.getBoundingClientRect().height + 20}px`);
      root.style.setProperty("--reader-header-height", `${header?.getBoundingClientRect().height ?? 72}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    if (header) observer.observe(header);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--player-dock-height");
      root.style.removeProperty("--reader-header-height");
    };
  }, [hasDocument, preferences.readingMode, isHydrated]);

  useEffect(() => {
    const dialog = voiceDialogRef.current;
    if (voiceStartup?.visible && dialog && !dialog.open) dialog.showModal();
  }, [voiceStartup?.visible]);

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
    const root = globalThis.document.documentElement;
    const dock = focusDockRef.current;
    if (!dock || preferences.readingMode !== "focus" || !focusControlsVisible) {
      root.style.setProperty("--focus-dock-height", "0px");
      return;
    }
    const measure = () => root.style.setProperty("--focus-dock-height", `${dock.getBoundingClientRect().height + 20}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => { observer.disconnect(); root.style.removeProperty("--focus-dock-height"); };
  }, [preferences.readingMode, focusControlsVisible]);

  useEffect(() => {
    let nativeFullscreen = Boolean(globalThis.document.fullscreenElement);
    const syncFullscreen = () => {
      const active = Boolean(globalThis.document.fullscreenElement);
      if (nativeFullscreen && !active) {
        setState((current) => ({ ...current, preferences: { ...current.preferences, readingMode: "standard" } }));
      }
      nativeFullscreen = active;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (isVoiceMenuOpen) { setIsVoiceMenuOpen(false); return; }
      setState((current) => current.preferences.readingMode === "focus" ? { ...current, preferences: { ...current.preferences, readingMode: "standard" } } : current);
    };
    globalThis.document.addEventListener("fullscreenchange", syncFullscreen);
    window.addEventListener("keydown", escape);
    return () => {
      globalThis.document.removeEventListener("fullscreenchange", syncFullscreen);
      window.removeEventListener("keydown", escape);
    };
  }, [isVoiceMenuOpen]);

  useEffect(() => {
    if (!isVoiceMenuOpen) return;
    const menus = globalThis.document.querySelectorAll<HTMLElement>(".voice-model-menu");
    for (const menu of menus) {
      if (menu.getBoundingClientRect().width > 0) { menu.querySelector<HTMLButtonElement>("button[aria-checked=true]")?.focus(); break; }
    }
  }, [isVoiceMenuOpen]);

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
      const dock = preferences.readingMode === "focus" ? focusDockRef.current : playerDockRef.current;
      const dockRect = dock?.getBoundingClientRect();
      const bottom = dockRect && dockRect.height > 0 && dockRect.top > paneRect.top
        ? Math.min(paneRect.bottom, dockRect.top)
        : paneRect.bottom;
      const visibleHeight = Math.max(1, bottom - paneRect.top);
      // Keep the active line visible without restarting smooth scroll on every word.
      if (wordRect.top >= paneRect.top + visibleHeight * 0.18 &&
          wordRect.bottom <= paneRect.top + visibleHeight * 0.72) return;
      const nextTop =
        readingPane.scrollTop + wordRect.top - paneRect.top - visibleHeight * 0.46;

      readingPane.scrollTo({
        top: Math.max(0, nextTop),
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
      return;
    }

    activeWord.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [currentWord, preferences.readingMode]);

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
    if (!isHydrated || !storageEnabledRef.current) return;
    let active = true;
    void saveReaderState({
      ...state,
      progress: {
        ...state.progress,
        percentage,
        estimatedRemainingSeconds: remainingSeconds,
        updatedAt: new Date().toISOString(),
      },
    }).then((result) => {
      if (active && !result.ok && result.code !== "superseded") setStorageWarning(result.error);
      else if (active && result.ok) setStorageWarning("");
    });
    return () => { active = false; };
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
    setImportError(null);
    storageEnabledRef.current = true;
    stopPlayback();
    setIsPlaying(false);
    setImportOpen(false);

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
    if (!file || processingAbortRef.current) return;
    setImportError(null);

    if (file.size <= 0) {
      setImportError("El archivo llegó vacío. Descárgalo primero y vuelve a seleccionarlo.");
      return;
    }

    if (file.size > MAX_CLIENT_UPLOAD_BYTES) {
      setImportError("El archivo es demasiado grande. Usa un PDF menor a 25 MB.");
      return;
    }

    setIsProcessing(true);
    const controller = new AbortController();
    processingAbortRef.current = controller;
    setStatusMessage("Extrayendo texto del archivo.");

    try {
      const { importFile } = await import("@/lib/reader/import-file");
      const result = await importFile(file, {
        signal: controller.signal,
        onStatus: (message) => { if (!controller.signal.aborted) setStatusMessage(message); },
      });
      if (controller.signal.aborted) return;
      const prepared = createDocumentFromText({
        title: file.name || "Documento importado", source: "file", sourceLabel: file.type || "archivo local",
        text: result.text, qualityStatus: result.needsReview ? "needs-review" : "ready",
        qualityMessage: result.usedOcr ? "Texto obtenido por OCR. Revisa nombres y cifras." : "Archivo procesado en este dispositivo.",
        ocrAvailable: result.needsReview,
      });
      if (!prepared.wordCount) {
        setImportError("No se encontró texto para escuchar. El documento anterior se conserva.");
        return;
      }
      setDocument(prepared);
      setStatusMessage(result.usedOcr ? "OCR terminado. Revisa nombres y cifras antes de escuchar." : "Archivo listo para escuchar.");
    } catch (error) {
      if (!controller.signal.aborted) setImportError(error instanceof Error ? error.message : "No se pudo procesar el archivo.");
    } finally {
      if (processingAbortRef.current === controller) processingAbortRef.current = null;
      setIsProcessing(false);
    }
  }

  async function processText() {
    if (processingAbortRef.current) return;
    setImportError(null);
    if (!pastedText.trim()) { setImportError("Pega texto antes de continuar."); return; }
    setStatusMessage("Limpiando texto pegado.");
    try {
      const prepared = createDocumentFromText({source: "pastedText", title: "Texto pegado", sourceLabel: "Texto pegado", text: pastedText, ocrAvailable: false});
      if (!prepared.wordCount) { setImportError("No se encontró texto para escuchar."); return; }
      setPastedText(prepared.cleanText);
      setDocument(prepared);
    } catch {
      setImportError("No se pudo preparar el texto. Prueba con un fragmento menor.");
    }
  }

  async function processUrl() {
    if (processingAbortRef.current) return;
    setImportError(null);
    const controller = new AbortController();
    processingAbortRef.current = controller;
    const targetUrl = url;
    setIsProcessing(true);
    setStatusMessage("Leyendo sitio web.");
    try {
      const response = await fetch("/api/documents/process", {
        signal: controller.signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "website",
          url: targetUrl,
        }),
      });
      const data = await readProcessResponse(response, "No se pudo procesar la liga.");

      if (controller.signal.aborted) return;
      if (data.document) setDocument(data.document);
      else setImportError(data.error ?? "No se pudo procesar la liga.");
    } catch {
      if (!controller.signal.aborted) setImportError("No se pudo conectar con el procesador de sitios web.");
    } finally {
      if (processingAbortRef.current === controller) processingAbortRef.current = null;
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

  function getSpeechWindow(fromWord: number, voiceModel = selectedVoiceModelRef.current) {
    if (!document) return null;

    const safeFromWord = Math.max(0, Math.min(fromWord, document.wordCount));
    const chunk = getChunkForWord(safeFromWord);
    if (!chunk || safeFromWord >= document.wordCount) return null;

    const chunkTokens = tokenizeWords(chunk.cleanText);
    const localStartWord = Math.max(0, safeFromWord - chunk.startWord);
    const startChar = chunkTokens[localStartWord]?.start ?? 0;
    let localEndWord = chunkTokens.length;
    if (voiceModel === PIPER_VOICE_MODEL_ID) {
      localEndWord = Math.min(localStartWord + 40, chunkTokens.length);
      // Prefer a sentence ending while keeping startup synthesis small.
      for (let index = localEndWord - 1; index >= localStartWord + 12; index--) {
        const after = chunk.cleanText.slice(chunkTokens[index].end, chunkTokens[index + 1]?.start ?? chunk.cleanText.length);
        if (/[.!?]/u.test(after) || /[.!?]$/u.test(chunkTokens[index].text)) { localEndWord = index + 1; break; }
      }
    }
    const endChar = chunkTokens[localEndWord]?.start ?? chunk.cleanText.length;
    const textToSpeak = chunk.cleanText.slice(startChar, endChar).trim();
    const speechBaseWord = chunk.startWord + localStartWord;
    const chunkEndWord = Math.min(chunk.startWord + localEndWord, document.wordCount);

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
          piperWordTimelineRef.current = buildPiperTimeline(
            tokenizeWords(textToSpeak ?? "").slice(0, endWord - startWord),
            startWord,
            audio.duration,
          );
        }

        const nextWord = piperWordAtTime(
          piperWordTimelineRef.current,
          audio.currentTime,
          startWord,
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

    playbackRateRef.current = rate;
    const activeSession = sessionId ?? playbackSessionRef.current + 1;
    playbackSessionRef.current = activeSession;
    shouldContinuePlaybackRef.current = true;

    if (!sessionId) {
      window.speechSynthesis?.cancel();
      clearProgressTimer();
      clearPiperProgressTracker();
    }

    const speechWindow = getSpeechWindow(fromWord, voiceModel);
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
        showStartup: sessionId === undefined,
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
      if (playbackSessionRef.current !== params.activeSession) return;
      clearProgressTimer();

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
    showStartup: boolean;
  }) {
    window.speechSynthesis?.cancel();
    stopPiperAudio();
    setIsPlaying(false);
    setStatusMessage("Preparando a Laura.");
    if (params.showStartup) updateVoiceStartupStatus({
      stage: "preparing",
      message: "Preparando a Laura",
      detail: "Preparando la voz en este dispositivo.",
    });

    let acceptingStatus = true;
    const controller = new AbortController();
    voiceAbortRef.current?.abort();
    voiceAbortRef.current = controller;
    try {
      console.info("[Piper TTS] Inicio de lectura", {
        documentId: document?.id,
        title: document?.title,
        fromWord: params.speechBaseWord,
        words: countWords(params.textToSpeak),
      });

      const result = await synthesizePiperSpeech({
        signal: controller.signal,
        text: params.textToSpeak,
        onStatus: (update) => {
          if (params.showStartup && acceptingStatus && playbackSessionRef.current === params.activeSession) updateVoiceStartupStatus(update);
        },
      });
      acceptingStatus = false;

      if (playbackSessionRef.current !== params.activeSession) return;

      console.info("[Piper TTS] Audio generado", {
        engine: "piper",
        initMs: Math.round(result.initMs),
        generationMs: Math.round(result.generationMs),
        bytes: result.audio.size,
      });

      if (params.showStartup) updateVoiceStartupStatus({
        stage: "playing",
        message: "Laura está lista",
        detail: "Iniciando el audio.",
      });
      await startPiperAudioPlayback(params, result.audio);
    } catch (error) {
      acceptingStatus = false;
      if (controller.signal.aborted) return;
      await fallbackToBrowserVoice(params, error);
    } finally {
      if (voiceAbortRef.current === controller) voiceAbortRef.current = null;
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
    // Decode locally to exclude silent regions from the estimated word clock.
    let timeline: PiperWordTiming[] = [];
    try {
      const decoder = new OfflineAudioContext(1, 1, 22050);
      const buffer = await decoder.decodeAudioData(await audioBlob.arrayBuffer());
      timeline = buildPiperTimeline(
        tokenizeWords(params.textToSpeak).slice(0, params.chunkEndWord - params.speechBaseWord),
        params.speechBaseWord, buffer.duration, buffer.getChannelData(0), buffer.sampleRate,
      );
    } catch (error) {
      console.warn("[Piper TTS] Acoustic timing unavailable; using duration estimate", error);
    }
    if (playbackSessionRef.current !== params.activeSession) return;
    piperWordTimelineRef.current = timeline;
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.playbackRate = playbackRateRef.current;
    piperAudioUrlRef.current = audioUrl;
    piperAudioRef.current = audio;
    utteranceRef.current = null;
    boundarySeenRef.current = false;
    activeSegmentRef.current = {
      startWord: params.speechBaseWord,
      endWord: params.chunkEndWord,
      rate: playbackRateRef.current,
      textToSpeak: params.textToSpeak,
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
      if (playbackSessionRef.current !== params.activeSession || piperAudioRef.current !== audio) return;
      cleanup();
      clearProgressTimer();
      clearPiperProgressTracker();
      if (playbackSessionRef.current !== params.activeSession) return;

      updateProgress(Math.max(progressWordRef.current, params.chunkEndWord));

      if (shouldContinuePlaybackRef.current && document && params.chunkEndWord < document.wordCount) {
        void startSpeech(
          params.chunkEndWord,
          params.activeSession,
          playbackRateRef.current,
          params.voiceModel,
        );
        return;
      }

      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedÃ³ guardado.");
    };

    audio.onerror = () => {
      if (playbackSessionRef.current !== params.activeSession || piperAudioRef.current !== audio) return;
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
    if (playbackSessionRef.current !== params.activeSession || piperAudioRef.current !== audio) {
      audio.pause();
      return;
    }
    startPiperProgressTracker(
      audio,
      params.speechBaseWord,
      params.chunkEndWord,
      params.activeSession,
      params.textToSpeak,
    );
    setVoiceStartup(null);
    setIsPlaying(true);
    setStatusMessage("Reproduciendo con Laura.");
    const next = getSpeechWindow(params.chunkEndWord, PIPER_VOICE_MODEL_ID);
    if (next && shouldContinuePlaybackRef.current) {
      prefetchAbortRef.current?.abort();
      const controller = new AbortController();
      prefetchAbortRef.current = controller;
      // Use the engine's bounded in-memory cache; do not retain document audio on a server.
      void synthesizePiperSpeech({ text: next.textToSpeak, signal: controller.signal })
        .catch(error => { if (!controller.signal.aborted) console.warn("[Piper TTS] Preparación anticipada no disponible", error); })
        .finally(() => { if (prefetchAbortRef.current === controller) prefetchAbortRef.current = null; });
    }
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
      rate: playbackRateRef.current,
      voiceModel: STANDARD_VOICE_MODEL_ID,
      preferredSystemVoice,
      statusMessage: "Laura no pudo iniciar. Se usó Voz estándar.",
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
        const audio = piperAudioRef.current;
        const session = playbackSessionRef.current;
        void audio
          .play()
          .then(() => {
            if (playbackSessionRef.current !== session || piperAudioRef.current !== audio) return;
            const activeSegment = activeSegmentRef.current;
            startPiperProgressTracker(
              audio,
              activeSegment?.startWord ?? currentWord,
              Math.min(activeSegment?.endWord ?? document.wordCount, document.wordCount),
              playbackSessionRef.current,
              activeSegment?.textToSpeak,
            );
            setIsPlaying(true);
            setStatusMessage("Audio reanudado con Laura.");
          })
          .catch((error: unknown) => {
            if (playbackSessionRef.current !== session || piperAudioRef.current !== audio) return;
            setIsPlaying(false);
            setStatusMessage(
              error instanceof Error
                ? `No se pudo reanudar a Laura: ${error.message}`
                : "No se pudo reanudar a Laura.",
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
    if (targetLine) return targetLine.startWord;
    const page = bookPages[activePage + direction];
    return page ? (direction > 0 ? page.startWord : page.endWord - 1) : currentWord;
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

    let targetWord = getLineNavigationWord(direction);
    if (targetWord === currentWord) return;

    const wasPlaying = isPlaying;
    stopPlayback();
    if (direction < 0 && !globalThis.document.querySelector(`.document-text .word[data-word-index="${targetWord}"]`)) {
      // Render the preceding page before measuring its last visual line.
      flushSync(() => updateProgress(targetWord));
      const pane = globalThis.document.querySelector(".document-text");
      const line = pane && getRenderedLineTargets(pane).find(item => targetWord >= item.startWord && targetWord <= item.endWord);
      if (line) targetWord = line.startWord;
    }
    updateProgress(targetWord);
    setIsPlaying(false);
    setStatusMessage(
      direction > 0 ? "Avanzaste una línea de texto." : "Retrocediste una línea de texto.",
    );

    if (wasPlaying) {
      void startSpeech(targetWord);
    }
  }

  function turnBookPage(direction: -1 | 1) {
    const target = bookPages[spreadStart + direction * spreadSize];
    if (!target) return;
    const wasPlaying = isPlaying;
    stopPlayback();
    updateProgress(target.startWord);
    setIsPlaying(false);
    if (wasPlaying) void startSpeech(target.startWord);
  }

  function openImport(panel: "file" | "text" | "web") {
    setImportError(null);
    setActivePanel(panel);
    setImportOpen(true);
  }

  function changeRate(rate: PlaybackRate) {
    playbackRateRef.current = rate;
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
      Boolean(piperAudioRef.current && !piperAudioRef.current.paused && !piperAudioRef.current.ended) ||
      Boolean(utteranceRef.current && window.speechSynthesis.speaking && !window.speechSynthesis.paused);
    const restartWord = progressWordRef.current;

    stopPlayback();
    setIsPlaying(false);
    if (wasPlaying) {
      void startSpeech(restartWord, undefined, preferences.rate, modelId);
    }

    updatePreferences({ voiceId: modelId });
    setIsVoiceMenuOpen(false);
    setStatusMessage(
      modelId === PIPER_VOICE_MODEL_ID
        ? "Laura seleccionada. Si no inicia, se usará Voz estándar."
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
    if (!document || processingAbortRef.current) return;
    const controller = new AbortController();
    processingAbortRef.current = controller;
    setIsProcessing(true);
    setStatusMessage("Preparando reconstrucción del texto.");
    try {
      const response = await fetch("/api/text/reconstruct", {
        method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: document.originalText }),
      });
      const data = await response.json() as { text?: string; message?: string; error?: string };
      if (!response.ok || !data.text?.trim()) throw new Error(data.error || "El servicio no devolvió texto válido.");
      if (controller.signal.aborted) return;
      setDocument(createDocumentFromText({
        title: document.title, source: document.source, sourceLabel: document.sourceLabel,
        text: data.text, qualityStatus: "needs-review", qualityMessage: data.message || "Revisa el resultado antes de escuchar.", ocrAvailable: true,
      }));
      setStatusMessage(data.message || "Texto recibido. Revisa nombres y cifras.");
    } catch (error) {
      setStatusMessage(controller.signal.aborted ? "Reconstrucción cancelada." : error instanceof Error ? error.message : "No se pudo reconstruir el texto. Se conserva el original.");
    } finally {
      if (processingAbortRef.current === controller) processingAbortRef.current = null;
      setIsProcessing(false);
    }
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
                <RotateCcw size={20} aria-hidden="true" />
                <span>10 s</span>
              </button>
              <button type="button" onClick={() => seek(-5)} aria-label="Retroceder 5 segundos">
                <RotateCcw size={20} aria-hidden="true" />
                <span>5 s</span>
              </button>
              <button className="play-button" type="button" onClick={togglePlayback} aria-label={isPlaying ? "Pausar" : "Reproducir"} title={isPlaying ? "Pausar" : "Reproducir"}>
                {isPlaying ? <Pause size={22} /> : <Play size={22} />}
              </button>
              <button type="button" onClick={() => seek(5)} aria-label="Adelantar 5 segundos">
                <RotateCw size={20} aria-hidden="true" />
                <span>5 s</span>
              </button>
              <button type="button" onClick={() => seek(10)} aria-label="Adelantar 10 segundos">
                <RotateCw size={20} aria-hidden="true" />
                <span>10 s</span>
              </button>
            </div>

            <div className="speed-control" aria-label="Velocidad de lectura">
              {([1, 0.85, 0.75, 0.65, 0.5] as PlaybackRate[]).map((rate) => (
                <button
                  key={rate}
                  type="button"
                  data-rate={rate}
                  aria-pressed={preferences.rate === rate}
                  className={preferences.rate === rate ? "active" : ""}
                  onClick={handleRateButtonClick}
                >
                  {rate === 1 ? "Normal" : rate}
                </button>
              ))}
            </div>

            <button className="reset-button" type="button" onClick={resetReading} aria-label="Reiniciar" title="Reiniciar">
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
          <Speech size={19} />
          <span>{activeModel.label}</span>
        </button>

        {isVoiceMenuOpen ? (
          <div className="voice-model-menu" role="menu" aria-label="Voces" onKeyDown={(event) => {
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const current = buttons.indexOf(globalThis.document.activeElement as HTMLButtonElement);
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
              buttons[index]?.focus();
            }
            if (event.key === "Escape") {
              event.stopPropagation(); setIsVoiceMenuOpen(false);
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".voice-model-button")?.focus();
            }
          }}>
            {VOICE_MODELS.map((model) => (
              <button
                key={model.id}
                type="button"
                role="menuitemradio"
                aria-checked={selectedVoiceModel === model.id}
                className={selectedVoiceModel === model.id ? "active" : ""}
                onClick={(event) => {
                  event.currentTarget.closest(".voice-model-selector")?.querySelector<HTMLButtonElement>(".voice-model-button")?.focus();
                  changeVoiceModel(model.id);
                }}
              >
                <span>{model.label}</span>
                <small>{model.description}</small>
              </button>
            ))}
            <small className="voice-credit"><a href="https://huggingface.co/HirCoir/Piper-TTS-Laura" target="_blank" rel="noreferrer">Laura por HirCoir · CC BY-NC 4.0</a></small>
          </div>
        ) : null}
      </div>
    );
  }

  function renderVoiceStartupOverlay() {
    if (!voiceStartup?.visible) return null;

    return (
      <dialog ref={voiceDialogRef} className="voice-startup-overlay" aria-labelledby="voice-startup-title" onCancel={() => { stopPlayback(); setIsPlaying(false); }}>
        <div className="voice-startup-modal" data-voice-status={voiceStartup.status}>
          <div className="voice-startup-icon" aria-hidden="true">
            <Speech size={24} />
          </div>
          <div>
            <p className="tool-title">Modelo de voz</p>
            <h2 id="voice-startup-title" aria-live="polite">{voiceStartup.message}</h2>
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
          <button type="button" className="primary-action" onClick={() => { stopPlayback(); setIsPlaying(false); setStatusMessage("Preparación de voz cancelada."); }}>Cancelar</button>
        </div>
      </dialog>
    );
  }

  function renderFocusControls() {
    return (
      <aside ref={focusDockRef} className="focus-control-dock" aria-label="Controles de lectura en pantalla completa">
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
            <RotateCcw size={20} aria-hidden="true" />
            <span>10 s</span>
          </button>
          <button type="button" onClick={() => seek(-5)} aria-label="Retroceder 5 segundos">
            <RotateCcw size={20} aria-hidden="true" />
            <span>5 s</span>
          </button>
          <button className="focus-play-button" type="button" onClick={togglePlayback} aria-label={isPlaying ? "Pausar" : "Reproducir"} title={isPlaying ? "Pausar" : "Reproducir"}>
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button type="button" onClick={() => seek(5)} aria-label="Adelantar 5 segundos">
            <RotateCw size={20} aria-hidden="true" />
            <span>5 s</span>
          </button>
          <button type="button" onClick={() => seek(10)} aria-label="Adelantar 10 segundos">
            <RotateCw size={20} aria-hidden="true" />
            <span>10 s</span>
          </button>
        </div>

        <div className="focus-speed" aria-label="Velocidad">
          {([1, 0.85, 0.75, 0.65, 0.5] as PlaybackRate[]).map((rate) => (
            <button
              key={rate}
              type="button"
              data-rate={rate}
              aria-pressed={preferences.rate === rate}
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
          title="Párrafo anterior"
        >
          <SkipBack size={iconSize} />
          <span>Párrafo</span>
        </button>
        <button
          type="button"
          onClick={() => jumpToLine(-1)}
          disabled={!document}
          aria-label="Línea anterior"
          title="Línea anterior"
        >
          <ChevronLeft size={iconSize} />
          <span>Línea</span>
        </button>
        <button
          type="button"
          onClick={() => jumpToLine(1)}
          disabled={!document}
          aria-label="Siguiente línea"
          title="Siguiente línea"
        >
          <span>Línea</span>
          <ChevronRight size={iconSize} />
        </button>
        <button
          type="button"
          onClick={() => jumpToParagraph(1)}
          disabled={nextDisabled}
          aria-label="Siguiente párrafo"
          title="Siguiente párrafo"
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
        <button
          type="button"
          className="mode-button"
          title={preferences.theme === "night" ? "Papel cálido" : "Lectura nocturna"}
          aria-label={preferences.theme === "night" ? "Papel cálido" : "Lectura nocturna"}
          onClick={toggleFocusTheme}
        >
          {preferences.theme === "night" ? <SunMedium size={18} /> : <Moon size={18} />}
        </button>
        <button
          type="button"
          className="mode-button"
          aria-label="Pantalla completa"
          title="Pantalla completa"
          onClick={toggleFocusMode}
          disabled={!document}
        >
          <ScanText size={18} />
        </button>
      </div>
    );
  }

  if (!isHydrated) return <main className="reader-shell"><p role="status">Recuperando tu documento...</p></main>;

  return (
    <main
      className={`reader-shell book-layout theme-${preferences.theme} mode-${preferences.readingMode} ${
        document ? "has-document" : "empty-state"
      }`}
    >
      <p className="status-accessible" role="status" aria-live="polite">{statusMessage}</p>
      {storageWarning ? <p role="alert" className="storage-warning">{storageWarning}</p> : null}
      <header ref={readerHeaderRef} className="reader-topbar">
        <div className="app-brand" aria-label="En voz">
            <Image
              src="/icons/en-voz-192.png"
              alt=""
              width={32}
              height={32}
              priority
              unoptimized
            />
          <span>En voz</span>
        </div>

        <nav className="source-navigation" aria-label="Agregar contenido">
          <button
            className={activePanel === "file" ? "home-action active" : "home-action"}
            aria-pressed={activePanel === "file"}
            type="button"
            onClick={() => openImport("file")}
          >
            <FileText size={22} />
            <span>Subir archivo</span>
          </button>
          <button
            className={activePanel === "text" ? "home-action active" : "home-action"}
            aria-pressed={activePanel === "text"}
            type="button"
            onClick={() => openImport("text")}
          >
            <Type size={22} />
            <span>Pegar texto</span>
          </button>
          <button
            className={activePanel === "web" ? "home-action active" : "home-action"}
            aria-pressed={activePanel === "web"}
            type="button"
            onClick={() => openImport("web")}
          >
            <Globe2 size={22} />
            <span>Leer sitio web</span>
          </button>

        </nav>
        {document ? (
          <nav className="book-page-controls" aria-label="Páginas del libro">
            <button type="button" aria-label="Página anterior" title="Página anterior" onClick={() => turnBookPage(-1)} disabled={spreadStart === 0}><ChevronLeft size={18} /></button>
            <span aria-live="polite">{spreadStart + 1}{visiblePages.length > 1 ? `–${spreadStart + visiblePages.length}` : ""} / {bookPages.length}</span>
            <button type="button" aria-label="Página siguiente" title="Página siguiente" onClick={() => turnBookPage(1)} disabled={spreadStart + spreadSize >= bookPages.length}><ChevronRight size={18} /></button>
          </nav>
        ) : null}
        {renderModeControls("book-mode-controls")}
      </header>

      <section className="workspace-grid">
        <section className="reader-center">
          {(!document || importOpen || isProcessing) ? <div className="import-panel">
            {document && !isProcessing ? <button type="button" className="import-close" aria-label="Cerrar importación" title="Cerrar" onClick={() => setImportOpen(false)}><X size={18} /></button> : null}
            {activePanel === "file" ? (
              <div className="input-cluster">
                <label className="upload-drop">
                  <input
                    type="file"
                    disabled={isProcessing}
                    accept=".pdf,.docx,.txt,.md,application/pdf,application/octet-stream,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
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
                  aria-label="Texto para escuchar"
                  disabled={isProcessing}
                  value={pastedText}
                  onChange={(event) => setPastedText(event.target.value)}
                  placeholder="Pega aquí el texto que quieres escuchar."
                />
                <button className="primary-action" type="button" onClick={processText} disabled={isProcessing || !pastedText.trim()}>
                  Preparar texto
                </button>
              </div>
            ) : null}

            {activePanel === "web" ? (
              <div className="inline-form">
                <input
                  type="url"
                  aria-label="Dirección del sitio web"
                  disabled={isProcessing}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://sitio.com/articulo"
                />
                <button type="button" onClick={processUrl} disabled={isProcessing || !url.trim()}>
                  Leer sitio
                </button>
              </div>
            ) : null}
            {isProcessing ? <div className="import-progress"><p>{statusMessage}</p><button type="button" onClick={() => processingAbortRef.current?.abort()}>Cancelar</button></div> : null}
            {importError ? <p className="import-error" role="alert">{importError}</p> : null}
          </div> : null}


          <div className="reader-stage">
            {document ? (
              <article className="reader-document">
                <div
                  className="document-text"
                  role="region"
                  aria-label="Contenido del documento"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (preferences.readingMode === "focus" && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault(); toggleFocusControlsFromReading();
                    }
                  }}
                  onClick={toggleFocusControlsFromReading}
                  title={
                    preferences.readingMode === "focus"
                      ? focusControlsVisible
                        ? "Ocultar controles"
                        : "Mostrar controles"
                      : undefined
                  }
                >
                  <div className="book-spread">
                    {visiblePages.map((page) => (
                      <section className="book-page" key={`${document.id}-${page.number}`} aria-label={`Página ${page.number}`}>
                        <header className="book-page-heading"><span>{document.title}</span></header>
                        <div className="book-page-body">{page.blocks.map((block) => renderStructuredTextBlock(block, currentWord))}</div>
                        <footer className="book-folio">{page.number}</footer>
                      </section>
                    ))}
                    {spreadSize === 2 && visiblePages.length === 1 ? <section className="book-page book-page-blank" aria-hidden="true" /> : null}
                  </div>
                </div>
              </article>
            ) : (
              <div className="empty-reader">
                <Headphones size={44} />
                <h2>Sin documento</h2>
              </div>
            )}
          </div>
        </section>

        {shouldShowTextReview ? <aside className="library-panel">

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
                  <small>El texto se enviará al servicio de IA configurado.</small>
                </>
              ) : (
                <small>La reconstrucción con IA ligera es opcional y no está configurada.</small>
              )}
            </div>
          ) : null}

        </aside> : null}
      </section>

      {document ? <footer ref={playerDockRef} className="player-dock desktop-player">
        {renderPlayerControls()}
      </footer> : null}

      {renderVoiceStartupOverlay()}

      {preferences.readingMode === "focus" && focusControlsVisible ? renderFocusControls() : null}
    </main>
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
        page: element.closest(".book-page"),
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
    page: Element | null;
    top: number;
    tolerance: number;
    words: typeof renderedWords;
  }> = [];

  for (const word of renderedWords) {
    const tolerance = Math.max(6, word.height * 0.52);
    const existingLine = lines.find((line) => line.page === word.page && Math.abs(line.top - word.top) <= line.tolerance);

    if (existingLine) {
      existingLine.words.push(word);
      existingLine.top = (existingLine.top + word.top) / 2;
      existingLine.tolerance = Math.max(existingLine.tolerance, tolerance);
      continue;
    }

    lines.push({
      page: word.page,
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
