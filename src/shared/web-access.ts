import type { IpcCommandChannel } from './ipc-contract';

/**
 * Whether an IPC command may be reached from the web remote.
 *
 *  - `allow`        — safe and meaningful over a remote connection.
 *  - `deny`         — deliberately withheld. Usually because it reconfigures
 *                     the machine, escalates what agents are allowed to do, or
 *                     changes global state under the desktop user's feet.
 *  - `desktop-only` — meaningless in a browser: it drives a native window, the
 *                     host filesystem, the tray, or the updater. These are not
 *                     a security decision; they simply have no remote meaning
 *                     and should degrade gracefully rather than throw.
 *
 * The previous allowlist was a bare array of 33 strings. Adding a command to
 * the app did not require thinking about the web at all, so the remote surface
 * drifted silently — and the reason any given command was *absent* was never
 * written down. This map is exhaustive by construction: `WEB_ACCESS` is typed
 * as `Record<IpcCommandChannel, WebAccess>`, so a new command will not compile
 * until someone classifies it.
 */
export type WebAccess = 'allow' | 'deny' | 'desktop-only';

/**
 * Commands that are registered but absent from `ipc-contract.ts`.
 *
 * "Exhaustive by construction" was only true of channels the contract knows
 * about, and nine handlers had been added without one. `webAccessFor` returns
 * `null` for anything it has never heard of, which the gateway treats as
 * denied — so these were refused with no decision ever having been made, and
 * the browser reported them as forbidden rather than as an oversight. Serving
 * the real renderer made that visible: it calls `runtimes:list` on boot and
 * got an unhandled rejection.
 *
 * These are classified here rather than quietly allowed, and
 * `registry.test.ts` fails if a registered channel appears in neither map, so
 * the next one cannot slip through the same gap. Moving them into the
 * contract is the better end state; classifying them is the part that has to
 * be true today.
 */
const UNTYPED_CHANNEL_ACCESS: Record<string, WebAccess> = {
  // Reads: describing state a remote user is already allowed to see.
  'agent:get-working-dir': 'allow',
  'canvas:read-activity-log': 'allow',
  'canvas:get-agent-state': 'allow',
  'subagent:list-persisted': 'allow',
  'runtimes:list': 'allow',

  // Lowers the sandbox around an agent with shell access on the host.
  'agent:disable-sandbox': 'deny',
  // Rewrites which runtimes the host will execute against.
  'runtimes:save': 'deny',

  // Native surfaces with no browser meaning.
  'canvas:open-folder': 'desktop-only',
  'canvas-window:get-always-on-top': 'desktop-only',
};

