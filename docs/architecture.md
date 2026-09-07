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

All app settings (theme, model, Copilot runtime source (bundled/inprocess/auto/path/server) + optional CLI path and remote server URL/token, workspace **profiles**, MCP servers, CLI tools, sandbox policy, web-remote, hotkeys, and **agent personas** including the per-persona `yolo` flag) are persisted as a single JSON file at `app.getPath('userData')/config.json` via `config.ts` (`loadConfig` / `saveConfig`). Because `userData` is pinned (see above), this resolves to `<appData>/whim/config.json` on every build.

### database.ts — Storage

`database.ts` still uses synchronous `better-sqlite3`, but application callers
use the asynchronous `storage.ts` facade. The actual SQLite, replay and
compaction work runs in `storage-worker.ts`; returning a promise from an IPC
handler alone would not isolate this work. Worker admission is bounded by
request count and serialized argument bytes. Workspace generations reject
stale continuations. Key tables:

| Table | Purpose |
|---|---|
| `intents` | Captured intents with description, client, due dates, folder, attachments, status |
| `agent_sessions` | Central agent registry (SDK, CLI, cloud) with status, prompt, source |
| `canvas_agents` | Legacy agent records for backward compatibility |
| `intent_events` | Cached event log entries for timeline |

Local append acknowledgements are tracked separately from hashed replay
checkpoints. A checkpoint cannot replay already-applied non-idempotent local
events; mixed uncheckpointed local writes and external changes use a validating
rebuild instead. Before reopening an append segment, recovery durably quarantines
an incomplete tail in a sibling `.torn-*` file. Complete JSON lacking its final
newline is retained; incomplete JSON is removed only after its original bytes
are durable in quarantine. An oversized tail fails closed.

Git staging and local merge/application hold a storage barrier, excluding
snapshot publication and source deletion. Bounded deferred requests resume after
that barrier and recheck their original workspace generation. Network fetches do
not hold it. Skill documents, scheduled results and report linkbacks use the same
worker-owned revision comparison, file fsync, atomic rename and directory sync
as ordinary canvas saves. Report publication awaits linkback completion instead
of acknowledging a failed final write.

### Startup, lazy features, and save lifecycle

The main window, tray shell and shortcut are created without waiting for storage
recovery. The persistence worker starts concurrently with native window creation,
rather than adding the two cold-start costs sequentially.
Native target delivery waits for `window:renderer-ready`, sent after the
renderer installs its subscriptions, rather than assuming a navigation event
means the split module graph has finished evaluating.
The renderer mounts its list/capture shell without waiting for CLI discovery,
model enumeration, a full collection snapshot, voice initialization or network
requests. `storage:status` distinguishes opening, ready, failed and closing
storage; a ready store can accept capture while canvas indexing is still in
progress. Missing runtime/model configuration does not hide local capture for
an existing workspace. Runtime setup is still required to run agents.

Normal startup no longer creates hidden settings/canvas windows or initializes
speech. Windows are created on demand and can be reused after a successful
close. Microphone permission is requested when microphone access is requested,
not at normal boot.

`scripts/build-renderer.js` emits content-hashed ES modules with actual esbuild
code splitting. The desktop entry's static graph excludes the editor and chat
implementations and all settings markup/control registration. `settings/controls.ts`
mounts the extracted settings form only on demand, using a typed host interface
for shared theme, workspace, persona and hotkey state. Draft tracking and durable
flushes include lazily mounted controls. The mobile shell separately defers formatted
Markdown. The desktop-web loader installs the shared API before importing the
same renderer graph. Classic merge workers keep explicit, content-hashed URLs
under each shell; the Node merge and storage workers are separate packaged
files. The app protocol sets **response** MIME types for modules/fonts and
confines reads to the renderer or configured workspace roots.

Each shell has an asset manifest describing its initial and lazy import graphs.
Build and package verification check their dependencies and worker outputs.
The mobile service worker precaches only its initial graph, not all lazy
features or the desktop renderer. The desktop initial shell is cached after
that surface is visited. Visited lazy features are cached on demand.
Updates wait for old clients instead of forcibly replacing their service worker.
Desktop navigations retain their own cached HTML, rather than falling back to
the mobile shell. Cached HTML is bound to its build manifest, so a newer online
navigation cannot strand an older offline shell with missing modules.
Workspace/API responses are never cached. An unvisited
feature still needs connectivity; load failures keep the surrounding UI and
show a reconnect/reload message. Deployment must retain old hashed assets for
already-open clients that have not fetched those features yet, or those clients
must save and reload. The build's clean step is not a versioned deployment
asset-retention mechanism.

