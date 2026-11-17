// Builds GhostOS: esbuild for the Electron main process, preload and the sidenote hook;
// Vite for the React renderer. Output goes to dist/.
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const RENDERER_CHUNK_WARN_KB = 2048;

const nodeTarget = { platform: "node", format: "cjs", target: "node22", bundle: true, sourcemap: true, logLevel: "warning" };

await Promise.all([
  esbuild({
    ...nodeTarget,
    entryPoints: [path.join(root, "src/main/index.ts")],
    outfile: path.join(dist, "main/index.js"),
    // node-pty is a native module and electron is provided at runtime.
    external: ["electron", "node-pty"],
  }),
  esbuild({
    ...nodeTarget,
    entryPoints: [path.join(root, "src/preload/index.ts")],
    outfile: path.join(dist, "preload/index.js"),
    external: ["electron"],
  }),
  esbuild({
    ...nodeTarget,
    entryPoints: [path.join(root, "src/hook/sidenote-hook.ts")],
    outfile: path.join(dist, "hook/sidenote-hook.js"),
  }),
  esbuild({
    ...nodeTarget,
    entryPoints: [path.join(root, "src/hook/ghostos-hook.ts")],
    outfile: path.join(dist, "hook/ghostos-hook.js"),
  }),
  esbuild({
    ...nodeTarget,
    entryPoints: [path.join(root, "src/runner/index.ts")],
    outfile: path.join(dist, "runner/index.js"),
  }),
  esbuild({
    ...nodeTarget,
    entryPoints: [path.join(root, "src/main/search/worker.ts")],
    outfile: path.join(dist, "main/search-worker.js"),
  }),
]);

await viteBuild({
  root: path.join(root, "src/renderer"),
  base: "./",
  plugins: [react()],
  logLevel: "warn",
  // The renderer loads from disk, not the network, so one larger bundle is fine.
  build: { outDir: path.join(dist, "renderer"), emptyOutDir: true, sourcemap: true, chunkSizeWarningLimit: RENDERER_CHUNK_WARN_KB },
});

console.log("GhostOS built to dist/");
