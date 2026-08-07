// @vitest-environment happy-dom
//
// Link routing out of a space document. A report link that opens nothing is
// worse than no link — the report exists, the user clicked, and nothing
// happened — so the routes are pinned here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openWhimResource } from './MarkdownCanvas';

const calls: any[] = [];

beforeEach(() => {
  calls.length = 0;
  (globalThis as any).whimAPI = {
    openCanvasArtifact: (spaceId: string, artifactId: string) => {
      calls.push({ kind: 'artifact', spaceId, artifactId });
      return Promise.resolve({ ok: true });
    },
    openCanvasWindow: (target: any) => { calls.push({ kind: 'space', ...target }); },
    openPageWindow: (target: any) => { calls.push({ kind: 'page', ...target }); },
  };
});

afterEach(() => {
  delete (globalThis as any).whimAPI;
});

describe('openWhimResource', () => {
  it('opens a report from a link in the document', () => {
    openWhimResource('whim://artifact/space-1/comment-7');

    expect(calls).toEqual([{ kind: 'artifact', spaceId: 'space-1', artifactId: 'comment-7' }]);
  });

  it('decodes ids, so a space id with a reserved character still resolves', () => {
    openWhimResource('whim://artifact/space%2F1/comment-7');

    expect(calls[0]).toMatchObject({ spaceId: 'space/1', artifactId: 'comment-7' });
  });

  it('opens nothing for a malformed report link instead of throwing', () => {
    expect(() => openWhimResource('whim://artifact/space-1')).not.toThrow();
    expect(() => openWhimResource('whim://artifact/%E0%A4%A/x')).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('still routes space and page links', () => {
    openWhimResource('whim://space/space-2');
    openWhimResource('whim://page/space-2/research');

    expect(calls[0]).toMatchObject({ kind: 'space', id: 'space-2' });
    expect(calls[1]).toMatchObject({ kind: 'page', spaceId: 'space-2', page: 'research' });
  });

  it('does not treat an artifact link as a space link', () => {
    openWhimResource('whim://artifact/space-1/report');

    expect(calls.every(c => c.kind === 'artifact')).toBe(true);
  });
});
