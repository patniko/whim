import type { Tool } from '@github/copilot-sdk';
import { merge3Async } from '../../shared/text-merge-node';
import { parseFrontmatter } from '../frontmatter';
import {
  persistScheduledCanvas,
  readScheduledCanvas,
  resolveScheduledCanvasTarget,
  type ScheduledCanvasTarget,
} from './scheduled-result';

export const SCHEDULED_EDIT_PROMPT =
  'This is a user follow-up on an existing scheduled result, not another scheduled run. '
  + 'Read the current canvas.md and use edit_scheduled_result to save requested changes. '
  + 'Keep source coverage, source links, checked-off items, and user notes unless the user asks to change them. '
  + 'Do not rerun the original task or call publish_scheduled_result. '
  + 'New external operations require the normal interactive permissions.';

/** Recognizes result-first documents without restoring any unattended authority. */
export function isScheduledResultDocument(content: string): boolean {
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
  const invocation = frontmatter.skill_invocation;
  return frontmatter.canvas_artifacts === false && !!invocation && typeof invocation === 'object'
    && 'instruction_snapshot' in invocation && invocation.instruction_snapshot === 'skill-instructions.md';
}

interface EditTurn {
  target: ScheduledCanvasTarget;
  baseline: string;
  pending: Promise<void>;
  closed: boolean;
  cancelled: boolean;
}

/**
 * Editing is armed only when a user sends a follow-up. The original publication
 * tool remains closed, and this tool has no access to schedule completion.
 */
export class ScheduledResultEditor {
  readonly tool: Tool;
  private turn?: EditTurn;

  constructor(private readonly target: ScheduledCanvasTarget) {
    this.tool = {
      name: 'edit_scheduled_result',
      description: 'Save a user-requested revision of the current result canvas. Supply the complete revised Markdown body, preserving source coverage, links and user decisions unless asked otherwise. The title, metadata, schedule and run history are preserved.',
      skipPermission: true,
      defer: 'never',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['body'],
        properties: { body: { type: 'string', minLength: 1, maxLength: 1024 * 1024 } },
      },
      handler: args => this.edit(args),
    };
  }

  async beginTurn(): Promise<void> {
    if (this.turn) throw new Error('The previous result edit is still finishing.');
    const turn: EditTurn = {
      target: resolveScheduledCanvasTarget(this.target),
      baseline: '', pending: Promise.resolve(), closed: false, cancelled: false,
    };
    this.turn = turn;
    try {
      turn.baseline = await readScheduledCanvas(turn.target);
      if (turn.closed || this.turn !== turn) throw new Error('The result edit was cancelled before it started.');
    } catch (error) {
      if (this.turn === turn) this.turn = undefined;
      throw error;
    }
  }

  async endTurn(cancelPending = false): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.closed = true;
    turn.cancelled ||= cancelPending;
    await turn.pending;
    if (this.turn === turn) this.turn = undefined;
  }

  private edit(args: unknown): Promise<{ spaceId: string }> {
    const turn = this.turn;
    if (!turn || turn.closed) return Promise.reject(new Error('Result editing requires an active user follow-up.'));
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => key !== 'body') || !('body' in args)
      || typeof args.body !== 'string' || !args.body.trim() || args.body.length > 1024 * 1024) {
      return Promise.reject(new Error('Supply a nonblank Markdown body of at most 1048576 characters.'));
    }
    const body = args.body.trim();
    if (/^---\r?\n/.test(body)) return Promise.reject(new Error('Supply Markdown body only, without frontmatter.'));
    const operation = turn.pending.then(async () => {
      if (turn.cancelled) throw new Error('The result edit was cancelled.');
      const target = turn.target;
      const prefix = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(turn.baseline)?.[1] ?? '';
      const oldBody = turn.baseline.slice(prefix.length);
      const title = /^\s*(#\s+.+)(?:\r?\n|$)/.exec(oldBody)?.[1];
      const revisedBody = title ? `${title}\n\n${body.replace(/^#\s+[^\n]*(?:\n|$)/, '').trim()}` : body;
      const generated = `${prefix}${revisedBody}\n`;
      await persistScheduledCanvas(target, async current => {
        const { merged } = await merge3Async(turn.baseline, current, generated);
        if (turn.cancelled) throw new Error('The result edit was cancelled.');
        return merged;
      });
      turn.baseline = generated;
      return { spaceId: target.spaceId };
    });
    // A rejected edit still reaches the caller, but cannot poison subsequent edits.
    turn.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