Quit, updater preparation and workspace changes use tokenized, per-window save
requests. Renderers lock input while flushing capture drafts, debounced settings
writes and document saves, then acknowledge only successful durable results.
Failed or missing acknowledgements cancel the operation; release messages
restore interaction on cancellation and after workspace transitions. Settings
forms with unapplied edits require explicit Save or Cancel rather than silently
changing permissions during quit. Native secondary-canvas and settings closes
also wait for the handshake. Explicit document Save drains newer revisions
behind an in-flight write. Navigation retains the current editor if save fails
or the document changes during close. Browser unload cannot await IPC; it uses
a leave-page warning for unsaved text, not a claimed durable unload save.
The mobile editor also serializes revision-aware saves. A rejected timer save
keeps the draft dirty and shows a retry error; delayed acknowledgements rebase
newer typing with the browser merge worker instead of overwriting it. Failed
saves prevent close/page navigation, and concurrent conflicts remain visible
for review rather than being silently acknowledged.

Workspace transitions suspend command admission and drain producers before
closing storage. Profile configuration changes only after old-editor flushing
and new-workspace initialization; initialization failure restores the previous
destination. Maintenance timers and notification callbacks are generation-scoped.
Updater installation is excluded from the producer set it must itself drain.
Recoverable shutdown failures restore workspace services, command admission and
document watchers, reconciling changes observed while watches were suspended.
If storage or restoration fails, commands remain blocked with an explicit
copy-drafts-and-restart error rather than resuming a partially closed workspace.

Web pairing and health responses carry an opaque workspace epoch. Both browser
transports pin subsequent API requests to it; the epoch includes a process
identity so it cannot accidentally match after restarting into another
workspace. Missing or stale epochs receive HTTP 409 before command execution,
even when both workspaces contain the same document ID. Browsers must preserve
their drafts and reload rather than automatically retrying an old write against
the new destination. Older cached browser clients must reload to obtain this
contract. Offline connection failure is distinct from expired authentication:
the cached shell offers reconnect/retry without removing device pairing.
Reconnect health checks never replace the epoch of an already-loaded page.
Workspace-change events retain browser editors and stop applying events from
the replacement workspace. The desktop-web first-handshake resync is ignored
independently of renderer-load timing, avoiding an initial reload loop.

### Performance diagnostics and reproducible fixtures

Set `WHIM_PERF=1` for bounded main-process numeric aggregates (printed after
shutdown storage draining). Add `?perf=1` (or `&perf=1`) to a renderer URL for
`window.__whimPerformance()` and long-task observation in DevTools. These
record named durations/counts/failures, never document text, workspace paths,
agent IDs, tokens, or error payloads. Storage round trips, execution time, Git
queue/network/reconciliation, merges, capture/document acknowledgement and
renderer refresh spans measure different scopes and must not be added together
as independent work. Renderer startup spans begin at entry evaluation, not at
Electron's `app.ready` event.

Existing Vitest fixtures in `storage-worker.test.ts` reopen a synthetic
1000-space workspace and exercise approximately 100 KB fsynced document saves.
`shared/performance.test.ts` checks exact sparse-merge output at 1000, 4000 and
10000 lines while reporting timings. `chat/transcript-layout.test.ts` reports
100000-row geometry/viewport costs; it does not measure Markdown rendering.
These fixtures use disposable directories and the existing test runner.
The tray/capture application p95 goals and a universal 50 ms main-thread limit
are not established by these isolated measurements.

Unmirrored SDK/CLI and ephemeral conversations use the SDK's cursor-based
`eventLog.read`, never an initial full `getEvents` response. Batches of at most
32 events are normalized in the storage worker before the next batch is
requested; tool/request completions update earlier rows across page boundaries.
Normal-session projections use SQLite-owned temporary databases with bounded
page caches, removed on close. Ephemeral projections remain exclusively in
memory, so their retained data still grows with the conversation by design.
There are at most eight cached runtime projections. RPC failures preserve the
last acknowledged cursor for retry; incompatible older runtimes produce an
explicit upgrade error, not an unbounded fallback. Runtime projection ordinals
never suppress live events in the unrelated durable-mirror sequence domain.
Opening unavailable history never creates a replacement session. Initial
runtime-history loading still scans the retained log in chronological batches
before returning its newest page; bounded batches do not provide history-size-
independent first-page latency. Tail-first normalization with cross-page
completion reconciliation remains necessary for that stronger guarantee.

