export type DocumentSource = "file" | "pastedText" | "website" | "googleDoc";

export type ReaderTheme = "warm-paper" | "night";

export type ReadingMode = "standard" | "focus";

export type PlaybackRate = 1 | 0.75 | 0.5;

export type OcrAction = "none" | "clean" | "reconstruct";

export type ReaderVoice = {
  id: string;
  name: string;
  country: "México" | "Gran Bretaña";
  flag: "🇲🇽" | "🇬🇧";
  locale: "es-MX" | "en-GB";
  gender: "female" | "male";
  maturity: "young" | "mature";
  azureName: string;
  description: string;
};

export type WordToken = {
  id: string;
  text: string;
  wordIndex: number;
  start: number;
  end: number;
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
