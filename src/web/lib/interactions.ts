import type { IpcEvents } from '../../shared/ipc-contract';

/**
 * An agent can block on three different questions, not just permission
 * approvals: a free-form/multiple-choice question, an MCP elicitation, and a
 * sandbox block.  Only approvals are carried on `agent:list-all`; the other
 * three exist purely as events, so the remote UI has to track them itself or
 * an agent that asks mid-run is unanswerable from a browser.
 */
export type PendingInteraction =
  | { kind: 'user-input'; agentId: string; requestId: string; question: string; choices: string[]; allowFreeform: boolean }
  | { kind: 'elicitation'; agentId: string; requestId: string; message: string; mode: 'form' | 'url'; source: string | null }
  | { kind: 'sandbox'; agentId: string; requestId: string; target: string; toolName: string | null; intention: string | null; decisions: Array<'allow-once' | 'allow-for-session' | 'disable'> };

/** agentId → the questions that agent is currently blocked on. */
export type InteractionMap = Record<string, PendingInteraction[]>;

function add(map: InteractionMap, item: PendingInteraction): InteractionMap {
  const existing = map[item.agentId] ?? [];
  if (existing.some((e) => e.requestId === item.requestId)) return map;
  return { ...map, [item.agentId]: [...existing, item] };
}

function remove(map: InteractionMap, agentId: string, requestId: string): InteractionMap {
  const existing = map[agentId];
  if (!existing) return map;
  const next = existing.filter((e) => e.requestId !== requestId);
  if (next.length === existing.length) return map;
  const copy = { ...map };
  if (next.length === 0) delete copy[agentId];
  else copy[agentId] = next;
  return copy;
}

/**
 * Fold one mirrored agent event into the pending-interaction map.  Returns the
 * same reference when nothing changed so React can skip re-rendering.
 */
export function applyInteractionEvent(map: InteractionMap, channel: string, payload: unknown): InteractionMap {
  switch (channel) {
    case 'agent:user-input-requested': {
      const p = payload as IpcEvents['agent:user-input-requested'];
      return add(map, {
        kind: 'user-input',
        agentId: p.agentId,
        requestId: p.requestId,
        question: p.question,
        choices: p.choices ?? [],
        allowFreeform: p.allowFreeform !== false,
      });
    }
    case 'agent:elicitation-requested': {
      const p = payload as IpcEvents['agent:elicitation-requested'];
      return add(map, {
        kind: 'elicitation',
        agentId: p.agentId,
        requestId: p.requestId,
        message: p.message,
        mode: p.mode === 'url' ? 'url' : 'form',
        source: p.elicitationSource ?? null,
      });
    }
    case 'agent:sandbox-blocked': {
      const p = payload as IpcEvents['agent:sandbox-blocked'];
      return add(map, {
        kind: 'sandbox',
        agentId: p.agentId,
        requestId: p.requestId,
        target: p.target,
        toolName: p.toolName ?? null,
        intention: p.intention ?? null,
        decisions: p.allowedDecisions ?? ['allow-once', 'allow-for-session'],
      });
    }
    case 'agent:user-input-resolved':
    case 'agent:elicitation-resolved':
    case 'agent:sandbox-resolved': {
      const p = payload as { agentId: string; requestId: string };
      return remove(map, p.agentId, p.requestId);
    }
    default:
      return map;
  }
}

/** Drop anything belonging to agents that no longer exist. */
export function pruneInteractions(map: InteractionMap, liveAgentIds: Set<string>): InteractionMap {
  const stale = Object.keys(map).filter((id) => !liveAgentIds.has(id));
  if (stale.length === 0) return map;
  const copy = { ...map };
  for (const id of stale) delete copy[id];
  return copy;
}
