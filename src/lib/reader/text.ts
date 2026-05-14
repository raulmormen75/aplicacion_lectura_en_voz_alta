import type { PlaybackRate, ReaderDocument, TextBlock, TextBlockKind, TextChunk, WordToken } from "./types";

const GRAPHIC_SYMBOLS =
  /[\p{Extended_Pictographic}\u2190-\u21ff\u2600-\u27bf\u2900-\u297f\u2b00-\u2bff]/gu;
const DECORATIVE_SYMBOLS = /[•·▪▫■□◆◇○●◦]/g;
const INLINE_MARKERS = /[*_`~^=|\\/#<>]/g;
const LINE_SPACES = /[ \t\f\v]+/g;
const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:['’´-][\p{L}\p{M}\p{N}]+)*/gu;

type ParsedLine = {
  text: string;
  explicitHeadingLevel: number | null;
  isBullet: boolean;
  isNumberedMarker: boolean;
};

type RawBlock = {
  kind: TextBlockKind;
  text: string;
};

export function cleanTextForSpeech(input: string) {
  return prepareTextForReading(input).cleanText;
}

export function prepareTextForReading(input: string) {
  const rawBlocks = buildRawBlocks(input);
  const cleanText = rawBlocks.map((block) => block.text).join("\n\n").trim();
  const blocks = createTextBlocks(rawBlocks);

  return {
    cleanText,
    blocks,
  };
}

export function segmentTextBlocks(input: string) {
  return prepareTextForReading(input).blocks;
}

export function cleanTextWithoutInventing(input: string) {
  const cleaned = cleanTextForSpeech(input)
    .replace(/-\s+(?=[\p{Ll}\p{M}])/gu, "")
    .replace(/\s+([.;,])/g, "$1")
    .replace(/([\p{Ll}\p{M}])\s+([\p{Ll}\p{M}])\s+([\p{Ll}\p{M}])\b/gu, "$1$2$3");

  return cleanTextForSpeech(cleaned);
}

export function createLegibleReconstructionPrompt(text: string) {
  return [
    "Reconstruye este texto OCR para lectura en voz alta.",
    "No agregues datos externos ni afirmaciones nuevas.",
    "Corrige solo cortes, caracteres dañados, saltos de línea y frases rotas.",
    "Elimina citas parentéticas académicas cuando sean referencias, por ejemplo: (Autor, 2020).",
    "Conserva títulos, subtítulos, párrafos y listas cuando se puedan inferir.",
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
  const blocks = segmentTextBlocks(text);
  const chunks: TextChunk[] = [];
  let buffer: string[] = [];
  let startWord = 0;
  let currentWords = 0;

  const pushChunk = () => {
    const chunkText = buffer.join("\n\n").trim();
    if (!chunkText) return;

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
  };

  for (const block of blocks) {
    const pieces = splitLongBlock(block.text, targetWords);

    for (const piece of pieces) {
      const pieceWords = countWords(piece);
      if (pieceWords === 0) continue;

      buffer.push(piece);
      currentWords += pieceWords;

      if (currentWords >= targetWords) pushChunk();
    }
  }

  if (buffer.length > 0) pushChunk();

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
  const preparedText = prepareTextForReading(params.text);
  const cleanText = preparedText.cleanText;
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
    blocks: preparedText.blocks,
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

function buildRawBlocks(input: string) {
  const normalizedInput = removeCitationReferences(input)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(GRAPHIC_SYMBOLS, " ");
  const parsedLines = normalizedInput.split("\n").map(parseLine);
  const blocks: RawBlock[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    const paragraph = joinParagraphLines(paragraphLines);
    if (paragraph) blocks.push({ kind: "paragraph", text: paragraph });
    paragraphLines = [];
  };

  parsedLines.forEach((line, index) => {
    const previousBlank = index === 0 || parsedLines[index - 1].text.length === 0;
    const nextBlank = index === parsedLines.length - 1 || parsedLines[index + 1].text.length === 0;

    if (!line.text) {
      flushParagraph();
      return;
    }

    const kind = classifyLine(line, previousBlank, nextBlank);

    if (kind === "paragraph") {
      paragraphLines.push(line.text);
      return;
    }

    flushParagraph();
    blocks.push({ kind, text: line.text });
  });

  flushParagraph();

  return blocks;
}

function parseLine(rawLine: string): ParsedLine {
  let working = rawLine
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?¿¡])/g, "$1")
    .trim();
  const markdownHeading = working.match(/^\s{0,3}(#{1,6})\s+(.+)$/u);
  const explicitHeadingLevel = markdownHeading ? markdownHeading[1].length : null;

  if (markdownHeading) working = markdownHeading[2];
  working = working.replace(/^\s{0,3}>{1,2}\s*/u, "");

  const bullet = working.match(
    /^\s*((?:[-*•·▪▫■□◆◇○●◦])|(?:(?:\d+(?:\.\d+)*|[a-zA-Z])[\.)]))\s+(.+)$/u,
  );
  const isBullet = Boolean(bullet);
  const isNumberedMarker = Boolean(bullet?.[1] && /^\d/.test(bullet[1]));
  if (bullet) working = bullet[2];

  const text = cleanLineText(working);

  return {
    text,
    explicitHeadingLevel,
    isBullet,
    isNumberedMarker,
  };
}

function cleanLineText(line: string) {
  return line
    .replace(DECORATIVE_SYMBOLS, " ")
    .replace(INLINE_MARKERS, " ")
    .replace(/[{}\[\]()+]/g, " ")
    .replace(/\s+([,.;:!?¿¡])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1")
    .replace(LINE_SPACES, " ")
    .trim();
}

function classifyLine(
  line: ParsedLine,
  previousBlank: boolean,
  nextBlank: boolean,
): TextBlockKind {
  if (line.explicitHeadingLevel) {
    return line.explicitHeadingLevel <= 2 ? "heading" : "subheading";
  }

  if (line.isNumberedMarker && looksLikeHeading(line.text, previousBlank, nextBlank)) {
    return "subheading";
  }

  if (line.isBullet && !looksLikeNumberedHeading(line.text)) {
    return "bullet";
  }

  if (looksLikeHeading(line.text, previousBlank, nextBlank)) {
    return looksLikePrimaryHeading(line.text) ? "heading" : "subheading";
  }

  if (line.isBullet) return "bullet";

  return "paragraph";
}

function looksLikeNumberedHeading(text: string) {
  return /^\d+(?:\.\d+)*\.?\s+[\p{Lu}\p{N}]/u.test(text) && countWords(text) <= 18;
}

function looksLikeHeading(text: string, previousBlank: boolean, nextBlank: boolean) {
  const words = countWords(text);
  if (words === 0 || words > 18) return false;
  if (looksLikeNumberedHeading(text)) return true;

  const endsAsSentence = /[.!?]$/.test(text);
  if (endsAsSentence) return false;

  const uppercaseRatio = getUppercaseRatio(text);
  if (words <= 12 && uppercaseRatio >= 0.68) return true;
  if (!previousBlank) return false;
  if (words <= 10 && !/,/.test(text)) return true;
  if (nextBlank && words <= 12) return true;

  return false;
}

function looksLikePrimaryHeading(text: string) {
  const words = countWords(text);
  return words <= 9 || getUppercaseRatio(text) >= 0.68;
}

function getUppercaseRatio(text: string) {
  const letters = Array.from(text).filter((char) => /\p{L}/u.test(char));
  if (letters.length === 0) return 0;
  const uppercase = letters.filter((char) => char === char.toUpperCase() && char !== char.toLowerCase());
  return uppercase.length / letters.length;
}

function joinParagraphLines(lines: string[]) {
  return lines.reduce((paragraph, line) => {
    if (!paragraph) return line;
    if (paragraph.endsWith("-") && /^[\p{Ll}\p{M}]/u.test(line)) {
      return `${paragraph.slice(0, -1)}${line}`;
    }

    return `${paragraph} ${line}`;
  }, "").replace(/\s+([,.;:!?¿¡])/g, "$1").replace(LINE_SPACES, " ").trim();
}

function createTextBlocks(rawBlocks: RawBlock[]) {
  const blocks: TextBlock[] = [];
  let charCursor = 0;
  let wordCursor = 0;

  rawBlocks.forEach((block, index) => {
    const wordCount = countWords(block.text);
    const start = charCursor;
    const end = start + block.text.length;

    blocks.push({
      id: `block-${index}-${start}`,
      kind: block.kind,
      text: block.text,
      start,
      end,
      startWord: wordCursor,
      wordCount,
    });

    charCursor = end + 2;
    wordCursor += wordCount;
  });

  return blocks;
}

function splitLongBlock(text: string, targetWords: number) {
  if (countWords(text) <= targetWords) return [text];

  const sentences = text.match(/[^.!?¿¡]+[.!?¿¡]?/g) ?? [text];
  const pieces: string[] = [];
  let buffer: string[] = [];
  let words = 0;

  for (const sentence of sentences) {
    const cleanSentence = sentence.trim();
    if (!cleanSentence) continue;

    buffer.push(cleanSentence);
    words += countWords(cleanSentence);

    if (words >= targetWords) {
      pieces.push(buffer.join(" ").trim());
      buffer = [];
      words = 0;
    }
  }

  if (buffer.length > 0) pieces.push(buffer.join(" ").trim());

  return pieces;
}

function removeCitationReferences(input: string) {
  return input
    .replace(/\s*\(([^()]{1,260})\)/g, (match, inner: string) =>
      isCitationText(inner) ? " " : match,
    )
    .replace(/\s*\[([^\[\]]{1,180})\]/g, (match, inner: string) =>
      isBracketCitation(inner) ? " " : match,
    );
}

function isBracketCitation(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (/^\d+(?:\s*[-,;]\s*\d+)*$/.test(text)) return true;
  return isCitationText(text);
}

function isCitationText(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return false;

  const hasYear = /\b(?:18|19|20)\d{2}[a-z]?\b/i.test(text);
  const yearOnly = /^(?:ca\.?\s*)?(?:18|19|20)\d{2}[a-z]?(?:\s*[:,-]\s*\d{1,4})?$/.test(text);
  const hasCitationCue =
    /[,;]|&|\bet\s+al\.?\b|\bpp?\.?\b|\bpá?gs?\.?\b|\bdoi\b|\bisbn\b|\bissn\b|\brecuperado\b|\bconsultado\b/i.test(
      text,
    );
  const hasAuthorConnector = /\b(y|and)\b/i.test(text);
  const isCompactReference = text.split(/\s+/).length <= 16;

  if (yearOnly) return true;
  if (/^(?:ibid\.?|idem|op\.?\s*cit\.?)$/i.test(text)) return true;
  if (/\b(?:doi|isbn|issn)\b/i.test(text)) return true;

  return hasYear && (hasCitationCue || hasAuthorConnector || isCompactReference);
}
