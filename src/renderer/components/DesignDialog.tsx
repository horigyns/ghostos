import { useCallback, useEffect, useState } from "react";
import type { Area, DesignSystem, DesignSystemView, ProjectView } from "../../shared/types";
import { usePrompt } from "./Prompt";

interface Props {
  areas: Area[];
  projects: ProjectView[];
  /** the design system to open first */
  initialId?: string;
  onClose: () => void;
  onError: (err: unknown) => void;
}

const KB = 1024;
const size = (bytes: number) => (bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / (KB * KB)).toFixed(1)} MB`);
const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

function AssetTile({ ds, file, bytes, onRemove, onError }: { ds: string; file: string; bytes: number; onRemove: () => void; onError: (err: unknown) => void }) {
  const [preview, setPreview] = useState<string | undefined>();
  useEffect(() => {
    if (IMAGE.test(file)) window.ghost.design.assetPreview(ds, file).then(setPreview).catch(() => undefined);
  }, [ds, file]);
  return (
    <div className="asset-tile">
      <button className="asset-thumb" title="Open in a window" onClick={() => void window.ghost.design.openAsset(ds, file).catch(onError)}>
        {preview ? <img src={preview} alt={file} /> : <span className="faint">{file.split(".").pop()?.toUpperCase()}</span>}
      </button>
      <div className="asset-name ellipsis" title={file}>{file}</div>
      <div className="row asset-meta">
        <span className="faint">{size(bytes)}</span>
        <span style={{ flex: 1 }} />
        <button className="ghost danger" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

/** Design systems: a brand's guide, assets and source-of-truth files, linked to areas and projects. */
export function DesignDialog({ areas, projects, initialId, onClose, onError }: Props) {
  const ask = usePrompt();
  const [list, setList] = useState<DesignSystem[] | null>(null);
  const [selected, setSelected] = useState<string | undefined>(initialId);
  const [ds, setDs] = useState<DesignSystemView | null>(null);
  const [guide, setGuide] = useState("");
  const [guideDirty, setGuideDirty] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const loadList = useCallback(async () => {
    const all = await window.ghost.design.list();
    setList(all);
    setSelected((cur) => (cur && all.some((d) => d.id === cur) ? cur : all[0]?.id));
  }, []);
  const loadOne = useCallback(async (id: string) => {
    const view = await window.ghost.design.get(id);
    setDs(view);
    setGuide(view.guide);
    setGuideDirty(false);
    setDraft(null);
  }, []);

  useEffect(() => {
    loadList().catch(onError);
  }, [loadList, onError]);
  useEffect(() => {
    if (selected) loadOne(selected).catch(onError);
    else setDs(null);
  }, [selected, loadOne, onError]);

  const run = (fn: () => Promise<unknown>) =>
    void fn()
      .then(() => loadList())
      .catch(onError);
  const replace = (view: DesignSystemView) => {
    setDs(view);
    void loadList();
  };
  const close = () => {
    if ((guideDirty || draft !== null) && !window.confirm("Close without saving the guide?")) return;
    onClose();
  };
  const create = async () => {
    const name = await ask("Design system name ");
    if (!name) return;
    run(async () => {
      const view = await window.ghost.design.create(name);
      setSelected(view.id);
    });
  };
  const toggle = (key: "areas" | "projects", id: string, on: boolean) => {
    if (!ds) return;
    const next = on ? [...ds[key], id] : ds[key].filter((x) => x !== id);
    window.ghost.design.save(ds.id, { [key]: next }).then(replace).catch(onError);
  };
  const runDraft = () => {
    if (!ds) return;
    setDrafting(true);
    window.ghost.design
      .draft(ds.id)
      .then(setDraft)
      .catch(onError)
      .finally(() => setDrafting(false));
  };

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette capabilities design-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="design-layout">
          <nav className="design-list">
            <div className="hint" style={{ padding: "4px 8px" }}>Design systems</div>
            {list?.map((d) => (
              <button key={d.id} className={`design-item ${d.id === selected ? "on" : ""}`} onClick={() => setSelected(d.id)}>
                {d.name}
              </button>
            ))}
            {list && !list.length && <p className="faint" style={{ padding: "0 8px" }}>None yet.</p>}
            <button className="ghost" onClick={() => void create()}>+ New design system</button>
          </nav>
          <div className="cap-body design-body">
            {!ds && (
              <p className="hint">
                A design system keeps every surface on one look: the guide (logo rules, colors, type, voice), the asset files (logos), and the files in
                your code that define the brand. Link it to an area or projects, and every Claude session there, in GhostOS, VS Code and the terminal, is
                told to use it.
              </p>
            )}
            {ds && (
              <>
                <div className="row">
                  <h3 style={{ margin: 0, fontSize: 16, textTransform: "none", letterSpacing: 0, color: "var(--text)" }}>{ds.name}</h3>
                  <span style={{ flex: 1 }} />
                  <button
                    className="ghost"
                    onClick={async () => {
                      const name = await ask("Rename design system", ds.name);
                      if (name && name !== ds.name) window.ghost.design.save(ds.id, { name }).then(replace).catch(onError);
                    }}
                  >
                    Rename
                  </button>
                  <button className="ghost" onClick={() => void window.ghost.design.reveal(ds.id).catch(onError)}>Show in Finder</button>
                  <button
                    className="ghost danger"
                    onClick={() =>
                      window.confirm(`Remove the design system "${ds.name}" with its guide and assets? (The brain's git history keeps a copy.)`) &&
                      run(async () => {
                        await window.ghost.design.remove(ds.id);
                        setSelected(undefined);
                      })
                    }
                  >
                    Remove
                  </button>
                </div>

                <h3>Applies to</h3>
                <div className="row">
                  {areas.map((a) => (
                    <label key={a.id} className="check">
                      <input type="checkbox" checked={ds.areas.includes(a.id)} onChange={(e) => toggle("areas", a.id, e.target.checked)} />
                      {a.name} <span className="faint">(area)</span>
                    </label>
                  ))}
                </div>
                <details className="design-projects">
                  <summary className="hint">Individual projects ({ds.projects.length})</summary>
                  <div className="row">
                    {projects.filter((p) => !p.archived || ds.projects.includes(p.id)).map((p) => (
                      <label key={p.id} className="check">
                        <input type="checkbox" checked={ds.projects.includes(p.id)} onChange={(e) => toggle("projects", p.id, e.target.checked)} />
                        {p.name}
                      </label>
                    ))}
                  </div>
                </details>

                <h3>Assets</h3>
                <p className="hint">The files to use as they are: logos, marks, fonts, reference images. Claude is told never to redraw the logo.</p>
                <div className="asset-grid">
                  {ds.assets.map((a) => (
                    <AssetTile
                      key={a.file}
                      ds={ds.id}
                      file={a.file}
                      bytes={a.bytes}
                      onError={onError}
                      onRemove={() => window.confirm(`Remove ${a.file} from the design system?`) && run(async () => {
                        await window.ghost.design.removeAsset(ds.id, a.file);
                        await loadOne(ds.id);
                      })}
                    />
                  ))}
                  <button className="asset-add" onClick={() => window.ghost.design.addAssets(ds.id).then(replace).catch(onError)}>+ Add files</button>
                </div>

                <h3>Source of truth in code</h3>
                <p className="hint">Files in project folders that define the brand (theme or Tailwind config, CSS variables, the logo component).</p>
                {ds.resolvedSources.map((s, i) => (
                  <div key={`${s.projectId}/${s.relPath}`} className="row source-row">
                    <span className={`mono ellipsis ${s.exists ? "" : "faint"}`} title={s.path}>
                      {projects.find((p) => p.id === s.projectId)?.name ?? s.projectId} / {s.relPath}
                    </span>
                    {!s.exists && <span className="badge">not on this Mac</span>}
                    <span style={{ flex: 1 }} />
                    <button className="ghost danger" onClick={() => run(async () => {
                      await window.ghost.design.removeSource(ds.id, i);
                      await loadOne(ds.id);
                    })}>Remove</button>
                  </div>
                ))}
                <div className="row">
                  <button onClick={() => window.ghost.design.addSource(ds.id).then(replace).catch(onError)}>+ Add a source file</button>
                </div>

                <h3>Guide (DESIGN.md)</h3>
                <p className="hint">Logo rules, colors, type, spacing, voice. Sessions get the start of it and read the rest from the file.</p>
                {draft !== null ? (
                  <div className="compare">
                    <div>
                      <div className="hint">Current</div>
                      <pre className="brief-text">{guide || "(empty)"}</pre>
                    </div>
                    <div>
                      <div className="hint">Claude's draft (edit before using it)</div>
                      <textarea className="brief-edit" rows={18} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    </div>
                  </div>
                ) : (
                  <textarea
                    className="brief-edit"
                    rows={16}
                    placeholder={"# Acme design system\n\n## Logo\nUse assets/acme-mark.svg as is…"}
                    value={guide}
                    onChange={(e) => {
                      setGuide(e.target.value);
                      setGuideDirty(true);
                    }}
                  />
                )}
                <div className="row">
                  <button
                    disabled={drafting}
                    title="Claude reads the linked projects' files (read-only) and drafts the guide; you review it before it's saved"
                    onClick={runDraft}
                  >
                    {drafting ? "Claude is reading the project…" : "Draft with Claude"}
                  </button>
                  <span className="faint">Sonnet, read-only, a few minutes</span>
                  <span style={{ flex: 1 }} />
                  {draft !== null ? (
                    <>
                      <button onClick={() => setDraft(null)}>Discard draft</button>
                      <button
                        className="primary"
                        onClick={() => run(async () => {
                          await window.ghost.design.saveGuide(ds.id, draft);
                          await loadOne(ds.id);
                        })}
                      >
                        Use this draft
                      </button>
                    </>
                  ) : (
                    <>
                      <button disabled={!guideDirty} onClick={() => void loadOne(ds.id).catch(onError)}>Discard</button>
                      <button
                        className="primary"
                        disabled={!guideDirty}
                        onClick={() => run(async () => {
                          await window.ghost.design.saveGuide(ds.id, guide);
                          setGuideDirty(false);
                        })}
                      >
                        Save guide
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="palette-foot">
          <span className="hint">Kept in the brain (design-systems/), so it syncs to the other Mac.</span>
          <span style={{ flex: 1 }} />
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
