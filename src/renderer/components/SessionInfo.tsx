import { useEffect, useState } from "react";
import type { LiveSession } from "../../shared/types";
import { PERMISSION_CHOICES } from "./sessionChoices";

const LIST_PREVIEW = 6;

function names(list: string[]): string {
  if (list.length <= LIST_PREVIEW) return list.join(", ");
  return `${list.slice(0, LIST_PREVIEW).join(", ")} and ${list.length - LIST_PREVIEW} more`;
}

/** What a chat's Claude Code has: its model, the connectors it reached, and the context GhostOS adds. */
export function SessionInfo({ session, onError }: { session: LiveSession; onError: (err: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<string | null>(null);
  const c = session.connectors;

  useEffect(() => {
    if (!open) return;
    window.ghost.capabilities.previewContext(session.projectId).then(setContext).catch(onError);
  }, [open, session.projectId, onError]);

  return (
    <span className="session-info">
      <button
        className={`toggle ${open ? "on" : ""}`}
        title={`What this chat has: model, permissions, ${c ? `${c.connected.length} connectors` : "connectors (still connecting)"}, context`}
        onClick={() => setOpen(!open)}
      >
        {session.model ?? "default"} · {PERMISSION_CHOICES.find((p) => p.value === session.permissionMode)?.label.toLowerCase() ?? session.permissionMode}
        {c ? null : <span className="faint">· connecting</span>} ▾
      </button>
      {open && (
        <div className="session-info-pop card" onMouseLeave={() => setOpen(false)}>
          <div className="row"><strong>Model</strong><span className="mono">{session.model ?? "your default (shown after the first reply)"}</span></div>
          <p className="hint">Same Claude Code, login, CLAUDE.md, memory, skills, plugins and agents as your terminal.</p>
          {c ? (
            <>
              <div><strong>Connected</strong> <span className="faint">({c.connected.length})</span></div>
              <p className="info-list">{c.connected.length ? names(c.connected) : "none"}</p>
              {c.needsAuth.length > 0 && (
                <>
                  <div><strong>Needs sign-in</strong> <span className="faint">({c.needsAuth.length})</span></div>
                  <p className="info-list faint" title={c.needsAuth.join(", ")}>{names(c.needsAuth)}. Sign in on claude.ai, or with /mcp in the Terminal view.</p>
                </>
              )}
              {c.failed.length > 0 && <p className="info-list faint">Didn't connect: {names(c.failed)}</p>}
            </>
          ) : (
            <p className="faint">Connectors are still connecting; your first message waits for them.</p>
          )}
          <details>
            <summary className="hint">Context GhostOS adds ({context === null ? "…" : `${context.length.toLocaleString()} characters`})</summary>
            <pre className="brief-text info-context">{context || "Nothing for this project."}</pre>
          </details>
        </div>
      )}
    </span>
  );
}
