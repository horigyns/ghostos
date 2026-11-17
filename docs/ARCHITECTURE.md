# GhostOS architecture

GhostOS is an Electron app. The main process owns everything with side effects (files, git, Claude processes). The renderer is a React UI that only talks to the main process through the `window.ghost` API (`src/shared/api.ts`, implemented in `src/preload/index.ts`). The renderer runs sandboxed with context isolation and no Node access.

## Module map

```
src/
  main/
    index.ts              Startup, config, IPC handlers, window, delivery poll timer, shutdown
    validate.ts           Runtime checks for every IPC input (ids, folders, permission mode, model, patch keys)
    config.ts             loadConfig(): brain location (shared with the background runner; no Electron)
    memory-and-runs.ts    Phase 2 wiring: in-app scheduler tick, runner install, runs/memory/settings/search IPC
    brain/
      store.ts            BrainStore: areas, projects, sidenotes, ideas on disk (YAML/JSONL, atomic writes)
      git.ts              BrainGit: init + debounced auto-commit (5 s) of the brain; remoteOf() for folders
      machine.ts          Stable per-Mac id in machine.json (hostnames change, the id doesn't)
      seed.ts             First-run project list; only attaches folders that exist on this Mac
      view.ts             toView(): a project as seen from this Mac; runFolder() for scheduled runs
    claude/
      env.ts              findClaudeBinary(), cleanEnv(): launch environment for the CLI
      events.ts           stream-json message -> ChatEvent mapping (incl. rate_limit_event -> usage)
      transcripts.ts      Reads ~/.claude/projects/<encoded folder>/<session>.jsonl: list, title, replay history
    sessions/
      manager.ts          SessionManager: live sessions, chat<->terminal switching, history on open
      chat.ts             ChatSession: one `claude -p` stream-json process per conversation
      terminal.ts         TerminalSession: node-pty running interactive `claude`
    runs/
      schedule.ts         isDue()/lastSlot(): daily, weekly and interval schedules in local time
      budget.ts           decideRun()/backgroundAllowed(): the budget guard
      local-state.ts      Machine-local usage cache, per-run state, runner lock (shared with launchd runner)
      executor.ts         executeRun(): headless claude -p run, recorded in run-history.jsonl
      tick.ts             One scheduler pass: due runs -> budget guard -> execute / skip / defer
      launchd.ts          Install/remove the com.ghostos.runner launchd agent
    memory/
      summarizer.ts       Haiku summary + proposed brief (structured output, no tools, no persistence)
      service.ts          MemoryService: one-at-a-time summary queue; applies or proposes brief updates
    search/
      search.ts           Full-text search over transcripts and the brain
      worker.ts           Worker-thread entry (dist/main/search-worker.js)
    sidenotes/
      service.ts          SidenoteService: add/send/withdraw/promote, applies deliveries to records
      inbox.ts            Inbox files for the hook, writeSessionSettings(), collectDeliveries()
  hook/
    sidenote-hook.ts      Standalone script Claude Code runs on hook events (built to dist/hook/)
  runner/index.ts         Background runner entry run by launchd (dist/runner/index.js)
  preload/index.ts        Exposes window.ghost over IPC
  shared/
    types.ts              Area, Project, Sidenote, Idea, ChatEvent, LiveSession, ...
    hook-protocol.ts      Inbox file names, claim/stale rules and session-id check shared by app and hook
    api.ts                GhostApi interface and IPC channel names
  renderer/
    App.tsx               Layout, Cmd+K / Cmd+I handling, live-session state
    components/           Sidebar, Rail (sidenotes + ideas), ChatView, TerminalView, SessionsPanel,
                          ProjectHeader, Switcher, IdeaCapture, Prompt, RunsPanel, MemoryPanel,
                          SettingsDialog, SearchPalette
    terminalBuffer.ts     Buffers terminal output for the xterm view
tests/                    store, sidenotes (hook + inbox + service), claude (events, transcripts, env)
tests/e2e/smoke.ts        End-to-end run against the real CLI
scripts/build.mjs         esbuild (main, preload, hook) + Vite (renderer) -> dist/
```

## Session data flow

