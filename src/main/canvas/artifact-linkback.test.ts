import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const notified: any[] = [];
vi.mock('../notify', () => ({
  notifyAllWindows: (channel: string, payload: any) => { notified.push({ channel, payload }); },
}));

const titleUpdates: any[] = [];
vi.mock('../database', () => ({
  updateCanvasContent: (spaceId: string, content: string) => {
    titleUpdates.push({ spaceId, content });
    return { titleChanged: false, title: '' };
  },
}));

vi.mock('../canvas-watcher', () => ({
  markSelfWrite: vi.fn(),
  clearSelfWrite: vi.fn(),
}));

import {
  REPORTS_HEADING,
  buildArtifactLinkUrl,
  buildArtifactLinkLine,
  upsertArtifactLink,
  linkArtifactIntoDocument,
} from './artifact-linkback';

const link = { spaceId: 'space-1', artifactId: 'comment-7', title: 'Q3 churn', status: '3 drivers' };

describe('upsertArtifactLink', () => {
  it('starts a Reports section in a document that has none', () => {
    const result = upsertArtifactLink('# Notes\n\nSome writing.\n', link);

    expect(result).toContain(REPORTS_HEADING);
    expect(result).toContain(buildArtifactLinkUrl('space-1', 'comment-7'));
  });

  it('produces a link the canvas can route, with the status alongside it', () => {
    expect(buildArtifactLinkLine(link)).toBe('- [Q3 churn](whim://artifact/space-1/comment-7) — 3 drivers');
  });

  it('adds to the existing section rather than starting a second one', () => {
    const first = upsertArtifactLink('# Notes\n', link);
    const second = upsertArtifactLink(first, { ...link, artifactId: 'comment-8', title: 'Pricing' });

    expect(second.match(/## Reports/g)).toHaveLength(1);
    expect(second).toContain('comment-7');
    expect(second).toContain('comment-8');
  });

  it('refreshes a report in place, so a rerun does not stack duplicate links', () => {
    const first = upsertArtifactLink('# Notes\n', link);
    const second = upsertArtifactLink(first, { ...link, title: 'Q3 churn (updated)', status: '4 drivers' });

    expect(second.match(/comment-7/g)).toHaveLength(1);
    expect(second).toContain('Q3 churn (updated)');
    expect(second).not.toContain('3 drivers');
  });

  it('is a no-op when nothing about the report changed', () => {
    const first = upsertArtifactLink('# Notes\n', link);
    expect(upsertArtifactLink(first, link)).toBe(first);
  });

  it('leaves the user\'s own prose under the heading alone', () => {
    const doc = `# Notes\n\n${REPORTS_HEADING}\n\nI keep the good ones here.\n`;
    const result = upsertArtifactLink(doc, link);

    expect(result).toContain('I keep the good ones here.');
    expect(result.indexOf('I keep the good ones here.')).toBeLessThan(result.indexOf('comment-7'));
  });

  it('does not stop at a later heading, which belongs to another section', () => {
    const doc = `${REPORTS_HEADING}\n\n- existing\n\n## Later\n\nOther content.\n`;
    const result = upsertArtifactLink(doc, link);

    expect(result.indexOf('comment-7')).toBeLessThan(result.indexOf('## Later'));
  });

  it('escapes a title that would otherwise break out of the link label', () => {
    const line = buildArtifactLinkLine({ ...link, title: 'Costs [Q3](evil)' });
    expect(line).toBe('- [Costs \\[Q3\\](evil)](whim://artifact/space-1/comment-7) — 3 drivers');
  });

  it('handles an empty document without leading blank lines', () => {
    expect(upsertArtifactLink('', link)).toBe(
      `${REPORTS_HEADING}\n\n- [Q3 churn](whim://artifact/space-1/comment-7) — 3 drivers\n`,
    );
  });
});

describe('linkArtifactIntoDocument', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    notified.length = 0;
    titleUpdates.length = 0;
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-linkback-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  // Each test uses its own space id: the editor merge cache is keyed by space
  // id and outlives a test, which in production is right (one id, one document)
  // but here would make two tmp workspaces look like one edited document.
  function makeSpace(folder: string, content = '# Notes\n'): string {
    const dir = path.join(workspaceRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'canvas.md'), content);
    return dir;
  }

  it('writes the link into the space document', () => {
    const dir = makeSpace('space-w');

    const wrote = linkArtifactIntoDocument({ workspaceRoot, spaceId: 'space-w', folder: 'space-w', link });

    expect(wrote).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'canvas.md'), 'utf-8')).toContain('whim://artifact/space-1/comment-7');
  });

  it('does not rewrite the document when the link is already there', () => {
    makeSpace('space-x');
    linkArtifactIntoDocument({ workspaceRoot, spaceId: 'space-x', folder: 'space-x', link });
    titleUpdates.length = 0;

    expect(linkArtifactIntoDocument({ workspaceRoot, spaceId: 'space-x', folder: 'space-x', link })).toBe(false);
    expect(titleUpdates).toHaveLength(0);
  });

  it('keeps writing the user did while the agent was working', () => {
    const dir = makeSpace('space-y', '# Notes\n');
    linkArtifactIntoDocument({ workspaceRoot, spaceId: 'space-y', folder: 'space-y', link });
    fs.appendFileSync(path.join(dir, 'canvas.md'), '\nA thought I had meanwhile.\n');

    linkArtifactIntoDocument({
      workspaceRoot,
      spaceId: 'space-y',
      folder: 'space-y',
      link: { ...link, artifactId: 'comment-8', title: 'Pricing' },
    });

    const content = fs.readFileSync(path.join(dir, 'canvas.md'), 'utf-8');
    expect(content).toContain('A thought I had meanwhile.');
    expect(content).toContain('comment-8');
  });

  it('links into the child page the comment was left on, and tells the open editor', () => {
    const dir = makeSpace('space-z');
    fs.writeFileSync(path.join(dir, 'research.md'), '# Research\n');

    const wrote = linkArtifactIntoDocument({
      workspaceRoot,
      spaceId: 'space-z',
      folder: 'space-z',
      pageName: 'research',
      link,
    });

    expect(wrote).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'research.md'), 'utf-8')).toContain('comment-7');
    // Child pages have no watcher, so without this an open page editor would
    // never show the link.
    expect(notified.some(n => n.channel === 'canvas:content-updated')).toBe(true);
  });

  it('reports failure rather than throwing when the space folder is gone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(linkArtifactIntoDocument({
      workspaceRoot,
      spaceId: 'missing',
      folder: 'missing',
      pageName: 'nope',
      link,
    })).toBe(false);
    warn.mockRestore();
  });
});
