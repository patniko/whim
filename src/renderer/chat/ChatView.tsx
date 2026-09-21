import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { ChatMessage, ChatEvent, ChatAttachment, AssistantMessage as AssistantMsgType, ToolCallMessage, ReasoningMessage, ApprovalMessage, UserInputMessage, ElicitationMessage, SessionEventMessage, SandboxBlockMessage } from '../../shared/chat-types';
import { MessageList } from './MessageList';
import { PromptBar } from './PromptBar';
import { SubagentDetailOverlay } from './SubagentDetailOverlay';
import { WorkingIndicator } from './tiles/WorkingIndicator';
import QRCode from 'qrcode';
import { applyStreamEvent, createEventBatch, finalizeMessages } from './event-batch';
import { hasPendingInteraction, type ChatHistorySource } from './transcript-layout';
import { useHistoryPaging } from './use-history-paging';
import { acknowledgeUserMessage, mergeHistoryWithLocal } from '../../shared/chat-identity';

declare const whimAPI: {
  sendChatMessage: (agentId: string, prompt: string, attachments?: any[]) => Promise<{ error?: string; messageId?: string }>;
  onChatEvent: (agentId: string, callback: (event: ChatEvent) => void) => () => void;
  approveAgent: (agentId: string, requestId: string, approved: boolean) => Promise<void>;
  respondToUserInput: (agentId: string, requestId: string, answer: string, wasFreeform: boolean) => Promise<void>;
  respondToElicitation: (agentId: string, requestId: string, action: string, content?: Record<string, unknown>) => Promise<void>;
  openAgentCli: (agentId: string) => Promise<any>;
  abortAgent: (agentId: string) => Promise<void>;
  listModels: () => Promise<{ id: string; name?: string }[]>;
  getSetting: (key: string) => Promise<string | null>;
  setChatModel: (agentId: string, model: string) => Promise<{ error?: string }>;
  quickLaunchAgent: (prompt: string, personaHandle?: string) => Promise<{ agentId: string; sessionId: string } | { error: string }>;
  getAgentHistory: (agentId: string) => Promise<{ events?: any[]; error?: string; restarted?: boolean }>;
  getAgentHistoryPage: (agentId: string, request?: import('../../shared/paging').PageRequest) => Promise<import('../../shared/paging').ChatHistoryPage>;
  getAgent: (agentId: string) => Promise<{ status: string } | null>;
  selectWorkspace: () => Promise<{ selected: boolean; path: string | null }>;
  onWorkspaceChanged: (callback: (path: string | null) => void) => void;
  setAgentYolo: (agentId: string, enabled: boolean) => Promise<{ ok?: boolean; error?: string }>;
  disableSandbox: (agentId: string) => Promise<{ ok?: boolean; error?: string }>;
  resolveSandboxBlock: (
    agentId: string,
    requestId: string,
    decision: 'allow-once' | 'allow-for-session' | 'disable',
  ) => Promise<{ ok?: boolean; error?: string }>;
  openPersonaSandboxEditor: (personaHandle: string) => void;
  onAgentYoloChanged: (callback: (data: { agentId: string; enabled: boolean }) => void) => void;
  enableRemote: (agentId: string) => Promise<{ enabled?: boolean; remoteSteerable?: boolean; url?: string; error?: string }>;
  disableRemote: (agentId: string) => Promise<{ ok?: boolean; error?: string }>;
  onAgentRemoteChanged: (callback: (data: { agentId: string; enabled: boolean; remoteSteerable: boolean; url?: string }) => void) => void;
  openExternal: (url: string) => Promise<any>;
  listAllAgents: () => Promise<Array<{ agentId: string; status: string; [key: string]: any }>>;
  [key: string]: any;
};

interface ChatViewProps {
  agentId?: string;
  agentPrompt: string;
  agentStatus: string;
  agentSource?: 'sdk' | 'cli' | 'cca';
  spaceId?: string;
  sandboxed?: boolean;
  yolo?: boolean;
  pendingApprovalId?: string;
  pendingPermissionKind?: string;
  onClose: () => void;
  onOpenCli: (agentId: string) => void;
  onOpenCanvas?: (spaceId: string) => void;
  historySource?: ChatHistorySource;
}

let nextMsgId = 1;
function genId(): string {
  return `msg-${nextMsgId++}`;
}

