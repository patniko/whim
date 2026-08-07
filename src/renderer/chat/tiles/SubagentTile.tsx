import React, { useState, useEffect, useRef } from 'react';
import { backupPollIntervalMs } from '../../transport-mode';

declare const whimAPI: any;

export interface SubagentTileProps {
  toolCallId: string;
  name: string;
  displayName: string;
  description: string;
  agentType: string;
  agentId?: string;
  completed: boolean;
  success?: boolean;
  error?: string;
  durationMs?: number;
  model?: string;
  totalTokens?: number;
  totalToolCalls?: number;
  parentAgentId: string;
  onOpenDetail?: (agentId: string) => void;
}

const AGENT_TYPE_ICONS: Record<string, string> = {
  explore: '🔍',
  task: '⚡',
  'general-purpose': '🧠',
  'rubber-duck': '🦆',
  'code-review': '📋',
  'configure-copilot': '⚙️',
};

function formatElapsed(startedAt: number, completedAt?: number): string {
  const elapsed = (completedAt ?? Date.now()) - startedAt;
  if (elapsed < 1000) return '<1s';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  return `${Math.floor(elapsed / 60_000)}m ${Math.floor((elapsed % 60_000) / 1000)}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function SubagentTile({
  toolCallId,
  name,
  displayName,
  description,
  agentType,
  agentId: initialAgentId,
  completed: initialCompleted,
  success: initialSuccess,
  error: initialError,
  durationMs: initialDurationMs,
  model: initialModel,
  totalTokens: initialTotalTokens,
  totalToolCalls: initialTotalToolCalls,
  parentAgentId,
  onOpenDetail,
}: SubagentTileProps) {
  const [completed, setCompleted] = useState(initialCompleted);
  const [success, setSuccess] = useState(initialSuccess);
  const [error, setError] = useState(initialError);
  const [agentId, setAgentId] = useState(initialAgentId);
  const [durationMs, setDurationMs] = useState(initialDurationMs);
  const [model, setModel] = useState(initialModel);
  const [totalTokens, setTotalTokens] = useState(initialTotalTokens);
  const [totalToolCalls, setTotalToolCalls] = useState(initialTotalToolCalls);
  const [currentIntent, setCurrentIntent] = useState<string | undefined>();
  const [elapsedDisplay, setElapsedDisplay] = useState('');
  const startedAt = useRef(Date.now());

  // Sync props when parent updates (e.g. from event handlers)
  useEffect(() => {
    setCompleted(initialCompleted);
    setSuccess(initialSuccess);
    setError(initialError);
    if (initialAgentId) setAgentId(initialAgentId);
    if (initialDurationMs !== undefined) setDurationMs(initialDurationMs);
    if (initialModel) setModel(initialModel);
    if (initialTotalTokens !== undefined) setTotalTokens(initialTotalTokens);
    if (initialTotalToolCalls !== undefined) setTotalToolCalls(initialTotalToolCalls);
  }, [initialCompleted, initialSuccess, initialError, initialAgentId, initialDurationMs, initialModel, initialTotalTokens, initialTotalToolCalls]);

  // Live polling when not completed
  useEffect(() => {
    if (completed || !agentId || !parentAgentId) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const data = await whimAPI.subagentAPI?.read(parentAgentId, agentId);
        if (cancelled || !data) return;
        if (data.intent) setCurrentIntent(data.intent);
        if (data.totalTokens !== undefined) setTotalTokens(data.totalTokens);
        if (data.totalToolCalls !== undefined) setTotalToolCalls(data.totalToolCalls);
        if (data.model) setModel(data.model);
      } catch {
        // ignore polling errors
      }
    };

    poll();
    // A safety net behind the subscription below, not the primary source.
    const interval = setInterval(poll, backupPollIntervalMs(2000));

    const unsub = whimAPI.subagentAPI?.onChanged?.(parentAgentId, (changed: any) => {
      if (changed?.agentId === agentId) {
        if (changed.intent) setCurrentIntent(changed.intent);
        if (changed.totalTokens !== undefined) setTotalTokens(changed.totalTokens);
        if (changed.totalToolCalls !== undefined) setTotalToolCalls(changed.totalToolCalls);
        if (changed.model) setModel(changed.model);
      }
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsub?.();
    };
  }, [completed, agentId, parentAgentId]);

  // Load persisted data for completed agents (e.g. after app restart)
  useEffect(() => {
    if (!completed || !parentAgentId || !agentId) return;
    // If we already have stats from props, skip
    if (totalTokens !== undefined && totalToolCalls !== undefined && model) return;

    (async () => {
      try {
        const persisted = await whimAPI.subagentAPI?.listPersisted?.(parentAgentId);
        if (!persisted) return;
        const match = persisted.find((a: any) => a.agentId === agentId);
        if (!match) return;
        if (match.totalTokens !== undefined) setTotalTokens(match.totalTokens);
        if (match.totalToolCalls !== undefined) setTotalToolCalls(match.totalToolCalls);
        if (match.model) setModel(match.model);
        if (match.durationMs !== undefined) setDurationMs(match.durationMs);
      } catch { /* ignore */ }
    })();
  }, [completed, parentAgentId, agentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed time ticker
  useEffect(() => {
    if (completed && durationMs !== undefined) {
      setElapsedDisplay(formatElapsed(0, durationMs));
      return;
    }

    const tick = () => setElapsedDisplay(formatElapsed(startedAt.current));
    tick();

    if (!completed) {
      const interval = setInterval(tick, 1000);
      return () => clearInterval(interval);
    }
  }, [completed, durationMs]);

  const icon = AGENT_TYPE_ICONS[agentType] || '🤖';
  const isRunning = !completed;
  const isFailed = completed && success === false;
  const isSuccess = completed && success !== false;
  const borderClass = isRunning ? 'border-running' : isFailed ? 'border-failed' : 'border-success';
  const statusLabel = isRunning ? 'Running' : isFailed ? 'Failed' : 'Done';
  const statusClass = isRunning ? 'status-running' : isFailed ? 'status-failed' : 'status-success';
  const clickable = !!agentId && !!onOpenDetail;

  const handleClick = () => {
    if (clickable) onOpenDetail!(agentId!);
  };

  return (
    <div
      className={`chat-subagent-tile ${borderClass} ${clickable ? 'clickable' : ''}`}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <div className="chat-subagent-header">
        <span className={`chat-subagent-icon ${isRunning ? 'running' : ''}`}>{icon}</span>
        <span className="chat-subagent-name">{displayName || name}</span>
        <span className={`chat-subagent-status ${statusClass}`}>{statusLabel}</span>
      </div>

      {description && (
        <div className="chat-subagent-description">{description}</div>
      )}

      {error && (
        <div className="chat-subagent-error">⚠️ {error}</div>
      )}

      <div className="chat-subagent-stats">
        <span>⏱ {elapsedDisplay}</span>
        {totalToolCalls !== undefined && <span>🔧 {totalToolCalls}</span>}
        {totalTokens !== undefined && <span>🎰 {formatTokens(totalTokens)}</span>}
        {model && <span>{model}</span>}
        {currentIntent && <span className="chat-subagent-intent">{currentIntent}</span>}
      </div>

      {clickable && (
        <div className="chat-subagent-hint">Click to inspect</div>
      )}
    </div>
  );
}
