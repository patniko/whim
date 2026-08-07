// ── Auto-update ────────────────────────────────────────────────────────────
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error' | 'disabled';
export interface UpdateState {
  status: UpdateStatus;
  /** Version offered by the latest release (when an update is available/downloading/downloaded). */
  version?: string;
  error?: string;
  progress?: number;
  /** Version of the currently-running app (app.getVersion()). */
  currentVersion?: string;
  /** Epoch ms of the last completed check, regardless of outcome. */
  lastCheckedAt?: number;
  /** Whether the most recent check was triggered by the user or the background timer. */
  checkInitiatedBy?: 'auto' | 'manual';
}

export interface Attachment {
  type: 'url' | 'file';
  name: string;
  url: string;
  /** Relative path within the space folder (for type: 'file') */
  relativePath?: string;
  /** MIME type of the file */
  mimeType?: string;
}

export interface CanvasAgent {
  id: string;
  space_id: string;
  selected_text: string;
  session_id: string;
  pid: number | null;
  status: 'running' | 'waiting-approval' | 'completed' | 'failed';
  created_at: string;
  updated_at: string;
}

export interface AgentSession {
  id: string;
  session_id: string;
  space_id: string | null;
  prompt: string;
  status: 'running' | 'waiting-approval' | 'completed' | 'failed';
  summary: string;
  working_dir: string | null;
  source: 'sdk' | 'cli' | 'cca';
  persona_handle: string | null;
  quoted_text: string | null;
  /**
   * For agents launched from a canvas comment, the id of the comment thread
   * they're bound to.  Persisted so the thread↔agent link survives navigation,
   * pop-out windows, and app restarts — the renderer rehydrates a canvas's live
   * agents from this on mount.  `null`/absent for non-comment agents.
   */
  comment_thread_id?: string | null;
  /**
   * Where the agent's runtime executes.  `'local'` is the default and
   * indicates a session whose worker dies when this app process exits.
   * `'cloud'` indicates a session whose worker continues to run remotely
   * (via the SDK's cloud session option, e.g. an @cloud persona); these
   * sessions can be resumed across app restarts and surfaced in Mission
   * Control.
   */
  run_location: 'local' | 'cloud';
  /** CCA job id and repository metadata used to restore polling after restart. */
  cca_job_id?: string | null;
  cca_repository?: string | null;
  cca_effective_repository?: string | null;
  /** Serialized CloudJobFallbackInfo when the launch used a fork fallback. */
  cca_fallback_json?: string | null;
  /** Serialized latest CloudJobStatus returned by the CCA API. */
  cca_result_json?: string | null;
  /**
   * Whether yolo mode (auto-approve all permission requests) was enabled on
   * this session.  Persisted so a session that the user flipped into yolo mode
   * keeps that setting across navigation, pop-out windows, and app restarts —
   * the renderer and the resumed worker both rehydrate it from here.  Defaults
   * to `false`.
   */
  yolo_mode?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * A canvas comment-thread agent interaction that is currently awaiting the
 * user (approval, question, elicitation, or sandbox block).  Captured by the
 * interaction broker so a freshly mounted canvas — after navigation, opening a
 * pop-out window, or app restart — can rehydrate the pending prompt instead of
 * losing it.  Mirrors the renderer's `CanvasAgentInteraction` union shape minus
 * the resolved fields (these are, by definition, unresolved).
 */
export type PendingCanvasInteraction =
  | {
      kind: 'approval';
      agentId: string;
      requestId: string;
      permissionKind: string;
      intention?: string;
      path?: string;
    }
  | {
      kind: 'user_input';
      agentId: string;
      requestId: string;
      question: string;
      choices?: string[];
      allowFreeform?: boolean;
    }
  | {
      kind: 'elicitation';
      agentId: string;
      requestId: string;
      message: string;
      requestedSchema?: unknown;
      mode?: 'form' | 'url';
      elicitationSource?: string;
    }
  | {
      kind: 'sandbox_block';
      agentId: string;
      requestId: string;
      source: 'permission' | 'pre-tool' | 'post-tool-shell';
      blockKind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
      toolName?: string;
      target: string;
      intention?: string;
      allowedDecisions?: Array<'allow-once' | 'allow-for-session' | 'disable'>;
      layer?: string;
      personaHandle?: string;
    };

/**
 * Snapshot of a single comment-thread agent's live state for a canvas, returned
 * by the `canvas:get-agent-state` IPC so the renderer can rehydrate presence,
 * thread status, and pending interactions when a canvas (re)mounts.
 */
export interface CanvasAgentStateSnapshot {
  agentId: string;
  threadId: string;
  personaHandle: string;
  /** Stable presence color derived from the persona handle. */
  color?: string;
  /** Coarse liveness used to label the thread: cloud agents that survived a
   *  restart are 'active'; local agents whose process is gone are 'failed'. */
  status: 'starting' | 'active' | 'waiting' | 'completed' | 'failed';
  /** Content-addressable text anchor for the presence cursor, when known. */
  presenceAnchor?: { prefix?: string; suffix?: string };
  pendingInteractions: PendingCanvasInteraction[];
}

/**
 * Persisted chat event for an agent.  Captured from the SDK session's
 * catch-all event stream during the agent's lifetime so the host can
 * reconstruct a full conversation transcript even if the SDK session is
 * lost (e.g. cloud worker expired, app restarted, runtime resumed without
 * the on-disk event log).
 *
 * When `resumeAgentSession` cannot reattach to the original session, the
 * persisted events are used to build a system-message replay that gets
 * fed into a fresh local session so the user can continue the
 * conversation seamlessly.  See `replayChatIntoFreshSession` in
 * `src/main/agents/sdk-runner.ts`.
 */
export interface AgentChatEvent {
  /** Monotonic per-agent sequence number; deterministic ordering. */
  seq: number;
  /** SDK event UUID (when available) — used for idempotent dedup on replay. */
  event_id: string | null;
  /**
   * Event type as emitted by the SDK (e.g. `assistant.message`,
   * `user.message`, `tool.execution_complete`, `session.error`).
   */
  type: string;
  /** ISO 8601 timestamp of when the host observed the event. */
  timestamp: string;
  /** Serialized JSON of the event payload (event.data when present). */
  payload: string;
}

export interface AgentAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export interface LinkPreviewMeta {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  favicon: string | null;
}

/**
 * A canvas artifact — the durable HTML report a run leaves in a space.
 *
 * Distinct from whim's markdown canvas: this is produced through the SDK canvas
 * surface and rendered in its own window on an isolated origin.
 */
export interface SpaceCanvasArtifact {
  artifactId: string;
  spaceId: string;
  title: string;
  status?: string;
  skillId?: string;
  /** Whether an HTML file has actually been published, as opposed to merely bound. */
  published: boolean;
  updatedAt: string;
  publishedAt?: string;
  /** URL on the isolated artifact origin. */
  url: string;
}

export interface Space {
  id: string;
  description: string;
  body: string | null;
  raw_text: string | null;
  client: string | null;
  due_at: string | null;
  due_at_utc: string | null;
  recurrence: string | null;
  completed_at: string | null;
  folder: string | null;
  session_id: string | null;
  source_skill_id: string | null;
  attachments: Attachment[];
  status: 'captured' | 'in_progress' | 'done';
  created_at: string;
  updated_at: string;
}

export interface CreateSpaceInput {
  body: string;
}

export interface RecurrenceResult {
  should_recur: boolean;
  reasoning: string;
  next_due: string | null;
  next_due_utc: string | null;
}

export interface RecallMatch {
  space_id: string;
  description: string;
  completed_at: string | null;
  confidence: number;
}

// ── Canvas target (popout window) ───────────────────────

export type CanvasTarget =
  | { kind: 'space'; id: string; title: string }
  | { kind: 'skill'; id: string; title: string }
  | { kind: 'page'; spaceId: string; page: string; title: string };

// ── Canvas export / sharing ─────────────────────────────

/** A format a canvas can be exported or shared as. */
export type ExportFormat = 'pdf' | 'docx' | 'md';

/**
 * A "push to folder" target for canvas sharing. Points at a local folder that
 * is typically synced by OneDrive/SharePoint or Google Drive desktop apps.
 */
export interface ExportDestination {
  id: string;
  label: string;
  path: string;
  defaultFormat: ExportFormat;
}

// ── Skills ──────────────────────────────────────────────

export interface SkillFrontmatter {
  name: string;
  description: string;
  [key: string]: unknown;
}

export type SkillScheduleFrequency = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly';

export interface Skill {
  /** Folder name inside .agents/skills/ (e.g. "pdf-processing") — used as primary key */
  id: string;
  name: string;
  description: string;
  /** Auto-generated or user-specified emoji for visual distinction */
  emoji: string;
  /** Relative folder path from workspace root (e.g. ".agents/skills/pdf-processing") */
  folder: string;
  /** Absolute path to the SKILL.md file */
  filePath: string;
  /** Schedule frequency (null = not scheduled) */
  schedule: SkillScheduleFrequency | null;
  /** Time of day to run in HH:MM format (local time, defaults to "09:00") */
  schedule_time: string | null;
  /** Day of week for weekly/biweekly (0=Sun, 1=Mon, ..., 6=Sat) */
  schedule_day: number | null;
  /** Next scheduled run time in UTC ISO 8601 */
  next_run_at: string | null;
  /** Last time this skill was auto-triggered in UTC ISO 8601 */
  last_run_at: string | null;
  /**
   * Canvas this skill's runs publish a report to, or null when reports are
   * off. Resolved from the `canvas` field in SKILL.md rather than stored in
   * the projection, because the file is the source of truth for it.
   */
  canvas?: string | null;
  /** Whether repeat runs refresh one space or start a new one. */
  space_mode?: 'new' | 'reuse' | null;
  /** The report template this skill ships in `canvas/`, when it has one. */
  canvas_template?: { id: string; displayName: string } | null;
  created_at: string;
  updated_at: string;
}

export interface SkillContent {
  frontmatter: SkillFrontmatter;
  body: string;
}

export interface SkillInvocationProvenance {
  skill_id: string;
  source: 'side-panel' | 'skill-card' | 'skill-editor' | 'schedule' | 'api';
  source_prompt?: string;
  created_at: string;
  /**
   * Identifies one occurrence of a scheduled skill.  A reused space keeps the
   * artifact from previous runs, so without this there is no way to tell a
   * report published by this run from one left behind by the last.
   */
  run_id?: string;
}

export interface SkillInvocationFrontmatter {
  skills: string[];
  instructions: string;
  preferred_agent?: string;
  /** Canvas type this run may publish to, or false to opt out. */
  canvas_artifacts?: string | false;
  /** Whether repeat runs refresh this space or start a new one. */
  space_mode?: 'new' | 'reuse';
  skill_invocation: SkillInvocationProvenance;
  [key: string]: unknown;
}

export interface SkillInvocationInput {
  skillId: string;
  intent?: string;
  run?: boolean;
  preferredAgent?: string | null;
  source?: SkillInvocationProvenance['source'];
}

export interface SkillInvocationResult {
  space: Space;
  canvasContent: string;
  agent?: { agentId: string; sessionId: string };
  error?: string;
}

export interface LaunchDocumentAgentOptions {
  personaHandle?: string | null;
  promptOverride?: string;
}

/** One day in the Activity view's calendar. Zero-activity days are included. */
export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Spaces completed on this day. */
  spaces: number;
  /** Agent runs started on this day. */
  agents: number;
  /** Tokens spent by runs on this day, parents and sub-agents together. */
  tokens: number;
}

export interface ActivityTotals {
  tokens: number;
  agents: number;
  subagents: number;
  spaces: number;
  toolCalls: number;
  /** Most agents that were running at the same moment in the window. */
  peakParallelAgents: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  busiestDay: { date: string; count: number } | null;
}

export interface ActivityStats {
  days: ActivityDay[];
  totals: ActivityTotals;
}
