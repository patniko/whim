import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@github/copilot-sdk';
import type { ScheduledInvocation } from '../../shared/skill-schedule';

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

const native = vi.hoisted(() => ({
  supported: vi.fn(() => true),
  show: vi.fn(),
  emit: vi.fn(),
  created: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));
vi.mock('electron', () => ({
  ipcMain: { emit: native.emit },
  Notification: class {
    static isSupported = native.supported;
    constructor(options: unknown) { native.created(options); }
    on(event: string, callback: (...args: unknown[]) => void) { native.listeners.set(event, callback); }
    show = native.show;
  },
}));
vi.mock('../storage', async () => ({
  ...(await import('../workspace')),
  ...(await import('./skill-schedule-store')),
  ...(await import('../canvas/artifact-store')),
  documentMatches: (await import('../storage-documents')).documentMatches,
  readDocument: (await import('../storage-documents')).readDocument,
  writeDocument: (await import('../storage-documents')).writeDocument,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),
 updateCanvasContent: (await import('../database')).updateCanvasContent }));
vi.mock('../database', () => ({ updateCanvasContent: vi.fn(() => ({ title: 'Follow-ups', titleChanged: false })) }));
vi.mock('../canvas-watcher', () => ({ markSelfWrite: vi.fn(), clearSelfWrite: vi.fn() }));
vi.mock('../notify', () => ({ notifyAllWindows: vi.fn() }));
vi.mock('../workspace', async importOriginal => ({
  ...(await importOriginal<typeof import('../workspace')>()), scheduleAutoCommit: vi.fn(),
}));
vi.mock('./skill-schedule-store', () => ({ completeScheduledRun: vi.fn() }));

import { notifyAllWindows } from '../notify';
import { updateCanvasContent } from '../storage';
import { scheduleAutoCommit } from '../workspace';
import { completeScheduledRun } from './skill-schedule-store';
import {
  createPublishScheduledResultTool,
  createScheduledResultContext,
  finishScheduledResult,
  markScheduledInteractionBlocked,
  scheduledPermissionDecision,
  type ScheduledResultContext,
} from './scheduled-result';

const initial = '---\nskills: [follow-ups]\nskill_invocation:\n  run_id: run-1\ninstructions: Read the skill snapshot\n---\n'
  + '# Follow-ups - Sep 6, 2026\n\nPreparing your result.\n';
const invocation: ScheduledInvocation = {
  scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T02:00:00Z',
  timeZone: 'America/Los_Angeles', readOnlyServers: ['slack', 'github-mcp-server'],
};
const searched = [
  { source: 'slack', status: 'searched', detail: 'Threads from September 5-6.' },
  { source: 'github-mcp-server', status: 'searched', detail: 'Open review requests.' },
];
const useful = {
  body: '- [ ] Reply to Alex: confirm the launch date. [Thread](https://example.test/thread/123)',
  summary: 'One person is waiting on you.', outcome: 'ready', coverage: searched,
};

let root: string;
let workspaceRoot: string;
let workingDir: string;
let canvas: string;
let context: ScheduledResultContext;

function publish(args: unknown = useful, target = context): unknown {
  const tool = createPublishScheduledResultTool(target);
  return tool.handler!(args, { sessionId: 'session', toolCallId: 'tool-1', toolName: tool.name, arguments: args });
}

function mcp(overrides: Partial<Extract<PermissionRequest, { kind: 'mcp' }>> = {}): PermissionRequest {
  return {
    kind: 'mcp', serverName: 'slack', toolName: 'search', toolTitle: 'Search',
    readOnly: true, ...overrides,
  };
}

function read(file: string, overrides: Partial<Extract<PermissionRequest, { kind: 'read' }>> = {}): PermissionRequest {
  return { kind: 'read', path: file, intention: 'Read source context', ...overrides };
}

