type DeviceVoice = Pick<SpeechSynthesisVoice, "name" | "lang" | "voiceURI" | "default">;

function locale(voice: DeviceVoice) {
  return voice.lang.toLowerCase().replaceAll("_", "-");
}

function regionRank(voice: DeviceVoice) {
  const lang = locale(voice);
  if (lang === "es-mx") return 0;
  if (lang.startsWith("es-") && lang !== "es-es") return 1;
  return 2;
}

export function deviceVoiceKey(voice: DeviceVoice) {
  return JSON.stringify([voice.voiceURI, locale(voice), voice.name]);
}

/** Include every distinct Spanish voice exposed by the browser, regardless of gender/provider. */
export function spanishDeviceVoices<T extends DeviceVoice>(voices: readonly T[]): T[] {
  const seen = new Set<string>();
  const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });
  return voices.filter(voice => {
    if (!/^es(?:-|$)/.test(locale(voice))) return false;
    const key = deviceVoiceKey(voice);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => regionRank(a) - regionRank(b) || collator.compare(a.name, b.name));
}

export function preferredSpanishVoice<T extends DeviceVoice>(voices: readonly T[], manualURI?: string): T | undefined {
  const spanish = spanishDeviceVoices(voices);
  const manual = spanish.find(voice => voice.voiceURI === manualURI);
  if (manual) return manual;
  const mexican = spanish.filter(voice => locale(voice) === "es-mx");
  const female = (voice: T) => /dalia|sabina|paulina|helena|monica|mónica|female|mujer/i.test(voice.name);
  const natural = (voice: T) => /natural|online/i.test(voice.name);
  return mexican.find(voice => female(voice) && natural(voice))
    ?? mexican.find(female)
    ?? mexican.find(natural)
    ?? mexican.find(voice => voice.default)
    ?? mexican[0]
    ?? spanish.find(voice => regionRank(voice) === 1 && natural(voice))
    ?? spanish.find(voice => regionRank(voice) === 1)
    ?? spanish.find(female)
    ?? spanish.find(voice => voice.default)
    ?? spanish[0];
}

export function deviceVoiceLabel(voice: DeviceVoice) {
  return voice.name.replace(/^Microsoft\s+/i, "")
    .replace(/\s+-\s+(?:Spanish|Español)\b.*$/i, "")
    .replace(/\s+Online\s*(?:\(Natural\))?/i, "").trim() || voice.name;
}
