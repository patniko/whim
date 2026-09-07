// Chat message types for the in-app agent chat experience.
// Inspired by github-tokens' ConversationMessage model.

export type ChatMessage = (
  | UserMessage
  | AssistantMessage
  | ToolCallMessage
  | ReasoningMessage
  | ApprovalMessage
  | UserInputMessage
  | ElicitationMessage
  | SandboxBlockMessage
  | SessionEventMessage
) & { sequence?: number };

export interface UserMessage {
  id: string;
  type: 'user';
  content: string;
  attachments?: ChatAttachment[];
  timestamp: string;
}

export interface AssistantMessage {
  id: string;
  type: 'assistant';
  content: string;
  isStreaming: boolean;
  timestamp: string;
}

export interface ToolCallMessage {
  id: string;
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  completed: boolean;
  success?: boolean;
  error?: string;
  timestamp: string;
}

export interface ReasoningMessage {
  id: string;
  type: 'reasoning';
  reasoningId: string;
  content: string;
  isStreaming: boolean;
  timestamp: string;
}

export interface ApprovalMessage {
  id: string;
  type: 'approval';
  requestId: string;
  agentId: string;
  permissionKind: string;
  intention?: string;
  path?: string;
  responded: boolean;
  approved?: boolean;
  timestamp: string;
}

export interface SessionEventMessage {
  id: string;
  type: 'session_event';
  eventType: 'idle' | 'error' | 'completed' | 'started' | 'info';
  message?: string;
  timestamp: string;
}

export interface UserInputMessage {
  id: string;
  type: 'user_input';
  requestId: string;
  agentId: string;
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  responded: boolean;
  answer?: string;
  wasFreeform?: boolean;
  timestamp: string;
}

// Re-export SDK elicitation schema types for convenience
export type ElicitationSchemaField = import('@github/copilot-sdk').ElicitationSchemaField;
export type ElicitationSchema = import('@github/copilot-sdk').ElicitationSchema;
export type ElicitationFieldValue = import('@github/copilot-sdk').ElicitationFieldValue;

export interface ElicitationMessage {
  id: string;
  type: 'elicitation';
  requestId: string;
  agentId: string;
  message: string;
  requestedSchema?: ElicitationSchema;
  mode?: 'form' | 'url';
  elicitationSource?: string;
  responded: boolean;
  action?: 'accept' | 'decline' | 'cancel';
  content?: Record<string, ElicitationFieldValue>;
  timestamp: string;
}

/**
 * Sandbox enforcement block surfaced inline in the chat thread.  Mirrors the
 * Workers-tab AgentsList panel so the user can see and resolve a block
 * (allow-once / allow-for-session / disable) without leaving the chat view.
 *
 * The fields match the broker's `SandboxBlockRequest` payload (see
 * `src/main/agents/interaction-broker.ts`). When the broker emits a
 * `'sandbox.resolved'` event with the matching `requestId`, the tile flips to
 * its resolved state showing the user's decision.
 */
export interface SandboxBlockMessage {
  id: string;
  type: 'sandbox_block';
  requestId: string;
  agentId: string;
  source: 'permission' | 'pre-tool' | 'post-tool-shell';
  kind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
  toolName?: string;
  target: string;
  intention?: string;
  allowedDecisions?: Array<'allow-once' | 'allow-for-session' | 'disable'>;
  layer?: string;
  personaHandle?: string;
  responded: boolean;
  decision?: 'allow-once' | 'allow-for-session' | 'disable';
  timestamp: string;
}

export interface ChatAttachment {
  type: 'file';
  name: string;
  path: string;
  mimeType?: string;
}

// Events sent from main process to renderer via IPC
export type ChatEvent = ChatEventPayload & {
  /** SDK transport identity; absent only on legacy or app-generated events. */
  eventId?: string;
  messageId?: string;
  /** Durable transcript sequence, assigned by the storage worker. */
  sequence?: number;
};

type ChatEventPayload =
  | { type: 'assistant.message_delta'; delta: string }
  | { type: 'assistant.message'; content: string }
  | { type: 'assistant.reasoning_delta'; reasoningId: string; delta: string }
  | { type: 'assistant.reasoning'; reasoningId: string; content: string }
  | { type: 'tool.start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool.progress'; toolCallId: string; message: string }
  | { type: 'tool.complete'; toolCallId: string; result: string; success: boolean; error?: string }
  | { type: 'session.idle' }
  | { type: 'session.error'; message: string }
  | { type: 'approval.needed'; requestId: string; agentId: string; permissionKind: string; intention?: string; path?: string }
  | { type: 'approval.resolved'; requestId: string; approved: boolean }
  | { type: 'user_input.requested'; requestId: string; agentId: string; question: string; choices?: string[]; allowFreeform?: boolean }
  | { type: 'user_input.resolved'; requestId: string; answer: string; wasFreeform: boolean }
  | { type: 'elicitation.requested'; requestId: string; agentId: string; message: string; requestedSchema?: ElicitationSchema; mode?: 'form' | 'url'; elicitationSource?: string }
  | { type: 'elicitation.resolved'; requestId: string; action: 'accept' | 'decline' | 'cancel'; content?: Record<string, ElicitationFieldValue> }
  | { type: 'subagent.started'; toolCallId: string; name: string; displayName: string; description: string; agentId?: string }
  | { type: 'subagent.completed'; toolCallId: string; name: string; agentId?: string; durationMs?: number; model?: string; totalTokens?: number; totalToolCalls?: number }
  | { type: 'subagent.failed'; toolCallId: string; name: string; error: string; agentId?: string }
  | {
      type: 'sandbox.blocked';
      requestId: string;
      agentId: string;
      source: 'permission' | 'pre-tool' | 'post-tool-shell';
      kind: 'read' | 'write' | 'shell' | 'mcp' | 'url' | 'web-fetch';
      toolName?: string;
      target: string;
      intention?: string;
      allowedDecisions?: Array<'allow-once' | 'allow-for-session' | 'disable'>;
      layer?: string;
      personaHandle?: string;
    }
  | {
      type: 'sandbox.resolved';
      requestId: string;
      decision: 'allow-once' | 'allow-for-session' | 'disable';
    }
  | {
      type: 'sandbox.disabled';
      message?: string;
    }
  | {
      type: 'session.restarted';
      message?: string;
    };
