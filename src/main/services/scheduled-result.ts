import * as fs from 'fs';
import * as path from 'path';
import { ipcMain, Notification } from 'electron';
import type { PermissionRequest, PermissionRequestResult, Tool } from '@github/copilot-sdk';
import type { ScheduledInvocation, ScheduledRunStatus } from '../../shared/skill-schedule';
import { scheduledRunLabels } from '../../shared/skill-schedule';
import { merge3Async } from '../../shared/text-merge-node';
import { readDocument, writeDocument } from '../storage';
import { clearSelfWrite, markSelfWrite } from '../canvas-watcher';
import { notifyAllWindows } from '../notify';
import { scheduleAutoCommit } from '../workspace';
import { completeScheduledRun } from '../storage';

type FinishedResult = { status: Exclude<ScheduledRunStatus, 'running'>; summary: string };
type PublicationOutcome = 'ready' | 'empty' | 'partial' | 'needs-connection';
interface SourceCoverage {
  source: string;
  status: 'searched' | 'unavailable';
  detail: string;
}
interface Publication {
  body: string;
  summary: string;
  outcome: PublicationOutcome;
  coverage: SourceCoverage[];
}
export interface ScheduledCanvasTarget {
  workspaceRoot: string;
  workingDir: string;
  spaceId: string;
}
interface ContextParams extends ScheduledCanvasTarget {
  invocation: ScheduledInvocation;
}
export interface ScheduledResultContext extends ContextParams {
  readonly params: ContextParams;
  readonly blockedReasons: Set<string>;
  readonly initialBaseline: string;
  publication?: Publication;
  /** Agent-authored revision, deliberately excluding concurrent user edits. */
  generatedBaseline: string;
  finished?: FinishedResult;
  pendingPublications?: Promise<void>;
  finishing?: Promise<FinishedResult>;
}

const MAX_CANVAS_BYTES = 8 * 1024 * 1024;
const MAX_BODY_LENGTH = 1024 * 1024;

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Root aliases (e.g. macOS /var) are canonicalized, but no child symlinks are trusted. */
function checkedPath(root: string, target: string): string {
  const normalized = path.resolve(target);
  if (!isWithin(root, normalized) || (target !== root && !target.startsWith(`${root}${path.sep}`))) {
    throw new Error('Path is outside the authorized workspace.');
  }
  let current = root;
  // Inspect before collapsing "..": link/../file can address a different file
  // than path.resolve() when the operating system follows the link first.
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.resolve(current, part);
    if (!isWithin(root, current)) throw new Error('Path traverses outside the authorized workspace.');
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic-link paths are not authorized.');
  }
  const canonical = fs.realpathSync(target);
  if (!isWithin(root, canonical) || canonical !== normalized) {
    throw new Error('Path no longer resolves inside the authorized workspace.');
  }
  const stat = fs.statSync(canonical);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('Only ordinary files and directories may be read.');
  return canonical;
}

function canvasPath(context: ScheduledCanvasTarget): string {
  checkedPath(context.workspaceRoot, context.workingDir);
  return checkedPath(context.workspaceRoot, path.join(context.workingDir, 'canvas.md'));
}

export async function readScheduledCanvas(context: ScheduledCanvasTarget): Promise<string> {
  const target = canvasPath(context);
  return readDocument(target, context.workspaceRoot, true);
}

export function resolveScheduledCanvasTarget(params: ScheduledCanvasTarget): ScheduledCanvasTarget {
  const workspaceRoot = fs.realpathSync(params.workspaceRoot);
  const relative = path.relative(path.resolve(params.workspaceRoot), path.resolve(params.workingDir));
  const workingDir = checkedPath(workspaceRoot, path.resolve(workspaceRoot, relative));
  if (workingDir === workspaceRoot || !fs.statSync(workingDir).isDirectory()) {
    throw new Error('Scheduled results require an owned space directory.');
  }
  if (!params.spaceId.trim()) throw new Error('A scheduled result requires a space ID.');
  return { workspaceRoot, workingDir, spaceId: params.spaceId };
}

export async function createScheduledResultContext(params: ContextParams): Promise<ScheduledResultContext> {
  const target = resolveScheduledCanvasTarget(params);
  // Snapshot authorization so a later configuration edit cannot widen this run.
  const invocation = { ...params.invocation, readOnlyServers: [...params.invocation.readOnlyServers] };
  const normalized = { ...target, invocation };
  const context: ScheduledResultContext = {
    ...normalized,
    params: normalized,
    blockedReasons: new Set(),
    initialBaseline: '',
    generatedBaseline: '',
  };
  const initialBaseline = await readScheduledCanvas(context);
  return { ...context, initialBaseline, generatedBaseline: initialBaseline };
}

