/**
 * Which settings a paired browser may read and write.
 *
 * `settings:get` and `settings:set` were withheld from the web entirely, and
 * for a defensible reason: settings hold the workspace location, the CLI
 * configuration, and the remote-access controls themselves, so a blanket
 * allow would let anyone who reached the remote widen their own privileges.
 *
 * But the renderer's whole bootstrap hangs off reading `workspace_root` — it
 * decides between the setup flow and the real interface — so denying the
 * channel outright meant the full interface never started at all. The useful
 * distinction is not the channel, it is the key.
 *
 * Both lists are allowlists: an unrecognised key is refused. A setting added
 * later is invisible to the web until someone decides it should not be, which
 * is the safe direction for that decision to fail in.
 */

/**
 * Readable remotely. These describe how the interface should present itself,
 * plus the workspace location the renderer cannot start without.
 */
const READABLE_SETTINGS = new Set([
  'theme',
  'focused_intent',
  'auto_hide_side_pane',
  'comment_trigger',
  'quick_start_completed',
  'onboarding_tips_seen',
  'model',
  'remoteAutoEnable',
  // A path, and so worth a moment's thought. It is already implied by the
  // content a paired device can legitimately read, and the renderer branches
  // on it during boot, so withholding it costs the whole interface and
  // protects nothing that isn't otherwise reachable.
  'workspace_root',
]);

/**
 * Writing settings stays denied entirely.
 *
 * Not because no key is safe — `theme` plainly is — but because the desktop
 * setter carries side effects that reach well past storing a value: it
 * respawns the CLI, reconfigures the updater, and moves panes in the desktop
 * window. Reaching that from a browser deserves its own design rather than
 * being tacked onto the work that made the interface load.
 */

/**
 * Never readable, and listed explicitly rather than left to the default.
 *
 * `cli_server_token` is a credential; the rest describe or select what the
 * host machine executes. A test asserts these stay out of the allowlists, so
 * a careless addition fails loudly.
 */
export const SECRET_SETTINGS = [
  'cli_server_token',
  'cli_server_url',
  'cli_path',
  'cli_source',
  'auto_download_updates',
];

export function canReadSetting(key: unknown): boolean {
  return typeof key === 'string' && READABLE_SETTINGS.has(key);
}

export function readableSettings(): string[] {
  return [...READABLE_SETTINGS];
}