1. The renderer calls `sessions.open({ projectId, cwd, resumeSessionId? })`. `cwd` is the project's primary local folder.
2. `SessionManager.open` creates a `ChatSession` (no process yet). A new session gets a UUID chosen by GhostOS and is later started with `--session-id <id>`; a resumed one uses `--resume <id>`. If the session is already open it is returned as is. History comes from the transcript file via `loadHistory` (capped at 400 events).
3. On `sessions.send`, `ChatSession` starts `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode <mode> --settings <file> [--model m]` with `cleanEnv()` and writes the message as a JSON line to stdin. The process stays alive across turns.
4. Each stdout line is parsed and mapped by `toChatEvents` to `ChatEvent`s (init, assistant-text, tool-use, tool-result, turn-end, usage). The manager forwards them over IPC (`ev:session-event`, `ev:usage`, `ev:session-state`). The title of a "New chat" becomes the first user message.
5. Sending while Claude is busy, or while the session is in terminal view, throws an error that the UI shows.
6. Stop sends SIGINT to the process (SIGKILL after 3 s). The next send starts a new process with `--resume`.
7. Terminal view: allowed only when idle. The chat process is stopped, then `TerminalSession` starts interactive `claude` with the same session id (`--resume` if the session exists on disk, else `--session-id`). Only one of chat or terminal runs at a time, since both write to the same session. Returning to chat kills the pty and replays history from the transcript.

Past-session listing (`sessions.listPast`) reads transcripts for the project's local folders that exist. A title is the AI title if present, else the first real user prompt, ignoring injected context.

## Sidenote data flow

```
Rail UI --add--> SidenoteService --> brain: projects/<id>/sidenotes.jsonl (status queued | saved)
                       |
                       +--(now / after)--> Inbox.enqueue: <appData>/inbox/<session_id>/<ts>-<noteId>.json
                                                              |
        Claude Code fires a hook event in a GhostOS session   |
        -> runs sidenote-hook.js <inboxDir> (via --settings)  v
        hook reads pending files, selects by event, deletes each file it delivers (claim),
        appends {id,event,at} to inbox/<session_id>/delivered.jsonl, prints the hook JSON
                                                              |
main process polls Inbox.collectDeliveries() every 1.5 s <-----+
  -> SidenoteService.applyDeliveries marks notes "delivered" -> evSidenotesChanged -> UI
```

Which events deliver what (`selectNotes` in `sidenote-hook.ts`):

| Hook event | Delivers | Output |
|------------|----------|--------|
| `PostToolBatch` | only `now` notes | context text next to the tool results; the turn keeps going |
| `Stop` | all pending notes | `decision: block` with the notes as the reason, so Claude continues once |
| `UserPromptSubmit` | all pending notes | context alongside the user's next message |

Properties worth knowing:

- A note is a file. The hook claims it by renaming it to `.claimed` (atomic, so two hooks never deliver the same note), prints it for Claude, then records it in `delivered.jsonl` and deletes the claim. A claim left by a hook that died is delivered again after 30 s rather than lost.
- The hook ignores session ids containing anything other than letters, digits and `-`, and never fails the Claude session: errors go to stderr only.
- The hook is registered by `writeSessionSettings`, which writes `<appData>/claude-session-settings.json`. That file is passed with `--settings` only by GhostOS (chat and terminal), so Claude sessions started elsewhere are unaffected. The command is `ELECTRON_RUN_AS_NODE=1 "<electron binary>" "<dist/hook/sidenote-hook.js>" "<inboxDir>"`.
- Modes: `later` notes are stored as `saved` and never enqueued. `send` turns a saved note into a queued `after` note. `withdraw` removes a queued note (returns it to `saved`) unless the hook already took it. `promote` copies the text into an idea under the same project.
- A sidenote needs an open chat (it is tied to the session id), and Claude Code must be running for the hook to fire. A queued note on an idle session waits for the next prompt.

## Brain layout

Location: `~/GhostOS-brain` by default; override with `brainDir` in `~/Library/Application Support/GhostOS/config.json` (created on first run).

```
~/GhostOS-brain/
  areas.yaml                       ordered areas; default: Work, Personal, Research, Random
  projects/<id>/project.yaml       manifest: name, area, description, folders[], createdAt
  projects/<id>/sidenotes.jsonl    one sidenote per line
  projects/<id>/runs.yaml          scheduled run definitions (runOn = machine id)
  projects/<id>/run-history.jsonl  append-only run records; later lines for the same id override earlier ones
  projects/<id>/brief.md           the project brief (appended to new sessions' system prompt)
  projects/<id>/brief.proposed.json  a brief update waiting for approval
  projects/<id>/sessions/<id>.json session summaries
  projects/<id>/rules.md           the project's own rules
  rules/global.md                  rules for all projects
  rules/areas/<area>.md            rules for one area
  agents/global/<name>.md          agents for all projects
  agents/areas/<area>/<name>.md    agents for one area
  .gitattributes                   *.jsonl merge=union (for sync)
  settings.yaml                    budget guard thresholds, autoApplyBriefs, enforcement
  ideas.jsonl                      all ideas; projectId null = unsorted inbox
```

