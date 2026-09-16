type Status = { stage: string; message: string; progress?: number; detail?: string };
type Result = { audio: Blob; initMs: number; generationMs: number };
type Job = { run(): Promise<void> };

// Rejection does not release the lock: native inference must finish first.
export function createPiperEngine<S extends Status>(
  prepare: (report: (update: S) => void) => Promise<{ predict(text: string): Promise<Blob> }>,
  stages: { preparing: S; generating: S },
  cacheBudget = 12 * 1024 * 1024,
) {
  const queue: Job[] = [];
  const cache = new Map<string, { audio: Blob; bytes: number }>();
  let cacheBytes = 0;
  let running = false;
  let subscriber: ((update: S) => void) | undefined;
  const report = (update: S) => subscriber?.(update);

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) await queue.shift()!.run();
    } finally {
      running = false;
    }
  }

  return function synthesize({ text, onStatus, timeoutMs = 90_000, signal }: {
    text: string; onStatus?: (update: S) => void; timeoutMs?: number; signal?: AbortSignal;
  }): Promise<Result> {
    const key = text.trim();
    if (signal?.aborted) return Promise.reject(new DOMException("Solicitud cancelada.", "AbortError"));
    if (!key) return Promise.reject(new Error("No hay texto suficiente para preparar la voz."));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error("El tiempo de espera debe ser un numero positivo."));
    }
    const deadline = performance.now() + timeoutMs;
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      let callback = onStatus;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, result?: Result) => {
        if (settled) return;
        settled = true;
        callback = undefined;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        if (result) resolve(result);
        else reject(error);
      };
      const abort = () => finish(new DOMException("Solicitud cancelada.", "AbortError"));
      const expire = () => finish(new Error("La voz tardo demasiado en prepararse."));
      const alive = () => {
        if (!settled && performance.now() >= deadline) expire();
        return !settled;
      };
      const emit = (update: S) => {
        if (!alive()) return;
        try { callback?.(update); } catch { /* Subscribers cannot break the queue. */ }
      };
      const job: Job = {
        async run() {
          if (!alive()) return;
          subscriber = emit;
          try {
            const cached = cache.get(key);
            if (cached) {
              cache.delete(key);
              cache.set(key, cached);
              finish(undefined, { audio: cached.audio, initMs: 0, generationMs: 0 });
              return;
            }
            const initStart = performance.now();
            emit(stages.preparing);
            if (!alive()) return;
            const session = await prepare(report);
            if (!alive()) return;
            const initMs = performance.now() - initStart;
            emit(stages.generating);
            if (!alive()) return;
            const generationStart = performance.now();
            const audio = await session.predict(key);
            if (!alive()) return;
            const generationMs = performance.now() - generationStart;
            // Include retained text in the budget; nothing is persisted.
            const bytes = audio.size + key.length * 2;
            if (bytes <= cacheBudget) {
              while (cache.size && (cacheBytes + bytes > cacheBudget || cache.size >= 128)) {
                const oldest = cache.keys().next().value!;
                cacheBytes -= cache.get(oldest)!.bytes;
                cache.delete(oldest);
              }
              cache.set(key, { audio, bytes });
              cacheBytes += bytes;
            }
            finish(undefined, { audio, initMs, generationMs });
          } catch (error) {
            finish(error);
          } finally {
            subscriber = undefined;
          }
        },
      };
      const armTimeout = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) { expire(); return; }
        timer = setTimeout(armTimeout, Math.min(remaining, 2_147_483_647));
      };
      signal?.addEventListener("abort", abort, { once: true });
      armTimeout();
      if (!alive()) return;
      queue.push(job);
      void drain();
    });
  };
}
