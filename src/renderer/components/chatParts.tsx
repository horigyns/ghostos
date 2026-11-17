import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatEvent, LiveSession } from "../../shared/types";

const MS_PER_SECOND = 1000;
const COMPOSER_MAX_PX = 220;

/** A file Claude wrote: click to open it in a pop-out window. */
export function OutputChip({ session, file, onError }: { session: LiveSession; file: string; onError: (err: unknown) => void }) {
  const kind = outputKind(file);
  return (
    <button className={`output-chip k-${kind}`} title={`Open ${file} in a window`} onClick={() => void window.ghost.outputs.open(session.projectId, file, session.key).catch(onError)}>
      <span className="output-icon">{OUTPUT_ICON[kind]}</span>
      <span className="ellipsis">{baseName(file)}</span>
      <span className="output-open">↗</span>
    </button>
  );
}

/** Renders `inline code` within a line of text. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : <Fragment key={i}>{part}</Fragment>,
  );
}

/** Minimal formatting for Claude's replies: fenced code blocks and inline code. Never injects HTML. */
export function FormattedText({ text }: { text: string }) {
  const parts = text.split(/```[\w-]*\n?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <pre key={i}>{part.replace(/\n$/, "")}</pre> : <Fragment key={i}>{inline(part)}</Fragment>))}
    </>
  );
}

const OUTPUT_ICON: Record<string, string> = { image: "▣", pdf: "▤", html: "◧", markdown: "¶", text: "≡", other: "◇" };

/** What a file is, for its icon (the viewer window decides how to show it). */
export function outputKind(file: string): string {
  const ext = file.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "html" || ext === "htm") return "html";
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["txt", "json", "csv", "tsv", "yaml", "yml", "toml", "xml", "log", "ts", "tsx", "js", "jsx", "py", "css", "sh", "sql"].includes(ext)) return "text";
  return "other";
}

const baseName = (file: string) => file.split("/").pop() ?? file;

export type Row =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; summary: string; isError?: boolean; done: boolean; filePath?: string }
  | { kind: "outputs"; files: string[] }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string }
  | { kind: "meta"; text: string };

export function toRows(events: ChatEvent[]): Row[] {
  const rows: Row[] = [];
  const tools = new Map<string, Extract<Row, { kind: "tool" }>>();
  /** files written successfully in the current turn, shown together when it ends */
  let turnFiles: string[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "user":
        rows.push({ kind: "user", text: e.text });
        break;
      case "assistant-text":
        rows.push({ kind: "assistant", text: e.text });
        break;
      case "tool-use": {
        const row = { kind: "tool" as const, name: e.name, summary: e.summary, done: false, filePath: e.filePath };
        tools.set(e.id, row);
        rows.push(row);
        break;
      }
      case "tool-result": {
        const row = tools.get(e.id);
        if (row) {
          row.done = true;
          row.isError = e.isError;
          if (row.filePath && !e.isError && !turnFiles.includes(row.filePath)) turnFiles.push(row.filePath);
        }
        break;
      }
      case "turn-end":
        if (turnFiles.length) rows.push({ kind: "outputs", files: turnFiles });
        turnFiles = [];
        if (!e.ok) rows.push({ kind: "error", text: e.error ?? "The turn ended with an error." });
        else if (e.durationMs !== undefined) rows.push({ kind: "meta", text: `Done in ${Math.round(e.durationMs / MS_PER_SECOND)}s` });
        break;
      case "notice":
        rows.push({ kind: "notice", text: e.text });
        break;
      case "exit":
        // A normal stop exits with 0 or by signal; a non-zero code means Claude Code itself failed.
        if (e.code) rows.push({ kind: "error", text: `Claude Code stopped with exit code ${e.code}. Your next message resumes the session.` });
        break;
      default:
        break;
    }
  }
  return rows;
}

/** The message box under a session: Enter sends, Shift+Enter is a new line; Stop while Claude works. */
export function Composer({ session, placeholder, onError }: { session: LiveSession; placeholder: string; onError: (err: unknown) => void }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => inputRef.current?.focus(), [session.key]);

  const send = async () => {
    const text = draft.trim();
    if (!text || session.busy) return;
    // Clear first so a fast double Enter can't send twice; restore the text if sending fails.
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    try {
      await window.ghost.sessions.send(session.key, text);
    } catch (err) {
      setDraft(text);
      onError(err);
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={inputRef}
        rows={2}
        value={draft}
        placeholder={session.busy ? "Claude is working. Pin a note on a message to add a thought." : placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, COMPOSER_MAX_PX)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {session.busy ? (
        <button onClick={() => window.ghost.sessions.stop(session.key).catch(onError)}>Stop</button>
      ) : (
        <button className="send" title="Send (Enter)" onClick={() => void send()} disabled={!draft.trim()}>
          ↑
        </button>
      )}
    </div>
  );
}