export function markScheduledInteractionBlocked(context: ScheduledResultContext, reason: string): void {
  if (!context.finished && !context.finishing) context.blockedReasons.add(reason.trim() || 'An unattended interaction was blocked.');
}

export function scheduledPermissionDecision(
  context: ScheduledResultContext,
  request: PermissionRequest,
): PermissionRequestResult {
  let reason: string;
  if (context.finished || context.finishing) return { kind: 'reject' };
  if (request.managedApprovalRequired) {
    reason = 'Managed policy requires a human decision; unattended approval is not allowed.';
  } else if ('requestSandboxBypass' in request && request.requestSandboxBypass) {
    reason = 'Sandbox bypass is not allowed for scheduled runs.';
  } else if (request.kind === 'mcp') {
    if (request.readOnly === true && context.invocation.readOnlyServers.includes(request.serverName)) {
      return { kind: 'approve-once' };
    }
    reason = `MCP access blocked: ${request.serverName}/${request.toolName} is not an authorized read-only operation.`;
  } else if (request.kind === 'read') {
    try {
      if (typeof request.path !== 'string' || !request.path.trim()) throw new Error('A concrete read path is required.');
      const target = path.isAbsolute(request.path) ? request.path : `${context.workingDir}${path.sep}${request.path}`;
      checkedPath(context.workspaceRoot, target);
      return { kind: 'approve-once' };
    } catch (error) {
      reason = `Read blocked: ${request.path}. ${errorMessage(error)}`;
    }
  } else {
    reason = `${request.kind} operations are not allowed for scheduled runs.`;
  }
  markScheduledInteractionBlocked(context, reason);
  return { kind: 'reject' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label} must be nonblank text of at most ${max} characters.`);
  }
  return value.trim();
}

function validatePublication(context: ScheduledResultContext, args: unknown): Publication {
  if (!record(args) || Object.keys(args).some(key => !['body', 'summary', 'outcome', 'coverage'].includes(key))) {
    throw new Error('Expected only body, summary, outcome, and coverage.');
  }
  const body = text(args.body, 'body', MAX_BODY_LENGTH);
  const summary = text(args.summary, 'summary', 1000);
  const outcome = args.outcome;
  if (outcome !== 'ready' && outcome !== 'empty' && outcome !== 'partial' && outcome !== 'needs-connection') {
    throw new Error('Invalid scheduled result outcome.');
  }
  if (!Array.isArray(args.coverage)) throw new Error('coverage must be an array.');
  const supplied = new Map<string, SourceCoverage>();
  for (const item of args.coverage) {
    if (!record(item) || Object.keys(item).some(key => !['source', 'status', 'detail'].includes(key))
      || typeof item.source !== 'string' || !context.invocation.readOnlyServers.includes(item.source)
      || supplied.has(item.source) || (item.status !== 'searched' && item.status !== 'unavailable')) {
      throw new Error('Coverage must use each exact authorized source identity at most once and a valid status.');
    }
    supplied.set(item.source, {
      source: item.source,
      status: item.status,
      detail: text(item.detail, 'coverage detail', 4000),
    });
  }
  const coverage = [...new Set(context.invocation.readOnlyServers)].map(source => supplied.get(source) ?? {
    source, status: 'unavailable' as const, detail: 'No coverage was reported for this authorized source.',
  });
  return { body, summary, outcome, coverage };
}

function publicationStatus(context: ScheduledResultContext, publication: Publication): PublicationOutcome {
  const unavailable = publication.coverage.some(item => item.status === 'unavailable');
  if (publication.outcome === 'needs-connection') return 'needs-connection';
  if (unavailable || context.blockedReasons.size) {
    if (publication.coverage.length && !publication.coverage.some(item => item.status === 'searched')) {
      return 'needs-connection';
    }
    return 'partial';
  }
  return publication.outcome;
}

function publicationSummary(context: ScheduledResultContext, publication: Publication): string {
  const status = publicationStatus(context, publication);
  const unavailable = publication.coverage.filter(item => item.status === 'unavailable').map(item => item.source);
  if (unavailable.length || context.blockedReasons.size) {
    const limitation = unavailable.length ? `Sources not searched: ${unavailable.join(', ')}.`
      : 'Required access or interaction was blocked.';
    return `${scheduledRunLabels[status]}: ${limitation} Review the saved findings and source coverage.`;
  }
  return status === 'partial' || status === 'needs-connection'
    ? `${scheduledRunLabels[status]}: ${publication.summary}` : publication.summary;
}

function frontmatterAndBody(content: string): { prefix: string; body: string } {
  const match = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))([\s\S]*)$/.exec(content);
  return match ? { prefix: match[1], body: match[2] } : { prefix: '', body: content };
}

/** The host owns the title and coverage; model headings must not duplicate them. */
function resultBody(body: string): string {
  if (/^---\r?\n/.test(body)) throw new Error('Publish Markdown body only, without frontmatter.');
  const lines = body.split(/\r?\n/);
  if (/^#\s+/.test(lines[0])) lines.shift();
  const kept: string[] = [];
  let coverageLevel = 0;
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker;
    }
    const heading = !fence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (heading && /^(?:source\s+)?coverage$/i.test(heading[2])) {
      coverageLevel = heading[1].length;
      continue;
    }
    if (heading && coverageLevel && heading[1].length <= coverageLevel) coverageLevel = 0;
    if (coverageLevel) continue;
    kept.push(heading?.[1] === '#' ? `#${line}` : line);
  }
  return text(kept.join('\n'), 'Markdown result body', MAX_BODY_LENGTH);
}

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#]/g, '\\$&');
}

