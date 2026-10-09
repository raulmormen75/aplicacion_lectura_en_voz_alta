import type { PiperStatusUpdate } from "./piper";

export type LauraWorkerRequest = { id: number; type: "prepare" } | { id: number; type: "predict"; text: string };
export type LauraWorkerReply =
  | { id: number; type: "status"; update: PiperStatusUpdate }
  | { id: number; type: "ready" }
  | { id: number; type: "audio"; audio: Blob }
  | { id: number; type: "error"; message: string };

export async function createLauraWorkerSession(
  report: (update: PiperStatusUpdate) => void,
  onFatal: () => void = () => {},
  makeWorker = () => new Worker(new URL("./laura-worker.ts", import.meta.url), { type: "module", name: "piper-laura" }),
) {
  const worker = makeWorker();
  const pending = new Map<number, { resolve: (audio?: Blob) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let failed: Error | undefined;
  const fail = (error: Error) => {
    if (failed) return;
    failed = error;
    worker.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    onFatal();
  };
  worker.onerror = event => {
    event.preventDefault();
    fail(new Error(event.message || "El motor de Laura se interrumpio."));
  };
  worker.onmessageerror = () => fail(new Error("No se pudo recibir el audio de Laura."));
  worker.onmessage = ({ data }: MessageEvent<LauraWorkerReply>) => {
    const request = pending.get(data.id);
    if (!request) return;
    if (data.type === "status") {
      report(data.update);
      return;
    }
    pending.delete(data.id);
    if (data.type === "error") request.reject(new Error(data.message));
    else request.resolve(data.type === "audio" ? data.audio : undefined);
  };
  function request(message: LauraWorkerRequest) {
    if (failed) return Promise.reject(failed);
    return new Promise<Blob | undefined>((resolve, reject) => {
      pending.set(message.id, { resolve, reject });
      try { worker.postMessage(message); } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  try { await request({ id: ++nextId, type: "prepare" }); } catch (error) {
    worker.terminate();
    throw error;
  }
  return {
    async predict(text: string): Promise<Blob> {
      const audio = await request({ id: ++nextId, type: "predict", text });
      if (!(audio instanceof Blob) || !audio.size) throw new Error("Laura no devolvio audio.");
      return audio;
    },
  };
}