/** Transform SDK SessionEvent[] into ChatMessage[] for display. */
export function parseHistoryEvents(events: any[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // Track tool calls by ID so we can update them with completion data
  const toolMsgMap = new Map<string, number>();
  // Track approval messages by requestId for permission.completed matching
  const approvalMsgMap = new Map<string, number>();

  for (const event of events) {
    const type = event.type || event.kind;
    const data = event.data || event;
    const ts = event.timestamp || new Date().toISOString();
    const id = typeof event.id === 'string' ? `history:${event.id}` : genId();

    if (type === 'user.message' || type === 'user_message') {
      const content = data.content || data.prompt || data.message || '';
      if (content) {
        messages.push({ id: data.messageId ? `user:${data.messageId}` : event.id ? `user:${event.id}` : id,
          type: 'user', content, timestamp: ts });
      }
    } else if (type === 'assistant.message' || type === 'assistant_message') {
      const content = data.content || data.message || '';
      if (content) {
        messages.push({ id: data.messageId ? `assistant:${data.messageId}` : id,
          type: 'assistant', content, isStreaming: false, timestamp: ts } as AssistantMsgType);
      }
    } else if (type === 'assistant.reasoning' || type === 'assistant_reasoning') {
      const content = data.content || '';
      if (content) {
        messages.push({
          id: data.reasoningId ? `reasoning:${data.reasoningId}` : id, type: 'reasoning',
          reasoningId: data.reasoningId || '', content, isStreaming: false, timestamp: ts,
        } as ReasoningMessage);
      }
    } else if (type === 'tool.execution_start' || type === 'tool_execution_start') {
      const toolCallId = data.toolCallId || '';
      const msg: ToolCallMessage = {
        id, type: 'tool_call', toolCallId,
        toolName: data.toolName || 'tool', args: data.arguments || data.toolArgs || {},
        completed: false, timestamp: ts,
      };
      toolMsgMap.set(toolCallId, messages.length);
      messages.push(msg);
    } else if (type === 'tool.execution_complete' || type === 'tool_execution_complete') {
      const toolCallId = data.toolCallId || '';
      const idx = toolMsgMap.get(toolCallId);
      if (idx !== undefined && messages[idx]?.type === 'tool_call') {
        const msg = messages[idx] as ToolCallMessage;
        msg.completed = true;
        // SDK result may be { content, detailedContent? } or a plain string
        const rawResult = data.result;
        msg.result = typeof rawResult === 'string'
          ? rawResult
          : rawResult?.detailedContent ?? rawResult?.content ?? '';
        msg.success = data.success !== false;
      }
    } else if (type === 'session.error' || type === 'session_error') {
      messages.push({
        id, type: 'session_event', eventType: 'error',
        message: data.message || 'Unknown error', timestamp: ts,
      } as SessionEventMessage);
    } else if (type === 'elicitation.requested') {
      messages.push({
        id, type: 'elicitation',
        requestId: data.requestId || '',
        agentId: data.agentId || '',
        message: data.message || '',
        requestedSchema: data.requestedSchema,
        mode: data.mode,
        elicitationSource: data.elicitationSource,
        responded: false,
        timestamp: ts,
      } as ElicitationMessage);
    } else if (type === 'elicitation.completed') {
      // Find the matching elicitation message and mark it resolved
      const elicitIdx = messages.findIndex(
        m => m.type === 'elicitation' && m.requestId === (data.requestId || '') && !m.responded
      );
      if (elicitIdx !== -1) {
        const msg = messages[elicitIdx] as ElicitationMessage;
        msg.responded = true;
        msg.action = data.action;
        msg.content = data.content;
      }
    } else if (type === 'permission.requested') {
      // SDK persists permission requests — map to ApprovalMessage
      const pr = data.permissionRequest || data;
      const reqId = pr.toolCallId || data.requestId || '';
      const approvalMsg: ApprovalMessage = {
        id, type: 'approval',
        requestId: reqId,
        agentId: '',
        permissionKind: pr.kind || 'permission',
        intention: pr.intention,
        path: pr.path || pr.fileName,
        responded: false,
        timestamp: ts,
      };
      approvalMsgMap.set(data.requestId || reqId, messages.length);
      messages.push(approvalMsg);
    } else if (type === 'permission.completed') {
      const reqId = data.requestId || '';
      const approved = data.result?.kind === 'approved' || data.result?.kind === 'approve-once' || data.result?.kind === 'approve-for-session' || data.result?.kind === 'approve-for-location';
      const idx = approvalMsgMap.get(reqId);
      if (idx !== undefined && messages[idx]?.type === 'approval') {
        const msg = messages[idx] as ApprovalMessage;
        msg.responded = true;
        msg.approved = approved;
      }
    }
  }
  return messages;
}

/**
 * Apply a buffered completion event (tool.complete, approval.resolved, session.idle/error)
 * to the message list using ID-based matching. This is idempotent.
 */
function applyCompletionEvent(msgs: ChatMessage[], event: ChatEvent): ChatMessage[] {
  switch (event.type) {
    case 'tool.complete':
      return msgs.map(m =>
        m.type === 'tool_call' && m.toolCallId === event.toolCallId
          ? { ...m, completed: true, success: event.success, result: event.result, error: event.error }
          : m
      );
    case 'approval.resolved':
      return msgs.map(m =>
        m.type === 'approval' && m.requestId === event.requestId
          ? { ...m, responded: true, approved: event.approved }
          : m
      );
    case 'user_input.resolved':
      return msgs.map(m =>
        m.type === 'user_input' && m.requestId === event.requestId
          ? { ...m, responded: true, answer: event.answer, wasFreeform: event.wasFreeform }
          : m
      );
    case 'elicitation.resolved':
      return msgs.map(m =>
        m.type === 'elicitation' && m.requestId === event.requestId
          ? { ...m, responded: true, action: event.action, content: event.content }
          : m
      );
    case 'sandbox.resolved':
      return msgs.map(m =>
        m.type === 'sandbox_block' && m.requestId === event.requestId
          ? { ...m, responded: true, decision: event.decision }
          : m
      );
    default:
      return msgs;
  }
}

/**
 * Replay buffered events that arrived during history loading.
 * Request/tool IDs and identified text are deduplicated. Legacy text without
 * identity is retained rather than guessed by equal content.
 */
export function replayBufferedEvents(msgs: ChatMessage[], events: ChatEvent[], localTermination?: SessionEventMessage): ChatMessage[] {
  let result = localTermination ? msgs.filter(message => message.id !== localTermination.id) : [...msgs];

  // Build dedup sets from existing messages
  const existingToolCallIds = new Set<string>();
  const existingApprovalIds = new Set<string>();
  const existingUserInputIds = new Set<string>();
  const existingElicitationIds = new Set<string>();
  const existingSandboxBlockIds = new Set<string>();

  for (const m of result) {
    if (m.type === 'tool_call') existingToolCallIds.add((m as ToolCallMessage).toolCallId);
    else if (m.type === 'approval') existingApprovalIds.add((m as ApprovalMessage).requestId);
    else if (m.type === 'user_input') existingUserInputIds.add((m as UserInputMessage).requestId);
    else if (m.type === 'elicitation') existingElicitationIds.add((m as ElicitationMessage).requestId);
    else if (m.type === 'sandbox_block') existingSandboxBlockIds.add((m as SandboxBlockMessage).requestId);
  }

  for (const event of events) {
    if (localTermination && event.type === 'session.idle') continue;
    switch (event.type) {
      case 'assistant.message_delta':
      case 'assistant.message':
      case 'assistant.reasoning_delta':
      case 'assistant.reasoning':
      case 'tool.progress':
        result = applyStreamEvent(result, event, genId(), new Date().toISOString());
        break;
      case 'session.idle':
        result = finalizeMessages(result);
        if (!result.some((m, i) => i === result.length - 1 && m.type === 'session_event' &&
          (m.eventType === 'completed' || m.eventType === 'error'))) {
          result.push({ id: genId(), type: 'session_event', eventType: 'completed',
            message: 'Completed', timestamp: new Date().toISOString() });
        }
        break;
      case 'session.restarted':
        result = finalizeMessages(result);
        result.push({ id: genId(), type: 'session_event', eventType: 'info',
          message: event.message || 'Previous session expired — started a fresh session with context.',
          timestamp: new Date().toISOString() });
        break;
      case 'sandbox.disabled':
        result = result.map(m => m.type === 'sandbox_block' && !m.responded
          ? { ...m, responded: true, decision: 'disable' } : m);
        result.push({ id: genId(), type: 'session_event', eventType: 'info',
          message: event.message || 'Sandbox disabled for this session.', timestamp: new Date().toISOString() });
        break;
      // Completion events — idempotent
      case 'tool.complete':
      case 'approval.resolved':
      case 'user_input.resolved':
      case 'elicitation.resolved':
      case 'sandbox.resolved':
        result = applyCompletionEvent(result, event);
        break;

      case 'tool.start':
        if (!existingToolCallIds.has(event.toolCallId)) {
          result.push({
            id: genId(), type: 'tool_call',
            toolCallId: event.toolCallId, toolName: event.toolName,
            args: event.args, completed: false,
            timestamp: new Date().toISOString(),
          } as ToolCallMessage);
          existingToolCallIds.add(event.toolCallId);
        }
        break;

      case 'approval.needed':
        if (!existingApprovalIds.has(event.requestId)) {
          result.push({
            id: genId(), type: 'approval',
            requestId: event.requestId, agentId: event.agentId,
            permissionKind: event.permissionKind,
            intention: event.intention, path: event.path,
            responded: false,
            timestamp: new Date().toISOString(),
          } as ApprovalMessage);
          existingApprovalIds.add(event.requestId);
        }
        break;

      case 'user_input.requested':
        if (!existingUserInputIds.has(event.requestId)) {
          result.push({
            id: genId(), type: 'user_input',
            requestId: event.requestId, agentId: event.agentId,
            question: event.question, choices: event.choices,
            allowFreeform: event.allowFreeform, responded: false,
            timestamp: new Date().toISOString(),
          } as UserInputMessage);
          existingUserInputIds.add(event.requestId);
        }
        break;

      case 'elicitation.requested':
        if (!existingElicitationIds.has(event.requestId)) {
          result.push({
            id: genId(), type: 'elicitation',
            requestId: event.requestId, agentId: event.agentId,
            message: event.message, requestedSchema: event.requestedSchema,
            mode: event.mode, elicitationSource: event.elicitationSource,
            responded: false,
            timestamp: new Date().toISOString(),
          } as ElicitationMessage);
          existingElicitationIds.add(event.requestId);
        }
        break;

      case 'sandbox.blocked':
        if (!existingSandboxBlockIds.has(event.requestId)) {
          result.push({
            id: genId(), type: 'sandbox_block',
            requestId: event.requestId, agentId: event.agentId,
            source: event.source, kind: event.kind,
            toolName: event.toolName, target: event.target,
            intention: event.intention,
            allowedDecisions: event.allowedDecisions,
            layer: event.layer, personaHandle: event.personaHandle,
            responded: false,
            timestamp: new Date().toISOString(),
          } as SandboxBlockMessage);
          existingSandboxBlockIds.add(event.requestId);
        }
        break;

      case 'session.error':
        result = finalizeMessages(result);
        result.push({
          id: genId(), type: 'session_event', eventType: 'error',
          message: event.message, timestamp: new Date().toISOString(),
        } as SessionEventMessage);
        break;

      case 'subagent.started':
        if (existingToolCallIds.has(event.toolCallId)) {
          result = result.map(m => m.type === 'tool_call' && m.toolCallId === event.toolCallId
            ? { ...m, toolName: '__subagent__', args: {
                ...m.args, name: event.name, displayName: event.displayName,
                description: event.description, agentType: event.name,
                agentId: event.agentId ?? m.args.agentId,
              } }
            : m);
        } else {
          result.push({
            id: genId(), type: 'tool_call',
            toolCallId: event.toolCallId, toolName: '__subagent__',
            args: {
              name: event.name, displayName: event.displayName,
              description: event.description, agentType: event.name,
              agentId: event.agentId, completed: false,
            },
            completed: false, timestamp: new Date().toISOString(),
          } as ToolCallMessage);
          existingToolCallIds.add(event.toolCallId);
        }
        break;

      case 'subagent.completed':
        result = result.map(m =>
          m.type === 'tool_call' && m.toolCallId === event.toolCallId
            ? { ...m, completed: true, success: true, args: { ...m.args, completed: true, success: true, agentId: event.agentId ?? m.args.agentId, durationMs: event.durationMs, model: event.model, totalTokens: event.totalTokens, totalToolCalls: event.totalToolCalls } }
            : m
        );
        break;

      case 'subagent.failed':
        result = result.map(m =>
          m.type === 'tool_call' && m.toolCallId === event.toolCallId
            ? { ...m, completed: true, success: false, args: { ...m.args, completed: true, success: false, error: event.error, agentId: event.agentId ?? m.args.agentId } }
            : m
        );
        break;

    }
  }

  return localTermination ? [...finalizeMessages(result), localTermination] : result;
}

export function ChatView(props: ChatViewProps) {
  return <ChatSession key={props.agentId || 'new'} {...props} />;
}

function ChatSession({ agentId: initialAgentId, agentPrompt, agentStatus: initialStatus, agentSource, spaceId, sandboxed: initialSandboxed, yolo: initialYolo, pendingApprovalId, pendingPermissionKind, onClose, onOpenCli, onOpenCanvas, historySource }: ChatViewProps) {
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(initialAgentId || null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    // For CLI sessions or sessions with history, don't seed — history will load
    if (initialAgentId && agentSource === 'cli') return [];
    // Seed with the initial agent prompt as the first "user" message
    const seed: ChatMessage[] = [];
    if (agentPrompt) {
      seed.push({
        id: genId(),
        type: 'user',
        content: agentPrompt,
        timestamp: new Date().toISOString(),
      });
    }
    // Seed pending approval if agent is waiting when chat opens
    if (initialAgentId && pendingApprovalId && pendingPermissionKind) {
      seed.push({
        id: genId(),
        type: 'approval',
        requestId: pendingApprovalId,
        agentId: initialAgentId,
        permissionKind: pendingPermissionKind,
        responded: false,
        timestamp: new Date().toISOString(),
      } as ApprovalMessage);
    }
    return seed;
  });
  const [isBusy, setIsBusy] = useState(initialStatus === 'running' && agentSource !== 'cli');
  const [status, setStatus] = useState(initialAgentId ? initialStatus : 'new');
  const [isWaitingForInput, setIsWaitingForInput] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(!!initialAgentId);
  const pageCursor = useRef<string | null>(null);
  const snapshotWatermark = useRef(0);
  const [hasOlder, setHasOlder] = useState(false);
  const loadOlder = useCallback(async () => {
    if (!currentAgentId || !pageCursor.current) return [];
    const page = await whimAPI.getAgentHistoryPage(currentAgentId, { cursor: pageCursor.current });
    pageCursor.current = page.nextCursor;
    setHasOlder(!!page.nextCursor);
    return page.items;
  }, [currentAgentId]);
  const backendHistory = useMemo<ChatHistorySource>(() => ({ hasOlder, loadOlder }), [hasOlder, loadOlder]);
  const historyPaging = useHistoryPaging(isLoadingHistory ? undefined : historySource ?? backendHistory, setMessages);
  const [models, setModels] = useState<{ id: string; name?: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [cwd, setCwd] = useState<string>('');
  const [overlayAgentId, setOverlayAgentId] = useState<string | null>(null);
  const [yoloEnabled, setYoloEnabled] = useState(initialYolo ?? false);
  const [sandboxActive, setSandboxActive] = useState(initialSandboxed ?? false);
  const [sandboxDisabling, setSandboxDisabling] = useState(false);
  const [remoteState, setRemoteState] = useState<{ enabled: boolean; remoteSteerable: boolean; url?: string }>({ enabled: false, remoteSteerable: false });
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteResetting, setRemoteResetting] = useState(false);
  const [remoteHint, setRemoteHint] = useState<string | null>(null);
  const remoteHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showRemoteOverlay, setShowRemoteOverlay] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const remoteErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const [hasCanvas, setHasCanvas] = useState(false);

  // Probe whether this space has a canvas with content. Re-check on canvas updates.
  useEffect(() => {
    if (!spaceId || !onOpenCanvas) {
      setHasCanvas(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await whimAPI.canvasHasContent(spaceId);
        if (!cancelled) setHasCanvas(!!res?.hasContent);
      } catch {
        if (!cancelled) setHasCanvas(false);
      }
    };
    check();
    const off = whimAPI.onCanvasContentUpdated?.((data: { spaceId: string; content: string }) => {
      if (data.spaceId === spaceId) {
        setHasCanvas(data.content.trim().length > 0);
      }
    });
    return () => {
      cancelled = true;
      if (typeof off === 'function') off();
    };
  }, [spaceId, onOpenCanvas]);

  const eventBatchRef = useRef<ReturnType<typeof createEventBatch> | null>(null);
  const eventRevision = useRef(0);
  const liveStatusObserved = useRef(false);
  // Track whether history has been applied so buffered events can be merged
  const historyLoadedRef = useRef(!initialAgentId);
  // Buffer ALL events that arrive before history loads for replay with dedup
  const pendingEvents = useRef<ChatEvent[]>([]);
  const historyTermination = useRef<SessionEventMessage | undefined>(undefined);
  useEffect(() => {
    setIsWaitingForInput(messages.some(hasPendingInteraction));
  }, [messages]);

  // Load available models
  useEffect(() => {
    (async () => {
      const [modelList, currentModel] = await Promise.all([
        whimAPI.listModels(),
        whimAPI.getSetting('model'),
      ]);
      setModels(modelList);
      if (currentModel) setSelectedModel(currentModel);
      else if (modelList.length > 0) setSelectedModel(modelList[0].id);
    })();
  }, []);

  // Load CWD from agent's persisted working_dir, fall back to workspace root
  useEffect(() => {
    (async () => {
      if (currentAgentId) {
        try {
          const workingDir = await (whimAPI as any).getAgentWorkingDir?.(currentAgentId);
          if (workingDir) { setCwd(workingDir); return; }
        } catch { /* fall through */ }
      }
      const val = await whimAPI.getSetting('workspace_root');
      if (val) setCwd(val);
    })();
    whimAPI.onWorkspaceChanged((path) => setCwd(path || ''));
  }, [currentAgentId]);

  // Close model dropdown on outside click
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelDropdownOpen]);

  // Listen for yolo mode changes
  useEffect(() => {
    whimAPI.onAgentYoloChanged((data: { agentId: string; enabled: boolean }) => {
      if (data.agentId === currentAgentId) {
        setYoloEnabled(data.enabled);
      }
    });
  }, [currentAgentId]);

  // Listen for remote control changes
  useEffect(() => {
    whimAPI.onAgentRemoteChanged((data: { agentId: string; enabled: boolean; remoteSteerable: boolean; url?: string }) => {
      if (data.agentId === currentAgentId) {
        setRemoteState({ enabled: data.enabled, remoteSteerable: data.remoteSteerable, url: data.url });
      }
    });
  }, [currentAgentId]);

  // Seed remote state from main process when the agent changes (e.g. ChatView
  // remount or navigation back to a session that already has remote enabled).
  // This is what makes the QR URL "stick" for the life of the session.
  useEffect(() => {
    if (!currentAgentId) return;
    let cancelled = false;
    (async () => {
      const api = whimAPI as typeof whimAPI & {
        getAgentRemoteState?: (agentId: string) => Promise<
          { enabled: boolean; remoteSteerable: boolean; url?: string } | { error: string }
        >;
      };
      if (!api.getAgentRemoteState) return;
      try {
        const result = await api.getAgentRemoteState(currentAgentId);
        if (cancelled) return;
        if ('error' in result) return;
        setRemoteState({
          enabled: result.enabled,
          remoteSteerable: result.remoteSteerable,
          url: result.url,
        });
      } catch (err) {
        console.warn('[chat] getAgentRemoteState failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentAgentId]);

  // Generate QR code when remote URL changes
  useEffect(() => {
    if (remoteState.url) {
      QRCode.toDataURL(remoteState.url, { width: 200, margin: 2 })
        .then(url => setQrDataUrl(url))
        .catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
  }, [remoteState.url]);

  // Load conversation history for existing agents (especially CLI sessions)
  useEffect(() => {
    if (!currentAgentId) return;
    historyLoadedRef.current = false;
    setIsLoadingHistory(true);
    const baselineIds = new Set(messages.map(message => message.id));
    let cancelled = false;
    let liveRevision = 0;
    const observedRevision = () => eventRevision.current;
    (async () => {
      try {
        const page = typeof whimAPI.getAgentHistoryPage === 'function'
          ? await whimAPI.getAgentHistoryPage(currentAgentId) : undefined;
        if (cancelled) return;
        const result = !page || page.legacySession
          ? await whimAPI.getAgentHistory(currentAgentId) : {};
        if (cancelled) return;
        pageCursor.current = page?.nextCursor ?? null;
        snapshotWatermark.current = page?.watermark ?? 0;
        setHasOlder(!!page?.nextCursor);
        eventBatchRef.current?.flush();
        const buffered = pendingEvents.current.filter(event =>
          event.sequence === undefined || !page || event.sequence > page.watermark);
        const localTermination = historyTermination.current;
        pendingEvents.current = [];
        historyLoadedRef.current = true;
        liveRevision = observedRevision();
        if (buffered.some(event => event.type === 'sandbox.disabled')) setSandboxActive(false);
        if (page?.items.length || (result.events && result.events.length > 0)) {
          const historyMessages = page?.items.length ? page.items : parseHistoryEvents(result.events!);
          if (historyMessages.length > 0) {
            setMessages(prev => {
              // Preserve seeded pending approval only if not already in history
              const pendingApproval = prev.find(m => m.type === 'approval');
              let msgs = historyMessages;
              if (pendingApproval && !msgs.some(
                m => m.type === 'approval' && m.requestId === (pendingApproval as ApprovalMessage).requestId
              )) {
                msgs = [...msgs, pendingApproval];
              }
              // Do not erase locally queued follow-ups while the snapshot is in flight.
              const localIds = new Set(prev.filter(message => !baselineIds.has(message.id)).map(message => message.id));
              const merged = replayBufferedEvents(mergeHistoryWithLocal(msgs, prev, localIds), buffered, localTermination);
              return merged;
            });
          } else {
            // History returned events but none were parseable — still replay buffered events
            setMessages(prev => {
              const merged = replayBufferedEvents(prev, buffered, localTermination);
              return merged;
            });
          }
        } else if ('error' in result && result.error) {
          // Resume failed — show error as session event so user knows why history is missing
          setMessages(prev => {
            const errorMsg: ChatMessage = {
              id: genId(),
              type: 'session_event',
              eventType: 'error',
              message: result.error as string,
              timestamp: new Date().toISOString(),
            };
            const merged = replayBufferedEvents([...prev, errorMsg], buffered, localTermination);
            return merged;
          });
        } else if (result.restarted) {
          // Session was recreated after expiry — show informational notice
          setMessages(prev => {
            const restartMsg: ChatMessage = {
              id: genId(),
              type: 'session_event',
              eventType: 'info',
              message: 'Previous session expired — started a fresh session with context from the original conversation.',
              timestamp: new Date().toISOString(),
            };
            const merged = replayBufferedEvents([...prev, restartMsg], buffered, localTermination);
            return merged;
          });
        } else {
          // No history events — replay buffered events against seeded messages
          setMessages(prev => {
            const merged = replayBufferedEvents(prev, buffered, localTermination);
            return merged;
          });
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[ChatView] Failed to load history:', err);
        eventBatchRef.current?.flush();
        const buffered = pendingEvents.current;
        const localTermination = historyTermination.current;
        pendingEvents.current = [];
        historyLoadedRef.current = true;
        liveRevision = observedRevision();
        // Show error and replay any buffered events so they aren't lost
        setMessages(prev => {
          const errorMsg: ChatMessage = {
            id: genId(),
            type: 'session_event',
            eventType: 'error',
            message: `Failed to load conversation history: ${err instanceof Error ? err.message : 'Unknown error'}`,
            timestamp: new Date().toISOString(),
          };
          const merged = replayBufferedEvents([...prev, errorMsg], buffered, localTermination);
          return merged;
        });
      }
      if (cancelled) return;
      historyLoadedRef.current = true;
      setIsLoadingHistory(false);

      // A status snapshot must not overwrite newer live activity.
      try {
        const match = typeof whimAPI.getAgent === 'function'
          ? await whimAPI.getAgent(currentAgentId)
          : (await whimAPI.listAllAgents()).find((a: any) => a.agentId === currentAgentId);
        if (cancelled || observedRevision() !== liveRevision || liveStatusObserved.current) return;
        if (match) {
          const backendStatus = match.status;
          if (backendStatus === 'completed' || backendStatus === 'failed') {
            setIsBusy(false);
            setStatus(backendStatus);
          } else if (backendStatus === 'waiting-approval') {
            setIsWaitingForInput(true);
            setStatus('waiting-approval');
          } else if (backendStatus === 'running') {
            setIsBusy(true);
            setStatus('running');
          }
        }
      } catch (error) {
        if (!cancelled) console.warn('[ChatView] Failed to reconcile agent status:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [currentAgentId]);

  // Subscribe to chat events immediately — buffer all events until history loads
  useEffect(() => {
    if (!currentAgentId) return;
    let active = true;
    const batch = createEventBatch((event: ChatEvent) => {
      if (!active) return;
      if (event.type === 'session.idle' || event.type === 'session.error') {
        liveStatusObserved.current = true;
        setIsBusy(false);
        setStatus(event.type === 'session.idle' ? 'completed' : 'failed');
      } else if (event.type === 'assistant.message_delta' || event.type === 'assistant.reasoning_delta' ||
        event.type === 'tool.start') {
        liveStatusObserved.current = true;
        setIsBusy(true);
        setStatus('running');
      }
      // Buffer ALL events that arrive before history loads for deduped replay
      if (!historyLoadedRef.current) {
        pendingEvents.current.push(event);
        return;
      }

      switch (event.type) {
        case 'assistant.message_delta': {
          const id = genId();
          const timestamp = new Date().toISOString();
          setMessages(prev => applyStreamEvent(prev, event, id, timestamp));
          break;
        }

        case 'assistant.message': {
          const id = genId();
          const timestamp = new Date().toISOString();
          setMessages(prev => applyStreamEvent(prev, event, id, timestamp));
          break;
        }

        case 'assistant.reasoning_delta': {
          const id = genId();
          const timestamp = new Date().toISOString();
          setMessages(prev => applyStreamEvent(prev, event, id, timestamp));
          break;
        }

        case 'assistant.reasoning': {
          const id = genId();
          const timestamp = new Date().toISOString();
          setMessages(prev => applyStreamEvent(prev, event, id, timestamp));
          break;
        }

        case 'tool.start': {
          setMessages(prev => prev.some(m => m.type === 'tool_call' && m.toolCallId === event.toolCallId) ? prev : [...prev, {
            id: genId(),
            type: 'tool_call',
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            completed: false,
            timestamp: new Date().toISOString(),
          } as ToolCallMessage]);
          break;
        }

        case 'tool.progress': {
          const id = genId();
          const timestamp = new Date().toISOString();
          setMessages(prev => applyStreamEvent(prev, event, id, timestamp));
          break;
        }

        case 'tool.complete': {
          setMessages(prev => prev.map(m =>
            m.type === 'tool_call' && m.toolCallId === event.toolCallId
              ? { ...m, completed: true, success: event.success, result: event.result, error: event.error }
              : m
          ));
          break;
        }

        case 'session.idle': {
          // Surface a clear inline "Completed" entry as the latest item in the
          // timeline so the user immediately sees that the agent finished —
          // replaces the old "Completed" badge that used to live in the header.
          // Avoid emitting a duplicate completion entry if the previous run
          // was already terminated (e.g. by handleAbort emitting "Stopped by
          // user" just before the SDK fires session.idle on the dead session).
          setMessages(prev => {
            const last = prev[prev.length - 1];
            const alreadyTerminated =
              last && last.type === 'session_event' &&
              (last.eventType === 'completed' || last.eventType === 'error');
            if (alreadyTerminated) return prev;
            return [...prev, {
              id: genId(),
              type: 'session_event',
              eventType: 'completed',
              message: 'Completed',
              timestamp: new Date().toISOString(),
            } as SessionEventMessage];
          });
          setIsBusy(false);
          setStatus('completed');
          setIsWaitingForInput(false);
          finalizeStreamingMessages();
          break;
        }

        case 'session.error': {
          setIsBusy(false);
          setStatus('failed');
          setIsWaitingForInput(false);
          finalizeStreamingMessages();
          setMessages(prev => [...prev, {
            id: genId(),
            type: 'session_event',
            eventType: 'error',
            message: event.message,
            timestamp: new Date().toISOString(),
          } as SessionEventMessage]);
          break;
        }

        case 'session.restarted': {
          finalizeStreamingMessages();
          setMessages(prev => [...prev, {
            id: genId(),
            type: 'session_event',
            eventType: 'info',
            message: event.message || 'Previous session expired — started a fresh session with context.',
            timestamp: new Date().toISOString(),
          } as SessionEventMessage]);
          break;
        }

        case 'sandbox.disabled': {
          setSandboxActive(false);
          // Mark any pending sandbox block messages as resolved with 'disable'
          // so the user sees consistent state in the chat thread when the
          // disable came from outside this window (Workers tab, OS toast).
          setMessages(prev => prev.map(m =>
            m.type === 'sandbox_block' && !m.responded
              ? { ...m, responded: true, decision: 'disable' as const }
              : m
          ));
          setMessages(prev => [...prev, {
            id: genId(),
            type: 'session_event',
            eventType: 'info',
            message: 'Sandbox disabled for this session.',
            timestamp: new Date().toISOString(),
          } as SessionEventMessage]);
          break;
        }

        case 'sandbox.blocked': {
          // Surface the block inline so the user can resolve it without
          // switching to the Workers tab. The broker also fires the global
          // `agent:sandbox-blocked` event (handled in app.ts) which keeps the
          // agentStore in sync — both paths render so cross-window dismissal
          // continues to work via `sandbox.resolved`.
          setMessages(prev => {
            // Guard against duplicate emission (e.g. replay race).
            if (prev.some(m => m.type === 'sandbox_block' && m.requestId === event.requestId)) {
              return prev;
            }
            return [...prev, {
              id: genId(),
              type: 'sandbox_block',
              requestId: event.requestId,
              agentId: event.agentId,
              source: event.source,
              kind: event.kind,
              toolName: event.toolName,
              target: event.target,
              intention: event.intention,
              allowedDecisions: event.allowedDecisions,
              layer: event.layer,
              personaHandle: event.personaHandle,
              responded: false,
              timestamp: new Date().toISOString(),
            } as SandboxBlockMessage];
          });
          break;
        }

        case 'sandbox.resolved': {
          setIsWaitingForInput(false);
          setMessages(prev => prev.map(m =>
            m.type === 'sandbox_block' && m.requestId === event.requestId
              ? { ...m, responded: true, decision: event.decision }
              : m
          ));
          break;
        }

        case 'approval.needed': {
          setMessages(prev => prev.some(m => m.type === 'approval' && m.requestId === event.requestId) ? prev : [...prev, {
            id: genId(),
            type: 'approval',
            requestId: event.requestId,
            agentId: event.agentId,
            permissionKind: event.permissionKind,
            intention: event.intention,
            path: event.path,
            responded: false,
            timestamp: new Date().toISOString(),
          } as ApprovalMessage]);
          break;
        }

        case 'approval.resolved': {
          setIsWaitingForInput(false);
          setMessages(prev => prev.map(m =>
            m.type === 'approval' && m.requestId === event.requestId
              ? { ...m, responded: true, approved: event.approved }
              : m
          ));
          break;
        }

        case 'user_input.requested': {
          setMessages(prev => prev.some(m => m.type === 'user_input' && m.requestId === event.requestId) ? prev : [...prev, {
            id: genId(),
            type: 'user_input',
            requestId: event.requestId,
            agentId: event.agentId,
            question: event.question,
            choices: event.choices,
            allowFreeform: event.allowFreeform,
            responded: false,
            timestamp: new Date().toISOString(),
          } as UserInputMessage]);
          break;
        }

        case 'user_input.resolved': {
          setIsWaitingForInput(false);
          setMessages(prev => prev.map(m =>
            m.type === 'user_input' && m.requestId === event.requestId
              ? { ...m, responded: true, answer: event.answer, wasFreeform: event.wasFreeform }
              : m
          ));
          break;
        }

        case 'elicitation.requested': {
          setMessages(prev => prev.some(m => m.type === 'elicitation' && m.requestId === event.requestId) ? prev : [...prev, {
            id: genId(),
            type: 'elicitation',
            requestId: event.requestId,
            agentId: event.agentId,
            message: event.message,
            requestedSchema: event.requestedSchema,
            mode: event.mode,
            elicitationSource: event.elicitationSource,
            responded: false,
            timestamp: new Date().toISOString(),
          } as ElicitationMessage]);
          break;
        }

        case 'elicitation.resolved': {
          setIsWaitingForInput(false);
          setMessages(prev => prev.map(m =>
            m.type === 'elicitation' && m.requestId === event.requestId
              ? { ...m, responded: true, action: event.action, content: event.content }
              : m
          ));
          break;
        }

        case 'subagent.started': {
          setMessages(prev => replayBufferedEvents(prev, [event]));
          break;
        }

        case 'subagent.completed': {
          setMessages(prev => prev.map(m =>
            m.type === 'tool_call' && m.toolCallId === event.toolCallId
              ? {
                  ...m,
                  completed: true,
                  success: true,
                  args: {
                    ...m.args,
                    completed: true,
                    success: true,
                    agentId: event.agentId ?? m.args.agentId,
                    durationMs: event.durationMs,
                    model: event.model,
                    totalTokens: event.totalTokens,
                    totalToolCalls: event.totalToolCalls,
                  },
                }
              : m
          ));
          break;
        }

        case 'subagent.failed': {
          setMessages(prev => prev.map(m =>
            m.type === 'tool_call' && m.toolCallId === event.toolCallId
              ? {
                  ...m,
                  completed: true,
                  success: false,
                  args: {
                    ...m.args,
                    completed: true,
                    success: false,
                    error: event.error,
                    agentId: event.agentId ?? m.args.agentId,
                  },
                }
              : m
          ));
          break;
        }
      }
    });

    eventBatchRef.current = batch;
    const seen = new Set<string>();
    const unsubscribe = whimAPI.onChatEvent(currentAgentId, event => {
      if (!active) return;
      if (event.sequence !== undefined && event.sequence <= snapshotWatermark.current) return;
      if (event.eventId) {
        if (seen.has(event.eventId)) return;
        seen.add(event.eventId);
        if (seen.size > 4096) seen.delete(seen.values().next().value!);
      }
      eventRevision.current++;
      batch.push(event);
    });
    return () => {
      active = false;
      batch.dispose();
      eventBatchRef.current = null;
      unsubscribe();
    };
  }, [currentAgentId]);

  const handleSend = useCallback(async (message: string, attachments?: Array<{ type: 'file'; name: string; path: string }>) => {
    const chatAttachments: ChatAttachment[] | undefined = attachments?.map(a => ({
      type: a.type,
      name: a.name,
      path: a.path,
    }));

    // Add user message to state
    const localId = genId();
    setMessages(prev => [...prev, {
      id: localId,
      type: 'user',
      content: message,
      attachments: chatAttachments,
      timestamp: new Date().toISOString(),
    }]);
    setIsBusy(true);
    setStatus('running');

    // If no agent yet, create one with this first message
    if (!currentAgentId) {
      // Parse leading @persona mention (mirrors the workers-tab launcher in
      // src/renderer/app.ts so chat-view first-message launches honor the
      // persona's run location, model, sandboxing, etc.). The IPC handler
      // validates the handle and returns `Persona @x not found` if invalid,
      // in which case we surface the error instead of silently dropping it.
      let prompt = message;
      let personaHandle: string | undefined;
      const mentionMatch = message.match(/^@([a-z0-9][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/i);
      if (mentionMatch) {
        personaHandle = mentionMatch[1].toLowerCase();
        prompt = (mentionMatch[2] || '').trim();
        if (!prompt) {
          // "@handle" with no follow-up — keep the @mention as the prompt
          // so the launcher has something to act on rather than failing.
          prompt = message;
          personaHandle = undefined;
        }
      }
      const launchResult = await whimAPI.quickLaunchAgent(prompt, personaHandle);
      if ('error' in launchResult && launchResult.error) {
        setMessages(prev => [...prev, {
          id: genId(),
          type: 'session_event',
          eventType: 'error',
          message: launchResult.error,
          timestamp: new Date().toISOString(),
        } as SessionEventMessage]);
        setIsBusy(false);
        setStatus('failed');
        return;
      }
      // Set the new agent ID — useEffect will pick up the subscription
      setCurrentAgentId((launchResult as { agentId: string }).agentId);
      return;
    }

    const result = await whimAPI.sendChatMessage(currentAgentId, message, chatAttachments);
    if (result.messageId) setMessages(current => acknowledgeUserMessage(current, localId, result.messageId!));
    if (result.error) {
      setMessages(prev => [...prev, {
        id: genId(),
        type: 'session_event',
        eventType: 'error',
        message: result.error,
        timestamp: new Date().toISOString(),
      } as SessionEventMessage]);
      setIsBusy(false);
    }
  }, [currentAgentId]);

  const handleApprovalRespond = useCallback((requestId: string, approved: boolean) => {
    if (!currentAgentId) return;
    whimAPI.approveAgent(currentAgentId, requestId, approved);
    setMessages(prev => prev.map(m =>
      m.type === 'approval' && m.requestId === requestId
        ? { ...m, responded: true, approved }
        : m
    ));
  }, [currentAgentId]);

  const handleUserInputRespond = useCallback((requestId: string, answer: string, wasFreeform: boolean) => {
    if (!currentAgentId) return;
    whimAPI.respondToUserInput(currentAgentId, requestId, answer, wasFreeform);
    setMessages(prev => prev.map(m =>
      m.type === 'user_input' && m.requestId === requestId
        ? { ...m, responded: true, answer, wasFreeform }
        : m
    ));
  }, [currentAgentId]);

  const handleElicitationRespond = useCallback((requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>) => {
    if (!currentAgentId) return;
    whimAPI.respondToElicitation(currentAgentId, requestId, action, content);
    setMessages(prev => prev.map((m): ChatMessage =>
      m.type === 'elicitation' && m.requestId === requestId
        ? { ...m, responded: true, action, content: content as ElicitationMessage['content'] }
        : m
    ));
  }, [currentAgentId]);

  const handleSandboxResolve = useCallback((
    agentId: string,
    requestId: string,
    decision: 'allow-once' | 'allow-for-session' | 'disable',
  ) => {
    // Optimistically mark resolved so the UI doesn't double-fire if the user
    // clicks twice; the broker also broadcasts `sandbox.resolved` which is
    // idempotent against this state.
    setMessages(prev => prev.map(m =>
      m.type === 'sandbox_block' && m.requestId === requestId
        ? { ...m, responded: true, decision }
        : m
    ));
    whimAPI.resolveSandboxBlock(agentId, requestId, decision).catch(err => {
      console.error('[ChatView] resolveSandboxBlock failed:', err);
    });
  }, []);

  const handleEditSandboxConfig = useCallback((personaHandle: string) => {
    try {
      whimAPI.openPersonaSandboxEditor(personaHandle);
    } catch (err) {
      console.error('[ChatView] openPersonaSandboxEditor failed:', err);
    }
  }, []);

  const handleModelSwitch = useCallback(async (modelId: string) => {
    setSelectedModel(modelId);
    setModelDropdownOpen(false);
    if (currentAgentId) await whimAPI.setChatModel(currentAgentId, modelId);
  }, [currentAgentId]);

  const handleBrowseCwd = useCallback(async () => {
    await whimAPI.selectWorkspace();
  }, []);

  const handleToggleYolo = useCallback(async () => {
    if (currentAgentId) {
      await whimAPI.setAgentYolo(currentAgentId, !yoloEnabled);
    }
  }, [currentAgentId, yoloEnabled]);

  const handleDisableSandbox = useCallback(async () => {
    if (!currentAgentId || sandboxDisabling) return;
    setSandboxDisabling(true);
    try {
      const result = await whimAPI.disableSandbox(currentAgentId);
      if (!result?.error) setSandboxActive(false);
    } finally {
      setSandboxDisabling(false);
    }
  }, [currentAgentId, sandboxDisabling]);

  const showRemoteError = useCallback((msg: string) => {
    if (remoteErrorTimer.current) clearTimeout(remoteErrorTimer.current);
    setRemoteError(msg);
    remoteErrorTimer.current = setTimeout(() => setRemoteError(null), 4000);
  }, []);

  const handleToggleRemote = useCallback(async () => {
    if (!currentAgentId) return;
    setRemoteError(null);
    setRemoteLoading(true);
    try {
      if (remoteState.enabled) {
        await whimAPI.disableRemote(currentAgentId);
        setShowRemoteOverlay(false);
      } else {
        const result = await whimAPI.enableRemote(currentAgentId);
        if ('error' in result && result.error) {
          console.error('[remote] Enable failed:', result.error);
          showRemoteError(result.error);
        } else if (result.url) {
          setShowRemoteOverlay(true);
        } else {
          showRemoteError('Remote enabled but no link was returned. Is this a GitHub repository?');
        }
      }
    } catch (err: any) {
      console.error('[remote] Enable threw:', err);
      showRemoteError(err.message || 'Failed to enable remote control');
    } finally {
      setRemoteLoading(false);
    }
  }, [currentAgentId, remoteState.enabled, showRemoteError]);

  const showRemoteHint = useCallback((msg: string) => {
    if (remoteHintTimer.current) clearTimeout(remoteHintTimer.current);
    setRemoteHint(msg);
    remoteHintTimer.current = setTimeout(() => setRemoteHint(null), 3000);
  }, []);

  const handleResetRemote = useCallback(async () => {
    if (!currentAgentId) return;
    const api = whimAPI as typeof whimAPI & {
      resetAgentRemote?: (agentId: string) => Promise<
        { enabled: boolean; remoteSteerable: boolean; url?: string; changed: boolean } | { error: string }
      >;
    };
    if (!api.resetAgentRemote) {
      showRemoteError('Reset is not available in this build');
      return;
    }
    setRemoteError(null);
    setRemoteHint(null);
    setRemoteResetting(true);
    try {
      const result = await api.resetAgentRemote(currentAgentId);
      if ('error' in result) {
        showRemoteError(result.error);
      } else if (!result.url) {
        showRemoteError('Remote was reset but no link was returned.');
      } else {
        showRemoteHint(result.changed ? 'Generated a new link' : 'Link is unchanged');
      }
    } catch (err: any) {
      console.error('[remote] Reset threw:', err);
      showRemoteError(err.message || 'Failed to reset remote control');
    } finally {
      setRemoteResetting(false);
    }
  }, [currentAgentId, showRemoteError, showRemoteHint]);

  const finalizeStreamingMessages = useCallback(() => {
    eventBatchRef.current?.flush();
    setMessages(finalizeMessages);
  }, []);

  const handleAbort = useCallback(async () => {
    if (!currentAgentId) return;
    eventBatchRef.current?.flush();
    // Optimistic UI update — stop showing working state immediately
    setIsBusy(false);
    setStatus('failed');
    setIsWaitingForInput(false);
    finalizeStreamingMessages();
    // Surface an inline timeline entry so the abort is visible alongside
    // other session events (mirrors the new 'completed' entry emitted on
    // session.idle below).
    const stoppedMessage: SessionEventMessage = {
      id: genId(),
      type: 'session_event',
      eventType: 'error',
      message: 'Stopped by user',
      timestamp: new Date().toISOString(),
    };
    if (!historyLoadedRef.current) historyTermination.current = stoppedMessage;
    setMessages(prev => [...prev, stoppedMessage]);
    // Fire backend abort (errors are non-fatal)
    void whimAPI.abortAgent(currentAgentId).catch(() => {});
  }, [currentAgentId, finalizeStreamingMessages]);

  const selectedModelInfo = models.find(m => m.id === selectedModel);
  const cwdFolderName = cwd ? cwd.split('/').pop() || cwd : '';

  // Derive streaming preview text from current messages (no extra state needed)
  const streamingPreviews = useMemo(() => {
    let thinkingPreview: string | undefined;
    let outputPreview: string | undefined;
    let activeToolName: string | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!activeToolName && m.type === 'tool_call' && !m.completed && m.toolName !== '__subagent__') {
        activeToolName = m.toolName;
      }
      if (m.type === 'reasoning' && m.isStreaming && m.content) {
        // Take last ~80 chars of thinking content
        const text = m.content.replace(/\s+/g, ' ').trim();
        thinkingPreview = text.length > 80 ? '…' + text.slice(-80) : text;
        break;
      }
      if (m.type === 'assistant' && m.isStreaming && m.content) {
        const text = m.content.replace(/\s+/g, ' ').trim();
        outputPreview = text.length > 80 ? '…' + text.slice(-80) : text;
        break;
      }
      // Stop scanning if we hit a non-streaming message type that isn't a tool
      if (m.type === 'user' || (m.type === 'assistant' && !m.isStreaming)) break;
    }
    return { thinkingPreview, outputPreview, activeToolName };
  }, [messages]);

  // Show working indicator only when actively running (not waiting for user input)
  const showWorkingIndicator = isBusy && !isWaitingForInput;

  // Toolbar above the prompt input: cwd + model picker + yolo toggle. Kept
  // inline here (rather than its own component) so all the state and handlers
  // stay co-located with the rest of the chat view. Order: working directory
  // (left) → model → yolo. Cwd lives here (rather than a separate top status
  // bar) to consolidate the agent's configuration into a single row right
  // above the prompt, freeing up vertical space.
  const promptToolbar = (
    <>
      <button
        className={`chat-status-bar-item ${!cwd ? 'warning' : ''}`}
        onClick={handleBrowseCwd}
        title={cwd || 'Click to set working directory'}
      >
        <span className="chat-status-bar-icon">{cwd ? '📂' : '⚠️'}</span>
        <span className="chat-status-bar-text">
          {cwdFolderName || '(no directory)'}
        </span>
        <span className="chat-status-bar-chevron">▾</span>
      </button>
      {cwd && (
        <button
          className="chat-status-bar-item"
          onClick={() => whimAPI.openPath(cwd)}
          title="Open folder in file manager"
        >
          <span className="chat-status-bar-icon">↗</span>
        </button>
      )}

      <span className="chat-status-bar-divider">|</span>

      <div className="chat-prompt-toolbar-dropdown" ref={modelDropdownRef}>
        <button
          className="chat-status-bar-item"
          onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
        >
          <span className="chat-status-bar-icon">🧠</span>
          <span className="chat-status-bar-text">
            {selectedModelInfo?.name || selectedModel || 'Select model'}
          </span>
          <span className={`chat-status-bar-chevron ${modelDropdownOpen ? 'open' : ''}`}>▾</span>
        </button>

        {modelDropdownOpen && (
          <div className="chat-model-dropdown chat-model-dropdown-up">
            {models.map((m) => {
              const isSelected = m.id === selectedModel;
              return (
                <button
                  key={m.id}
                  className={`chat-model-dropdown-item ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleModelSwitch(m.id)}
                >
                  <span className="chat-model-dropdown-name">
                    {isSelected ? '✓ ' : ''}{m.name || m.id}
                  </span>
                </button>
              );
            })}
            {models.length === 0 && (
              <div className="chat-model-dropdown-empty">Loading…</div>
            )}
          </div>
        )}
      </div>

      <span className="chat-status-bar-divider">|</span>

      <button
        className={`chat-status-bar-item chat-yolo-btn${yoloEnabled ? ' active' : ''}`}
        onClick={handleToggleYolo}
        title={yoloEnabled ? 'Yolo mode ON — auto-approving all permissions' : 'Enable yolo mode (auto-approve all)'}
      >
        <span className="chat-status-bar-icon">🔥</span>
        <span className="chat-status-bar-text">
          {yoloEnabled ? 'YOLO' : 'Yolo'}
        </span>
      </button>
    </>
  );

  return (
    <div className="chat-container">
      <header className="chat-header">
        <button className="header-icon-btn" onClick={onClose} title="Back (Esc)">←</button>
        <div className="chat-header-info">
          {agentPrompt && (
            <span className="chat-header-title" title={agentPrompt}>
              {agentPrompt.length > 80 ? agentPrompt.slice(0, 77) + '…' : agentPrompt}
            </span>
          )}
        </div>
        <div className="header-actions">
          {spaceId && onOpenCanvas && hasCanvas && (
            <button className="header-icon-btn" onClick={() => onOpenCanvas(spaceId)} title="Open canvas">
              📄
            </button>
          )}
          {currentAgentId && (
            <button className="header-icon-btn" onClick={() => onOpenCli(currentAgentId)} title="Open in CLI">
              ⌨️
            </button>
          )}
          {agentSource !== 'cli' && (
            <button
              className={`header-icon-btn chat-remote-icon-btn${remoteState.enabled ? ' active' : ''}`}
              onClick={remoteState.enabled && remoteState.url ? () => setShowRemoteOverlay(true) : handleToggleRemote}
              disabled={remoteLoading}
              title={remoteState.enabled ? 'Remote control enabled — click to view link' : 'Enable remote control (Mission Control)'}
              aria-label={remoteState.enabled ? 'Remote control enabled' : 'Enable remote control'}
            >
              {remoteLoading ? '⏳' : '📱'}
            </button>
          )}
        </div>
        {remoteError && (
          <span className="remote-error-toast">{remoteError}</span>
        )}
      </header>

      {/* Sandbox security banner — only renders when this session is sandboxed.
          Stretches full-width to read as a prominent trust signal (and replaces
          the old chat-status-bar entirely; cwd/model/yolo moved into the
          toolbar directly above the prompt input). */}
      {sandboxActive && (
        <button
          className="chat-sandbox-banner"
          onClick={handleDisableSandbox}
          disabled={sandboxDisabling}
          title="Sandbox active — click to disable for this session"
        >
          <span className="chat-sandbox-banner-icon">{sandboxDisabling ? '⏳' : '🔒'}</span>
          <span className="chat-sandbox-banner-label">Sandbox active</span>
          <span className="chat-sandbox-banner-sub">
            {sandboxDisabling ? 'Disabling…' : 'Tool calls are confined for this session — click to disable'}
          </span>
        </button>
      )}

      {showRemoteOverlay && remoteState.enabled && (
        <div className="remote-overlay">
          <div className="remote-overlay-backdrop" onClick={() => setShowRemoteOverlay(false)} />
          <div className="remote-overlay-panel">
            <div className="remote-overlay-header">
              <span className="remote-overlay-title">📱 Remote Control</span>
              <button className="remote-overlay-close" onClick={() => setShowRemoteOverlay(false)}>✕</button>
            </div>
            <div className="remote-overlay-body">
              {remoteState.url ? (
                <>
                  <p className="remote-overlay-desc">Scan the QR code or click the link to control this session from another device. Remote is enabled across all spaces in this workspace.</p>
                  {qrDataUrl && (
                    <div className="remote-overlay-qr">
                      <img src={qrDataUrl} alt="QR Code for remote session" />
                    </div>
                  )}
                  <a
                    className="remote-overlay-link"
                    href="#"
                    onClick={(e) => { e.preventDefault(); whimAPI.openExternal(remoteState.url!); }}
                  >
                    {remoteState.url}
                  </a>
                  <button className="remote-overlay-copy" onClick={() => navigator.clipboard.writeText(remoteState.url!)}>
                    Copy link
                  </button>
                </>
              ) : (
                <p className="remote-overlay-desc">Remote control is enabled across all spaces but no link is available for this session yet. The session may not be in a GitHub repository working directory.</p>
              )}
              {remoteHint && <div className="remote-overlay-hint">{remoteHint}</div>}
              <button
                className="remote-overlay-reset"
                onClick={handleResetRemote}
                disabled={remoteResetting}
                title="Disable and re-enable remote control to recover from a stuck link"
              >
                {remoteResetting ? 'Resetting…' : 'Reset link'}
              </button>
              <button className="remote-overlay-disable" onClick={async () => { await handleToggleRemote(); setShowRemoteOverlay(false); }}>
                Disable Remote Control
              </button>
            </div>
          </div>
        </div>
      )}

      {isLoadingHistory && (
        <div className="chat-loading-history">Loading conversation history...</div>
      )}

      <MessageList
        messages={messages}
        historyPaging={historyPaging}
        onApprovalRespond={handleApprovalRespond}
        onUserInputRespond={handleUserInputRespond}
        onElicitationRespond={handleElicitationRespond}
        onSandboxResolve={handleSandboxResolve}
        onEditSandboxConfig={handleEditSandboxConfig}
        parentAgentId={currentAgentId || ''}
        onOpenSubagentDetail={setOverlayAgentId}
      />

      {showWorkingIndicator && (
        <WorkingIndicator
          thinkingPreview={streamingPreviews.thinkingPreview}
          outputPreview={streamingPreviews.outputPreview}
          activeToolName={streamingPreviews.activeToolName}
        />
      )}

      <PromptBar
        onSend={handleSend}
        disabled={false}
        isBusy={isBusy}
        onAbort={currentAgentId ? handleAbort : undefined}
        toolbar={promptToolbar}
        placeholder={
          !currentAgentId ? 'What would you like the agent to do?' :
          isBusy ? 'Type to queue a follow-up — or press ◼ to stop' :
          agentSource === 'cli' ? 'Continue this CLI session here...' :
          'Send a follow-up message...'
        }
      />

      {overlayAgentId && currentAgentId && (
        <SubagentDetailOverlay
          parentAgentId={currentAgentId}
          agentId={overlayAgentId}
          onClose={() => setOverlayAgentId(null)}
        />
      )}
    </div>
  );
}
