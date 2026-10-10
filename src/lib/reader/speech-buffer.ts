import type { TextChunk, WordToken } from "./types";

export type RemoteVoiceId = "hf-mexico" | "hf-dora";
export type SpeechFragment = {
  textToSpeak: string;
  speechBaseWord: number;
  chunkEndWord: number;
  resumeWord: number;
};

// Stable fragment boundaries let a line/word jump reuse the same waveform.
export function speechFragment(
  chunk: TextChunk,
  tokens: WordToken[],
  fromWord: number,
  voice: RemoteVoiceId,
): SpeechFragment | null {
  const maxChars = voice === "hf-mexico" ? 280 : 720;
  const maxWords = voice === "hf-mexico" ? 38 : 64;
  const target = fromWord - chunk.startWord;
  if (target < 0 || target >= tokens.length) return null;
  const boundary = (index: number) => {
    if (index === 0) return 0;
    if (index === tokens.length) return chunk.cleanText.length;
    const minimum = tokens[index - 1].end;
    let cursor = tokens[index].start;
    while (cursor > minimum && /\s/u.test(chunk.cleanText[cursor - 1])) cursor--;
    const end = cursor;
    while (cursor > minimum && "¿¡([{“«".includes(chunk.cleanText[cursor - 1])) cursor--;
    return cursor < end ? cursor : tokens[index].start;
  };
  const canSplit = (index: number) => index === tokens.length ||
    /\s/u.test(chunk.cleanText.slice(tokens[index - 1].end, tokens[index].start));
  for (let start = 0; start < tokens.length;) {
    let end = start + 1;
    const startChar = boundary(start);
    while (end < tokens.length && !canSplit(end)) end++;
    while (end < tokens.length && end - start < maxWords &&
      boundary(end + 1) - startChar <= maxChars) end++;
    // A decimal, abbreviation or punctuation-bound unit must stay together.
    if (!canSplit(end)) {
      let previous = end;
      while (previous > start && !canSplit(previous)) previous--;
      if (previous > start) end = previous;
      else while (end < tokens.length && !canSplit(end)) end++;
    }
    // Use a complete sentence when it occupies at least half the fragment.
    for (let i = end - 1; i >= start + Math.floor((end - start) / 2); i--) {
      const punctuation = chunk.cleanText.slice(tokens[i].end, tokens[i + 1]?.start ?? chunk.cleanText.length);
      if (/[.!?]/u.test(punctuation) && /\s/u.test(punctuation) && canSplit(i + 1)) { end = i + 1; break; }
    }
    const endChar = boundary(end);
    if (target < end) {
      const textToSpeak = chunk.cleanText.slice(startChar, endChar).trim();
      if (textToSpeak.length > maxChars) throw new Error("Hay una palabra demasiado larga para la demo de voz. Usa una voz del dispositivo.");
      return {
        textToSpeak, speechBaseWord: chunk.startWord + start,
        chunkEndWord: chunk.startWord + end, resumeWord: fromWord,
      };
    }
    start = end;
  }
  return null;
}

type Request = { voice: RemoteVoiceId; text: string; signal?: AbortSignal; priority?: "play" | "prefetch" };
type Consumer = { resolve(audio: Blob): void; reject(error: unknown): void; cleanup(): void };
type Job = { key: string; voice: RemoteVoiceId; text: string; consumers: Set<Consumer>; controller: AbortController; running: boolean };

export function createSpeechBuffer(fetchAudio: (voice: RemoteVoiceId, text: string, signal: AbortSignal) => Promise<Blob>,
  budget = 16 * 1024 * 1024) {
  const cache = new Map<string, { audio: Blob; bytes: number }>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let retainedBytes = 0;
  let running = 0;
  const cancelled = () => new DOMException("Lectura cancelada.", "AbortError");

  function drain() {
    while (running < 2 && queue.length) {
      const job = queue.shift()!;
      if (!job.consumers.size) continue;
      running++;
      job.running = true;
      const timer = setTimeout(() => job.controller.abort(), 45_000);
      void fetchAudio(job.voice, job.text, job.controller.signal).then(audio => {
        if (job.controller.signal.aborted) throw cancelled();
        if (!job.consumers.size) return;
        const bytes = audio.size + job.key.length * 2;
        if (bytes <= budget) {
          while (cache.size && (retainedBytes + bytes > budget || cache.size >= 32)) {
            const oldest = cache.keys().next().value!;
            retainedBytes -= cache.get(oldest)!.bytes;
            cache.delete(oldest);
          }
          cache.set(job.key, { audio, bytes });
          retainedBytes += bytes;
        }
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        for (const consumer of job.consumers) { consumer.cleanup(); consumer.resolve(audio); }
      }).catch(error => {
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        for (const consumer of job.consumers) { consumer.cleanup(); consumer.reject(error); }
      }).finally(() => {
        clearTimeout(timer);
        job.consumers.clear();
        if (jobs.get(job.key) === job) jobs.delete(job.key);
        running--;
        drain();
      });
    }
  }

  function synthesize({ voice, text, signal, priority = "play" }: Request): Promise<Blob> {
    if (signal?.aborted) return Promise.reject(cancelled());
    const key = `${voice}:${text}`;
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); return Promise.resolve(hit.audio); }
    return new Promise((resolve, reject) => {
      let job = jobs.get(key);
      if (!job || job.controller.signal.aborted) {
        job = { key, voice, text, consumers: new Set(), controller: new AbortController(), running: false };
        jobs.set(key, job);
        if (priority === "play") queue.unshift(job); else queue.push(job);
      } else if (priority === "play" && !job.running) {
        queue.splice(queue.indexOf(job), 1); queue.unshift(job);
      }
      const ownedJob = job;
      const consumer: Consumer = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", abort) };
      function abort() {
        consumer.cleanup(); ownedJob.consumers.delete(consumer); reject(cancelled());
        if (!ownedJob.consumers.size) {
          ownedJob.controller.abort();
          if (jobs.get(key) === ownedJob) jobs.delete(key);
          const index = queue.indexOf(ownedJob);
          if (index >= 0) queue.splice(index, 1);
        }
      }
      ownedJob.consumers.add(consumer);
      signal?.addEventListener("abort", abort, { once: true });
      drain();
    });
  }

  return {
    synthesize,
    clear() {
      for (const job of jobs.values()) {
        job.controller.abort();
        for (const consumer of job.consumers) { consumer.cleanup(); consumer.reject(cancelled()); }
        job.consumers.clear();
      }
      jobs.clear(); queue.length = 0; cache.clear(); retainedBytes = 0;
    },
  };
}

export const remoteSpeech = createSpeechBuffer(async (voice, text, signal) => {
  const response = await fetch("/api/speech", {
    method: "POST", signal, credentials: "same-origin", cache: "no-store",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ voice, text }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error || "La demo de voz no está disponible. Usa una voz del dispositivo.");
  }
  const audio = await response.blob();
  if (!audio.size || audio.size > 5 * 1024 * 1024 || !response.headers.get("content-type")?.startsWith("audio/")) {
    throw new Error("La demo devolvió un audio incompatible.");
  }
  return audio;
});
