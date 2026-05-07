import type { PlaybackRate, ReaderDocument, TextChunk, WordToken } from "./types";

const GRAPHIC_SYMBOLS =
  /[\p{Extended_Pictographic}\u2190-\u21ff\u2600-\u27bf\u2900-\u297f\u2b00-\u2bff]/gu;
const MARKDOWN_MARKERS = /(^|\s)(#{1,6}|\*{1,3}|_{1,3}|`{1,3}|>{1,2})(?=\s|$)/gmu;
const DECORATIVE_BULLETS = /^[\s>*#_\-•·▪▫■□◆◇○●◦]+/gmu;
const MULTISPACE = /\s+/g;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:['’´-][\p{L}\p{M}\p{N}]+)*/gu;

export function cleanTextForSpeech(input: string) {
  return input
    .normalize("NFKC")
    .replace(GRAPHIC_SYMBOLS, " ")
    .replace(MARKDOWN_MARKERS, " ")
    .replace(DECORATIVE_BULLETS, "")
    .replace(/[*_`~^=|\\/<>{}[\]()+]/g, " ")
    .replace(/[•·▪▫■□◆◇○●◦]/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(MULTISPACE, " ")
    .trim();
}

export function cleanTextWithoutInventing(input: string) {
  return cleanTextForSpeech(input)
    .replace(/-\s+/g, "")
    .replace(/\s+([.;,])/g, "$1")
    .replace(/([a-záéíóúñü])\s+([a-záéíóúñü])\s+([a-záéíóúñü])\b/giu, "$1$2$3")
    .replace(MULTISPACE, " ")
    .trim();
}

export function createLegibleReconstructionPrompt(text: string) {
  return [
    "Reconstruye este texto OCR para lectura en voz alta.",
    "No agregues datos externos ni afirmaciones nuevas.",
    "Corrige solo cortes, caracteres dañados, saltos de línea y frases rotas.",
    "Devuelve únicamente el texto reconstruido.",
    "",
    text,
  ].join("\n");
}

export function countWords(text: string) {
  return Array.from(text.matchAll(WORD_PATTERN)).length;
}

export function tokenizeWords(text: string): WordToken[] {
  return Array.from(text.matchAll(WORD_PATTERN)).map((match, index) => ({
    id: `w-${index}-${match.index ?? 0}`,
    text: match[0],
    wordIndex: index,
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

export function splitIntoChunks(text: string, targetWords = 140): TextChunk[] {
  const sentences = text.match(/[^.!?¿¡]+[.!?]?/g) ?? [text];
  const chunks: TextChunk[] = [];
  let buffer: string[] = [];
  let startWord = 0;
  let currentWords = 0;

  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    if (!cleanSentence) continue;

    const sentenceWords = countWords(cleanSentence);
    buffer.push(cleanSentence);
    currentWords += sentenceWords;

    if (currentWords >= targetWords) {
      const chunkText = buffer.join(" ").trim();
      chunks.push({
        id: `chunk-${chunks.length + 1}`,
        text: chunkText,
        cleanText: chunkText,
        startWord,
        wordCount: currentWords,
        language: detectLanguage(chunkText),
      });
      startWord += currentWords;
      buffer = [];
      currentWords = 0;
    }
  }

  if (buffer.length > 0) {
    const chunkText = buffer.join(" ").trim();
    const wordCount = countWords(chunkText);
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      text: chunkText,
      cleanText: chunkText,
      startWord,
      wordCount,
      language: detectLanguage(chunkText),
    });
  }

  return chunks;
}

export function detectLanguage(text: string): "es" | "en" | "mixed" {
  const lower = ` ${text.toLowerCase()} `;
  const englishHits = [
    " the ",
    " and ",
    " of ",
    " to ",
    " with ",
    " science ",
    " research ",
    " learning ",
  ].filter((term) => lower.includes(term)).length;
  const spanishHits = [
    " el ",
    " la ",
    " de ",
    " que ",
    " con ",
    " para ",
    " ciencia ",
    " aprendizaje ",
  ].filter((term) => lower.includes(term)).length;

  if (englishHits >= 2 && spanishHits >= 2) return "mixed";
  if (englishHits > spanishHits) return "en";
  return "es";
}

export function estimateRemainingSeconds(
  totalWords: number,
  currentWord: number,
  rate: PlaybackRate,
  actualDurationSeconds?: number,
) {
  const remainingWords = Math.max(totalWords - currentWord, 0);
  if (actualDurationSeconds && totalWords > 0) {
    const secondsPerWord = actualDurationSeconds / totalWords;
    return Math.round(remainingWords * secondsPerWord);
  }

  const baseWordsPerMinute = 155;
  const wordsPerMinute = baseWordsPerMinute * rate;
  return Math.round((remainingWords / wordsPerMinute) * 60);
}

export function formatRemainingTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 1) return `${Math.max(1, remainder)} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours} h ${mins} min` : `${hours} h`;
}

export function calculatePercentage(totalWords: number, currentWord: number) {
  if (totalWords <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((currentWord / totalWords) * 100)));
}

export function createDocumentFromText(params: {
  title: string;
  source: ReaderDocument["source"];
  sourceLabel: string;
  text: string;
  qualityMessage?: string;
}) {
  const cleanText = cleanTextForSpeech(params.text);
  const wordCount = countWords(cleanText);
  const chunks = splitIntoChunks(cleanText);
  const detectedLanguage = detectLanguage(cleanText);
  const needsReview = wordCount === 0 || incoherenceScore(cleanText) > 0.22;

  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
    title: params.title,
    source: params.source,
    sourceLabel: params.sourceLabel,
    createdAt: new Date().toISOString(),
    originalText: params.text,
    cleanText,
    chunks,
    wordCount,
    detectedLanguage,
    quality: {
      status: needsReview ? "needs-review" : "ready",
      message:
        params.qualityMessage ??
        (needsReview
          ? "El texto requiere revisión antes de leerse con naturalidad."
          : "Documento listo para escuchar."),
      ocrAvailable: params.source === "file",
    },
  } satisfies ReaderDocument;
}

export function incoherenceScore(text: string) {
  if (!text.trim()) return 1;
  const symbols = (text.match(/[^\p{L}\p{M}\p{N}\s.,;:!?¿¡'"áéíóúÁÉÍÓÚñÑüÜ-]/gu) ?? []).length;
  const words = Math.max(countWords(text), 1);
  const veryShortTokens = (text.match(/\b[\p{L}\p{M}]\b/gu) ?? []).length;
  return Math.min(1, symbols / words + veryShortTokens / words);
}
