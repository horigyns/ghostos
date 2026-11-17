// Pop-out viewer windows for files Claude writes (and design assets): images, SVG, PDF, HTML, markdown, text.
// Each is its own sandboxed window with no preload and no Node, in a separate session partition, so a document
// can't reach GhostOS. Markdown and text are rendered by GhostOS into a page with a strict content policy.
import { BrowserWindow, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { escapeHtml, renderMarkdown } from "./markdown";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg"]);
const HTML = new Set([".html", ".htm"]);
const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const TEXT = new Set([".txt", ".json", ".csv", ".tsv", ".yaml", ".yml", ".toml", ".xml", ".log", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".swift", ".kt", ".css", ".scss", ".sh", ".sql", ".env.example", ".ini"]);
const TEXT_MAX_BYTES = 5 * 1024 * 1024;
const WINDOW = { width: 960, height: 760 };
const PARTITION = "viewer"; // its own cookies and storage, never GhostOS's
/** File types macOS may open in their usual app when GhostOS can't show them (documents and media, nothing runnable). */
const OPEN_IN_APP = new Set([".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".key", ".pages", ".numbers", ".rtf", ".odt", ".mp4", ".mov", ".m4v", ".mp3", ".m4a", ".wav", ".aiff"]);
/** Script and style hosts HTML outputs may load from (like Claude's artifacts); everything else on the network is blocked. */
const ALLOWED_HOSTS = new Set(["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com", "cdn.tailwindcss.com"]);
/** Folders a viewer window may load local files from, by its web contents id. */
const allowedDirs = new Map<number, string[]>();
let partitionReady = false;

/** Locks the viewer partition down once: no permissions, no downloads, files only from the shown file's folder, GETs only to the CDN list. */
function prepareViewerPartition(): void {
  if (partitionReady) return;
  partitionReady = true;
  const s = session.fromPartition(PARTITION);
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.on("will-download", (event) => event.preventDefault());
  s.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("devtools:") || url.startsWith("chrome-extension:")) return callback({});
    if (url.startsWith("file:")) {
      const dirs = details.webContentsId === undefined ? undefined : allowedDirs.get(details.webContentsId);
      let file: string;
      try {
        file = decodeURIComponent(new URL(url).pathname);
      } catch {
        return callback({ cancel: true });
      }
      return callback({ cancel: !dirs?.some((dir) => file === dir || file.startsWith(dir + path.sep)) });
    }
    try {
      const u = new URL(url);
      return callback({ cancel: !(u.protocol === "https:" && details.method === "GET" && ALLOWED_HOSTS.has(u.hostname)) });
    } catch {
      return callback({ cancel: true });
    }
  });
}

/** Whether macOS may open this file in its usual app (never anything runnable). */
export function mayOpenInApp(file: string): boolean {
  return OPEN_IN_APP.has(path.extname(file).toLowerCase());
}

const PAGE_CSS = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --dim: #6e6e73; --line: #e5e5ea; --code: #f5f5f7; --accent: #20835e; }
@media (prefers-color-scheme: dark) { :root { --bg: #15161a; --fg: #e7e7ea; --dim: #9b9ca6; --line: #2c2d35; --code: #101114; --accent: #2dbe89; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; }
main { max-width: 820px; margin: 0 auto; padding: 32px 28px 64px; }
h1, h2, h3 { line-height: 1.25; } h1 { font-size: 28px; } h2 { font-size: 21px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
a { color: var(--accent); } img { max-width: 100%; }
pre, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; background: var(--code); border-radius: 6px; }
code { padding: 1px 5px; } pre { padding: 12px 14px; overflow-x: auto; } pre code { padding: 0; background: none; }
blockquote { margin: 0; padding: 2px 14px; border-left: 3px solid var(--accent); color: var(--dim); }
table { border-collapse: collapse; } th, td { border: 1px solid var(--line); padding: 5px 10px; text-align: left; }
hr { border: none; border-top: 1px solid var(--line); } .raw { white-space: pre-wrap; word-break: break-word; }
`;

export type ViewerKind = "image" | "pdf" | "html" | "markdown" | "text" | "other";

export function viewerKind(file: string): ViewerKind {
  const name = file.toLowerCase();
  const ext = path.extname(name);
  if (IMAGE.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (HTML.has(ext)) return "html";
  if (MARKDOWN.has(ext)) return "markdown";
  if (TEXT.has(ext) || name.endsWith(".env.example")) return "text";
  return "other";
}

/** The page GhostOS renders for markdown and text (a strict policy: no scripts, images only from files and data). */
export function renderedPage(file: string, kind: "markdown" | "text"): string {
  const source = fs.readFileSync(file, "utf8");
  const body = kind === "markdown" ? renderMarkdown(source) : `<pre class="raw">${escapeHtml(source)}</pre>`;
  const base = `${pathToFileURL(path.dirname(file)).href}/`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src file: data:; style-src 'unsafe-inline'">
<base href="${escapeHtml(base)}"><title>${escapeHtml(path.basename(file))}</title><style>${PAGE_CSS}</style></head>
<body><main>${body}</main></body></html>`;
}

/** Opens a file in a new viewer window. Kinds GhostOS can't show open in the Mac's default app. */
export async function openViewer(file: string, scratchDir: string): Promise<void> {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error("That file doesn't exist anymore.");
  const kind = viewerKind(file);
  // Kinds GhostOS can't show: documents and media open in their app; anything else (it could be runnable, like
  // .command or .app) is only shown in Finder.
  if (kind === "other" || ((kind === "markdown" || kind === "text") && fs.statSync(file).size > TEXT_MAX_BYTES)) {
    if (kind === "other" && !mayOpenInApp(file)) {
      shell.showItemInFolder(file);
      return;
    }
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return;
  }
  prepareViewerPartition();
  fs.mkdirSync(scratchDir, { recursive: true });
  const win = new BrowserWindow({
    ...WINDOW,
    title: path.basename(file),
    backgroundColor: "#15161a",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
      plugins: kind === "pdf", // Chromium's PDF viewer
      // HTML outputs are like Claude's artifacts and may need their scripts; markdown and text never run any.
      javascript: kind === "html",
    },
  });
  // Links open in the browser; the window itself never navigates away from the file.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  const contentsId = win.webContents.id;
  // The shown file's folder (its images, scripts) and, for rendered pages, GhostOS's own page folder.
  allowedDirs.set(contentsId, [path.dirname(fs.realpathSync(file)), ...(kind === "markdown" || kind === "text" ? [fs.realpathSync(scratchDir)] : [])]);
  win.on("closed", () => allowedDirs.delete(contentsId));
  if (kind === "markdown" || kind === "text") {
    const page = path.join(scratchDir, `view-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
    fs.writeFileSync(page, renderedPage(file, kind));
    win.on("closed", () => fs.rmSync(page, { force: true }));
    await win.loadFile(page);
  } else {
    await win.loadFile(file);
  }
}
