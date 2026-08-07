<div align="center">

<img src="copilot.png" width="96" height="96" alt="whim" />

# whim

**Capture ideas, launch agents, and get things done — straight from your system tray.**

[![License: MIT](https://img.shields.io/github/license/patniko/whim?color=7c66dc)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/patniko/whim?color=7c66dc)](https://github.com/patniko/whim/releases)
![Platforms](https://img.shields.io/badge/platforms-macOS%20·%20Windows-7c66dc)
![Built with Electron](https://img.shields.io/badge/built%20with-Electron-7c66dc)

[Quick start](#getting-started) · [User guide](./docs/user-guide.md) · [Canvas reports](./docs/canvas-artifacts.md) · [Interactive walkthrough](./walkthrough) · [Architecture](./docs/architecture.md)

</div>

---

A powerful Electron system-tray app for capturing intents — ideas, tasks, and goals — with voice input, AI-powered refinement, a rich markdown canvas, and an integrated AI agent system that can work locally or in the cloud.

## ✨ Highlights

|   |   |
|---|---|
| 🎯 **Instant capture** | A global hotkey summons whim anywhere. Type or speak — voice transcribes locally and AI refines it in the background. |
| 📝 **Rich canvas** | Every intent gets a full markdown editor, auto-saved and versioned with git. |
| 🤖 **AI agents** | Select text and `@mention` a persona to put a local or cloud agent to work — with live status and approvals. |
| 📱 **Remote access** | Optional, token-gated mobile web UI served over your LAN or Tailscale. |

## See it in action

The fastest way to get a feel for whim is the **[interactive walkthrough](./walkthrough)** — a
clickable, simulated tour of capture, agents, skills, and scheduling that runs in your browser (no
install required):

```bash
cd walkthrough && npm install && npm start   # → http://localhost:4321
```

## Overview

whim lives in your system tray and pops up with `Ctrl+Shift+Space`. Type or speak what you need to do, press Enter, and it's captured instantly. In the background, an LLM refines your raw input — cleaning up the description and extracting structured fields like client names and due dates.

Each intent has a **canvas** — a full markdown editor (powered by [Milkdown](https://milkdown.dev), built on ProseMirror + remark) where you can flesh out notes, paste files, and deploy AI agents to work on specific sections of your document.

Agents can run **locally** via the Copilot SDK, or in the **cloud** via GitHub's Copilot Coding Agent (CCA) infrastructure. Create personas like `@cca` to route work to the cloud, or `@reviewer` to run tasks locally — all from the same interface.

## Key Features

### 🎯 Intent Capture
- **Global hotkey** (`Ctrl+Shift+Space`) summons a floating window; press Enter to save
- **Voice input** — press Spacebar when the input is empty to start recording; press again to stop. Transcription runs locally via Whisper (no cloud dependency)
- **AI refinement** — every captured intent is sent to GitHub Copilot's LLM in the background. The refined text animates in with a letter-glow effect
- **Smart classification** — input is classified as intent vs. query; queries are answered inline

### 📝 Canvas Editor
- Click any intent to open its **markdown canvas** — a rich editor with headings, lists, code blocks, images, and more
- **File attachments** — paste or drag-drop files, images, and documents
- **Version history** — all canvas changes are auto-committed to git; browse and restore previous versions
- **Canvas popout** — when pinned, canvases open in separate windows for multi-tasking
- **AI title generation** — click ✨ to generate a title from canvas content

### ⚡ AI Agent System
- **Local agents** — highlight text in the canvas, @mention a persona, and an agent works on it using the Copilot SDK
- **Cloud agents** — personas configured with "Cloud" run location trigger GitHub's Copilot Coding Agent (CCA) to work on your repo in the cloud
- **Agent personas** — define custom personas with instructions, model preferences, and local/cloud execution
- **Live status** — see agent progress with real-time step indicators, tool execution tracking, and approval workflows
- **Sub-agent tracking** — agents that spawn sub-agents are tracked independently
- **In-app chat** — click any agent to open a full chat view for interactive conversation
- **MCP integration** — configure Model Context Protocol servers to extend agent capabilities

### 🗂 Spaces & Workers
- **Spaces tab** — your active intents with agent status indicators (shimmer animation when agents are working, attention badges when paused)
- **Workers tab** — all agents across all intents, with real-time status, step tracking, and approval controls
- **Mini-agent cards** — each intent card shows its running agents; click one to open its chat directly
- **Delete sessions** — remove completed or failed agent sessions
- **Open canvas** — jump from a worker back to its source canvas

### 📱 Remote Web Access
- **Mobile web UI** — optionally serve a lightweight phone-friendly site from the running desktop app
- **LAN / Tailscale access** — bind to selected network interfaces, with Tailscale addresses labeled in Settings
- **Token gated** — every `/api/*` request and WebSocket event stream requires the shared token
- **Real-time workers** — chat events, worker status, approvals, sandbox blocks, and space updates stream over WebSocket

### 🎨 UI/UX
- **Light/dark themes** with translucent, blurred backgrounds
- **Workspace profiles** — split work and personal repos; click the whim logo at the bottom of the panel (or press `Ctrl/Cmd+Shift+P`) to switch, with a per-profile color tint so you always know which mode you're in
- **Edge snapping** — drag the window to any screen edge; it snaps to position
- **Pin mode** — pin the window to prevent auto-hide; enables free positioning and resizing
- **Keyboard-first** — arrow keys navigate intents, Enter opens canvas, Escape goes back, Tab switches tabs
- **Focus management** — hotkey always returns to Spaces tab with cursor in capture field

### 🔧 Settings
- **AI model selection** — choose from available Copilot models
- **Workspace directory** — select where intent data is stored
- **Profiles** — keep separate repos (e.g. work and personal); each has an optional name (defaults to the git repo name) and a tap-to-generate color tint; switch via the logo or the `Switch Profile` hotkey
- **Copilot runtime** — uses a **bundled** Copilot CLI by default; optionally auto-detect a local CLI, set a custom path, or connect to a remote CLI server, with a **Test connection** check
- **Agent personas** — define @mentionable personas with custom instructions and local/cloud execution
- **MCP servers** — auto-discovered from `~/.copilot/` + user-added custom servers
- **CLI tools** — define CLI tools available in the environment so agents know when to use them
- **Remote web access** — enable the mobile site, choose port/interfaces, rotate the token, and scan a QR code

### 📊 Additional Features
- **Smart recurrence** — dated intents are re-evaluated on completion; recurring tasks auto-spawn
- **Recall** — new intents are matched against past intents for semantic similarity hints
- **Past view** — browse completed intents with activity timelines
- **Timeline** — event activity log across all intents

## Architecture

```
src/
├── main/                      # Electron main process
│   ├── main.ts                # App lifecycle, tray, window, hotkeys
│   ├── database.ts            # SQLite (intents, agents, events)
│   ├── ai.ts                  # Copilot SDK client (parse, recurrence, recall)
│   ├── agent-service.ts       # Local agent lifecycle management
│   ├── cloud-agent.ts         # Cloud agent API (Copilot CCA)
│   ├── cloud-agent-poller.ts  # Cloud job status polling
│   ├── subagent-service.ts    # Sub-agent state tracking
│   ├── ipc.ts                 # IPC handlers bridging renderer ↔ main
│   ├── workspace.ts           # Workspace folders, canvas I/O, git auto-commit
│   ├── eventlog.ts            # Append-only event log (.whim/events.jsonl)
│   ├── session.ts             # Copilot CLI discovery, terminal launch
│   ├── voice.ts               # Local Whisper model (speech-to-text)
│   ├── config.ts              # User config (theme, model, personas, profiles)
│   ├── mcp.ts                 # MCP server discovery & management
│   ├── web/                   # Optional LAN/Tailscale web server + RPC gateway
│   ├── migration.ts           # Database migrations
│   └── preload.ts             # Context bridge exposing intentAPI
├── renderer/                  # Electron renderer process
│   ├── index.html             # App shell (main, settings, canvas, chat views)
│   ├── styles.css             # Light/dark theme styles
│   ├── app.ts                 # UI logic, filters, navigation
│   ├── canvas/                # React island for markdown editor
│   │   ├── MarkdownCanvas.tsx # Milkdown wrapper with agents, attachments
│   │   ├── editor/            # Milkdown editor + ProseMirror plugins
│   │   └── mount.tsx          # React root lifecycle
│   └── chat/                  # React chat UI for agent conversations
│       ├── ChatView.tsx       # Main chat interface
│       ├── PromptBar.tsx      # Message input bar
│       ├── MessageList.tsx    # Message history
│       └── tiles/             # Message type renderers
├── web/                       # Mobile-first remote web client
│   ├── index.tsx              # React app for capture/spaces/workers/chat/deploy
│   └── lib/client.ts          # Token-authenticated HTTP + WebSocket transport
├── shared/
│   └── types.ts               # Shared TypeScript types
└── assets/
    └── tray-icon.png          # System tray icon
```

See [docs/architecture.md](./docs/architecture.md) for detailed component descriptions, [docs/user-guide.md](./docs/user-guide.md) for usage instructions, and [docs/canvas-artifacts.md](./docs/canvas-artifacts.md) for scheduled skills that publish visual reports.

## Getting Started

### Prerequisites

- Node.js 20+
- A GitHub account with Copilot access
- For cloud agents: `gh` CLI authenticated (`gh auth login`)

> The GitHub Copilot CLI is **bundled** with the app — no separate install is
> required. To use a self-updating CLI with terminal-resumable sessions,
> optionally install it locally (`npm install -g @github/copilot`, Homebrew, or
> `curl -fsSL https://gh.io/copilot-install | bash`) and select **Auto-detect**
> or **Custom path** in Settings → Copilot Runtime. You can also connect to a
> remote runtime via **Remote CLI server**.

### Install & Run

```bash
npm install
npm run start
```

The app will build, launch, and appear in your system tray. Press `Ctrl+Shift+Space` to open.

### Development

```bash
npm run dev    # Builds then launches with tsc watch + esbuild watch + Electron
npm test       # Run all tests (vitest)
npm run lint   # Lint with oxlint
```

## Quick Reference

| Action | How |
|---|---|
| Open window | `Ctrl+Shift+Space` or click tray icon |
| Type an intent | Just start typing |
| Voice input | Press `Space` when input is empty → speak → press `Space` to stop |
| Save | Press `Enter` |
| Search intents | Press `Shift+Tab` to toggle search mode |
| Switch profile | Click the whim logo (bottom of panel) or `Ctrl/Cmd+Shift+P` |
| Open canvas | Click an intent or press `Enter` on selected |
| Expand canvas | `Cmd+Enter` from the intent list |
| Save canvas | `Cmd+S` in the editor |
| Deploy agent | Select text → @mention a persona in a comment → agent starts |
| Refresh title | Hover intent → click ✨ |
| View workers | Click the "Workers" filter tab |
| Open chat | Click any agent card |
| Toggle done | Click the circle next to an intent |
| Delete intent | Hover → click ✕ |
| Settings | Click ⚙ in the header |
| Enable mobile web | Settings → Remote Web Access → Serve mobile web UI |
| Dismiss window | `Escape` or click outside |

### Workspace Structure

whim stores data in a user-selected workspace directory:

```
<workspace>/
├── .whim/
│   ├── events.jsonl       # Append-only event log (source of truth)
│   └── intents.db         # SQLite cache (rebuilt from event log)
├── <intent-slug-a1b2>/
│   ├── canvas.md          # Markdown canvas content
│   └── attachments/       # Pasted/dropped files
└── .gitignore
```

All workspace changes are auto-committed to git with `whim: auto-save` messages.

## Testing

```bash
npm test              # Run the full suite (1,300+ tests)
npm run test:watch    # Watch mode
```

Tests cover: database operations, validators, config, MCP servers, agent service, workspace, event log, session management, cloud agent parsing, the canvas editor, and integration tests.

## License

[MIT](./LICENSE) © Patrick Nikoletich
