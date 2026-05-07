"use client";

import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  FileText,
  Globe2,
  Headphones,
  Home,
  LogIn,
  Moon,
  Pause,
  Play,
  RotateCcw,
  ScanText,
  Sparkles,
  SunMedium,
  Type,
} from "lucide-react";
import Image from "next/image";
import { signIn } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  calculatePercentage,
  cleanTextWithoutInventing,
  countWords,
  createDocumentFromText,
  estimateRemainingSeconds,
  formatRemainingTime,
  tokenizeWords,
} from "@/lib/reader/text";
import {
  DEFAULT_READER_STATE,
  loadReaderState,
  saveReaderState,
} from "@/lib/reader/storage";
import type {
  PlaybackRate,
  ReaderDocument,
  ReaderPreferences,
  StoredReaderState,
} from "@/lib/reader/types";

type ProcessResponse = {
  document?: ReaderDocument;
  error?: string;
};

type IntegrationsStatus = {
  googleReady: boolean;
  gptOssReady: boolean;
};

const SAMPLE_TEXT =
  "La lectura científica exige atención, ritmo y continuidad. Esta aplicación convierte documentos largos en una experiencia auditiva clara, con avance guardado, resaltado visual y controles diseñados para retomar el contenido sin perder el hilo.";
const MAX_CLIENT_UPLOAD_BYTES = 25 * 1024 * 1024;
const READER_WINDOW_BEFORE = 90;
const READER_WINDOW_AFTER = 180;

