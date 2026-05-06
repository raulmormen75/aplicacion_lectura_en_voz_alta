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
import { getVoiceById, getVoiceForLanguage, READER_VOICES } from "@/lib/reader/voices";

type ProcessResponse = {
  document?: ReaderDocument;
  error?: string;
};

type IntegrationsStatus = {
  googleReady: boolean;
  azureReady: boolean;
  gptOssReady: boolean;
};

const SAMPLE_TEXT =
  "La lectura científica exige atención, ritmo y continuidad. Esta aplicación convierte documentos largos en una experiencia auditiva clara, con avance guardado, resaltado visual y controles diseñados para retomar el contenido sin perder el hilo.";

export function ReaderApp() {
  const [state, setState] = useState<StoredReaderState>(DEFAULT_READER_STATE);
  const [activePanel, setActivePanel] = useState<"file" | "text" | "web">("file");
  const [pastedText, setPastedText] = useState(SAMPLE_TEXT);
  const [url, setUrl] = useState("");
  const [googleDocUrl, setGoogleDocUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [voiceMenuOpen, setVoiceMenuOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Avance guardado en este dispositivo.");
  const [integrations, setIntegrations] = useState<IntegrationsStatus>({
    googleReady: false,
    azureReady: false,
    gptOssReady: false,
  });
  const [isHydrated, setIsHydrated] = useState(false);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const intervalRef = useRef<number | null>(null);

  const clearProgressTimer = useCallback(() => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const document = state.document;
  const preferences = state.preferences;
  const voice = getVoiceById(preferences.voiceId);
  const tokens = useMemo(
    () => tokenizeWords(document?.cleanText ?? ""),
    [document?.cleanText],
  );
  const currentWord = Math.min(state.progress.currentWord, Math.max(tokens.length - 1, 0));
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
    fetch("/api/integrations/status")
      .then((response) => response.json())
      .then((data: IntegrationsStatus) => setIntegrations(data))
      .catch(() => undefined);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }

    return () => {
      window.speechSynthesis?.cancel();
      clearProgressTimer();
    };
  }, [clearProgressTimer]);

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
    const recommendedVoice = getVoiceForLanguage(nextDocument.detectedLanguage);
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
      preferences: {
        ...current.preferences,
        voiceId:
          nextDocument.detectedLanguage === "mixed"
            ? current.preferences.voiceId
            : recommendedVoice.id,
      },
    }));
    setStatusMessage("Documento listo para escuchar.");
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
    setIsProcessing(true);
    setStatusMessage("Extrayendo texto del archivo.");

    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/documents/process", {
      method: "POST",
      body: formData,
    });
    const data = (await response.json()) as ProcessResponse;
    setIsProcessing(false);

    if (data.document) {
      setDocument(data.document);
      return;
    }

    setStatusMessage(data.error ?? "No se pudo procesar el archivo.");
  }

  async function processText() {
    setIsProcessing(true);
    setStatusMessage("Limpiando texto pegado.");
    const response = await fetch("/api/documents/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "pastedText",
        title: "Texto pegado",
        text: pastedText,
      }),
    });
    const data = (await response.json()) as ProcessResponse;
    setIsProcessing(false);

    if (data.document) setDocument(data.document);
    else setStatusMessage(data.error ?? "No se pudo procesar el texto.");
  }

  async function processUrl(source: "website" | "googleDoc") {
    const targetUrl = source === "website" ? url : googleDocUrl;
    setIsProcessing(true);
    setStatusMessage(source === "website" ? "Leyendo sitio web." : "Importando Google Docs.");
    const response = await fetch("/api/documents/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source,
        url: targetUrl,
      }),
    });
    const data = (await response.json()) as ProcessResponse;
    setIsProcessing(false);

    if (data.document) setDocument(data.document);
    else setStatusMessage(data.error ?? "No se pudo procesar la liga.");
  }

  function updateProgress(nextWord: number) {
    const safeWord = Math.max(0, Math.min(nextWord, document?.wordCount ?? 0));
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

  function startProgressTimer(startWord: number) {
    clearProgressTimer();
    const wordsPerSecond = (155 * preferences.rate) / 60;
    const intervalMs = Math.max(280, Math.round(1000 / wordsPerSecond));
    let localWord = startWord;

    intervalRef.current = window.setInterval(() => {
      localWord += 1;
      if (!document || localWord >= document.wordCount) {
        clearProgressTimer();
        setIsPlaying(false);
        return;
      }
      updateProgress(localWord);
    }, intervalMs);
  }

  function startSpeech(fromWord = currentWord) {
    if (!document) return;

    window.speechSynthesis.cancel();
    clearProgressTimer();

    const words = tokenizeWords(document.cleanText).map((token) => token.text);
    const textToSpeak = words.slice(fromWord).join(" ");
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    const systemVoices = window.speechSynthesis.getVoices();
    const preferredSystemVoice =
      systemVoices.find((item) => item.lang === voice.locale && /female|mujer|ximena|dalia|sonia|ada/i.test(item.name)) ??
      systemVoices.find((item) => item.lang === voice.locale) ??
      systemVoices.find((item) => item.lang.startsWith(voice.locale.split("-")[0]));

    if (preferredSystemVoice) utterance.voice = preferredSystemVoice;
    utterance.lang = voice.locale;
    utterance.rate = preferences.rate;
    utterance.pitch = voice.gender === "female" ? 1.04 : 0.92;

    utterance.onboundary = (event) => {
      if (event.name !== "word") return;
      const spoken = textToSpeak.slice(0, event.charIndex);
      updateProgress(fromWord + Math.max(0, countWords(spoken)));
    };
    utterance.onend = () => {
      clearProgressTimer();
      setIsPlaying(false);
      setStatusMessage("Lectura terminada. Tu avance quedó guardado.");
    };
    utterance.onerror = () => {
      clearProgressTimer();
      setIsPlaying(false);
      setStatusMessage("La voz del navegador se interrumpió. Intenta reproducir de nuevo.");
    };

    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
    startProgressTimer(fromWord);
    setIsPlaying(true);
    setStatusMessage(
      integrations.azureReady
        ? "Lectura iniciada con voz configurada."
        : "Lectura iniciada con voz del navegador. Azure se activará al configurar credenciales.",
    );
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
      window.speechSynthesis.resume();
      startProgressTimer(currentWord);
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

    window.speechSynthesis.cancel();
    clearProgressTimer();
    updateProgress(nextWord);
    setIsPlaying(false);

    if (wasPlaying) {
      window.setTimeout(() => startSpeech(nextWord), 120);
    }
  }

  function changeRate(rate: PlaybackRate) {
    updatePreferences({ rate });
    setStatusMessage(`Velocidad actualizada a ${rate === 1 ? "Normal" : rate}.`);
    if (isPlaying) {
      window.speechSynthesis.cancel();
      clearProgressTimer();
      setIsPlaying(false);
      window.setTimeout(() => startSpeech(currentWord), 120);
    }
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
      await documentElementFullscreen();
    } else if (globalThis.document.fullscreenElement) {
      await globalThis.document.exitFullscreen();
    }
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
                    accept=".pdf,.doc,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                    onChange={(event) => processFile(event.target.files?.[0] ?? null)}
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

          <div className="reader-stage" aria-live="polite">
            {document ? (
              <article className="reader-document">
                <div className="reading-metrics">
                  <span>{formatRemainingTime(remainingSeconds)} restantes</span>
                  <strong>{percentage}% leído</strong>
                </div>
                <div className="document-text">
                  {tokens.map((token) => (
                    <span
                      key={token.id}
                      className={token.wordIndex === currentWord ? "word active-word" : "word"}
                    >
                      {token.text}{" "}
                    </span>
                  ))}
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
          <div className="tool-group">
            <p className="tool-title">Voz</p>
            <div className="voice-picker">
              <button
                type="button"
                className="voice-trigger"
                aria-haspopup="listbox"
                aria-expanded={voiceMenuOpen}
                onClick={() => setVoiceMenuOpen((open) => !open)}
              >
                <span>
                  <strong>{voice.name}</strong>
                  <small>{voice.country}</small>
                </span>
                <span className="voice-flag" aria-hidden="true">
                  {voice.flag}
                </span>
              </button>
              {voiceMenuOpen ? (
                <div className="voice-menu" role="listbox" aria-label="Seleccionar voz">
                  {READER_VOICES.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={item.id === preferences.voiceId}
                      className={item.id === preferences.voiceId ? "voice-option active" : "voice-option"}
                      onClick={() => {
                        updatePreferences({ voiceId: item.id });
                        setVoiceMenuOpen(false);
                      }}
                    >
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.country}</small>
                      </span>
                      <span className="voice-flag" aria-hidden="true">
                        {item.flag}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <span className="tool-note">{voice.description}</span>
          </div>

          <div className="tool-group">
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

      <footer className="player-dock">
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

        <button className="reset-button" type="button" onClick={() => updateProgress(0)}>
          <RotateCcw size={18} />
          Reiniciar
        </button>
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
