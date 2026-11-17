import { useCallback, useEffect, useState } from "react";
import { VoiceSection } from "./VoiceSection";
import type { CapabilitiesState } from "../../shared/api";
import type { AgentDoc, Area, BrainSettings, CapabilityFile, EnforcementLevel } from "../../shared/types";
import { AboutYouNotes } from "./MemoryNotes";

export type CapabilitiesTab = "rules" | "about" | "agents" | "enforcement" | "install";
type Tab = CapabilitiesTab;
const GLOBAL = "global";
const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const NEW_AGENT_TEMPLATE = "---\nname: NAME\ndescription: When Claude should use this agent.\n---\n\nInstructions for the agent.\n";

const FILE_STATE: Record<CapabilityFile["state"], string> = {
  write: "will be written",
  same: "up to date",
  conflict: "kept: you have your own file here",
  remove: "will be removed",
};

interface Props {
  /** the tab to open on (default: Rules) */
  initialTab?: CapabilitiesTab;
  areas: Area[];
  settings: BrainSettings;
  version: number;
  onClose: () => void;
  onError: (err: unknown) => void;
}

const scopeName = (scope: string, areas: Area[]) => (scope === GLOBAL ? "All projects" : areas.find((a) => a.id === scope)?.name ?? scope);

/** Rules and agents layered global → area → project, how strictly they're enforced, and applying them to ~/.claude. */
export function CapabilitiesDialog({ areas, settings, version, initialTab, onClose, onError }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "rules");
  const [data, setData] = useState<CapabilitiesState | null>(null);
  const [ruleScope, setRuleScope] = useState(GLOBAL);
  const [ruleText, setRuleText] = useState("");
  const [ruleDirty, setRuleDirty] = useState(false);
  const [editing, setEditing] = useState<AgentDoc | null>(null);
  /** true when `editing` is an agent already in the brain (its name and scope are then fixed) */
  const [editingExisting, setEditingExisting] = useState(false);
  const [importScope, setImportScope] = useState<Record<string, string>>({});
  const [enforcement, setEnforcement] = useState(settings.enforcement);
  // Follow saved settings (e.g. changed on the other Mac and synced in).
  useEffect(() => setEnforcement(settings.enforcement), [settings.enforcement]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setData(await window.ghost.capabilities.get()), []);
  useEffect(() => {
    load().catch(onError);
  }, [load, version, onError]);

  // Show the saved rules for the chosen scope, unless the user is editing them.
  useEffect(() => {
    if (!data || ruleDirty) return;
    setRuleText(ruleScope === GLOBAL ? data.globalRules : data.areaRules[ruleScope] ?? "");
  }, [data, ruleScope, ruleDirty]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  const pickRuleScope = (scope: string) => {
    if (ruleDirty && !window.confirm("Discard your unsaved rule changes?")) return;
    setRuleDirty(false);
    setRuleScope(scope);
  };

  const saveRules = () =>
    run(async () => {
      await window.ghost.capabilities.saveRules(ruleScope === GLOBAL ? {} : { area: ruleScope }, ruleText);
      setRuleDirty(false);
    });

  const saveAgent = (doc: AgentDoc) => {
    const clash = !editingExisting && data?.agents.some((a) => a.scope === doc.scope && a.name === doc.name);
    if (clash && !window.confirm(`There is already an agent "${doc.name}" there. Replace it?`)) return;
    void run(async () => {
      await window.ghost.capabilities.saveAgent({ ...doc, content: doc.content.replace("name: NAME", `name: ${doc.name}`) });
      setEditing(null);
    });
  };

  const saveEnforcement = () => run(() => window.ghost.settings.save({ ...settings, enforcement }));

  const apply = () => {
    if (!window.confirm("Write GhostOS's hooks and agents into ~/.claude? Your settings.json is backed up first, and your own hooks and agent files are kept.")) return;
    void run(() => window.ghost.capabilities.apply());
  };
  const remove = () => {
    if (!window.confirm("Remove GhostOS's hooks and agents from ~/.claude? Agent files you've edited there are kept.")) return;
    void run(() => window.ghost.capabilities.remove());
  };

  const unsaved = ruleDirty || editing !== null || JSON.stringify(enforcement) !== JSON.stringify(settings.enforcement);
  const close = () => {
    if (unsaved && !window.confirm("Close without saving your changes?")) return;
    onClose();
  };
  const startEdit = (agent: AgentDoc, existing: boolean) => {
    setEditing(agent);
    setEditingExisting(existing);
  };

  const scopes = [GLOBAL, ...areas.map((a) => a.id)];
  const plan = data?.plan;
  const pending = plan?.files.filter((f) => f.state === "write" || f.state === "remove").length ?? 0;

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="palette capabilities" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="project-tabs">
          {(["rules", "about", "agents", "enforcement", "install"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {{ rules: "Rules", about: "About you", agents: "Agents", enforcement: "Enforcement", install: "Apply to Claude" }[t]}
              {t === "install" && plan?.applied && pending ? <span className="count-badge">{pending}</span> : null}
            </button>
          ))}
        </nav>
        <div className="cap-body">
          {!data && <p className="faint">Loading…</p>}

          {tab === "about" && (
            <>
              <VoiceSection version={version} onError={onError} />
              <h3>What Claude knows about you</h3>
              <AboutYouNotes version={version} onError={onError} />
            </>
          )}

          {data && tab === "rules" && (
            <>
              <p className="hint">
                Rules reach every Claude session in a project folder: all-projects rules first, then the area's, then the project's own
                (edit those in a project's Memory tab). They're added when a session starts, in GhostOS, VS Code and the terminal once
                applied to Claude.
              </p>
              <div className="row">
                <select value={ruleScope} onChange={(e) => pickRuleScope(e.target.value)}>
                  {scopes.map((s) => (
                    <option key={s} value={s}>{scopeName(s, areas)}</option>
                  ))}
                </select>
                {ruleDirty && <span className="badge">unsaved</span>}
              </div>
              <textarea
                className="brief-edit"
                rows={16}
                placeholder={ruleScope === GLOBAL ? "e.g. Plan before coding. Never commit unless I ask." : `Rules for every ${scopeName(ruleScope, areas)} project.`}
                value={ruleText}
                onChange={(e) => {
                  setRuleText(e.target.value);
                  setRuleDirty(true);
                }}
              />
              <div className="row">
                <span style={{ flex: 1 }} />
                <button disabled={!ruleDirty || busy} onClick={() => setRuleDirty(false)}>Discard</button>
                <button className="primary" disabled={!ruleDirty || busy} onClick={() => void saveRules()}>Save rules</button>
              </div>
            </>
          )}

          {data && tab === "agents" && !editing && (
            <>
              <div className="panel-head">
                <span className="hint" style={{ flex: 1 }}>
                  Agents for all projects install as-is; area agents install with the area's name in front (e.g. acme-planner) and
                  say which projects they're for.
                </span>
                <button className="primary" onClick={() => startEdit({ name: "", scope: GLOBAL, content: NEW_AGENT_TEMPLATE }, false)}>New agent</button>
              </div>
              {scopes.map((scope) => {
                const agents = data.agents.filter((a) => a.scope === scope);
                if (!agents.length) return null;
                return (
                  <div key={scope}>
                    <h3>{scopeName(scope, areas)}</h3>
                    {agents.map((a) => (
                      <div key={`${a.scope}/${a.name}`} className="card row">
                        <strong>{a.name}</strong>
                        <span className="faint ellipsis" style={{ flex: 1 }}>{/description:\s*(.*)/.exec(a.content)?.[1] ?? ""}</span>
                        <button className="ghost" onClick={() => startEdit({ ...a }, true)}>Edit</button>
                        <button
                          className="ghost danger"
                          onClick={() => window.confirm(`Delete the agent "${a.name}" from the brain?`) && void run(() => window.ghost.capabilities.removeAgent(a.scope, a.name))}
                        >
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                );
              })}
              {!data.agents.length && <p className="faint">No agents in the brain yet. Import yours below or make a new one.</p>}

              <h3 style={{ marginTop: 18 }}>Import</h3>
              {!data.importable.length && <p className="faint">Nothing new to import from ~/.claude/agents or your projects' .claude/agents folders.</p>}
              {data.importable.map((a) => (
                <div key={a.path} className="card row">
                  <strong>{a.name}</strong>
                  <span className="faint ellipsis" style={{ flex: 1 }} title={a.path}>{a.source}</span>
                  <select value={importScope[a.path] ?? GLOBAL} onChange={(e) => setImportScope({ ...importScope, [a.path]: e.target.value })}>
                    {scopes.map((s) => (
                      <option key={s} value={s}>{scopeName(s, areas)}</option>
                    ))}
                  </select>
                  <button disabled={busy} onClick={() => void run(() => window.ghost.capabilities.importAgent(a.path, importScope[a.path] ?? GLOBAL))}>
                    Import
                  </button>
                </div>
              ))}
            </>
          )}

          {data && tab === "agents" && editing && (
            <div className="card form">
              <div className="row">
                <input
                  placeholder="agent-name"
                  disabled={editingExisting}
                  title={editingExisting ? "To rename or move an agent, make a new one and delete this one." : undefined}
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value.toLowerCase() })}
                  style={{ width: 220 }}
                />
                <select value={editing.scope} disabled={editingExisting} onChange={(e) => setEditing({ ...editing, scope: e.target.value })}>
                  {scopes.map((s) => (
                    <option key={s} value={s}>{scopeName(s, areas)}</option>
                  ))}
                </select>
                {editing.name && !AGENT_NAME.test(editing.name) && <span className="hint">Use lowercase letters, digits and dashes.</span>}
              </div>
              <textarea
                className="brief-edit"
                rows={18}
                value={editing.content.replace("name: NAME", `name: ${editing.name || "NAME"}`)}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
              <div className="row">
                <span style={{ flex: 1 }} />
                <button onClick={() => setEditing(null)}>Cancel</button>
                <button
                  className="primary"
                  disabled={busy || !AGENT_NAME.test(editing.name)}
                  onClick={() => saveAgent(editing)}
                >
                  Save agent
                </button>
              </div>
            </div>
          )}

          {data && tab === "enforcement" && (
            <>
              <p className="hint">These apply to every Claude Code session in a GhostOS project folder, once applied to Claude.</p>
              <label className="setting check">
                <input type="checkbox" checked={enforcement.sessionContext} onChange={(e) => setEnforcement({ ...enforcement, sessionContext: e.target.checked })} />
                <span>Start sessions with the project's rules and brief</span>
                <span className="hint">In VS Code and the terminal too. GhostOS's own chats always get them.</span>
              </label>
              <label className="setting">
                <span>Code review before a commit</span>
                <select value={enforcement.reviewBeforeCommit} onChange={(e) => setEnforcement({ ...enforcement, reviewBeforeCommit: e.target.value as EnforcementLevel })}>
                  <option value="block">Required (blocks the commit)</option>
                  <option value="remind">Reminder</option>
                  <option value="off">Off</option>
                </select>
                <span className="hint">Claude can't run git commit until a code-reviewer agent or review skill has run since the last commit.</span>
              </label>
              <label className="setting">
                <span>Documenter after 5+ changed files</span>
                <select value={enforcement.documenterReminder} onChange={(e) => setEnforcement({ ...enforcement, documenterReminder: e.target.value as "remind" | "off" })}>
                  <option value="remind">Reminder</option>
                  <option value="off">Off</option>
                </select>
                <span className="hint">Once per session, when Claude finishes.</span>
              </label>
              <label className="setting">
                <span>Error log after a failed command</span>
                <select value={enforcement.errorLogReminder} onChange={(e) => setEnforcement({ ...enforcement, errorLogReminder: e.target.value as "remind" | "off" })}>
                  <option value="remind">Reminder</option>
                  <option value="off">Off</option>
                </select>
                <span className="hint">Once per session, only in projects with docs/error-log.</span>
              </label>
              <div className="row">
                <span style={{ flex: 1 }} />
                <button
                  className="primary"
                  disabled={busy || JSON.stringify(enforcement) === JSON.stringify(settings.enforcement)}
                  onClick={() => void saveEnforcement()}
                >
                  Save
                </button>
              </div>
            </>
          )}

          {data && plan && tab === "install" && (
            <>
              <p>
                {plan.applied ? (
                  <strong>Applied to Claude on this Mac.</strong>
                ) : (
                  <strong>Not applied yet.</strong>
                )}{" "}
                <span className="hint">
                  Applying adds GhostOS's hooks ({plan.hookEvents.join(", ")}) to ~/.claude/settings.json next to your own, and writes the
                  brain's agents to ~/.claude/agents. Then the rules, brief and checks work in VS Code and the terminal as well. Hooks only
                  act in GhostOS project folders. Remove takes out only what GhostOS added.
                </span>
              </p>
              <div className="plan-files">
                {plan.files.map((f) => (
                  <div key={f.path} className={`plan-file ${f.state}`}>
                    <span className="mono ellipsis" title={f.path}>{f.path.replace(/^\/Users\/[^/]+/, "~")}</span>
                    <span className="faint">{f.note ?? FILE_STATE[f.state]}</span>
                  </div>
                ))}
              </div>
              <div className="row">
                <span style={{ flex: 1 }} />
                {plan.applied && <button className="danger" disabled={busy} onClick={remove}>Remove from Claude</button>}
                <button className="primary" disabled={busy || (plan.applied && !pending)} onClick={apply}>
                  {plan.applied ? (pending ? "Update" : "Up to date") : "Apply to Claude"}
                </button>
              </div>
            </>
          )}
        </div>
        <div className="palette-foot">
          <span className="hint" style={{ flex: 1 }}>Stored in your brain folder, so they follow you to your other Mac.</span>
          <button onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