export function ReaderApp() {
  const [state, setState] = useState<StoredReaderState>(DEFAULT_READER_STATE);
  const [activePanel, setActivePanel] = useState<"file" | "text" | "web">("file");
  const [pastedText, setPastedText] = useState(SAMPLE_TEXT);
  const [url, setUrl] = useState("");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Avance guardado en este dispositivo.");
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationsStatus>({
    googleReady: false,
    gptOssReady: false,
  });
  const [isHydrated, setIsHydrated] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const intervalRef = useRef<number | null>(null);
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const playbackSessionRef = useRef(0);
  const shouldContinuePlaybackRef = useRef(false);
  const progressWordRef = useRef(0);
  const boundarySeenRef = useRef(false);

  const clearProgressTimer = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const document = state.document;
  const preferences = state.preferences;
  const tokens = useMemo(
    () => tokenizeWords(document?.cleanText ?? ""),
    [document?.cleanText],
  );
  const currentWord = Math.min(state.progress.currentWord, document?.wordCount ?? 0);
  const visibleTextParts = useMemo(() => {
    if (!document || tokens.length === 0) return [];

    const startWord = Math.max(0, currentWord - READER_WINDOW_BEFORE);
    const endWord = Math.min(tokens.length, currentWord + READER_WINDOW_AFTER);
    const visibleWords = tokens.slice(startWord, endWord);
    const windowStart = visibleWords[0]?.start ?? 0;
    const windowEnd = visibleWords.at(-1)?.end ?? document.cleanText.length;
    const parts: Array<{
      id: string;
      text: string;
      type: "word" | "text";
      wordIndex?: number;
    }> = [];
    let cursor = windowStart;

    for (const token of visibleWords) {
      if (token.start > cursor) {
        parts.push({
          id: `t-${cursor}-${token.start}`,
          text: document.cleanText.slice(cursor, token.start),
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

    if (cursor < windowEnd) {
      parts.push({
        id: `t-${cursor}-${windowEnd}`,
        text: document.cleanText.slice(cursor, windowEnd),
        type: "text",
      });
    }

    return parts;
  }, [currentWord, document, tokens]);
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
      shouldContinuePlaybackRef.current = false;
      window.speechSynthesis?.removeEventListener?.("voiceschanged", refreshVoices);
      window.speechSynthesis?.cancel();
      clearProgressTimer();
    };
  }, [clearProgressTimer]);

  useEffect(() => {
    progressWordRef.current = currentWord;
  }, [currentWord]);

  useEffect(() => {
    const activeWord = activeWordRef.current;
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
    shouldContinuePlaybackRef.current = false;
    playbackSessionRef.current += 1;
    window.speechSynthesis.cancel();
    clearProgressTimer();
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

  async function handleGoogleSignIn() {
    if (integrations.googleReady) {
      await signIn("google");
      return;
    }

    setState((current) => ({
      ...current,
      session: {
        signedIn: true,
        userName: "Raul",
      },
    }));
    setStatusMessage(
      "Modo local activo. Configura Google OAuth para sincronizar entre dispositivos.",
    );
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

      if (data.document) setDocument(data.document);
      else setStatusMessage(data.error ?? "No se pudo procesar el texto.");
    } catch {
      setStatusMessage("No se pudo conectar con el procesador de texto.");
    } finally {
      setIsProcessing(false);
    }
  }

  async function processUrl(source: "website" | "googleDoc") {
    const targetUrl = source === "website" ? url : googleDocUrl;
    setIsProcessing(true);
    setStatusMessage(source === "website" ? "Leyendo sitio web." : "Importando Google Docs.");
    try {
      const response = await fetch("/api/documents/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source,
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

  function getPreferredSystemVoice() {
    const availableVoices = systemVoices.length
      ? systemVoices
      : window.speechSynthesis.getVoices();
    const documentLanguage = document?.detectedLanguage === "en" ? "en" : "es";
    const localePrefix = documentLanguage === "en" ? "en" : "es";
    const regionalLocale = documentLanguage === "en" ? "en-GB" : "es-MX";

    return (
      availableVoices.find(
        (item) =>
          item.lang === regionalLocale &&
          /female|mujer|woman|ximena|dalia|sonia|ada|sabina/i.test(item.name),
      ) ??
      availableVoices.find((item) => item.lang === regionalLocale) ??
      availableVoices.find((item) => item.lang.startsWith(localePrefix))
    );
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

  function startSpeech(fromWord = currentWord, sessionId?: number, rate = preferences.rate) {
    if (!document) return;

    const activeSession = sessionId ?? playbackSessionRef.current + 1;
    playbackSessionRef.current = activeSession;
    shouldContinuePlaybackRef.current = true;

    if (!sessionId) {
      window.speechSynthesis.cancel();
      clearProgressTimer();
    }

    const safeFromWord = Math.max(0, Math.min(fromWord, document.wordCount));
    const chunk = getChunkForWord(safeFromWord);
    if (!chunk || safeFromWord >= document.wordCount) {
      clearProgressTimer();
      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedó guardado.");
      return;
    }

    const chunkTokens = tokenizeWords(chunk.cleanText);
    const localStartWord = Math.max(0, safeFromWord - chunk.startWord);
    const startChar = chunkTokens[localStartWord]?.start ?? 0;
    const textToSpeak = chunk.cleanText.slice(startChar).trim();
    const speechBaseWord = chunk.startWord + localStartWord;
    const chunkEndWord = Math.min(chunk.startWord + chunk.wordCount, document.wordCount);

    if (!textToSpeak) {
      startSpeech(chunkEndWord, activeSession, rate);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    const preferredSystemVoice = getPreferredSystemVoice();
    const utteranceLanguage =
      preferredSystemVoice?.lang ?? (document.detectedLanguage === "en" ? "en-GB" : "es-MX");

    if (preferredSystemVoice) utterance.voice = preferredSystemVoice;
    utterance.lang = utteranceLanguage;
    utterance.rate = rate;
    utterance.pitch = document.detectedLanguage === "en" ? 1 : 1.02;
    boundarySeenRef.current = false;

    utterance.onboundary = (event) => {
      if (playbackSessionRef.current !== activeSession) return;
      if (event.name && event.name !== "word") return;
      boundarySeenRef.current = true;
      const spoken = textToSpeak.slice(0, event.charIndex);
      const nextWord = speechBaseWord + Math.max(0, countWords(spoken));
      updateProgress(Math.max(progressWordRef.current, nextWord));
    };
    utterance.onend = () => {
      clearProgressTimer();
      if (playbackSessionRef.current !== activeSession) return;

      updateProgress(Math.max(progressWordRef.current, chunkEndWord));

      if (shouldContinuePlaybackRef.current && chunkEndWord < document.wordCount) {
        startSpeech(chunkEndWord, activeSession, rate);
        return;
      }

      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedó guardado.");
    };
    utterance.onerror = () => {
      if (playbackSessionRef.current !== activeSession) return;
      clearProgressTimer();
      setIsPlaying(false);
      shouldContinuePlaybackRef.current = false;
      setStatusMessage("La voz del navegador se interrumpió. Intenta reproducir de nuevo.");
    };

    utteranceRef.current = utterance;
    updateProgress(speechBaseWord);
    window.speechSynthesis.speak(utterance);
    startProgressTimer(speechBaseWord, chunkEndWord, rate);
    setIsPlaying(true);
    setStatusMessage("Lectura iniciada con la voz disponible del navegador.");
  }

  function togglePlayback() {
    if (!document) return;

    if (isPlaying) {
      window.speechSynthesis.pause();
      clearProgressTimer();
      setIsPlaying(false);
      setStatusMessage("Lectura pausada. Avance guardado.");
      return;
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

    startSpeech(currentWord);
  }

  function seek(seconds: number) {
    if (!document) return;
    const wasPlaying = isPlaying;
    const wordsToMove = Math.round(((155 * preferences.rate) / 60) * seconds);
    const nextWord = Math.max(0, Math.min(document.wordCount, currentWord + wordsToMove));

    shouldContinuePlaybackRef.current = false;
    playbackSessionRef.current += 1;
    window.speechSynthesis.cancel();
    clearProgressTimer();
    updateProgress(nextWord);
    setIsPlaying(false);

    if (wasPlaying) {
      startSpeech(nextWord);
    }
  }

  function changeRate(rate: PlaybackRate) {
    updatePreferences({ rate });
    setStatusMessage(`Velocidad actualizada a ${rate === 1 ? "Normal" : rate}.`);
    if (isPlaying) {
      shouldContinuePlaybackRef.current = false;
      playbackSessionRef.current += 1;
      window.speechSynthesis.cancel();
      clearProgressTimer();
      setIsPlaying(false);
      startSpeech(currentWord, undefined, rate);
    }
  }

  function resetReading() {
    shouldContinuePlaybackRef.current = false;
    playbackSessionRef.current += 1;
    window.speechSynthesis.cancel();
    clearProgressTimer();
    setIsPlaying(false);
    updateProgress(0);
    setStatusMessage("Lectura reiniciada. Avance guardado.");
  }

  async function applyCleanOnly() {
    if (!document) return;
    const cleaned = cleanTextWithoutInventing(document.originalText);
    setDocument(
      createDocumentFromText({
        title: document.title,
        source: document.source,
        sourceLabel: document.sourceLabel,
        text: cleaned,
        qualityMessage: "Texto limpiado sin inventar contenido.",
      }),
    );
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
        qualityMessage: data.message,
      }),
    );
  }

  async function toggleFocusMode() {
    const nextMode = preferences.readingMode === "focus" ? "standard" : "focus";
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
        <div className="time-pill">
          <span>{formatRemainingTime(remainingSeconds)} restantes</span>
          <strong>{percentage}%</strong>
        </div>
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
          {([1, 0.75, 0.5] as PlaybackRate[]).map((rate) => (
            <button
              key={rate}
              type="button"
              className={preferences.rate === rate ? "active" : ""}
              onClick={() => changeRate(rate)}
            >
              {rate === 1 ? "Normal" : rate}
            </button>
          ))}
        </div>

        <button className="reset-button" type="button" onClick={resetReading}>
          <RotateCcw size={18} />
          Reiniciar
        </button>
      </>
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

        <button className="google-button" type="button" onClick={handleGoogleSignIn}>
          <LogIn size={18} />
          {state.session.signedIn ? "Google conectado" : "Iniciar sesión con Google"}
        </button>
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

          <div className="panel-card compact-status">
            <Cloud size={18} />
            <p>
              Sincronización con Google.{" "}
              <strong>{integrations.googleReady ? "Lista" : "pendiente de credenciales"}</strong>
            </p>
          </div>
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
                <div className="inline-form">
                  <input
                    value={googleDocUrl}
                    onChange={(event) => setGoogleDocUrl(event.target.value)}
                    placeholder="Liga de Google Docs compartida"
                  />
                  <button type="button" onClick={() => processUrl("googleDoc")}>
                    Google Docs
                  </button>
                </div>
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
                <button type="button" onClick={() => processUrl("website")}>
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
                <div className="document-text">
                  {visibleTextParts.map((part) =>
                    part.type === "word" ? (
                      <span
                        key={part.id}
                        ref={part.wordIndex === currentWord ? activeWordRef : undefined}
                        className={part.wordIndex === currentWord ? "word active-word" : "word"}
                      >
                        {part.text}
                      </span>
                    ) : (
                      <span key={part.id}>{part.text}</span>
                    ),
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

          {document && document.quality.status !== "ready" ? (
            <div className="ocr-card">
              <Sparkles size={18} />
              <h3>Texto difícil de leer</h3>
              <p>{document?.quality.message}</p>
              <button type="button" onClick={applyCleanOnly}>
                Limpiar sin inventar
              </button>
              <button type="button" onClick={reconstructLegibleText}>
                Reconstruir legible
              </button>
              <small>
                gpt-oss: {integrations.gptOssReady ? "configurado" : "pendiente"}
              </small>
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

      {preferences.readingMode === "focus" ? (
        <button className="focus-exit" type="button" onClick={toggleFocusMode}>
          Salir
        </button>
      ) : null}
    </main>
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