function renderPublication(
  context: ScheduledResultContext,
  publication: Publication,
  status: FinishedResult['status'] = publicationStatus(context, publication),
): string {
  const initial = frontmatterAndBody(context.initialBaseline);
  const date = new Date(context.invocation.scheduledAt).toLocaleDateString('en-US', {
    timeZone: context.invocation.timeZone, year: 'numeric', month: 'short', day: 'numeric',
  });
  const heading = /^#\s+(.+)$/m.exec(initial.body)?.[1] ?? `Scheduled result - ${date}`;
  const coverage = publication.coverage.length
    ? publication.coverage.map(item => `- **${inline(item.source)}**: ${item.status} - ${inline(item.detail)}`).join('\n')
    : 'No external sources were authorized for this run.';
  return `${initial.prefix}# ${heading}\n\n${resultBody(publication.body)}\n\n## Source coverage\n\n`
    + `Outcome: ${scheduledRunLabels[status]}\n\n${coverage}\n`;
}

export async function persistScheduledCanvas(context: ScheduledCanvasTarget, transform: (current: string) => Promise<string>): Promise<void> {
  const target = canvasPath(context);
  const current = await readScheduledCanvas(context);
  const content = await transform(current);
  if (Buffer.byteLength(content, 'utf-8') > MAX_CANVAS_BYTES) throw new Error('Result exceeds the safe canvas size.');
  markSelfWrite(context.spaceId, content);
  try {
    const updated = await writeDocument({
      filePath: target, root: context.workspaceRoot, content, expected: current,
      spaceId: context.spaceId, strict: true,
    });
    if (updated.titleChanged) notifyAllWindows('space:title-updated', { spaceId: context.spaceId, title: updated.title });
  } catch (error) {
    clearSelfWrite(context.spaceId);
    throw error;
  }
  notifyAllWindows('canvas:content-updated', { spaceId: context.spaceId, content });
  scheduleAutoCommit(context.workspaceRoot);
}

