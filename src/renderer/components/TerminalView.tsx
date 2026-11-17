import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { attachTerminal } from "../terminalBuffer";

const FONT_SIZE = 13;

/** Claude Code's own interface for this session, in a real terminal. */
export function TerminalView({ sessionKey }: { sessionKey: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: FONT_SIZE,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: "#0d0e11" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const { backlog, detach } = attachTerminal(sessionKey, (data) => term.write(data));
    if (backlog) term.write(backlog);
    const input = term.onData((data) => window.ghost.sessions.writeTerminal(sessionKey, data));

    const resize = () => {
      try {
        fit.fit();
        window.ghost.sessions.resizeTerminal(sessionKey, term.cols, term.rows);
      } catch {
        // the view is hidden or not laid out yet; the next resize will fit it
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    term.focus();

    return () => {
      observer.disconnect();
      input.dispose();
      detach();
      term.dispose();
    };
  }, [sessionKey]);

  return <div className="terminal-wrap" ref={hostRef} />;
}
