# GhostOS

A local-first Mac app that is one home for all your projects and the Claude Code sessions working on them. It is organized around what needs your attention: one Board of everything waiting on you across projects, each session shown as a work log, and a library of projects with their chats, scheduled runs and memory.

GhostOS runs the real [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI under your own login. There is no GhostOS server and no telemetry; nothing leaves your Mac except what Claude Code itself sends.

> GhostOS is an independent project. It is not made by or affiliated with Anthropic.

Status: 0.4.0, macOS only, run from source (not packaged as a `.app` yet).

## The three places

- **Board** (⌘1). A ranked queue across all projects. *Needs action*: Claude asked you a question in an open session, a scheduled run failed or finished, a project brief update waits for your approval. *Unfinished*: open threads from earlier sessions, uncommitted or unpushed work, unmerged branches, notes saved for later. Act on each item in place (reply to Claude, rerun or ask Claude to fix a run, approve a brief from its diff, pick a thread back up). Keys: `j`/`k` move, `↵` open, `e` done, `s` snooze.
- **Sessions** (⌘2). One Claude Code session as a work log: a "Where this stands" card (summary, files changed, git state, what's open), tool steps folded into one line, and notes you pin to a message and send when you choose. A context drawer (⌘.) shows the project's brief, to-dos, runs, folders and model. Any session can switch to Claude Code's own terminal UI.
- **Projects** (⌘3). Projects grouped in areas, each with a brief, chats (in folders you make), scheduled runs, memory and ideas.

Across all three: **⌘K** goes anywhere, runs a command, or starts a session from a sentence you type; the **Scope** pill narrows Board and ⌘K to one project; the **Running** strip shows every live session and your 5-hour and weekly usage.

## What else it does

- **Scheduled runs.** Recurring Claude jobs per project (daily, chosen days, every N minutes, cron, or once), run headless with `claude -p` in the project folder. An optional launchd agent runs them while the app is closed.
- **Budget guard.** Above thresholds you set, scheduled runs switch to a cheaper model, wait for the 5-hour window, or are skipped. Runs you start yourself are never blocked.
- **Project memory.** A living brief per project, given to every new session there. Finished sessions are summarized (on Haiku) and Claude proposes brief updates for you to approve.
- **Ghost.** Watches every project for unfinished work and marks a project stalled after a few quiet days, with an optional macOS notification and daily digest.
- **Rules in layers.** Rules for all projects, for each area and for each project, plus agents, given to every session. "Apply to Claude" adds GhostOS's hook to `~/.claude/settings.json` (backed up first) so the same rules, briefs and checks work in VS Code and the terminal too; Remove takes out only what GhostOS added.
- **Design systems.** A brand guide, logo files and source files per brand, linked to areas or projects, so sessions there follow them.
- **Search** (⌘F) across transcripts, notes, ideas, briefs, summaries and run results. **Ideas** (⌘I) captured from anywhere.
- **Import from Claude.** Copies Claude Code's auto-memory notes and Claude desktop scheduled tasks into GhostOS (nothing in `~/.claude` changes).
- **Sync between Macs.** The brain is a git repo; connect a private remote and it syncs every few minutes.

## Run it

Requirements: macOS, Node.js 22 or later, and the `claude` CLI installed and logged in (GhostOS looks in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, then `PATH`).

```bash
git clone https://github.com/horigyns/ghostos.git
cd ghostos
npm install            # also rebuilds node-pty for Electron
npm start              # builds, then launches the app
```

On first launch GhostOS creates its brain at `~/GhostOS-brain` with four areas (Work, Personal, Research, Random). Add a project with **+** next to an area in Projects, then give it a folder (⋯ → Folders…).

Development:

```bash
npm test               # unit tests (vitest)
npm run typecheck
npm run smoke          # end-to-end against the real CLI; uses a little of your subscription (Haiku)
```

`GHOSTOS_USER_DATA=<dir> npm start` runs a separate instance with its own app data. `GHOSTOS_CAPTURE=/path/shot.png npm start` screenshots the window and quits.

## Where data lives

| What | Where |
|------|-------|
| Brain: areas, projects, notes, ideas, runs and their history, briefs, summaries, rules, agents, settings | `~/GhostOS-brain` (plain YAML, JSONL and markdown, auto-committed to git) |
| Brain location, machine id, usage cache, runner state | `~/Library/Application Support/GhostOS/` |
| Background runner (when enabled) | `~/Library/LaunchAgents/com.ghostos.runner.plist` |
| Claude transcripts and memory (read only) | `~/.claude/projects` |
| GhostOS hook and agents (only after Apply) | `~/.claude/settings.json`, `~/.claude/agents/` |

## Privacy and safety

- GhostOS launches the unmodified Claude Code CLI. It strips API keys and parent-session variables from the environment so the CLI uses your own login. Why it's built this way: [`docs/adr/0001-claude-code-cli-as-engine.md`](docs/adr/0001-claude-code-cli-as-engine.md).
- Scheduled runs execute prompts stored in your brain, unattended, with the permission mode you choose. A run only executes on the Mac where it was saved or approved. Keep a synced brain repo private.
- Briefs are written from session transcripts, so review proposed updates before approving them (proposals are the default).

## Known limits

- macOS only; run from source.
- Chat replies render as text with code blocks, not full markdown.
- A running session keeps its model; picking another model starts a new session.
- No system-wide hotkey; ⌘K and ⌘I work inside the app.
- Sync conflicts on files both Macs edited stop the sync until you resolve them in `~/GhostOS-brain`.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): module map, data flow, brain layout
- [`docs/CHANGELOG.md`](docs/CHANGELOG.md)
- [`docs/adr/`](docs/adr/): decision records

## License

[MIT](LICENSE)