beforeEach(async () => {
  vi.clearAllMocks();
  native.listeners.clear();
  native.supported.mockReturnValue(true);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whim-scheduled-result-')));
  workspaceRoot = path.join(root, 'workspace');
  workingDir = path.join(workspaceRoot, 'follow-ups');
  fs.mkdirSync(workingDir, { recursive: true });
  canvas = path.join(workingDir, 'canvas.md');
  fs.writeFileSync(canvas, initial);
  context = await createScheduledResultContext({ workspaceRoot, workingDir, spaceId: 'space-1', invocation });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scheduled result publication', () => {
  it('persists a dated main canvas with original frontmatter, explicit coverage, and renderer/autocommit updates', async () => {
    const tool = createPublishScheduledResultTool(context);
    expect(tool).toMatchObject({ name: 'publish_scheduled_result', skipPermission: true, defer: 'never' });
    expect(await publish()).toMatchObject({ status: 'ready', spaceId: 'space-1' });
    const content = fs.readFileSync(canvas, 'utf-8');
    expect(content).toContain(initial.split('# Follow-ups')[0]);
    expect(content).toContain('# Follow-ups - Sep 6, 2026');
    expect(content).toContain(useful.body);
    expect(content).toContain('**slack**: searched');
    expect(content).toContain('**github-mcp-server**: searched');
    expect(content).not.toContain('Preparing your result.');
    expect(updateCanvasContent).toHaveBeenCalledWith('space-1', content);
    expect(notifyAllWindows).toHaveBeenCalledWith('canvas:content-updated', { spaceId: 'space-1', content });
    expect(scheduleAutoCommit).toHaveBeenCalledWith(workspaceRoot);
    expect(completeScheduledRun).not.toHaveBeenCalled();
  });

  it('removes the model title and coverage section, without duplicating host headings', async () => {
    await publish({ ...useful, body: '# Another title\n\nUseful follow-up.\n\n## Source coverage\n\nEverything was searched.\n\n## Next steps\n\nReply today.' });
    const content = fs.readFileSync(canvas, 'utf-8');
    expect(content.match(/^# /gm)).toHaveLength(1);
    expect(content.match(/^## Source coverage$/gm)).toHaveLength(1);
    expect(content).not.toContain('Everything was searched.');
    expect(content).toContain('## Next steps\n\nReply today.');
  });

  it('preserves user edits to frontmatter, the title, checkboxes, and notes across multiple publications', async () => {
    fs.writeFileSync(canvas, initial.replace('instructions:', 'user_note: keep me\ninstructions:')
      .replace('Preparing your result.', 'My personal draft.'));
    await publish();
    let current = fs.readFileSync(canvas, 'utf-8');
    expect(current).toContain('My personal draft.');
    expect(current).toContain('user_note: keep me');
    fs.writeFileSync(canvas, current.replace('- [ ] Reply', '- [x] Reply')
      .replace('# Follow-ups - Sep 6, 2026', '# My renamed follow-ups - Sep 6, 2026') + '\nKeep this handwritten note.\n');
    await publish({ ...useful, body: useful.body + '\n\nAnother follow-up.' });
    current = fs.readFileSync(canvas, 'utf-8');
    expect(current).toContain('- [x] Reply');
    expect(current).toContain('Keep this handwritten note.');
    expect(current).toContain('# My renamed follow-ups - Sep 6, 2026');
    expect(current).toContain('My personal draft.');
    expect(current).toContain('user_note: keep me');
    expect(current).toContain('Another follow-up.');
  });

  it('downgrades missing coverage instead of claiming a complete or empty search', async () => {
    expect(await publish({ ...useful, coverage: searched.slice(0, 1) })).toMatchObject({ status: 'partial' });
    expect(fs.readFileSync(canvas, 'utf-8')).toContain('**github-mcp-server**: unavailable');
    expect((await finishScheduledResult(context)).status).toBe('partial');
  });

  it('uses the same host-generated downgrade summary in the tool, ledger and notification', async () => {
    const summary = 'Partial result: Sources not searched: github-mcp-server. Review the saved findings and source coverage.';
    expect(await publish({
      ...useful, summary: 'Ready: every source was searched successfully.', coverage: searched.slice(0, 1),
    })).toMatchObject({ status: 'partial', summary });
    expect((await finishScheduledResult(context))).toEqual({ status: 'partial', summary });
    expect(completeScheduledRun).toHaveBeenCalledWith(workspaceRoot, 'schedule-1', 'run-1', {
      status: 'partial', summary, spaceId: 'space-1',
    });
    expect(native.created).toHaveBeenCalledWith(expect.objectContaining({ body: summary }));
  });

  it.each(['ready', 'empty', 'partial'])('reports needs-connection if %s claims omit all authorized sources', async outcome => {
    expect(await publish({ ...useful, outcome, coverage: [] })).toMatchObject({ status: 'needs-connection' });
    expect((await finishScheduledResult(context)).status).toBe('needs-connection');
  });

  it('accepts an explicitly empty selected source list without inventing source access', async () => {
    const local = await createScheduledResultContext({
      workspaceRoot, workingDir, spaceId: 'space-1', invocation: { ...invocation, readOnlyServers: [] },
    });
    await publish({ ...useful, outcome: 'empty', coverage: [] }, local);
    expect((await finishScheduledResult(local)).status).toBe('empty');
    expect(fs.readFileSync(canvas, 'utf-8')).toContain('No external sources were authorized');
  });

  it.each([
    null,
    { ...useful, body: ' \n ' },
    { ...useful, summary: '' },
    { ...useful, outcome: 'success' },
    { ...useful, coverage: null },
    { ...useful, path: '../other.md' },
    { ...useful, body: '---\nskills: [evil]\n---\nBody' },
    { ...useful, body: '# Title only' },
    { ...useful, coverage: [{ ...searched[0], source: 'Slack' }] },
    { ...useful, coverage: [{ ...searched[0], source: 'slack/other' }] },
    { ...useful, coverage: [searched[0], searched[0]] },
    { ...useful, coverage: [{ ...searched[0], status: 'successful' }] },
    { ...useful, coverage: [{ ...searched[0], detail: '  ' }] },
    { ...useful, coverage: [{ ...searched[0], filePath: 'elsewhere' }] },
  ])('rejects malformed or unauthorized publication input without persisting it (%#)', async args => {
    await expect(publish(args)).rejects.toThrow();
    expect(context.publication).toBeUndefined();
    expect(fs.readFileSync(canvas, 'utf-8')).toBe(initial);
    expect(scheduleAutoCommit).not.toHaveBeenCalled();
  });

  it('refuses a replaced canvas symlink, leaving its target unchanged', async () => {
    const unrelated = path.join(root, 'private.md');
    fs.writeFileSync(unrelated, 'private');
    fs.unlinkSync(canvas);
    fs.symlinkSync(unrelated, canvas);
    await expect(publish()).rejects.toThrow(/Symbolic-link/);
    expect(context.publication).toBeUndefined();
    expect(fs.readFileSync(unrelated, 'utf-8')).toBe('private');
  });

  it('refuses a directory symlink swapped in after launch, including an in-workspace alias', async () => {
    const original = path.join(workspaceRoot, 'moved');
    fs.renameSync(workingDir, original);
    fs.symlinkSync(original, workingDir);
    await expect(publish()).rejects.toThrow(/Symbolic-link/);
    expect(fs.readFileSync(path.join(original, 'canvas.md'), 'utf-8')).toBe(initial);
  });

  it('refuses a hard-linked canvas', async () => {
    fs.linkSync(canvas, path.join(root, 'other.md'));
    await expect(publish()).rejects.toThrow(/unlinked/);
    expect(fs.readFileSync(canvas, 'utf-8')).toBe(initial);
  });

  it('keeps the previous canvas intact and cleans staging files when a write fails', async () => {
    vi.mocked(fs.writeSync).mockImplementationOnce(() => { throw new Error('Disk full'); });
    await expect(publish()).rejects.toThrow('Disk full');
    expect(fs.readFileSync(canvas, 'utf-8')).toBe(initial);
    expect(fs.readdirSync(workingDir)).toEqual(['canvas.md']);
    expect(context.publication).toBeUndefined();
  });
});

describe('unattended permissions', () => {
  it('approves only exact selected MCP servers with explicit read-only metadata, never tool-name heuristics', () => {
    expect(scheduledPermissionDecision(context, mcp())).toEqual({ kind: 'approve-once' });
    expect(scheduledPermissionDecision(context, mcp({ readOnly: false, toolName: 'read_everything' }))).toEqual({ kind: 'reject' });
    expect(scheduledPermissionDecision(context, mcp({ readOnly: undefined }))).toEqual({ kind: 'reject' });
    for (const serverName of ['Slack', 'slack-extra', 'other', '*']) {
      expect(scheduledPermissionDecision(context, mcp({ serverName }))).toEqual({ kind: 'reject' });
    }
    expect(context.blockedReasons.size).toBe(6);
  });

  it('snapshots source identities instead of following configuration mutations', async () => {
    const selected = ['slack'];
    const target = await createScheduledResultContext({
      workspaceRoot, workingDir, spaceId: 'space-1', invocation: { ...invocation, readOnlyServers: selected },
    });
    selected.push('other');
    expect(scheduledPermissionDecision(target, mcp({ serverName: 'other' }))).toEqual({ kind: 'reject' });
  });

  it('allows concrete workspace reads, including skill snapshots, directories and previous spaces', () => {
    fs.writeFileSync(path.join(workingDir, 'skill-instructions.md'), 'Skill snapshot');
    fs.mkdirSync(path.join(workspaceRoot, 'previous'));
    fs.writeFileSync(path.join(workspaceRoot, 'previous', 'canvas.md'), 'Previous findings');
    for (const target of ['canvas.md', 'skill-instructions.md', '.', '../previous/canvas.md', workspaceRoot]) {
      expect(scheduledPermissionDecision(context, read(target))).toEqual({ kind: 'approve-once' });
    }
  });

  it('denies missing, escaping, prefix-collision and symbolic-link read paths', () => {
    const outside = path.join(root, 'workspace-other');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
    fs.writeFileSync(path.join(root, 'canvas.md'), 'private canvas');
    fs.symlinkSync(outside, path.join(workingDir, 'escape'));
    fs.symlinkSync(canvas, path.join(workingDir, 'alias.md'));
    for (const target of ['', 'missing.md', '../../workspace-other/secret.md', outside, 'escape/secret.md', 'escape/../canvas.md', 'alias.md']) {
      expect(scheduledPermissionDecision(context, read(target))).toEqual({ kind: 'reject' });
    }
  });

  it('denies managed approvals and sandbox bypass without prompting', () => {
    expect(scheduledPermissionDecision(context, read(canvas, { managedApprovalRequired: true }))).toEqual({ kind: 'reject' });
    expect(scheduledPermissionDecision(context, mcp({ managedApprovalRequired: true }))).toEqual({ kind: 'reject' });
    expect(scheduledPermissionDecision(context, read(canvas, { requestSandboxBypass: true }))).toEqual({ kind: 'reject' });
    expect([...context.blockedReasons].join('\n')).toContain('Managed policy');
    expect([...context.blockedReasons].join('\n')).toContain('Sandbox bypass');
  });

  it('rejects raw canvas writes, unrelated writes, shell, URL, and custom tools', () => {
    const requests: PermissionRequest[] = [
      { kind: 'write', fileName: canvas, intention: 'Publish', diff: 'result', newFileContents: 'result', canOfferSessionApproval: false },
      { kind: 'write', fileName: path.join(root, 'unrelated.md'), intention: 'Write', diff: 'change', canOfferSessionApproval: false },
      {
        kind: 'shell', fullCommandText: 'cat canvas.md', intention: 'Read', canOfferSessionApproval: false,
        commands: [], hasWriteFileRedirection: false, possiblePaths: [], possibleUrls: [],
      },
      { kind: 'url', url: 'https://example.test', intention: 'Read' },
      { kind: 'custom-tool', toolName: 'publish_scheduled_result', toolDescription: 'Publish', args: {} },
    ];
    for (const request of requests) expect(scheduledPermissionDecision(context, request)).toEqual({ kind: 'reject' });
    expect(native.show).not.toHaveBeenCalled();
  });
});

describe('scheduled completion', () => {
  it('completes once and notification clicks open the ordinary space, never an artifact', async () => {
    await publish();
    const result = (await finishScheduledResult(context));
    expect(result).toEqual({ status: 'ready', summary: useful.summary });
    expect((await finishScheduledResult(context, 'late error'))).toBe(result);
    expect(completeScheduledRun).toHaveBeenCalledExactlyOnceWith(workspaceRoot, 'schedule-1', 'run-1', {
      status: 'ready', summary: useful.summary, spaceId: 'space-1',
    });
    expect(native.show).toHaveBeenCalledTimes(1);
    native.listeners.get('click')!();
    expect(native.emit).toHaveBeenCalledWith('canvas-window:open', undefined, { kind: 'space', id: 'space-1', title: '' });
    await expect(publish()).rejects.toThrow(/already finished/);
    expect(scheduledPermissionDecision(context, read(canvas))).toEqual({ kind: 'reject' });
  });

  it('records a published empty result durably without a native notification', async () => {
    await publish({ ...useful, outcome: 'empty', body: 'No unanswered requests in the searched window.', summary: 'Nothing needs follow-up.' });
    expect((await finishScheduledResult(context))).toEqual({ status: 'empty', summary: 'Nothing needs follow-up.' });
    expect(completeScheduledRun).toHaveBeenCalledWith(workspaceRoot, 'schedule-1', 'run-1', {
      status: 'empty', summary: 'Nothing needs follow-up.', spaceId: 'space-1',
    });
    expect(native.show).not.toHaveBeenCalled();
  });

  it('makes no-output failure visible without destroying user content', async () => {
    fs.appendFileSync(canvas, '\nA draft the user wrote while waiting.\n');
    expect((await finishScheduledResult(context)).status).toBe('failed');
    const content = fs.readFileSync(canvas, 'utf-8');
    expect(content).toContain('A draft the user wrote while waiting.');
    expect(content).toContain('without publishing a result');
    expect(content).toContain('**Failed**');
    expect(notifyAllWindows).toHaveBeenCalledWith('canvas:content-updated', { spaceId: 'space-1', content });
    expect(native.show).toHaveBeenCalledTimes(1);
  });

  it('records blocked no-output runs as needs-connection with visible reasons', async () => {
    markScheduledInteractionBlocked(context, 'Slack requires sign-in.');
    markScheduledInteractionBlocked(context, 'Slack requires sign-in.');
    expect((await finishScheduledResult(context)).status).toBe('needs-connection');
    expect(fs.readFileSync(canvas, 'utf-8')).toContain('Slack requires sign-in.');
    expect(native.created).toHaveBeenCalledWith(expect.objectContaining({ title: 'Scheduled result: Needs connection' }));
  });

  it('downgrades useful results when necessary reads or interactions were blocked after publishing', async () => {
    await publish();
    markScheduledInteractionBlocked(context, 'Could not read previous source context.');
    expect((await finishScheduledResult(context)).status).toBe('partial');
    const content = fs.readFileSync(canvas, 'utf-8');
    expect(content).toContain(useful.body);
    expect(content).toContain('**Partial result**');
    expect(content).toContain('Outcome: Partial result');
    expect(content).not.toContain('Outcome: Ready');
    expect(content).toContain('Could not read previous source context.');
  });

  it('execution errors always fail but preserve the useful result and user edits', async () => {
    await publish();
    fs.appendFileSync(canvas, '\nMy saved response draft.\n');
    expect((await finishScheduledResult(context, 'SDK disconnected'))).toMatchObject({ status: 'failed' });
    const content = fs.readFileSync(canvas, 'utf-8');
    expect(content).toContain(useful.body);
    expect(content).toContain('My saved response draft.');
    expect(content).toContain('SDK disconnected');
    expect(content).toContain('Outcome: Failed');
    expect(content).not.toContain('Outcome: Ready');
    expect(completeScheduledRun).toHaveBeenCalledWith(workspaceRoot, 'schedule-1', 'run-1',
      expect.objectContaining({ status: 'failed', summary: expect.stringContaining('SDK disconnected') }));
  });

  it.each([{ manual: true }, { scheduleId: '' }])('manual/unsaved previews publish normally but do not touch the ledger (%#)', async override => {
    const manual = await createScheduledResultContext({
      workspaceRoot, workingDir, spaceId: 'space-1', invocation: { ...invocation, ...override },
    });
    await publish(useful, manual);
    expect((await finishScheduledResult(manual)).status).toBe('ready');
    expect(completeScheduledRun).not.toHaveBeenCalled();
    expect(fs.readFileSync(canvas, 'utf-8')).toContain(useful.body);
  });

  it('rejects a retained manual-run tool after finish without writes, notifications or ledger activity', async () => {
    const manual = await createScheduledResultContext({
      workspaceRoot, workingDir, spaceId: 'space-1', invocation: { ...invocation, manual: true },
    });
    const tool = createPublishScheduledResultTool(manual);
    const call = { sessionId: 'session', toolCallId: 'tool-1', toolName: tool.name, arguments: useful };
    await tool.handler!(useful, call);
    (await finishScheduledResult(manual));
    const completed = fs.readFileSync(canvas, 'utf-8');
    const writes = vi.mocked(scheduleAutoCommit).mock.calls.length;
    await expect(tool.handler!({ ...useful, body: 'A later user conversation.' }, call)).rejects.toThrow(/already finished/);
    expect(fs.readFileSync(canvas, 'utf-8')).toBe(completed);
    expect(scheduleAutoCommit).toHaveBeenCalledTimes(writes);
    expect(native.show).toHaveBeenCalledTimes(1);
    expect(completeScheduledRun).not.toHaveBeenCalled();
  });

  it('surfaces ledger failures on canvas and notifies once instead of reporting success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(completeScheduledRun).mockImplementationOnce(() => { throw new Error('Ledger unavailable'); });
    await publish();
    const result = (await finishScheduledResult(context));
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Ledger unavailable');
    expect(fs.readFileSync(canvas, 'utf-8')).toContain('Ledger unavailable');
    expect((await finishScheduledResult(context))).toBe(result);
    expect(completeScheduledRun).toHaveBeenCalledTimes(1);
    expect(native.show).toHaveBeenCalledTimes(1);
  });

  it('never writes through a replaced symlink while surfacing failure to the ledger, renderer and OS', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unrelated = path.join(root, 'private.md');
    fs.writeFileSync(unrelated, 'private');
    fs.unlinkSync(canvas);
    fs.symlinkSync(unrelated, canvas);
    expect((await finishScheduledResult(context)).status).toBe('failed');
    expect(fs.readFileSync(unrelated, 'utf-8')).toBe('private');
    expect(notifyAllWindows).toHaveBeenCalledWith('space:processed', { spaceId: 'space-1' });
    expect(completeScheduledRun).toHaveBeenCalledWith(workspaceRoot, 'schedule-1', 'run-1',
      expect.objectContaining({ status: 'failed', summary: expect.stringContaining('Could not save') }));
    expect(native.show).toHaveBeenCalledTimes(1);
  });
});
