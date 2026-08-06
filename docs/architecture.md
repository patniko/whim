# Architecture

whim is an Electron app with a clear separation between the main process (Node.js) and the renderer process (Chromium). The renderer uses a hybrid approach: vanilla DOM for most views, with React islands for the Milkdown markdown editor and the agent chat interface.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          WHIM (Electron App)                        │
├────────────────────────────┬────────────────────────────────────────┤
│     Main Process (Node)    │        Renderer Process (Chromium)     │
│                            │                                        │
│  ai.ts — Copilot SDK       │  app.ts — UI logic, navigation        │
│  agent-service.ts — Local  │  canvas/ — Milkdown markdown editor   │
│  cloud-agent.ts — CCA API  │  chat/ — Agent chat interface         │
│  database.ts — SQLite      │  styles.css — Light/dark themes       │
│  workspace.ts — File I/O   │                                        │
│  ipc.ts ◄──────────────────┼──► preload.ts (context bridge)        │
│  config.ts, mcp.ts,        │                                        │
│  voice.ts, session.ts      │                                        │
│  web/ — Remote web server  │  src/web — Mobile remote UI            │
├────────────────────────────┴────────────────────────────────────────┤
│  External: Copilot SDK (local) │ Copilot CCA (cloud) │ MCP Servers │
└─────────────────────────────────────────────────────────────────────┘
```

## Main Process (`src/main/`)

### main.ts — App Lifecycle

- Creates a frameless, transparent, always-on-top `BrowserWindow` (420×520 default)
- Supports **window expand/collapse** — canvas opens expand to 720×700 centered; closing collapses back
- Registers a system tray icon with context menu (Show / Quit)
- Binds `Ctrl+Shift+Space` as a global shortcut to toggle the window
- Registers a custom `copilot-whim://` protocol for a real origin (microphone + image loading)
- **Blur-hide logic**: auto-hides on focus loss unless canvas is open, input has content, or window is pinned
- **Edge snapping**: detects nearest screen edge after drag, snaps to position
- **Pin mode**: disables auto-hide, enables resizing, opens canvases in popout windows
- **Canvas popout windows**: separate `BrowserWindow` for multi-monitor canvas editing
- **Stable settings path**: `app-paths.ts` is imported *first* (before any module resolves `app.getPath('userData')` at load time) and pins `userData` to `<appData>/whim`. This makes the settings location independent of `productName`, so `config.json` persists across dev and packaged builds and past renames. Legacy installs that used a different `productName` (e.g. `Copilot Whim`) leave an orphaned config behind; it is **not** auto-migrated — copy it manually if needed: `cp "<appData>/Copilot Whim/config.json" "<appData>/whim/config.json"`.

### Settings storage — `config.json`

All app settings (theme, model, Copilot runtime source (bundled/auto/path/server) + optional CLI path and remote server URL/token, workspace **profiles**, MCP servers, CLI tools, sandbox policy, web-remote, hotkeys, and **agent personas** including the per-persona `yolo` flag) are persisted as a single JSON file at `app.getPath('userData')/config.json` via `config.ts` (`loadConfig` / `saveConfig`). Because `userData` is pinned (see above), this resolves to `<appData>/whim/config.json` on every build.

### database.ts — Storage

Uses `better-sqlite3` for synchronous SQLite. Key tables:

| Table | Purpose |
|---|---|
| `intents` | Captured intents with description, client, due dates, folder, attachments, status |
| `agent_sessions` | Central agent registry (SDK, CLI, cloud) with status, prompt, source |
| `canvas_agents` | Legacy agent records for backward compatibility |
| `intent_events` | Cached event log entries for timeline |

### ai.ts — Copilot SDK Client

Three specialized sessions: **Parse** (extract title/client/dates), **Recurrence** (evaluate repeat tasks), **Recall** (find similar past intents). All share the user's selected model.

**Runtime resolution.** `resolveRuntimeConnection()` chooses how the SDK connects, based on `config.cliSource`:
- `bundled` *(default)* → spawn the CLI shipped with the app via `resolveBundledCliPath()` (`@github/copilot`, pinned in `package.json` and `asarUnpack`-ed so its native `prebuilds/` run from `app.asar.unpacked`). Spawned through Electron-as-Node (`ELECTRON_RUN_AS_NODE=1`).
- `auto` → newest local CLI from `session.ts` detection (prefers the self-updated bundle under `~/.copilot/pkg/<platform>-<arch>/` or the OS cache dirs).
- `path` → an explicit user-configured CLI path/command.
- `server` → `RuntimeConnection.forUri(url, { connectionToken })` to an already-running runtime.

