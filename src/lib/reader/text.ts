import type { PlaybackRate, ReaderDocument, TextBlock, TextBlockKind, TextChunk, WordToken } from "./types";

const GRAPHIC_SYMBOLS =
  /[\p{Extended_Pictographic}\u2190-\u21ff\u2600-\u27bf\u2900-\u297f\u2b00-\u2bff]/gu;
const DECORATIVE_SYMBOLS = /[•·▪▫■□◆◇○●◦]/g;
const INLINE_MARKERS = /[*_`~|\\#]/g;
const EMOJI_COMPONENTS = /[\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u{e0020}-\u{e007f}]/gu;
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
  // Spaced single letters may be variables, initials or words. Do not guess joins.
  return cleanTextForSpeech(input);
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
  return chunksFromPreparedText(prepareTextForReading(text), targetWords);
}

function chunksFromPreparedText(
  { cleanText, blocks }: ReturnType<typeof prepareTextForReading>,
  targetWords = 140,
): TextChunk[] {
  const capacity = Number.isFinite(targetWords) && targetWords > 0
    ? Math.max(1, Math.floor(targetWords)) : 140;
  const pieces = blocks.flatMap((block) => splitLongBlock(block.text, block.wordCount, capacity)
    .filter((piece) => piece.wordCount > 0)
    .map((piece) => ({ ...piece, start: block.start + piece.start })));
  const chunks: TextChunk[] = [];
  let startChar = 0;
  let startWord = 0;
  let currentWords = 0;

  pieces.forEach((piece, index) => {
    currentWords += piece.wordCount;
    if (currentWords < capacity && index < pieces.length - 1) return;

    // Slice the one prepared document. Never re-clean or reassemble its sentences.
    const endChar = pieces[index + 1]?.start ?? cleanText.length;
    const chunkText = cleanText.slice(startChar, endChar).trim();
    chunks.push({
      id: `chunk-${chunks.length + 1}`,
      text: chunkText,
      cleanText: chunkText,
      startWord,
      wordCount: currentWords,
      language: detectLanguage(chunkText),
    });
    startWord += currentWords;
    startChar = endChar;
    currentWords = 0;
  });

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
  qualityStatus?: ReaderDocument["quality"]["status"];
  qualityMessage?: string;
  ocrAvailable?: boolean;
}) {
  const preparedText = prepareTextForReading(params.text);
  const cleanText = preparedText.cleanText;
  const wordCount = countWords(cleanText);
  const chunks = chunksFromPreparedText(preparedText);
  const detectedLanguage = detectLanguage(cleanText);
  const needsReview = wordCount === 0 || incoherenceScore(cleanText) > 0.22;
  const qualityStatus =
    wordCount > 0 && params.qualityStatus
      ? params.qualityStatus
      : needsReview
        ? "needs-review"
        : "ready";

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
      status: qualityStatus,
      message:
        params.qualityMessage ??
        (qualityStatus !== "ready"
          ? "El texto requiere revisión antes de leerse con naturalidad."
          : "Documento listo para escuchar."),
      ocrAvailable: params.ocrAvailable ?? params.source === "file",
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
  const normalizedInput = input
    .replace(/[0-9#*]\ufe0f?\u20e3/gu, " ")
    .replace(EMOJI_COMPONENTS, "")
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(GRAPHIC_SYMBOLS, " ");
  const parsedLines = removeCitationReferences(normalizedInput).split("\n").map(parseLine);
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
    /^\s*((?:[-*•·▪▫■□◆◇○●◦])|(?:\+(?=\s+\p{L}[\p{L}\p{M}]+\s+\p{L})(?!.*[+=]))|(?:(?:\d+(?:\.\d+)*|[a-zA-Z])[\.)]))\s+(.+)$/u,
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
  if (/^\s*(?:={3,}|-{3,}|(?:\*\s*){3,}|(?:_\s*){3,})\s*$/.test(line)) return "";
  return verbalizeMathOperators(line)
    .replace(DECORATIVE_SYMBOLS, " ")
    .replace(INLINE_MARKERS, " ")
    .replace(/[{}\[\]]/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+([,.;:!?¿¡])/g, "$1")
    .replace(/([¿¡])\s+/g, "$1")
    .replace(LINE_SPACES, " ")
    .trim();
}

function verbalizeMathOperators(line: string) {
  const spoken: Record<string, string> = {
    "+": "más", "=": "igual a", "<=": "menor o igual que", ">=": "mayor o igual que",
    "!=": "distinto de", "≤": "menor o igual que", "≥": "mayor o igual que", "≠": "distinto de",
    "×": "por", "÷": "dividido entre", "*": "por", "/": "dividido entre", "^": "elevado a",
    "<": "menor que", ">": "mayor que",
  };
  const operand = (index: number, direction: -1 | 1) => {
    while (index >= 0 && index < line.length && /\s/u.test(line[index])) index += direction;
    if (direction === 1 && /[+-]/u.test(line[index] ?? "")) {
      index += direction;
      while (index < line.length && /\s/u.test(line[index])) index += direction;
    }
    if (direction === -1 ? /[)\]]/u.test(line[index] ?? "") : /[(\[]/u.test(line[index] ?? "")) return true;
    const edge = index;
    while (index >= 0 && index < line.length && /[\p{L}\p{M}\p{N}]/u.test(line[index])) index += direction;
    const token = direction === -1 ? line.slice(index + 1, edge + 1) : line.slice(edge, index);
    // Numeric values and individual algebraic variables, not slashes in URLs/prose.
    return /^(?:\p{N}+|\p{L}[\p{M}\p{N}]*)$/u.test(token);
  };
  return line.replace(/<=|>=|!=|[+=≤≥≠×÷*/^<>]/gu, (operator: string, offset: number) => {
    if (operator === "/" && line.slice(offset - 1, offset + 2).toLowerCase() === "y/o") return operator;
    if (["*", "/", "^", "<", ">", "<=", ">="].includes(operator) &&
        !(operand(offset - 1, -1) && operand(offset + operator.length, 1))) return operator;
    return ` ${spoken[operator]} `;
  });
}

function classifyLine(
  line: ParsedLine,
  previousBlank: boolean,
  nextBlank: boolean,
): TextBlockKind {
  if (line.explicitHeadingLevel) {
    return line.explicitHeadingLevel <= 2 ? "heading" : "subheading";
  }

  if (line.isNumberedMarker && looksLikeHeading(line.text, previousBlank, nextBlank, true)) {
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

function looksLikeHeading(
  text: string,
  previousBlank: boolean,
  nextBlank: boolean,
  hasNumberedMarker = false,
) {
  const words = countWords(text);
  if (words === 0 || words > 18) return false;
  if (looksLikeNumberedHeading(text)) return true;

  const endsAsSentence = /[.!?,;][)"'»”’]*$/u.test(text);
  if (endsAsSentence) return false;

  // Blank lines from PDF extraction are not evidence that a prose continuation is a title.
  if (!hasNumberedMarker && /^[^\p{L}\p{N}]*\p{Ll}/u.test(text)) return false;

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
    if (paragraph.endsWith("-") && /[\p{L}\p{M}]{2}-$/u.test(paragraph.slice(-5)) && /^[\p{Ll}\p{M}]{2}/u.test(line)) {
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

const ABBREVIATIONS = new Set([
  "dr.", "dra.", "sr.", "sra.", "srta.", "ud.", "uds.", "etc.", "aprox.",
  "p.", "pp.", "pág.", "págs.", "ej.", "fig.", "núm.", "no.", "art.", "vol.", "e.g.", "i.e.",
]);

function isAbbreviation(value: string) {
  let end = value.length;
  while (end > 0 && /[)\]"'»”’]/u.test(value[end - 1])) end--;
  const word = value.slice(0, end).toLowerCase();
  return ABBREVIATIONS.has(word) || /^(?:\p{L}\.)+$/u.test(word);
}

function splitLongBlock(text: string, wordCount: number, targetWords: number) {
  if (wordCount <= targetWords) return [{ start: 0, wordCount }];
  // Whitespace boundaries keep decimals, dotted initials and opening punctuation intact.
  const units = Array.from(text.matchAll(/\S+/gu), (match) => ({
    start: match.index, text: match[0], wordCount: countWords(match[0]),
  }));
  const pieces: Array<{ start: number; wordCount: number }> = [];
  let start = 0;
  while (start < units.length) {
    let words = 0;
    let end = start;
    let sentenceEnd = start;
    let sentenceWords = 0;
    while (end < units.length) {
      const unit = units[end++];
      words += unit.wordCount;
      const abbreviation = isAbbreviation(unit.text);
      if (!abbreviation && /[.!?][)\]"'»”’]*$/u.test(unit.text)) {
        sentenceEnd = end;
        sentenceWords = words;
      }
      if (words >= targetWords && !abbreviation) {
        if (sentenceEnd > start && sentenceWords >= targetWords * 0.5) {
          end = sentenceEnd;
          words = sentenceWords;
        }
        break;
      }
    }
    pieces.push({ start: units[start].start, wordCount: words });
    start = end;
  }
  return pieces;
}

function removeCitationReferences(input: string) {
  return input
    .replace(/\(([^()]{1,260})\)/g, (match, inner: string) =>
      isCitationText(inner) ? " " : match,
    )
    .replace(/\[([^\[\]]{1,180})\]/g, (match, inner: string) =>
      isBracketCitation(inner) ? " " : match,
    );
}

function isBracketCitation(value: string) {
  const text = value.replace(/\s+/g, " ").trim();
  if (/^\d+(?:\s*[-,;]\s*\d+)*$/.test(text)) return true;
  return isCitationText(text);
}

function isCitationText(value: string) {
  // Inline emphasis may surround an author/year. Parse its plain form only here.
  const text = value.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return false;

  if (/^(?:ibid\.?|idem|op\.?\s*cit\.?)$/i.test(text)) return true;

  // Require the entire parenthesis to match references, not merely contain a year.
  // Bare dates and ambiguous prose are retained to avoid losing semantic content.
  return text.split(/\s*;\s*/).every(isAuthorDateReference);
}

const NAME_PREFIXES = new Set(["de", "del", "la", "las", "los", "van", "von"]);
const NAME_JOINERS = new Set([...NAME_PREFIXES, "of", "the", "y", "and"]);

function isReferenceDate(value: string) {
  return /^(?:18|19|20)\d{2}[a-z]?$/u.test(value) || /^s\.\s*f\.$/u.test(value);
}

function isAuthorList(value: string) {
  const authors = value.replace(/ et al\.?$/u, "");
  const tokens = authors.match(/[, &]|[^ ,&]+/gu) ?? [];
  let hasName = false;
  let needsName = true;
  for (const token of tokens) {
    if (token === " ") continue;
    if (token === "," || token === "&") {
      if (!hasName || needsName) return false;
      hasName = false;
      needsName = true;
    } else if (/^\p{Lu}[\p{L}\p{M}'’.-]*$/u.test(token)) {
      hasName = true;
      needsName = false;
    } else if ((hasName ? NAME_JOINERS : NAME_PREFIXES).has(token)) {
      needsName = true;
    } else {
      return false;
    }
  }
  return hasName && !needsName;
}

function isAuthorDateReference(text: string) {
  // Comma-separated fields are consumed once. No ambiguous author/name partitions.
  const fields = text.split(",").map((field) => field.trim());
  if (fields.length < 2 || fields.some((field) => !field)) return false;
  const firstDate = fields.findIndex((field, index) => index > 0 && isReferenceDate(field));
  if (firstDate < 1 || !isAuthorList(fields.slice(0, firstDate).join(", "))) return false;
  let index = firstDate;
  while (index < fields.length && isReferenceDate(fields[index])) index++;
  return index === fields.length || index === fields.length - 1 &&
    /^(?:pp?\.|págs?\.)\s*\d+(?:\s*[-–]\s*\d+)?$/u.test(fields[index]);
}
