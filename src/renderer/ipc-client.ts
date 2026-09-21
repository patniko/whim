/**
 * Typed IPC client for the renderer process.
 *
 * Provides typed access to the preload-injected `window.whimAPI` bridge
 * and re-exports the types that renderer code commonly needs.
 *
 * Usage:
 *   import { getAPI } from './ipc-client';
 *   const api = getAPI();
 *   const spaces = await api.list();
 */

// ── Core API interfaces from preload ────────────────────────────────────────
import type { WhimAPI, SubagentAPI } from '../shared/whim-api';

export type { WhimAPI, SubagentAPI };

const readAPIs = new WeakMap<object, object>();

/** Write-tracking wrappers share their underlying transport's read ownership. */
export function registerReadAPI<T extends object>(wrapper: T, source: T): void {
  readAPIs.set(wrapper, getReadAPI(source));
}

export function getReadAPI<T extends object>(api: T): T {
  return (readAPIs.get(api) as T | undefined) ?? api;
}

// ── IPC contract types ──────────────────────────────────────────────────────
export type {
  AgentPersona,
  CliToolDefinition,
  CustomMcpServer,
  DiscoveredMcpServer,
  AgentListItem,
  AgentListAllItem,
  SpaceUpdates,
  SpaceEvent,
  CanvasCommit,
  CloudJobPollResult,
  CloudJobResult,
  IpcEventPayload,
} from '../shared/ipc-contract';

// ── Domain types ────────────────────────────────────────────────────────────
export type {
  Space,
  CreateSpaceInput,
  AgentAnchor,
  AgentSession,
  LinkPreviewMeta,
  RecurrenceResult,
  RecallMatch,
  Attachment,
} from '../shared/types';

// ── Chat types ──────────────────────────────────────────────────────────────
export type {
  ChatEvent,
  ChatMessage,
  UserMessage,
  AssistantMessage,
  ToolCallMessage,
  ReasoningMessage,
  ApprovalMessage,
  UserInputMessage,
  ElicitationMessage,
  SessionEventMessage,
  ChatAttachment,
} from '../shared/chat-types';

// ── Sub-agent types ─────────────────────────────────────────────────────────
export type {
  SubagentSummary,
  SubagentInfo,
  SubagentStatus,
  SubagentType,
  SubagentTurn,
  SubagentToolCall,
  SubagentProgress,
} from '../shared/subagent-types';

/**
 * Typed accessor for the preload-injected IPC bridge.
 * Use this instead of accessing `window.whimAPI` directly.
 */
export function getAPI(): WhimAPI {
  return (window as any).whimAPI;
}
