export type DocumentSource = "file" | "pastedText" | "website" | "googleDoc";

export type ReaderTheme = "warm-paper" | "night";

export type ReadingMode = "standard" | "focus";

export type PlaybackRate = 2 | 1.5 | 1.25 | 1 | 0.85 | 0.75 | 0.65 | 0.5;

export type OcrAction = "none" | "clean" | "reconstruct";

export type WordToken = {
  id: string;
  text: string;
  wordIndex: number;
  start: number;
  end: number;
};

export type TextBlockKind = "heading" | "subheading" | "paragraph" | "bullet";

/** Classification recovered from a document before offsets are assigned. */
export type SourceTextBlock = { kind: TextBlockKind; text: string };

export type TextBlock = {
  id: string;
  kind: TextBlockKind;
  text: string;
  start: number;
  end: number;
  startWord: number;
  wordCount: number;
};

export type TextChunk = {
  id: string;
  text: string;
  cleanText: string;
  startWord: number;
  wordCount: number;
  language: "es" | "en" | "mixed";
};

export type ReaderDocument = {
  id: string;
  title: string;
  source: DocumentSource;
  sourceLabel: string;
  createdAt: string;
  originalText: string;
  cleanText: string;
  blocks?: TextBlock[];
  chunks: TextChunk[];
  wordCount: number;
  detectedLanguage: "es" | "en" | "mixed";
  quality: {
    status: "ready" | "needs-ocr" | "needs-review";
    message: string;
    ocrAvailable: boolean;
  };
};

export type ReadingProgress = {
  documentId: string | null;
  currentWord: number;
  currentTimeSeconds: number;
  percentage: number;
  estimatedRemainingSeconds: number;
  updatedAt: string;
};

export type ReaderPreferences = {
  voiceId: string;
  rate: PlaybackRate;
  theme: ReaderTheme;
  readingMode: ReadingMode;
  language?: "auto" | "es" | "en";
  textScale?: 0.9 | 1 | 1.1 | 1.25;
  systemVoiceURI?: string;
};

export type StoredReaderState = {
  document: ReaderDocument | null;
  progress: ReadingProgress;
  preferences: ReaderPreferences;
  session: {
    signedIn: boolean;
    userName: string;
  };
};
