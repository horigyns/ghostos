// Worker-thread entry for search (built to dist/main/search-worker.js).
import { parentPort, workerData } from "node:worker_threads";
import { search, type SearchRequest } from "./search";

search(workerData as SearchRequest)
  .then((hits) => parentPort?.postMessage({ ok: true, hits }))
  .catch((err) => parentPort?.postMessage({ ok: false, error: (err as Error).message }));