- A project folder entry is `{ label?, remote?, paths: { <machineId>: <absolute path> } }`. `remote` is the git origin, recorded only if the folder is the top of its own repo, so a folder inside another repo never inherits an unrelated remote. Adding a folder with a matching remote merges into the existing entry (covered by a test).
- Random (`random`) is the fallback area. Removing an area moves its projects to Random. A project pointing at a missing area is filed under Random.
- Corrupt JSONL lines are skipped rather than losing the file.
- `BrainGit` commits changes about 5 s after the last change and once more on quit. A remote is added only when the user connects one (Phase 3 sync).

Machine-local (not in the brain), under `~/Library/Application Support/GhostOS/`: `config.json`, `machine.json`, `inbox/`, `claude-session-settings.json`.

## Testing

- `npm test` runs vitest over `tests/`: store (areas, projects, per-machine folders, YAML output, ideas, sidenotes, corrupt lines), sidenotes (hook selection and output shapes, inbox round trip, withdraw, settings file, service), claude (event mapping, transcript encoding/titles/history, clean environment).
- `npm run smoke` (`tests/e2e/smoke.ts`) drives the real CLI on Haiku and checks: first turn streams text and tool calls; a "now" sidenote reaches Claude mid-turn; the hook records the delivery; usage arrives from the stream; the same process keeps context across turns; the terminal view starts Claude Code's interface; returning to chat replays history; chat resumes the session after the terminal view; `/exit` in the terminal returns to chat with fresh history; chat works again after that.

Design rationale for launching the CLI rather than using the Agent SDK: `docs/adr/0001-claude-code-cli-as-engine.md`.

## Scheduled runs and memory (Phase 2)

```
app (every 60 s) ─┐                         ┌─> skip  (weekly usage ≥ pause threshold) -> record "skipped"
                  ├─> tick(): lock -> due? ─┼─> defer (5-hour usage ≥ threshold)       -> wait for reset
launchd (5 min) ──┘   (runner-state.json)   └─> run   (maybe on the cheaper model)
                                                  -> claude -p (stream-json, brief appended, own process group)
                                                  -> run-history.jsonl (+ usage.json from rate_limit_event)
                                                  -> brain git commit

chat tab closed (did work) / "Summarize" -> MemoryService queue -> claude -p --model haiku (no tools,
no persistence, JSON schema) -> sessions/<id>.json + brief.proposed.json (or brief.md when automatic)
-> next new session in the project gets the brief via --append-system-prompt
```

## Rules, enforcement and sync (Phase 3)

```
brain rules/agents/brief ─> buildSessionContext(project)  (≤ 9,500 chars: header, global, area, project rules,
                            │                              area agent list, <project-brief>)
                            ├─> GhostOS chats and runs: --append-system-prompt
                            └─> other Claude sessions (after Apply): SessionStart hook -> additionalContext

~/.claude/settings.json (after Apply) ── hooks ──> <electron> dist/hook/ghostos-hook.js <appData>
   SessionStart                 context for GhostOS project folders (skipped when GHOSTOS_SESSION=1)
   PreToolUse Bash, if *git*commit*   deny (or remind) unless a review agent/skill ran since the last commit
                                (commands are split into simple commands and words, heredocs dropped)
   Stop                         once per session: documenter reminder after 5+ edited files
   PostToolUseFailure Bash      once per session: error-log reminder where docs/error-log exists
```