Any source that can't be satisfied falls back to the bundled CLI. `getRuntimeStatus()` reports the effective source/version/compatibility; `testRuntimeConnection()` spins up a throwaway client and runs a real handshake (bounded by a timeout) for the Settings "Test connection" button.

**session.ts — CLI discovery.** `findLatestSelfUpdatedCli()` scans every self-update cache cross-platform and picks the newest fully-extracted bundle (built on `findSelfUpdatedClis()`, which returns them all, newest first); `autoDetectCopilotCli()` adds well-known install paths (`~/.local/bin`, Homebrew, npm-global), PATH augmentation for GUI launches, a login-shell fallback for version-manager installs, and newest-by-probed-version selection. `discoverCopilotClis()` enumerates *every* install found across all of those sources with its probed version, origin label and compatibility — it backs the CLI pickers in onboarding and Settings so the user can override a bad auto-pick. `MIN_CLI_VERSION` gates compatibility.

### agent-service.ts — Local Agent Lifecycle

- `launchAgent()` / `launchCommentAgent()` / `launchQuickAgent()` — create SDK sessions with workspace, instructions, and canvas attachment
- Event streaming → renderer via IPC. Approval workflow with approve/deny.
- `sendChatMessage()` for multi-turn agent chat
- `listAllAgents()` merges in-memory live state with DB-persisted sessions
- Sub-agent tracking via `SubagentTracker`

### cloud-agent.ts — Cloud Agent API

- `parseGitRemote()` — extracts owner/repo from HTTPS/SSH git URLs
- `launchCloudAgent()` — POST `/agents/swe/v1/jobs/{owner}/{repo}` to Copilot CCA
- `getCloudJobStatus()` — poll job status, returns PR details on completion

### cloud-agent-poller.ts — Cloud Job Polling

Polls every 10s, maps cloud statuses to agent lifecycle, updates DB, emits events, auto-stops on terminal status.

### web/ — Remote Web Access

The optional remote web server is disabled by default and lives entirely in the Electron main process:

- `server.ts` starts/stops Node `http` servers on the selected bind addresses and serves `dist/web/`
- `auth.ts` enforces a shared token on every `/api/*` request and WebSocket handshake using constant-time comparison plus bad-attempt lockout
- `gateway.ts` exposes only an explicit v1 allowlist: capture, browse spaces, list/chat/approve workers, deploy agents, personas, and models
- `event-hub.ts` mirrors allowlisted renderer events into a WebSocket stream, including dynamic `chat:event:<agentId>` channels

The desktop settings panel controls enablement, port, bind addresses, token rotation, and QR onboarding. Plain HTTP is acceptable over Tailscale's encrypted tunnel; raw LAN use should be limited to trusted networks.

### workspace.ts — Workspace & Persistence

Event-sourced via append-only `.whim/events.jsonl`. SQLite is a disposable cache. Auto-commits to git. Attachment handling with 25MB limit.

### mcp.ts — MCP Server Discovery

Auto-discovers from `~/.copilot/mcp-config.json` and installed plugins. Merges with user-defined custom servers.

### voice.ts — Local Whisper STT

Runs `whisper-tiny.en` locally via `@huggingface/transformers`. Pre-loaded on startup.

## Renderer Process (`src/renderer/`)

### app.ts — Main UI (3200+ lines)

- **Spaces tab**: intent cards with agent mini-cards, shimmer animation on active titles, ✨ refresh button
- **Workers tab**: all agents with live step tracking, approval controls, delete/canvas buttons
- **Past tab**: completed intents with activity timelines
- Canvas mounting, agent chat, keyboard navigation, window lifecycle

### canvas/MarkdownCanvas.tsx — Markdown Editor

Milkdown (ProseMirror + remark) wrapper: auto-save, file attachments, @mention agent deployment, agent presence indicators, and multi-line comment threads. The Milkdown integration lives under `canvas/editor/` (the editor component plus custom ProseMirror plugins for comments, mentions, presence, and decorations). Comments are stored inline in the markdown via a `:::whim-comments` block (the legacy `:::documint-comments` marker is still read and upgraded on the next save).

### canvas/ — Canvas Reports (`src/main/canvas/`)

A separate concept from the markdown canvas above: SDK-hosted canvases that let a skill run publish a self-contained HTML report into its space, served from an isolated `whim-artifact://` origin and opened from the space list, tray, or a notification. See [canvas-artifacts.md](./canvas-artifacts.md).

### chat/ — Agent Chat UI

React components: `ChatView`, `MessageList`, `PromptBar`, `SubagentDetailOverlay`, and tile renderers for assistant messages, tools, approvals, reasoning, and sub-agents.

## Data Flow

### Intent Capture → AI Refinement → Recall
### Local Agent: @mention → SDK session → event streaming → chat
### Cloud Agent: @mention → CCA API POST → poll status → PR link
