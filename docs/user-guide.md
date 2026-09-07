# whim User Guide

This guide walks you through everything you can do with whim — from first launch to deploying cloud agents.

---

## Getting Started

### First Launch

1. Install and start the app (`npm run start`)
2. whim appears as an icon in your menu bar (macOS) or system tray (Windows/Linux)
3. The **Quick start** tour runs first, before any setup. It walks you through the two ways to
   show and hide the side pane:
   - **The global shortcut** — **Cmd+Shift+Space** on macOS, **Ctrl+Shift+Space** elsewhere.
     Press it once to slide whim away, again to bring it back. If the combo is already taken by
     another app, click it in the tour and press the keys you'd rather use — it's saved
     immediately (and you can change it later under **Settings → Hotkeys**).
   - **The tray icon** — clicking the whim icon in the menu bar / system tray always brings the
     pane back, so you can never lose the window.
4. After the tour you'll be prompted to **select a workspace directory** — this is where all your
   intent data will be stored

You can replay the tour any time from the **?** button in the header → **Replay quick start**.

### Setting Up Your Workspace

Your workspace is a regular directory (ideally a git repository) where whim stores:
- whim canvas documents as markdown files
- File attachments
- An event log and database cache

Click **⚙ Settings** → **Workspace** → **Change** to select your directory.

---

## Capturing Intents

### Typing

1. Press **Ctrl+Shift+Space** to open whim
2. Start typing your thought, task, or goal
3. Press **Enter** to capture it

whim uses AI to refine your input in the background — extracting a clean title, client names, and due dates. You'll see the refined text animate in with a subtle glow effect.

### Voice Input

