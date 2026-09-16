export type PiperWordTiming = { startsAt: number; wordIndex: number };
type Token = { text: string; start: number; end: number };

// This is acoustic activity mapping, not forced alignment or word timestamps.
export function buildPiperTimeline(
  tokens: Token[], startWord: number, duration: number,
  samples?: Float32Array, sampleRate = 22050,
): PiperWordTiming[] {
  if (!tokens.length || !Number.isFinite(duration) || duration <= 0) return [];
  const frameSeconds = 0.02;
  const activity: number[] = [];
  if (samples?.length) {
    const frameSize = Math.max(1, Math.round(sampleRate * frameSeconds));
    for (let start = 0; start < samples.length; start += frameSize) {
      let energy = 0;
      const end = Math.min(samples.length, start + frameSize);
      for (let i = start; i < end; i++) energy += samples[i] ** 2;
      activity.push(Math.sqrt(energy / (end - start)));
    }
  }
  const peak = activity.reduce((max, value) => Math.max(max, value), 0);
  const threshold = Math.max(0.001, peak * 0.035);
  const spokenFrames = activity.flatMap((value, index) => value >= threshold ? [index] : []);
  const weights = tokens.map(({ text }) => {
    const vowels = text.match(/[aeiouáéíóúü]+/gi)?.length ?? 1;
    return Math.max(1, vowels) + Math.min(text.length, 20) * 0.08;
  });
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  return weights.map((weight, index) => {
    const fraction = cumulative / total;
    const frame = spokenFrames[Math.min(spokenFrames.length - 1, Math.floor(fraction * spokenFrames.length))];
    cumulative += weight;
    return { wordIndex: startWord + index, startsAt: frame === undefined ? fraction * duration : frame * frameSeconds };
  });
}

export function piperWordAtTime(timeline: PiperWordTiming[], mediaTime: number, startWord: number) {
  let low = 0;
  let high = timeline.length - 1;
  let result = startWord;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (timeline[middle].startsAt <= mediaTime) {
      result = timeline[middle].wordIndex;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}
