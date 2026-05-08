import type { ReaderVoice } from "./types";

export const READER_VOICES: ReaderVoice[] = [
  {
    id: "ximena-mx",
    name: "Ximena",
    country: "México",
    flag: "🇲🇽",
    locale: "es-MX",
    googleLocale: "es-US",
    gender: "female",
    maturity: "young",
    azureName: "es-MX-Ximena:DragonHDLatestNeural",
    googleName: "es-US-Chirp3-HD-Aoede",
    description: "Mujer mexicana joven, clara y cercana para divulgación científica.",
  },
  {
    id: "dalia-mx",
    name: "Dalia",
    country: "México",
    flag: "🇲🇽",
    locale: "es-MX",
    googleLocale: "es-US",
    gender: "female",
    maturity: "young",
    azureName: "es-MX-DaliaNeural",
    googleName: "es-US-Neural2-A",
    description: "Mujer mexicana joven, estable y natural para lectura documental.",
  },
  {
    id: "tristan-mx",
    name: "Tristán",
    country: "México",
    flag: "🇲🇽",
    locale: "es-MX",
    googleLocale: "es-US",
    gender: "male",
    maturity: "mature",
    azureName: "es-MX-Tristan:DragonHDLatestNeural",
    googleName: "es-US-Chirp3-HD-Charon",
    description: "Hombre mexicano maduro, sereno y explicativo.",
  },
  {
    id: "jorge-mx",
    name: "Jorge",
    country: "México",
    flag: "🇲🇽",
    locale: "es-MX",
    googleLocale: "es-US",
    gender: "male",
    maturity: "mature",
    azureName: "es-MX-JorgeNeural",
    googleName: "es-US-Neural2-B",
    description: "Hombre mexicano maduro, sobrio y adecuado para textos largos.",
  },
  {
    id: "ada-gb",
    name: "Ada",
    country: "Gran Bretaña",
    flag: "🇬🇧",
    locale: "en-GB",
    googleLocale: "en-GB",
    gender: "female",
    maturity: "young",
    azureName: "en-GB-Ada:DragonHDLatestNeural",
    googleName: "en-GB-Chirp3-HD-Sulafat",
    description: "Mujer británica joven para contenido en inglés.",
  },
  {
    id: "ollie-gb",
    name: "Ollie",
    country: "Gran Bretaña",
    flag: "🇬🇧",
    locale: "en-GB",
    googleLocale: "en-GB",
    gender: "male",
    maturity: "mature",
    azureName: "en-GB-Ollie:DragonHDLatestNeural",
    googleName: "en-GB-Chirp3-HD-Umbriel",
    description: "Hombre británico maduro para lectura científica en inglés.",
  },
];

export const DEFAULT_VOICE_ID = "dalia-mx";

export function getVoiceById(voiceId: string) {
  return READER_VOICES.find((voice) => voice.id === voiceId) ?? READER_VOICES[0];
}

export function getVoiceForLanguage(language: "es" | "en" | "mixed") {
  if (language === "en") {
    return READER_VOICES.find((voice) => voice.id === "ada-gb") ?? READER_VOICES[0];
  }

  return READER_VOICES.find((voice) => voice.id === DEFAULT_VOICE_ID) ?? READER_VOICES[0];
}