1. Open whim and make sure the text field is empty
2. Press **Spacebar** to start recording (you'll see a red recording indicator)
3. Speak naturally — describe your task in full sentences
4. Press **Spacebar** again to stop recording
5. Your speech is transcribed locally using Whisper (nothing leaves your machine)
6. The transcription is then refined by AI, just like typed input

### Smart Features

- **Query detection** — if you type a question instead of a task, whim answers it inline
- **Recall** — when a new intent is similar to a past one, you'll see a hint linking them
- **Recurrence** — when you complete a recurring task (e.g., "weekly status update"), whim automatically creates the next occurrence

---

## The Spaces Tab

The **Spaces** tab is your home view. It shows all active (non-completed) intents.

### Intent Cards

Each intent card shows:
- **Title** — the AI-refined description (hover to see ✨ refresh button)
- **Client badge** — extracted client/company name
- **Due date** — with overdue highlighting
- **Agent indicators** — mini-cards showing running agents with status:
  - ⚡ Running (green, animated)
  - ⏳ Needs attention (amber, pulsing)
  - ☁️ Cloud agent (blue)
  - ✓ Completed (grey)
  - ✗ Failed (red)

### Intent Actions

- **Click** an intent → opens its canvas
- **Click ✓ circle** → toggles completion status
- **Click ✨** → regenerates the title from canvas content using AI
- **Click ▶** → launches a terminal session
- **Click ✕** → deletes the intent
- **Click a mini-agent card** → opens that agent's chat directly

### Searching

Press **Shift+Tab** to enter search mode. Type to filter intents by description. Press **Shift+Tab** again or **Escape** to exit search.

---

## The Canvas Editor

The canvas is a rich markdown editor where you flesh out your intents.

### Opening the Canvas

- **Click** any intent → opens canvas in the tray window
- **Cmd+Enter** → opens canvas in expanded mode (larger window)
- When **pinned**, canvases open in a separate popout window

### Editing

The formatting toolbar stays visible while you scroll. It includes text styles
(normal text, headings, and code blocks), bold, italic, strikethrough, inline code,
links, bulleted lists, numbered lists, checklists, block quotes, list indentation,
and undo/redo. Active formatting is highlighted; unavailable actions are disabled.
Markdown typing shortcuts still work.

Select text before applying inline formatting, or toggle it at the caret before
typing. List buttons convert the current list to the chosen type; pressing the
active list button removes the selected items from that list. Use **Tab** and
**Shift+Tab**, or the indentation buttons, to nest and unnest items. Checklist boxes
can be clicked or toggled with **Space** when focused. **Enter** continues a checklist
with an unchecked item; **Enter** on an empty item exits it.

Press **Alt+F10** to focus the toolbar. Use Tab or the arrow keys to move between
controls, and **Escape** to return to the document.

### Links and Pasting

- Select text and click the **link** button (in either toolbar), or press
  **Cmd/Ctrl+K**, to turn it into a link. With no selection, enter link text and an
  address to insert a new link at the caret.
- Place the caret in an existing link, or select it, then use **Cmd/Ctrl+K** to
  change its text/address, open it, or remove the link while keeping the text.
- Paste a single URL over selected text to link that text without replacing it.
  Paste at the caret to insert a clickable URL. Existing bold/italic formatting
  is preserved.
- **Cmd/Ctrl+Shift+V** pastes plain text without interpreting links or Markdown.
  URLs pasted into code remain literal text. Regular rich-text/Markdown pastes
  and image attachments keep their existing behavior.

The canvas also supports images, file attachments (paste or drag-drop), and
comments with threads.

### Saving

- **Auto-save** — changes are saved automatically after 2 seconds of inactivity
- **Cmd+S** — manual save
- All saves are auto-committed to git

### Version History

Click the **🕘** button in the canvas header to browse version history. You can see what changed in each commit and restore any previous version.

### Title Editing

Click the title in the canvas header to edit it. You can also click the **✨** button to auto-generate a title from the canvas content.

---

## AI Agents

whim's agent system lets AI work on your documents and code autonomously.

### Deploying a Local Agent

1. Open an intent's canvas
2. Select text you want an agent to work on
3. Create a **comment** on the selected text (use the comment button in the editor)
4. Write instructions in the comment (e.g., "Fix the bug in this function")
5. **@mention a persona** (e.g., `@coder`) to specify which agent type
6. The agent starts working immediately

The agent:
- Reads your canvas document
- Executes tools (shell commands, file edits, web searches)
- Works autonomously until complete
- May request permission for certain operations

### Deploying a Cloud Agent

Cloud agents run on GitHub's infrastructure using the Copilot Coding Agent (CCA):

1. Go to **⚙ Settings** → **Agent Personas**
2. Create a persona (e.g., `@cca`) with **Run location: ☁️ Cloud**
3. Use that persona's @mention in a canvas comment
4. The agent runs in GitHub's cloud, creates a PR with its changes

Requirements for cloud agents:
- Your workspace must be a GitHub repository with a remote configured
- The `gh` CLI must be authenticated (`gh auth login`)
- The repository must have Copilot Coding Agent enabled

### Agent Status

Agents show their status in real-time:
- **⚡ Running** — actively working (animated pulse)
- **⏳ Waiting** — needs your approval for a permission
- **✓ Completed** — finished successfully
- **✗ Failed** — encountered an error

### Agent Chat

Click any agent (in Spaces mini-cards or Workers tab) to open the **chat view**:
- See the full conversation history
- Send follow-up messages
- View tool executions with details
- Approve or deny permission requests
- See sub-agent activity

### Approval Workflow

When an agent needs permission (e.g., to run a shell command), you'll see:
- An **amber badge** on the intent card ("⏳ needs attention")
- An **approval bar** in the Workers tab with Approve/Deny buttons
- A **notification** (OS-level) that you can click to jump to the agent

---

## The Workers Tab

The **Workers** tab shows all agents across all intents.

### Agent Cards

Each agent card shows:
- **Source icon** — ⚡ (local SDK), ☁️ (cloud), or 🖥 (CLI)
- **Intent name** — which intent the agent belongs to
- **Task description** — what the agent is working on
- **Live steps** — real-time tool execution progress
- **Summary** — completion summary or error message

### Worker Actions

- **Click a card** → opens the agent chat view
- **📄 button** (on hover) → opens the source canvas for the agent's intent
- **✕ button** (on hover) → deletes the agent session
- **Approve/Deny buttons** → respond to permission requests

---

## Scheduled Skills and Reports

A skill can run on a schedule and publish a **report** — a visual summary you open with one click from the space row, the tray, or the notification it fires when it finds something.

Repeat runs refresh the same space by default, so a daily skill leaves one space to complete rather than a hundred. Complete the space when you are done with it; the next run reopens it.

See [Canvas reports](./canvas-artifacts.md) for enabling reports on a skill, shipping a report layout with it, and the security model.

---

## Remote Web Access

Remote Web Access serves a lightweight mobile site from the running whim desktop app. It is **off by default**.

### Enabling

1. Open **Settings** → **Remote Web Access**
2. Check **Serve mobile web UI on this network**
3. Choose a port and one or more bind interfaces. Tailscale interfaces are labeled; prefer those for phone access.
4. Scan the QR code from your phone, or open one of the listed URLs.

The phone UI can capture intents, browse spaces, view workers, chat with agents, approve/deny permission requests, and deploy agents. Canvas editing and settings editing are not available from mobile.

### Security model

Every remote API request and the live WebSocket event stream require the shared token shown in Settings. Regenerating the token closes existing mobile sessions. Tailscale traffic is encrypted by the tunnel; raw LAN HTTP is plaintext, so only enable raw LAN interfaces on trusted networks.

---

## The Past Tab

The **Past** tab shows completed intents with their activity history, organized by completion date. Click any past intent to reopen its canvas.

---

## Settings

Open settings with the **⚙** button in the header.

### Theme
Toggle between **Light** ☀️ and **Dark** 🌙 themes.

### Font
Under **General > Appearance**, choose a font from the dropdown. Each font name is displayed in that font to preview it before choosing. The selection is saved and applies immediately to the interface and canvas, including open popout windows; code remains monospace. **Default (System)** restores the original system text and Fraunces headings. Fraunces is bundled; other choices use local fonts with fallbacks where unavailable.

### AI Model
Select which Copilot model to use for AI refinement and agent sessions.

### Workspace
Choose the directory where whim stores all data.

### Profiles
Keep separate repos — for example **work** and **personal** — and switch between them quickly. Each profile remembers its own workspace directory and can carry a color **tint** so you always know which mode you're in.

- **Add Profile** — pick a folder; whim adds it as a profile and switches to it.
- **Name** — defaults to the git remote repository name (falling back to the folder name). Type your own to override.
- **Tint** — tap the color swatch to generate a new reasonable color (tuned to read well in light and dark). The active profile's tint washes subtly over the whole side panel.
- **Switch** — activate any profile from the list, click the **whim logo** at the bottom of the side panel to cycle to the next one, or press the **Switch Profile** hotkey (`Cmd/Ctrl+Shift+P`).

The active profile's name appears next to the whim logo at the bottom of the panel.

### Copilot Runtime
whim ships with the Copilot SDK's **native runtime** and uses it over stdio by default — nothing to install. In Settings → **Copilot Runtime** you can choose where the runtime comes from:

- **Bundled native stdio** *(default, recommended)* — the SDK's native runtime in a separate process, without starting the full CLI.
- **Bundled in-process** *(experimental, opt-in)* — the same native runtime loaded into Whim's main process. Avoids the runtime subprocess but shares its crash and resource-lifecycle risks with the app. If sessions hang, switch back to bundled native stdio; restart Whim if needed. Changing native runtime builds requires an app restart.
- **Auto-detect local CLI** — find and use a locally-installed CLI, preferring the newest self-updated version (under `~/.copilot/pkg/…`). Use this for terminal-resumable sessions that share state with your own `copilot` install.
- **Custom CLI path** — point at a specific `copilot` binary or entry point.
- **Remote CLI server** — connect to an already-running runtime by URL (`host:port` or `http://host:port`) with an optional connection token.

Use **Test connection** to verify the selected runtime actually connects (it performs a real handshake), and the **Active** line shows the resolved source, version, and whether it meets the minimum supported version.

The native runtime's version appears after it connects; it is not probed by launching a CLI. The full bundled CLI remains available for terminal sessions. Choosing a bundled SDK transport does not erase saved custom CLI paths or server settings. Persistent and ephemeral agents still use separate, reused clients; the ephemeral client starts only when needed.

### MCP Servers
Model Context Protocol servers extend what agents can do. whim auto-discovers servers from `~/.copilot/mcp-config.json` and installed plugins. You can also add custom servers:
- **stdio** — command-line tool servers
- **http/sse** — web-based servers

### CLI Tools
Define CLI tools available in your environment (e.g., `gh`, `docker`, `kubectl`). Agents will know when to use these tools.

### Agent Personas
Create @mentionable personas:
- **Handle** — the @mention name (e.g., `coder`, `reviewer`, `cca`)
- **Instructions** — what the persona does and how it behaves
- **Model** — which AI model to use (or default)
- **Run location** — 💻 Local, ☁️ Cloud, or 🤖 Copilot Cloud Agent

### Where settings are stored
Everything on this screen — theme, model, workspace and **profiles**, Copilot CLI path, MCP servers, CLI tools, keyboard shortcuts, and **agent personas** (including a persona's 🔥 yolo flag) — is saved to a single file that persists across restarts and updates:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/whim/config.json` |
| Windows | `%APPDATA%\whim\config.json` |
| Linux | `~/.config/whim/config.json` |

This path is fixed for every build (development and installed), so your settings always load from the same place.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Toggle whim window |
| `Enter` | Save intent / Open selected canvas |
| `Cmd+Enter` | Open canvas in expanded mode |
| `Escape` | Close current view / Dismiss window |
| `Space` (empty input) | Start/stop voice recording |
| `Shift+Tab` | Toggle search mode |
| `Cmd/Ctrl+Shift+P` | Switch workspace profile |
| `↑ / ↓` | Navigate intent/agent list |
| `← / →` | Switch between Spaces / Workers / Past tabs |
| `Cmd+S` | Save canvas |
| `Cmd/Ctrl+K` | Insert or edit a link |
| `Cmd/Ctrl+B` / `Cmd/Ctrl+I` | Bold / italic |
| `Cmd/Ctrl+E` / `Cmd/Ctrl+Shift+X` | Inline code / strikethrough |
| `Cmd/Ctrl+Alt+8` / `Cmd/Ctrl+Alt+7` / `Cmd/Ctrl+Alt+9` | Bulleted list / numbered list / checklist |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo |
| `Cmd/Ctrl+Shift+V` | Paste plain text |
| `Alt+F10` | Focus the formatting toolbar |

---

## Window Behavior

### Edge Snapping
Drag the window to any screen edge and it snaps to position. Positions are remembered across sessions.

### Pin Mode
Click **📌** to pin the window:
- Window stays visible when you click outside
- Window becomes resizable
- Canvases open in separate popout windows (great for multi-monitor)

Unpin to return to auto-hide behavior.

### Expanded Mode
When you open a canvas (not pinned), the window expands to 720×700 centered on screen. Close the canvas to collapse back to tray size.

---

## Tips & Tricks

1. **Quick agent launch** — on the Workers tab, click **+ New Agent** to start an agent without a canvas
2. **Refresh titles** — hover any intent and click ✨ to auto-generate a better title from canvas content
3. **Jump to canvas from worker** — hover any worker card and click 📄 to open its source canvas
4. **Voice for long intents** — use voice input for lengthy descriptions; the AI will extract a clean title
5. **Git integration** — your workspace is auto-committed to git, so all changes are versioned
6. **Multiple agents** — deploy multiple agents on different sections of the same canvas; they work independently
