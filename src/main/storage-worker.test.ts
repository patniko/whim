import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { performance } from 'perf_hooks';

const fixture = vi.hoisted(() => ({ worker: '' }));
vi.mock('worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(_file: string | URL, options?: import('worker_threads').WorkerOptions) {
        super(fixture.worker, options);
      }
    },
  };
});
vi.mock('./notify', () => ({ notifyAllWindows: vi.fn() }));

import {
  initWorkspace, initDatabase, closeDatabase, createSpace, getSpace, listSpaces, updateSpace,
  getStorageReadiness, withWorkspaceContext, applyIncomingChanges, checkpointAppliedState,
  writeDocument, syncCanvasContent, compactOldSegments,
  listSpaceSummaries, archiveSpaceFolder,
  withStorageBarrier, createSubagentRecord, createSubagentToolCall, listSubagentToolCalls,
  createAgentSession, updateCanvasAgentStatus, updateAgentSessionStatus, getAgentSession,
  createSkillDocument, deleteSkillDirectory, getSkillCanvasSettings, readDocument,
  openRuntimeHistory, appendRuntimeHistory, queryRuntimeHistory, listAgentChatEvents,
} from './storage';
import { appendEvent } from './eventlog';

let bundle: string;
let workspace: string;
beforeAll(async () => {
  bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-worker-test-'));
  fixture.worker = path.join(bundle, 'storage-worker.cjs');
  await build({
    entryPoints: [path.resolve('src/main/storage-worker.ts')],
    outfile: fixture.worker, bundle: true, packages: 'external', platform: 'node', format: 'cjs',
  });
  // Packages stay external so the test uses the installed native binding.
  fs.symlinkSync(path.resolve('node_modules'), path.join(bundle, 'node_modules'), 'dir');
});
afterAll(() => { fs.rmSync(bundle, { recursive: true, force: true }); });
beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-storage-test-'));
  await initWorkspace(workspace);
  await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
});
afterEach(async () => {
  await closeDatabase();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('sole persistence worker', () => {
  it('normalizes runtime history off-main without writing ephemeral transcripts to the durable mirror', async () => {
    expect(await openRuntimeHistory('ephemeral', 'session', true)).toBeUndefined();
    await appendRuntimeHistory('ephemeral', 'session', [{
      id: 'event', type: 'assistant.message', timestamp: '2026-09-07',
      payload: JSON.stringify({ messageId: 'answer', content: 'Synthetic ephemeral content' }),
    }], 'next');
    const page = await queryRuntimeHistory('ephemeral', 'session', { limit: 1 });
    expect(page.items).toMatchObject([{ id: 'assistant:answer', content: 'Synthetic ephemeral content' }]);
    expect(page.watermark).toBe(0);
    expect(await listAgentChatEvents('ephemeral')).toEqual([]);
    await closeDatabase();
    await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
    expect(await openRuntimeHistory('ephemeral', 'session', true)).toBeUndefined();
    expect((await queryRuntimeHistory('ephemeral', 'session')).items).toEqual([]);
  });
  it('durably creates and edits skill documents and reads report metadata off-main', async () => {
    const filePath = await createSkillDocument(workspace, 'fixture-skill', '---\nname: Fixture\ncanvas: true\nspace_mode: reuse\n---\nOriginal\n');
    const content = await readDocument(filePath, workspace);
    const skill = {
      id: 'fixture-skill', name: 'Fixture', description: '', emoji: '', folder: '.agents/skills/fixture-skill', filePath,
      schedule: null, schedule_time: null, schedule_day: null, next_run_at: null, last_run_at: null,
      created_at: '', updated_at: '',
    };
    expect(await getSkillCanvasSettings(workspace, skill, 'whim-report')).toEqual({ canvas: 'whim-report', space_mode: 'reuse', canvas_template: null });
    await writeDocument({ filePath, root: workspace, expected: content, content: `${content}Saved\n` });
    await expect(writeDocument({ filePath, root: workspace, expected: content, content: 'stale' })).rejects.toThrow('merge_stale');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(`${content}Saved\n`);
    await expect(deleteSkillDirectory(workspace, '.agents/skills')).rejects.toThrow('Invalid skill');
    await deleteSkillDirectory(workspace, skill.folder);
    expect(fs.existsSync(filePath)).toBe(false);
  });
  it('defers producer writes across synchronization and acknowledges them only after release', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const synchronization = withStorageBarrier(async () => { entered(); await wait; });
    await ready;
    let acknowledged = false;
    const saving = createSpace({ body: 'during synchronization' }).then(space => { acknowledged = true; return space; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(acknowledged).toBe(false);
    release();
    await synchronization;
    const space = await saving;
    expect((await getSpace(space.id))?.body).toBe(space.body);
  });

  it('does not reapply acknowledged non-idempotent local events before or after remote appends', async () => {
    await createSubagentRecord({
      id: 'sub', parent_agent_id: 'parent', tool_call_id: 'call', agent_name: 'synthetic',
      display_name: 'Fixture', description: '', agent_type: 'task', status: 'completed',
      started_at: 1, completed_at: 2, duration_ms: 1, model: null, total_tokens: null,
      total_tool_calls: 1, error: null, streaming_content: '', turns_json: '[]', progress_json: '{}',
    });
    await createSubagentToolCall({
      subagent_id: 'sub', parent_agent_id: 'parent', tool_call_id: 'tool', tool_name: 'fixture', arguments_json: '{}',
      success: 1, error: null, started_at: 1, completed_at: 2, result: 'done',
    });
    await withStorageBarrier(async () => {});
    expect(await listSubagentToolCalls('sub')).toHaveLength(1);
    const space = await createSpace({ body: 'local suffix' });
    appendEvent(path.join(workspace, '.whim', 'events'), 'space.update', {
      id: space.id, fields: { description: 'remote suffix' },
    });
    await applyIncomingChanges();
    expect(await listSubagentToolCalls('sub')).toHaveLength(1);
    expect((await getSpace(space.id))?.description).toBe('remote suffix');
  });

  it('preserves historical session-only canvas no-ops without relaxing unrelated update targets', async () => {
    const now = new Date().toISOString();
    await createAgentSession({
      id: 'quick', session_id: 'session', space_id: null, prompt: 'Fixture', status: 'running',
      summary: '', working_dir: workspace, source: 'sdk', persona_handle: null,
      quoted_text: null, run_location: 'local', created_at: now, updated_at: now,
    });
    await updateCanvasAgentStatus('quick', 'completed');
    await updateAgentSessionStatus('quick', 'completed', 'Done');
    appendEvent(path.join(workspace, '.whim', 'events'), 'canvas_agent.updated', {
      id: 'quick', status: 'completed', updated_at: now,
    });
    await applyIncomingChanges();
    expect((await getAgentSession('quick'))?.status).toBe('completed');
    await expect(updateCanvasAgentStatus('missing', 'failed')).rejects.toThrow('missing');
  });

  it('measures hot storage readiness with 1000 synthetic spaces before full indexing', async () => {
    for (let i = 0; i < 1000; i++) await createSpace({ body: `Readiness fixture ${i}` });
    await closeDatabase();
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
      samples.push(performance.now() - start);
      expect(getStorageReadiness().state).toBe('ready');
      const page = await listSpaceSummaries({ limit: 60 });
      expect(page.total).toBe(1000);
      expect(page.items).toHaveLength(60);
      await closeDatabase();
    }
    samples.sort((a, b) => a - b);
    console.info('[fixture:1000-space-storage-ready]', {
      samples: samples.length, p95Ms: samples[9], maxMs: samples[9],
      scope: 'new worker plus hot database open, not Electron app-ready or first paint',
    });
  }, 30_000);
  it('reconciles unopened and archived canvases after external file edits', async () => {
    const space = await createSpace({ body: 'Synthetic title' });
    const folder = path.join(workspace, space.folder!);
    fs.mkdirSync(folder, { recursive: true });
    const canvas = path.join(folder, 'canvas.md');
    fs.writeFileSync(canvas, '# Title\noriginal search token');
    await syncCanvasContent(workspace);
    expect((await listSpaceSummaries({ query: 'original search' })).total).toBe(1);
    fs.writeFileSync(canvas, '# Title\nexternal search token');
    await vi.waitFor(async () => expect((await listSpaceSummaries({ query: 'external search' })).total).toBe(1), { timeout: 5000 });
    expect((await listSpaceSummaries({ query: 'original search' })).total).toBe(0);
    await archiveSpaceFolder(workspace, space.folder!);
    const archived = path.join(workspace, '.whim', 'archive', space.folder!, 'canvas.md');
    fs.writeFileSync(archived, '# Title\narchived search token');
    await vi.waitFor(async () => expect((await listSpaceSummaries({ query: 'archived search' })).total).toBe(1), { timeout: 5000 });
    fs.unlinkSync(archived);
    await vi.waitFor(async () => expect((await listSpaceSummaries({ query: 'archived search' })).total).toBe(0), { timeout: 5000 });
  });

  it('orders reads after durable writes and replays the acknowledged result', async () => {
    const created = await createSpace({ body: 'synthetic capture' });
    const write = updateSpace(created.id, { description: 'saved' });
    const read = getSpace(created.id);
    expect((await read)?.description).toBe('saved');
    await write;
    await closeDatabase();
    await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
    expect((await getSpace(created.id))?.description).toBe('saved');
  });

  it('rejects excess admission explicitly without dropping admitted writes', async () => {
    const requests = Array.from({ length: 300 }, (_, i) => createSpace({ body: `fixture ${i}` }));
    const results = await Promise.allSettled(requests);
    const accepted = results.filter(result => result.status === 'fulfilled').length;
    expect(results.some(result => result.status === 'rejected' && String(result.reason).includes('capacity'))).toBe(true);
    expect((await listSpaces()).length).toBe(accepted);
  });

  it('drains admitted work on close and rejects later writes', async () => {
    const saved = createSpace({ body: 'before close' });
    const closing = closeDatabase();
    await expect(createSpace({ body: 'after close' })).rejects.toThrow('closing');
    await saved;
    await closing;
    expect(getStorageReadiness().state).toBe('closed');
  });

  it('rejects continuations retained from an earlier workspace generation', async () => {
    let resume!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; });
    const stale = withWorkspaceContext(async () => {
      await wait;
      return createSpace({ body: 'must not cross workspace' });
    });
    await closeDatabase();
    await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
    resume();
    await expect(stale).rejects.toThrow('Stale workspace');
  });

  it('applies remote suffixes before reads and refuses unseen changes as a checkpoint', async () => {
    const space = await createSpace({ body: 'local' });
    await checkpointAppliedState();
    appendEvent(path.join(workspace, '.whim', 'events'), 'space.update', { id: space.id, fields: { description: 'remote', updated_at: new Date().toISOString() } });
    await expect(checkpointAppliedState()).rejects.toThrow('Unapplied external');
    await applyIncomingChanges();
    expect((await getSpace(space.id))?.description).toBe('remote');
  });

  it('durably compares document revisions in the worker and preserves conflicts', async () => {
    const filePath = path.join(workspace, 'document.md');
    await writeDocument({ filePath, root: workspace, expected: undefined, content: 'base' });
    await writeDocument({ filePath, root: workspace, expected: 'base', content: 'remote' });
    await expect(writeDocument({ filePath, root: workspace, expected: 'base', content: 'local' })).rejects.toThrow('merge_stale');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('remote');
  });

  it('keeps the main event loop responsive while storing 100KB documents', async () => {
    const space = await createSpace({ body: 'timing fixture' });
    const filePath = path.join(workspace, 'capture.md');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const durations: number[] = [];
    let expected: string | undefined;
    try {
      for (let i = 0; i < 30; i++) {
        const content = '# Fixture\n' + String(i).padStart(2, '0') + 'x'.repeat(100_000);
        const started = performance.now();
        await writeDocument({ filePath, root: workspace, expected, content, spaceId: space.id });
        durations.push(performance.now() - started);
        expected = content;
      }
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(expected);
    const p95 = durations.sort((a, b) => a - b)[Math.ceil(durations.length * .95) - 1];
    console.info('[fixture:durable-save]', { samples: durations.length, p95Ms: p95 });
    expect(p95).toBeLessThan(100);
    await syncCanvasContent(workspace);
    expect(getStorageReadiness().indexing).toBe(false);
    expect((await compactOldSegments(path.join(workspace, '.whim', 'events'))).ran).toBe(false);
  });
});