export function createPublishScheduledResultTool(context: ScheduledResultContext): Tool {
  return {
    name: 'publish_scheduled_result',
    description: 'Persist the scheduled Markdown result to this space canvas. Report coverage for every authorized source; unavailable or omitted sources prevent a complete outcome. Do not include a title or coverage section in body.',
    skipPermission: true,
    defer: 'never',
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['body', 'summary', 'outcome', 'coverage'],
      properties: {
        body: { type: 'string', minLength: 1, maxLength: MAX_BODY_LENGTH },
        summary: { type: 'string', minLength: 1, maxLength: 1000 },
        outcome: { type: 'string', enum: ['ready', 'empty', 'partial', 'needs-connection'] },
        coverage: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['source', 'status', 'detail'],
            properties: {
              source: { type: 'string', enum: context.invocation.readOnlyServers },
              status: { type: 'string', enum: ['searched', 'unavailable'] },
              detail: { type: 'string', minLength: 1, maxLength: 4000 },
            },
          },
        },
      },
    },
    handler: async (args: unknown) => {
      if (context.finished || context.finishing) {
        throw new Error('This scheduled run has already finished. Use edit_scheduled_result for a user follow-up.');
      }
      const publication = validatePublication(context, args);
      const operation = (context.pendingPublications ?? Promise.resolve()).then(async () => {
        const generated = renderPublication(context, publication);
        await persistScheduledCanvas(context, async current => (await merge3Async(context.generatedBaseline, current, generated)).merged);
        context.generatedBaseline = generated;
        context.publication = publication;
        return {
          status: publicationStatus(context, publication),
          summary: publicationSummary(context, publication),
          spaceId: context.spaceId,
        };
      });
      context.pendingPublications = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

async function appendNotice(context: ScheduledResultContext, result: FinishedResult): Promise<void> {
  const base = context.publication ? renderPublication(context, context.publication, result.status) : context.initialBaseline;
  const generated = `${base.trimEnd()}\n\n## Scheduled run status\n\n`
    + `**${scheduledRunLabels[result.status]}**: ${inline(result.summary)}\n`
    + (context.blockedReasons.size
      ? `\n${[...context.blockedReasons].map(reason => `- ${inline(reason)}`).join('\n')}\n`
      : '');
  await persistScheduledCanvas(context, async current => (await merge3Async(context.generatedBaseline, current, generated)).merged);
  context.generatedBaseline = generated;
}

function notifyFinished(context: ScheduledResultContext, result: FinishedResult): void {
  if (result.status === 'empty') return;
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: `Scheduled result: ${scheduledRunLabels[result.status]}`, body: result.summary, silent: true,
    });
    notification.on('click', () => {
      // Use the ordinary space route, not the legacy report/artifact window.
      ipcMain.emit('canvas-window:open', undefined, { kind: 'space', id: context.spaceId, title: '' });
    });
    notification.on('failed', (_event, error) => console.warn('[schedule] Notification failed:', error));
    notification.show();
  } catch (error) {
    console.warn('[schedule] Could not show result notification:', error);
  }
}

export async function finishScheduledResult(context: ScheduledResultContext, error?: string): Promise<FinishedResult> {
  if (context.finishing) return context.finishing;
  if (context.finished) return context.finished;
  context.finishing = finalizeScheduledResult(context, error);
  return context.finishing;
}

async function finalizeScheduledResult(context: ScheduledResultContext, error?: string): Promise<FinishedResult> {
  // Seal the publisher immediately, then drain accepted writes before handing
  // the canvas to a user's next turn.
  await context.pendingPublications;
  const publication = context.publication;
  const status = error !== undefined ? 'failed'
    : publication ? publicationStatus(context, publication)
      : context.blockedReasons.size ? 'needs-connection' : 'failed';
  let summary = error !== undefined ? `Run failed: ${error || 'Unknown execution error.'}`
    : publication ? publicationSummary(context, publication) : (context.blockedReasons.size
      ? 'No result was published because required access or interaction was blocked.'
      : 'The run finished without publishing a result.');
  if (publication && error !== undefined) summary += ` Saved result: ${publicationSummary(context, publication)}`;
  const result: FinishedResult = { status, summary };
  context.finished = result;
  if (!publication || status === 'failed' || context.blockedReasons.size) {
    try {
      (await appendNotice(context, result));
    } catch (failure) {
      result.status = 'failed';
      result.summary = `Run failed: Could not save the status notice: ${errorMessage(failure)} ${result.summary}`;
      console.error('[schedule] Could not save result status:', failure);
      notifyAllWindows('space:processed', { spaceId: context.spaceId });
    }
  }
  if (!context.invocation.manual && context.invocation.scheduleId) {
    try {
      (await completeScheduledRun(context.workspaceRoot, context.invocation.scheduleId, context.invocation.runId, {
        ...result, spaceId: context.spaceId,
      }));
    } catch (failure) {
      result.status = 'failed';
      result.summary = `Run failed: Could not complete the schedule ledger: ${errorMessage(failure)} ${result.summary}`;
      console.error('[schedule] Could not complete schedule:', failure);
      try {
        (await appendNotice(context, result));
      } catch (noticeError) {
        console.error('[schedule] Could not save ledger failure notice:', noticeError);
        notifyAllWindows('space:processed', { spaceId: context.spaceId });
      }
    }
  }
  notifyFinished(context, result);
  return result;
}