### ai.ts — Copilot SDK Client

Three specialized sessions: **Parse** (extract title/client/dates), **Recurrence** (evaluate repeat tasks), **Recall** (find similar past intents). All share the user's selected model.

**Runtime resolution.** `resolveRuntimeConnection()` chooses how the SDK connects, based on `config.cliSource`:
- `bundled` *(default)* → spawn `copilot-runtime` (`copilot-runtime.exe` on Windows) from the SDK 1.0.13 platform package over stdio. `getBundledSdkRuntimePaths()` selects physical files under `app.asar.unpacked` in packaged builds. No CLI shim or Electron-as-Node flag is needed.
- `inprocess` *(experimental, explicit opt-in)* → `RuntimeConnection.forInProcess()`, loading the same bundled `runtime.node` through Koffi. SDK 1.0.13 only accepts an explicit FFI library location through the host's `COPILOT_CLI_PATH`: `startRuntimeClient()` serializes FFI startups, temporarily pins that variable to the unpacked native entrypoint, and restores it after startup, including on failure. It never changes `ELECTRON_RUN_AS_NODE` globally.
- `auto` → newest local CLI from `session.ts` detection (prefers the self-updated bundle under `~/.copilot/pkg/<platform>-<arch>/` or the OS cache dirs).
- `path` → an explicit user-configured CLI path/command.
- `server` → `RuntimeConnection.forUri(url, { connectionToken })` to an already-running runtime.

Unavailable custom sources fall back to bundled stdio; missing bundled native files surface an installation error, never a silent switch to another library. Custom CLI children retain the Electron shim and child-only `ELECTRON_RUN_AS_NODE=1`; server and in-process clients receive no subprocess environment options. `getRuntimeStatus()` reads native versions from the live SDK `getStatus()` handshake because the native wrapper has no `--version` command. `testRuntimeConnection()` reuses the active client where possible.

The full `@github/copilot` package is retained for terminal sessions and CLI discovery, independent of the SDK runtime selection. Native SDK platform packages, Koffi, and its platform addon are unpacked for native loading. In-process libraries remain loaded for the lifetime of the app, so changing library builds requires restarting Whim. Primary and lazy ephemeral clients remain separate; ephemeral sessions supply `createSessionFsProvider`. Shutdown delegates cancellation and session cleanup to `client.stop()` before releasing either host.

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

Log-backed entities are authoritative in append-only rotated JSONL under
`.whim/events/`; the legacy `.whim/events.jsonl` layout is migrated. SQLite is
a derived cache, while canvas/page files remain authoritative documents in
their own right. A local log append is fsynced before applying SQLite and is
marked applied only after SQL succeeds. Worker-backed document publication
compares the expected disk revision, fsyncs a temporary file, renames it, and
synchronizes the directory before returning an acknowledgement. Conflicts and
failed writes are errors, not successful empty documents.

Applied fingerprints allow a validated hot cache or eligible incoming suffix
to be reused. Invalid/torn replay must not stamp a clean fingerprint.
Compaction publishes checksummed, immutable snapshot shards (including chat
events) before its root, then removes only covered source data and eligible
cold side content. Readers must understand this snapshot format before sharing
compacted logs. Git operations are serialized; fetch does not hold the storage
barrier, but local merge/replay/projection reconciliation does. An acknowledgement
means local persistence, not successful Git push or protection against every
external-writer/power-loss scenario. Windows directory fsync and comprehensive
producer isolation across workspace switches still need platform/integration
coverage. Attachments retain the existing 25 MB limit.

### mcp.ts — MCP Server Discovery

Auto-discovers from `~/.copilot/mcp-config.json` and installed plugins. Merges with user-defined custom servers.

### voice.ts — Local Whisper STT

Runs `whisper-tiny.en` locally via `@huggingface/transformers` in `voice-worker.ts`.
The worker, runtime and model are loaded on first transcription with shared,
retryable initialization. PCM conversion, validation and inference execute off
main; inference is serialized. Admission allows five requests and at most
32 MiB of queued PCM data. Worker failures reject pending requests and an
explicit retry creates a new worker. There is no normal-boot model warmup.
The real model still needs its cached files or a first-use download.

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