export const WEB_ACCESS: Record<IpcCommandChannel, WebAccess> = {
  // ── Spaces — the core workspace content ──
  'space:create': 'allow',
  'space:list': 'allow',
  'space:update': 'allow',
  'space:delete': 'allow',
  'space:dismiss-recurrence': 'allow',
  'space:events': 'allow',
  'space:resolve-date': 'allow',
  'space:classify': 'allow',
  'space:summarize-title': 'allow',
  'space:search': 'allow',
  'space:unarchive': 'allow',

  // Needs a secure context for getUserMedia, which TLS now provides.
  'voice:transcribe': 'allow',

  // ── Settings — reachable, but filtered by key ──
  // Settings carry sandbox defaults, CLI selection and remote access itself,
  // so these are *not* open channels: settings-access.ts allowlists which keys
  // may be read and which may be written, and the gateway refuses the rest.
  // The channel has to be reachable because the renderer cannot boot without
  // reading `workspace_root`.
  'settings:get': 'allow',
  // Writes stay denied: the desktop setter respawns the CLI and reconfigures
  // the updater, which is more than a browser should reach.
  'settings:set': 'deny',
  'web-remote:get-state': 'deny',
  'web-remote:set-enabled': 'deny',
  'web-remote:set-config': 'deny',
  'web-remote:revoke-device': 'deny',
  'web-remote:regenerate-token': 'deny',
  'web-remote:list-interfaces': 'deny',

  'hotkeys:get': 'desktop-only',
  'hotkeys:set': 'desktop-only',
  'hotkeys:reset': 'desktop-only',
  // Reports whether an OS-level global shortcut registered. A browser has no
  // such concept.
  'hotkeys:toggle-status': 'desktop-only',

  // Probe and configure the local CLI installation — host-machine concerns.
  'cli:resolve-path': 'deny',
  'cli:check-version': 'deny',
  'cli:check-mxc-capable': 'deny',
  // The reply names an absolute path on the host, which is why this was
  // denied. But the renderer's boot reads it to choose between the setup flow
  // and the real interface, so denying it did not hide a path — it stopped
  // the browser interface from starting. web-redaction.ts replaces the path
  // and passes the rest through, which is the part a paired device needs.
  'cli:runtime-status': 'allow',
  'cli:test-connection': 'deny',
  // Enumerates CLI installs by absolute path on the host filesystem, and only
  // feeds the Settings window, which is itself denied.
  'cli:discover': 'deny',

  'models:list': 'allow',
  'models:list-detailed': 'allow',

  // Reading personas is needed to launch an agent; saving one edits the
  // sandbox policy agents run under, which is a privilege change.
  'personas:list': 'allow',
  'personas:save': 'deny',

  // MCP servers and CLI tools decide what capabilities agents get.
  'mcp:list-discovered': 'deny',
  'mcp:list-custom': 'deny',
  'mcp:save-custom': 'deny',
  'cli-tools:list': 'deny',
  'cli-tools:save': 'deny',

  'sandbox:get-default': 'allow',
  'sandbox:save-default': 'deny',
  'sandbox:open-config-preview': 'desktop-only',

  'session:launch': 'deny',
  'session:active-spaces': 'allow',

  // Switching workspace changes what the desktop user is looking at. The
  // gateway reads a single global active workspace, so this cannot be made
  // per-connection until the gateway is workspace-aware.
  'workspace:select': 'deny',
  'workspace:clear': 'deny',
  'profiles:list': 'allow',
  'profiles:add': 'deny',
  'profiles:activate': 'deny',
  'profiles:cycle': 'deny',
  'profiles:update': 'deny',
  'profiles:remove': 'deny',

  // Would open a file or URL on the host machine, not in the browser.
  'shell:openPath': 'desktop-only',
  'shell:openExternal': 'desktop-only',

  'workspace:git-status': 'allow',
  'workspace:git-push': 'allow',
  'workspace:git-pull': 'allow',

  // ── Canvas ──
  'canvas:read': 'allow',
  'canvas:has-content': 'allow',
  'canvas:write': 'allow',
  'canvas:close': 'allow',
  // Signature assumes a local file path; needs an upload endpoint first.
  'canvas:paste-file': 'deny',
  'canvas:resolve-attachment': 'allow',
  'canvas:fetch-link-meta': 'allow',
  'canvas:history': 'allow',
  'canvas:restore': 'allow',
  'canvas:preview-version': 'allow',
  'canvas:create-page': 'allow',
  'canvas:read-page': 'allow',
  'canvas:write-page': 'allow',
  'canvas:close-page': 'allow',
  'canvas:list-pages': 'allow',
  'canvas:open-link': 'desktop-only',
  // Deciding what a link means is a question about the workspace, not an
  // action on the host — the browser applies the answer itself.
  'canvas:resolve-link': 'allow',
  'canvas:read-file': 'allow',
  // Export and share write to host filesystem paths chosen on the desktop.
  'canvas:export': 'deny',
  'canvas:share': 'deny',
  'canvas:export-to-destination': 'deny',
  // Reports are metadata reads, so a remote user can see one exists.
  'canvas-artifact:list': 'allow',
  'canvas-artifact:list-all': 'allow',
  // Opening one drives a native BrowserWindow on the desktop, and the report
  // itself is served over the whim-artifact:// scheme, which a browser cannot
  // reach. Popping a window on the host that the remote user cannot see is
  // worse than degrading, so this stays desktop-only until the gateway can
  // serve artifact content over HTTP.
  'canvas-artifact:open': 'desktop-only',
  'export-destinations:list': 'allow',
  'export-destinations:save': 'deny',

  'dialog:select-folder': 'desktop-only',

  // ── Agents ──
  'agent:launch': 'allow',
  'agent:launch-from-comment': 'allow',
  'agent:list': 'allow',
  'agent:approve': 'allow',
  'agent:respond-user-input': 'allow',
  'agent:respond-elicitation': 'allow',
  'agent:abort': 'allow',
  'agent:open-cli': 'desktop-only',
  'agent:resolve-sandbox': 'allow',
  'agent:quick-launch': 'allow',
  'agent:launch-document': 'allow',
  'agent:list-all': 'allow',
  'agent:delete-session': 'allow',
  'agent:launch-cloud': 'allow',
  'agent:cloud-status': 'allow',
  'agent:get-history': 'allow',
  'agent:set-yolo': 'allow',
  'agent:enable-remote': 'allow',
  'agent:disable-remote': 'allow',
  'agent:get-remote-state': 'allow',
  'agent:reset-remote': 'allow',
  // App-wide remote toggles are a settings-level change.
  'app:set-remote': 'deny',
  'app:get-remote-status': 'allow',
  'cli:launch-session': 'desktop-only',

  'chat:send-message': 'allow',
  'chat:set-model': 'allow',

  'subagent:list': 'allow',
  'subagent:read': 'allow',
  'subagent:write': 'allow',
  'subagent:cancel': 'allow',

  'window:get-pinned': 'desktop-only',

  // ── Skills — workspace content, same as spaces ──
  'skill:list': 'allow',
  'skill:read': 'allow',
  'skill:write': 'allow',
  'skill:create': 'allow',
  'skill:create-from-prompt': 'allow',
  'skill:delete': 'allow',
  'skill:open-folder': 'desktop-only',
  'skill:create-space': 'allow',
  'skill:launch': 'allow',
  'skill:invoke': 'allow',
  'skill:set-schedule': 'allow',
  'skill:clear-schedule': 'allow',
  'skill:set-canvas': 'allow',

  // The updater drives a native download and relaunch.
  'update:install': 'desktop-only',
  'update:check': 'desktop-only',
  'update:download': 'desktop-only',
  'update:get-state': 'desktop-only',
  'update:open-log': 'desktop-only',

  ...UNTYPED_CHANNEL_ACCESS,
};

export function webAccessFor(channel: string): WebAccess | null {
  return (WEB_ACCESS as Record<string, WebAccess | undefined>)[channel] ?? null;
}

/** Channels that are safe to expose remotely, in declaration order. */
export function webAllowedChannels(): IpcCommandChannel[] {
  return (Object.keys(WEB_ACCESS) as IpcCommandChannel[]).filter((channel) => WEB_ACCESS[channel] === 'allow');
}
