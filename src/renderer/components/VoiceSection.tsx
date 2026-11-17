import { useCallback, useEffect, useState } from "react";
import type { VoiceView } from "../../shared/types";

const KB = 1024;
const size = (bytes: number) => `${Math.max(1, Math.round(bytes / KB))} KB`;
const GUIDE_PLACEHOLDER = `# How I write

Short, direct sentences. I lead with the point, then the reason.
No hype words ("revolutionary", "game-changing"), no em dashes.
Founder letters: first person, plain numbers, one clear ask at the end.
Sign-off: first name only.
(Write your own, or add samples and use Draft from my samples.)`;

/** How the user writes: a voice guide and samples, so letters, updates and posts sound like them. */
export function VoiceSection({ version, onError }: { version: number; onError: (err: unknown) => void }) {
  const [voice, setVoice] = useState<VoiceView | null>(null);
  const [guide, setGuide] = useState("");
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [pasting, setPasting] = useState<{ name: string; text: string } | null>(null);

  const apply = useCallback((view: VoiceView, keepGuide = false) => {
    setVoice(view);
    if (!keepGuide) {
      setGuide(view.guide);
      setDirty(false);
    }
  }, []);
  useEffect(() => {
    window.ghost.voice.get().then((v) => apply(v)).catch(onError);
  }, [apply, version, onError]);

  if (!voice) return <p className="faint">Loading…</p>;
  // Sample changes must not throw away an unsaved guide edit.
  const update = (p: Promise<VoiceView>) => p.then((v) => apply(v, dirty)).catch(onError);

  const save = (text: string) =>
    window.ghost.voice
      .saveGuide(text)
      .then((v) => {
        apply(v);
        setDraft(null);
      })
      .catch(onError);
  const runDraft = () => {
    setDrafting(true);
    window.ghost.voice
      .draft()
      .then(setDraft)
      .catch(onError)
      .finally(() => setDrafting(false));
  };

  return (
    <div className="voice">
      <h3>Your voice</h3>
      <p className="hint">
        So a founder letter, an investor update or a post sounds like you wrote it. Every Claude session (GhostOS, VS Code, the terminal, in a
        project or not) is told how you write and where your samples are, and reads them before writing anything you'll send as your own.
      </p>

      <div className="row">
        <strong>Writing samples</strong>
        <span className="faint">{voice.samples.length ? `${voice.samples.length}` : "none yet"}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => void update(window.ghost.voice.addFiles())} title="Word, RTF, text or markdown files">+ Add files</button>
        <button onClick={() => setPasting({ name: "", text: "" })}>+ Paste text</button>
      </div>
      {pasting && (
        <div className="card voice-paste">
          <input placeholder="Name (e.g. Founder letter, Q3 2026)" value={pasting.name} onChange={(e) => setPasting({ ...pasting, name: e.target.value })} />
          <textarea className="brief-edit" rows={8} placeholder="Paste something you wrote: a letter, an update, an email, a post…" value={pasting.text} onChange={(e) => setPasting({ ...pasting, text: e.target.value })} />
          <div className="row">
            <span style={{ flex: 1 }} />
            <button onClick={() => setPasting(null)}>Cancel</button>
            <button
              className="primary"
              disabled={!pasting.name.trim() || !pasting.text.trim()}
              onClick={() => void update(window.ghost.voice.pasteSample(pasting.name.trim(), pasting.text)).then(() => setPasting(null))}
            >
              Add sample
            </button>
          </div>
        </div>
      )}
      {voice.samples.length > 0 && (
        <div className="voice-samples">
          {voice.samples.map((s) => (
            <div key={s.file} className="voice-sample">
              <button className="loop-title" title="Open" onClick={() => void window.ghost.voice.openSample(s.file).catch(onError)}>
                <span>{s.file}</span>
                <span className="faint loop-detail">{s.excerpt}</span>
              </button>
              <span className="faint">{size(s.bytes)}</span>
              <button className="ghost danger" onClick={() => window.confirm(`Remove the sample "${s.file}"?`) && void update(window.ghost.voice.removeSample(s.file))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {!voice.samples.length && (
        <p className="faint">Add 3 to 10 things you're happy with: a founder letter, investor updates, emails, posts. Pieces you wrote yourself, not ones Claude drafted.</p>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <strong>Voice guide</strong>
        {dirty && <span className="badge">unsaved</span>}
      </div>
      {draft !== null ? (
        <div className="compare">
          <div>
            <div className="hint">Current</div>
            <pre className="brief-text">{guide || "(empty)"}</pre>
          </div>
          <div>
            <div className="hint">Claude's draft (edit before using it)</div>
            <textarea className="brief-edit" rows={16} value={draft} onChange={(e) => setDraft(e.target.value)} />
          </div>
        </div>
      ) : (
        <textarea
          className="brief-edit"
          rows={12}
          placeholder={GUIDE_PLACEHOLDER}
          value={guide}
          onChange={(e) => {
            setGuide(e.target.value);
            setDirty(true);
          }}
        />
      )}
      <div className="row">
        <button disabled={drafting || !voice.samples.length} onClick={runDraft} title="Claude reads your samples (and nothing else) and describes how you write">
          {drafting ? "Claude is reading your samples…" : "Draft from my samples"}
        </button>
        <span className="faint">Sonnet, about a minute</span>
        <button className="ghost" onClick={() => void window.ghost.voice.reveal().catch(onError)}>Show in Finder</button>
        <span style={{ flex: 1 }} />
        {draft !== null ? (
          <>
            <button onClick={() => setDraft(null)}>Discard draft</button>
            <button className="primary" onClick={() => void save(draft)}>Use this draft</button>
          </>
        ) : (
          <>
            <button disabled={!dirty} onClick={() => void window.ghost.voice.get().then((v) => apply(v)).catch(onError)}>Discard</button>
            <button className="primary" disabled={!dirty} onClick={() => void save(guide)}>Save guide</button>
          </>
        )}
      </div>
    </div>
  );
}
