import assert from "node:assert/strict";
import test from "node:test";
import { deviceVoiceLabel, preferredSpanishVoice, spanishDeviceVoices } from "../src/lib/reader/device-voices.ts";

const voice = (name, lang, voiceURI = name, isDefault = false) => ({ name, lang, voiceURI, default: isDefault });
const sabina = voice("Microsoft Sabina - Spanish (Mexico)", "es-MX");
const helena = voice("Microsoft Helena - Spanish (Spain)", "es-ES");
const english = voice("Default English", "en-US", "english", true);

test("catalog includes all Spanish regions and bare Spanish, excluding other languages", () => {
  const spanish = [sabina, helena, voice("Argentina", "es-AR"), voice("Latino", "es-419"),
    voice("Español", "es"), voice("US Spanish", "ES_us"), voice("Raul", "es-MX")];
  const result = spanishDeviceVoices([...spanish, english, voice("Português", "pt-BR"), voice("Unknown", "")]);
  assert.equal(result.length, spanish.length);
  assert.deepEqual(new Set(result), new Set(spanish));
  assert.ok(result.slice(0, 2).every(item => item.lang === "es-MX"));
});

test("catalog removes repeated entries while retaining different voices and providers", () => {
  const other = voice(sabina.name, sabina.lang, "other-provider");
  assert.deepEqual(new Set(spanishDeviceVoices([sabina, { ...sabina }, other])), new Set([sabina, other]));
});

test("manual Spanish selection wins over an automatic Mexican choice", () => {
  assert.equal(preferredSpanishVoice([sabina, helena], helena.voiceURI), helena);
});

test("foreign or removed saved voices cannot select an English default", () => {
  assert.equal(preferredSpanishVoice([english, sabina], english.voiceURI), sabina);
  assert.equal(preferredSpanishVoice([english, helena], "removed-voice"), helena);
  assert.equal(preferredSpanishVoice([english]), undefined);
  assert.equal(preferredSpanishVoice([]), undefined);
});

test("automatic preference favors a Mexican female natural voice when exposed", () => {
  const dalia = voice("Microsoft Dalia Online (Natural) - Spanish (Mexico)", "es-MX");
  assert.equal(preferredSpanishVoice([english, helena, sabina, dalia]), dalia);
  assert.equal(preferredSpanishVoice([english, helena, sabina]), sabina);
});

test("available male Spanish voices remain selectable", () => {
  const raul = voice("Raul", "es-MX");
  assert.equal(preferredSpanishVoice([raul]), raul);
  assert.equal(preferredSpanishVoice([sabina, raul], raul.voiceURI), raul);
});

test("voice labels omit redundant Microsoft language metadata", () => {
  assert.equal(deviceVoiceLabel(sabina), "Sabina");
  assert.equal(deviceVoiceLabel(voice("Microsoft Dalia Online (Natural) - Spanish (Mexico)", "es-MX")), "Dalia");
  assert.equal(deviceVoiceLabel(voice("Google español", "es-ES")), "Google español");
});
