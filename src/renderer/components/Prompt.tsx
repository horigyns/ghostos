// A small text-input dialog (Electron doesn't support window.prompt).
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Ask = (title: string, initial?: string) => Promise<string | null>;

const PromptContext = createContext<Ask>(async () => null);

export function usePrompt(): Ask {
  return useContext(PromptContext);
}

interface Pending {
  title: string;
  value: string;
  resolve: (value: string | null) => void;
}

export function PromptProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ask = useCallback<Ask>(
    (title, initial = "") => new Promise((resolve) => setPending({ title, value: initial, resolve })),
    [],
  );

  const finish = (value: string | null) => {
    pending?.resolve(value?.trim() ? value.trim() : null);
    setPending(null);
  };

  return (
    <PromptContext.Provider value={ask}>
      {children}
      {pending && (
        <div className="overlay" onMouseDown={() => finish(null)}>
          <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              autoFocus
              placeholder={pending.title}
              value={pending.value}
              onChange={(e) => setPending({ ...pending, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") finish(pending.value);
                if (e.key === "Escape") finish(null);
              }}
            />
            <div className="palette-foot">
              <span className="dim">{pending.title}</span>
              <span style={{ flex: 1 }} />
              <button onClick={() => finish(null)}>Cancel</button>
              <button className="primary" onClick={() => finish(pending.value)}>OK</button>
            </div>
          </div>
        </div>
      )}
    </PromptContext.Provider>
  );
}
