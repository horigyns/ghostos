# ADR: Use the unmodified Claude Code CLI as the engine
Date: 2026-11-13
Status: Accepted (one open question, below)

## Context
GhostOS needs to run Claude sessions on my existing Claude subscription. Two ways to do that:

1. Build on the Agent SDK and sign in with claude.ai. Anthropic's Agent SDK docs say third-party developers may not offer claude.ai login in their products.
2. Launch the Claude Code CLI itself. Anthropic's Claude Code legal page says the policy "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription" and expects "ordinary, individual usage".

The alternative of paying API prices was compared: roughly $108/week at last week's usage.

## Decision
GhostOS launches the unmodified `claude` binary, logged in as me, and never uses the Agent SDK with claude.ai login.

- Chat: `claude -p --input-format stream-json --output-format stream-json --verbose`, one process per conversation (`src/main/sessions/chat.ts`).
- Terminal: node-pty running interactive `claude` (`src/main/sessions/terminal.ts`).
- `cleanEnv()` (`src/main/claude/env.ts`) removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ELECTRON_RUN_AS_NODE` and the `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PID*`, `CLAUDE_EFFORT*`, `CLAUDE_PREVIEW_*` variables, so the CLI uses my own login and not a parent session's.
- New sessions get their id from GhostOS via `--session-id`, so sidenotes can target a session before its first message. Past sessions use `--resume`.

## Rationale
This keeps GhostOS on the side of the policy that explicitly allows individual use of the real binary with my own subscription. API pricing is about $108/week at current usage, which is why the subscription route matters. The CLI also gives hooks, permissions, transcripts and resume for free.

## Consequences
- GhostOS depends on Claude Code's stream-json format and hook events (PostToolBatch, Stop, UserPromptSubmit). Format changes can break the chat view; the smoke test is the check.
- Sidenote delivery is wired in only through `--settings` on GhostOS-launched sessions, so my other Claude sessions are unaffected.
- Open question, not yet confirmed with Anthropic: whether a custom chat UI over stream-json is acceptable for personal use. If the answer is no, the terminal view becomes the main view and the chat window is dropped or demoted. The terminal path is already implemented, which is why it was built as a first-class view.
- Stopping a turn kills the process; the next message resumes the session.