- `src/hook/ghostos-hook.ts` reads `config.json` and `machine.json` from the app data folder, finds the project whose folder (on this Mac) contains `cwd` (realpath, deepest folder wins) and does nothing elsewhere. It reads at most the last 8 MB of the transcript, never throws into Claude (errors go to stderr, exit 0), and keeps one-time reminder markers in `<appData>/hook-state/`.
- GhostOS's own sessions set `GHOSTOS_SESSION=1` so they don't get the context twice (they already have it in the system prompt).
- `src/main/capabilities/install.ts` (`CapabilityInstaller`): `plan` / `apply` / `remove` / `refresh`. GhostOS hook entries end with `# GhostOS-managed hook`, carry a 10 s timeout, and exit quietly if the app was moved or deleted; they are merged next to the user's entries, whose groups are left untouched. `settings.json` is backed up to `<appData>/backups/` (last 10 kept) and written atomically through a symlink with its permissions kept; if it changes while GhostOS writes, nothing is written. Agents go to `~/.claude/agents/<name>.md` (all projects) or `<area>-<name>.md` (area, description tagged with the area). `capabilities-manifest.json` (written atomically, after every change) records the hash of each agent file GhostOS wrote: a file GhostOS didn't write is reported as a conflict and never overwritten or claimed (even when identical), and Remove deletes only files still matching what GhostOS wrote. Area agents' frontmatter is re-serialised with YAML. `refresh` re-points the hooks at start and after each sync; agent files follow only edits made in GhostOS, while agents arriving by sync wait for Update.
- `src/main/brain/sync.ts` (`BrainSync`), under `BrainGit.exclusive` so no commit lands mid-sync: commit everything → `fetch` → local `rebase origin/main` (only when behind; no autostash) → `push HEAD:main`. A failed rebase is aborted and reported; a brain with unrelated history is refused with an explanation; `BrainGit` never commits unmerged files or while a rebase is in progress (also from the background runner) and aborts a rebase left by a crash at start. Quitting waits up to 20 s for a sync in progress. Ideas and sidenotes carry `updatedAt`, and reading keeps the newest copy of an id, so a union merge never shows an item twice. Runs at start, 20 s after each brain commit, and every 5 minutes, but only once a remote exists. `createGithubRepo` calls `gh repo create --private` and runs only from the Settings button.
- `src/main/brain/locate.ts`: `suggestFolders` searches home, Desktop, Documents, Developer and similar folders and iCloud Drive (depth 3, skipping `node_modules`, `Library` and hidden folders) for each folder the project has on another Mac, matching git repos by normalised remote and others by name. Linking stores the path under this Mac's id.
- Moving a run to this Mac sets `runOn` and approves it here (the per-Mac approval from Phase 2).
- Tests: `tests/phase3.test.ts` (context layering and cap, every hook event, the commit-command pattern, installer merge/backup/conflict/remove, area agent labels, remote normalisation, folder suggestions, two brains syncing through a bare remote with union merge). `npm run smoke:phase3` runs the real CLI with the installer's hook entries in a temporary settings file.

## Ghost (supervisor)

- `src/main/ghost/loops.ts` (pure): open loops per project from summaries (`openThreads`, last 60 days), git state, run history and sidenotes; applies `GhostDecision`s (newest per loop id wins) and marks projects stalled after `stallDays` without activity. Loop ids are stable hashes, so decisions stick across scans.
- `src/main/ghost/git-state.ts`: read-only git per repository (status, upstream ahead count, last commit, branches not merged into the default branch). No fetch.
- `src/main/ghost/service.ts` (`GhostService`, Electron-free): scans every 30 min (first after 90 s), queues summaries for quiet external sessions through `MemoryService` (`manual: false`), notifies stalled projects (per-Mac state in app data `ghost.json`), writes `ghost-loops.json` for session context, runs the daily digest with `runIsolatedClaude` (no tools, no MCP, no settings, no persistence).
- `src/main/ghost-wiring.ts`: IPC (`ghost:*`), Electron `Notification` (click → focus window, `ev:ghost-open`), settings validation.
- The summarizer schema has `resolvedThreads`: the prompt lists tracked threads by number; numbers map back to loop ids and become `done` decisions (`by: "summary"`). A session can't close its own threads.
- Brain: `ghost/decisions.jsonl` (append-only, union merge). App data: `ghost.json`, `ghost-loops.json`.

## Project home, chat folders, design systems, viewers (Phase 5)

- `src/main/workspace-wiring.ts`: IPC for chat folders (`organize:*`), `session:trash` (`shell.trashItem` on the transcript found by `locateSession` in the project's folders; refused while the session is open), design systems (`design:*`) and `output:open`.
- Brain: `projects/<id>/organize.jsonl` (append-only records `folder:<id>`, `place:<session>`, `hide:<session>`; newest per id wins, union-merged between Macs); `design-systems/<id>/design-system.yaml`, `DESIGN.md`, `assets/`. Design sources are `{projectId, folderLabel, relPath}` and resolve per Mac (`design/design.ts` `resolveSource`, never outside the folder).
- `design/design.ts` `designContext` adds a section per applicable design system to `buildSessionContext` (guide path, assets, resolved sources, first 1,200 characters of the guide). `design/draft.ts` runs `runIsolatedClaude` with `tools: Read, Glob, Grep`, path-scoped allow rules (`Read(//folder/**)`) for the linked folders and assets, deny rules for secrets, and `--add-dir`; the draft goes back to the dialog for review.
- Tool-use events carry `filePath` (Write, Edit, MultiEdit, NotebookEdit; `claude/events.ts` `toolFilePath`), live and from history. `SessionManager` remembers each open session's written files; `output:open` allows a file inside the project's folders or written by that session.
- `viewer/window.ts`: one `BrowserWindow` per file, `sandbox`, no preload, partition `viewer` (permissions refused, downloads cancelled, `file:` only from the shown file's folder, network only GETs to a CDN list), navigation blocked (http links open in the browser). Unknown kinds open in their app only for document and media types; otherwise Finder. Images, PDF and HTML load the file; markdown (`viewer/markdown.ts`, escape-first) and text render to a page in app data `viewer/` with CSP `default-src 'none'`.
