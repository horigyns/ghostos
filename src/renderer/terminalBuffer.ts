// Holds terminal output that arrives before (or while) a terminal view is mounted, so switching
// tabs or views never loses Claude Code's screen.
const MAX_BUFFER_CHARS = 2_000_000;

const buffers = new Map<string, string>();
const listeners = new Map<string, (data: string) => void>();

export function appendTerminalData(key: string, data: string): void {
  const next = (buffers.get(key) ?? "") + data;
  buffers.set(key, next.length > MAX_BUFFER_CHARS ? next.slice(-MAX_BUFFER_CHARS) : next);
  listeners.get(key)?.(data);
}

/** Subscribes a mounted terminal; returns everything buffered so far. */
export function attachTerminal(key: string, onData: (data: string) => void): { backlog: string; detach: () => void } {
  listeners.set(key, onData);
  return { backlog: buffers.get(key) ?? "", detach: () => listeners.delete(key) };
}

export function clearTerminal(key: string): void {
  buffers.delete(key);
  listeners.delete(key);
}
