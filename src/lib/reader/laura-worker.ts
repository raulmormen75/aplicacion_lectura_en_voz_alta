import { createLauraSession } from "./laura";
import type { LauraWorkerReply, LauraWorkerRequest } from "./laura-worker-client";

const scope = self as unknown as {
  postMessage(message: LauraWorkerReply): void;
  onmessage: (event: MessageEvent<LauraWorkerRequest>) => void;
};
let session: Awaited<ReturnType<typeof createLauraSession>> | undefined;
let queue = Promise.resolve();

// The main engine retains its lock after cancellation; inference stays off the UI thread.
scope.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.type === "prepare") {
        session ??= await createLauraSession(update => scope.postMessage({ id: data.id, type: "status", update }));
        scope.postMessage({ id: data.id, type: "ready" });
      } else {
        if (!session) throw new Error("Laura no esta preparada.");
        const audio = await session.predict(data.text);
        scope.postMessage({ id: data.id, type: "audio", audio });
      }
    } catch (error) {
      scope.postMessage({ id: data.id, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  });
};
