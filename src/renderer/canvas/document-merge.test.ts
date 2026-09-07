import { describe, expect, it } from 'vitest';
import { mergeCanvasDocument } from './document-merge';
import { joinComments } from './editor/comments';
import { serializeFrontmatter } from '../../shared/frontmatter';
import type { CommentThread } from './types';
import { merge3 } from '../../shared/text-merge';

describe('canvas merge document semantics', () => {
  const thread: CommentThread = {
    id: 'thread', quote: 'body', anchor: {}, comments: [{ body: 'remote comment', updatedAt: '2026-01-01' }],
  };

  it('keeps disk-authoritative comments and frontmatter for rendered documents', async () => {
    const base = serializeFrontmatter({ title: 'old' }, 'heading\nbody');
    const local = serializeFrontmatter({ title: 'local' }, 'local heading\nbody');
    const disk = serializeFrontmatter({ title: 'remote' }, joinComments('heading\nremote body', [thread]));
    const result = await mergeCanvasDocument(base, local, disk, false, true);
    expect(result.body).toBe('local heading\nremote body');
    expect(result.threads).toEqual([thread]);
    expect(result.frontmatter).toEqual({ title: 'remote' });
  });

  it('does not parse and reserialize dirty raw frontmatter or malformed comments', async () => {
    const base = '---\ntitle: old\n---\nbody\n';
    const local = '---\ntitle: [unfinished\n---\nbody\n';
    const disk = base + '\n:::whim-comments\n{invalid}\n:::\n';
    const result = await mergeCanvasDocument(base, local, disk, true, true);
    expect(result.full).toContain('title: [unfinished');
    expect(result.full).toContain(':::whim-comments\n{invalid}\n:::');
  });

  it('rebases edits made after saving without dropping locally added comments', async () => {
    const sent = 'heading\nbody';
    const current = joinComments('new heading\nbody', [thread]);
    const saved = 'heading\nremote body';
    const result = await mergeCanvasDocument(sent, current, saved, true, false);
    expect(result.full).toBe(merge3(sent, current, saved).merged);
    expect(result.body).toContain('new heading');
    expect(result.body).toContain('remote body');
    expect(result.threads).toEqual([thread]);
  });

  it('uses the same normalized disk snapshot for clean rendered and raw documents', async () => {
    const legacy = joinComments('disk body', [thread]).replace(':::whim-comments', ':::documint-comments');
    const result = await mergeCanvasDocument('base', 'base', legacy, false, false);
    expect(result.full).toBe(joinComments('disk body', [thread]));
    expect(result.synchronizedDisk).toBe(result.full);
  });
});
