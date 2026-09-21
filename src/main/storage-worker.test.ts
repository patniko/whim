import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { performance } from 'perf_hooks';

const fixture = vi.hoisted(() => ({ worker: '', instance: undefined as import('worker_threads').Worker | undefined }));
vi.mock('worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(_file: string | URL, options?: import('worker_threads').WorkerOptions) {
        super(fixture.worker, options);
        fixture.instance = this;
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
  saveSkillSchedule,
  indexSkills, listSkills, setSpaceSessionId, updateCanvasContent,
  publishArtifact, acknowledgeArtifactPublication,
} from './storage';
import { appendEvent } from './eventlog';
import { notifyAllWindows } from './notify';
import { startWatching, stopAllWatchers, refreshWatchedCanvases } from './canvas-watcher';

let bundle: string;
let workspace: string;
beforeAll(async () => {
  bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-worker-test-'));
  fixture.worker = path.join(bundle, 'storage-worker.cjs');
  await build({
    entryPoints: [path.resolve('src/main/storage-worker.ts')],
    outfile: fixture.worker, bundle: true, packages: 'external', platform: 'node', format: 'cjs',
    plugins: [{
      name: 'forbid-worker-electron',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'worker-forbidden' }));
        builder.onLoad({ filter: /.*/, namespace: 'worker-forbidden' }, () => ({
          contents: 'throw new Error("Electron must not load in the storage worker"); module.exports = {};',
          loader: 'js',
        }));
      },
    }],
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
  stopAllWatchers();
  await closeDatabase();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('sole persistence worker', () => {
  it('durably acknowledges artifact publications through the worker boundary', async () => {
    const space = await createSpace({ body: '# Artifact fixture' });
    const folder = path.join(workspace, space.folder!);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'report.html'), '<h1>Fixture</h1>');
    const input = {
      workspaceRoot: workspace, folder: space.folder!, spaceId: space.id,
      artifactId: 'fixture', title: 'Fixture', sourceRelativePath: 'report.html',
    };
    const published = await publishArtifact(input);
    const publicationId = published.artifact.pendingPublicationId;
    expect(publicationId).toBeTypeOf('string');
    if (!publicationId) throw new Error('Missing publication receipt');
    const receipt = { ...input, publicationId };
    expect(await acknowledgeArtifactPublication({ ...receipt, publicationId: 'stale' })).toBe(false);
    expect(await acknowledgeArtifactPublication(receipt)).toBe(true);
    expect(await acknowledgeArtifactPublication(receipt)).toBe(false);
    const retry = await publishArtifact(input);
    expect(retry.changed).toBe(false);
    expect(retry.artifact.pendingPublicationId).toBeUndefined();
  });

  it('starts without Electron and forwards schedule notifications to the main process', async () => {
    vi.mocked(notifyAllWindows).mockClear();
    const schedule = await saveSkillSchedule(workspace, 'fixture-skill', 'daily', '09:00', null, {
      timeZone: 'UTC', intent: '', readOnlyServers: [],
    });
    expect(schedule.skillId).toBe('fixture-skill');
    expect(notifyAllWindows).toHaveBeenCalledExactlyOnceWith('skills:changed');
  });

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

  it('restores disk projections before acknowledging a compaction storage barrier', async () => {
    const space = await createSpace({ body: '# Original logged title' });
    const deleted = await createSpace({ body: '# Deleted remotely' });
    const missingCanvas = await createSpace({ body: '# Missing canvas title' });
    for (const [item, content] of [
      [space, '# Disk title\ncanvasexclusive'],
      [deleted, '# Deleted disk title\ndeletedexclusive'],
      [missingCanvas, '# Removed disk title\nremovedexclusive'],
    ] as const) {
      const folder = path.join(workspace, item.folder!);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, 'canvas.md'), content);
      await setSpaceSessionId(item.id, `local-session-${item.id}`);
    }
    await createSkillDocument(workspace, 'fixture', '---\nname: Fixture\n---\n');
    await createSkillDocument(workspace, 'removed', '---\nname: Removed\n---\n');
    await syncCanvasContent(workspace);
    await indexSkills(workspace);
    expect((await getSpace(space.id))?.description).toBe('Disk title');
    expect((await listSpaceSummaries({ query: 'canvasexclusive' })).total).toBe(1);
    expect((await listSkills()).map(skill => skill.id).sort()).toEqual(['fixture', 'removed']);

    const root = path.join(workspace, '.whim', 'events');
    appendEvent(root, 'space.delete', { id: deleted.id });
    fs.unlinkSync(path.join(workspace, missingCanvas.folder!, 'canvas.md'));
    await deleteSkillDirectory(workspace, '.agents/skills/removed');
    const compaction = await compactOldSegments(root, { now: new Date(Date.now() + 90 * 86400_000) });
    expect(compaction.ran).toBe(true);

    await withStorageBarrier(async () => {
      expect(await getSpace(space.id)).toMatchObject({ description: 'Disk title', session_id: `local-session-${space.id}` });
      expect((await listSpaceSummaries({ query: 'canvasexclusive' })).total).toBe(1);
      expect(await getSpace(deleted.id)).toBeNull();
      expect((await listSpaceSummaries({ query: 'deletedexclusive' })).total).toBe(0);
      expect((await listSpaceSummaries({ query: 'removedexclusive' })).total).toBe(0);
      expect((await getSpace(missingCanvas.id))?.description).toBe('Missing canvas title');
      expect((await listSkills()).map(skill => skill.id)).toEqual(['fixture']);
    });
    await closeDatabase();
    await initDatabase(path.join(workspace, '.whim', 'spaces.db'), root);
    expect(await getSpace(space.id)).toMatchObject({ description: 'Disk title', session_id: `local-session-${space.id}` });
    expect((await listSpaceSummaries({ query: 'canvasexclusive' })).total).toBe(1);
    expect((await listSkills()).map(skill => skill.id)).toEqual(['fixture']);
  });

  it('rejects an incomplete projection rebuild, retains the prior cache, and retries safely', async () => {
    const space = await createSpace({ body: '# Logged title' });
    const folder = path.join(workspace, space.folder!);
    const canvas = path.join(folder, 'canvas.md');
    fs.mkdirSync(folder);
    fs.writeFileSync(canvas, '# Disk title\nindexedexclusive');
    await setSpaceSessionId(space.id, 'local-session');
    await syncCanvasContent(workspace);
    await checkpointAppliedState();
    const sidecar = path.join(workspace, '.whim', 'db.fingerprint.json');
    const fingerprint = fs.readFileSync(sidecar);
    expect((await compactOldSegments(path.join(workspace, '.whim', 'events'), {
      now: new Date(Date.now() + 90 * 86400_000),
    })).ran).toBe(true);
    fs.unlinkSync(canvas);
    fs.mkdirSync(canvas);
    const synchronized = vi.fn(async () => {});
    await expect(withStorageBarrier(synchronized)).rejects.toThrow('EISDIR');
    expect(synchronized).not.toHaveBeenCalled();
    expect(fs.readFileSync(sidecar)).toEqual(fingerprint);
    expect(await getSpace(space.id)).toMatchObject({ description: 'Disk title', session_id: 'local-session' });
    await expect(checkpointAppliedState()).rejects.toThrow('requires recovery');

    fs.rmdirSync(canvas);
    fs.writeFileSync(canvas, '# Retried disk title\nindexedexclusive');
    await withStorageBarrier(synchronized);
    expect(synchronized).toHaveBeenCalledOnce();
    expect(await getSpace(space.id)).toMatchObject({ description: 'Retried disk title', session_id: 'local-session' });
    expect((await listSpaceSummaries({ query: 'indexedexclusive' })).total).toBe(1);
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

  it('coalesces overlapping closes and settles every waiter after draining the real worker', async () => {
    const saved = createSpace({ body: 'before overlapping close' });
    const first = closeDatabase();
    const second = closeDatabase();
    expect(second).toBe(first);
    const space = await saved;
    await Promise.all([first, second]);
    expect(getStorageReadiness()).toMatchObject({ state: 'closed', pending: 0 });
    await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
    expect(await getSpace(space.id)).toMatchObject({ body: space.body });
  });

  it('coalesces closes waiting on a barrier without orphaning deferred requests', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const synchronization = withStorageBarrier(async () => { entered(); await wait; });
    await ready;
    const saved = createSpace({ body: 'admitted before barrier close' });
    const first = closeDatabase();
    const second = closeDatabase();
    expect(second).toBe(first);
    release();
    await Promise.all([synchronization, saved, first, second]);
    expect(getStorageReadiness()).toMatchObject({ state: 'closed', pending: 0 });
  });

  it('settles overlapping closes after a worker failure and allows reopening', async () => {
    const saved = await createSpace({ body: 'saved before worker failure' });
    await fixture.instance!.terminate();
    const first = closeDatabase();
    const second = closeDatabase();
    expect(second).toBe(first);
    const results = await Promise.allSettled([first, second]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(String(result.reason)).toContain('Storage worker exited');
    }
    expect(getStorageReadiness()).toMatchObject({ state: 'closed', pending: 0 });
    await closeDatabase();
    await initDatabase(path.join(workspace, '.whim', 'spaces.db'), path.join(workspace, '.whim', 'events'));
    expect((await getSpace(saved.id))?.body).toBe(saved.body);
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

  it('rejects stale skill indexing from A without inserting old skills or deleting B skills', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-storage-other-'));
    let resume!: () => void;
    const wait = new Promise<void>(resolve => { resume = resolve; });
    try {
      await createSkillDocument(workspace, 'old-only', '---\nname: Old workspace\n---\n');
      const stale = withWorkspaceContext(async () => {
        await wait;
        return Promise.allSettled([
          createSpace({ body: 'old continuation' }),
          indexSkills(workspace),
        ]);
      });
      await closeDatabase();
      await initWorkspace(other);
      await initDatabase(path.join(other, '.whim', 'spaces.db'), path.join(other, '.whim', 'events'));
      await createSkillDocument(other, 'new-only', '---\nname: New workspace\n---\n');
      await indexSkills(other);
      resume();
      const results = await stale;
      for (const result of results) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(String(result.reason)).toContain('Stale workspace');
      }
      expect((await listSkills()).map(skill => skill.id)).toEqual(['new-only']);
    } finally {
      resume();
      await closeDatabase();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('revalidates skill indexing when the workspace changes between batches', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-storage-batch-other-'));
    try {
      for (let i = 0; i < 20; i++) {
        await createSkillDocument(workspace, `old-${i}`, `---\nname: Old ${i}\n---\n`);
      }
      const indexing = indexSkills(workspace);
      const result = Promise.allSettled([indexing]);
      await initWorkspace(other);
      await initDatabase(path.join(other, '.whim', 'spaces.db'), path.join(other, '.whim', 'events'));
      expect((await result)[0].status).toBe('rejected');
      await createSkillDocument(other, 'new-only', '---\nname: New workspace\n---\n');
      await indexSkills(other);
      expect((await listSkills()).map(skill => skill.id)).toEqual(['new-only']);
    } finally {
      await closeDatabase();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('retries the same canvas revision after the real barrier exhausts storage admission', async () => {
    const space = await createSpace({ body: '# Original title' });
    const folder = path.join(workspace, space.folder!);
    const canvas = path.join(folder, 'canvas.md');
    fs.mkdirSync(folder);
    fs.writeFileSync(canvas, '# Original title');
    const changed = vi.fn(async (content: string) => { await updateCanvasContent(space.id, content); });
    startWatching(space.id, canvas, changed);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const synchronization = withStorageBarrier(async () => { entered(); await wait; });
    await ready;
    const admitted = Array.from({ length: 256 }, () => getSpace(space.id));
    try {
      fs.writeFileSync(canvas, '# Retried title\nretryexclusive');
      await expect(refreshWatchedCanvases()).rejects.toThrow('Storage busy');
      expect(getStorageReadiness().pending).toBe(256);
    } finally {
      release();
      await synchronization;
      await Promise.all(admitted);
    }
    await refreshWatchedCanvases();
    expect(changed).toHaveBeenCalledTimes(2);
    expect((await getSpace(space.id))?.description).toBe('Retried title');
    expect((await listSpaceSummaries({ query: 'retryexclusive' })).total).toBe(1);
    await refreshWatchedCanvases();
    expect(changed).toHaveBeenCalledTimes(2);
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
