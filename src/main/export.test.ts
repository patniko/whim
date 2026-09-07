import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Mock heavy / native dependencies so we can unit-test the pure render logic.
vi.mock('electron', () => ({ BrowserWindow: class {} }));
vi.mock('html-to-docx', () => ({ default: vi.fn(async () => Buffer.from('docx')) }));
vi.mock('./storage', async () => ({
  ...(await import('./workspace')),
  ...(await import('./services/skill-schedule-store')),
  ...(await import('./canvas/artifact-store')),
  documentMatches: (await import('./storage-documents')).documentMatches,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

  isInitialized: vi.fn(() => true),
  getSpace: vi.fn(),
}));
vi.mock('./workspace', () => ({
  resolveSpaceFolder: vi.fn((ws: string, folder: string) => path.join(ws, folder)),
  readCanvas: vi.fn(),
  readPage: vi.fn(),
  getMimeType: vi.fn((p: string) => (p.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream')),
}));
vi.mock('./config', () => ({
  getConfigValue: vi.fn(() => '/workspace'),
}));

import {
  slugifyTitle,
  renderCanvasHtml,
  loadCanvasForExport,
  EXPORT_FORMATS,
  EXPORT_EXTENSIONS,
} from './export';
import { isInitialized, getSpace } from './storage';
import { readCanvas } from './workspace';
import { getConfigValue } from './config';

describe('export engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfigValue).mockReturnValue('/workspace' as never);
    vi.mocked(isInitialized).mockReturnValue(true);
  });

  describe('slugifyTitle', () => {
    it('lowercases and hyphenates', () => {
      expect(slugifyTitle('My Report (v2)')).toBe('my-report-v2');
    });

    it('trims leading/trailing separators', () => {
      expect(slugifyTitle('  Hello!!  ')).toBe('hello');
    });

    it('falls back to "canvas" for empty/symbol-only titles', () => {
      expect(slugifyTitle('')).toBe('canvas');
      expect(slugifyTitle('!!!')).toBe('canvas');
    });

    it('truncates very long titles', () => {
      const slug = slugifyTitle('a'.repeat(200));
      expect(slug.length).toBeLessThanOrEqual(80);
    });
  });

  describe('format tables', () => {
    it('exposes the three supported formats with extensions', () => {
      expect(EXPORT_FORMATS).toEqual(['pdf', 'docx', 'md']);
      expect(EXPORT_EXTENSIONS).toEqual({ pdf: 'pdf', docx: 'docx', md: 'md' });
    });
  });

  describe('renderCanvasHtml', () => {
    const loaded = { title: 'My <Doc>', body: '# Heading\n\n- one\n- two', baseDir: '/workspace/space' };

    it('converts markdown to HTML and escapes the title', () => {
      const html = renderCanvasHtml(loaded);
      expect(html).toContain('<h1>Heading</h1>');
      expect(html).toContain('<li>one</li>');
      expect(html).toContain('<title>My &lt;Doc&gt;</title>');
    });

    it('adds a <base href> to the attachment folder by default', () => {
      const html = renderCanvasHtml(loaded);
      expect(html).toMatch(/<base href="file:\/\/.*space\/?">/);
    });

    it('inlines local images as data URIs when requested', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-export-test-'));
      try {
        fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([1, 2, 3, 4]));
        const html = renderCanvasHtml(
          { title: 'Img', body: '![alt](pic.png)', baseDir: dir },
          { inlineImages: true },
        );
        expect(html).toContain('data:image/png;base64,');
        expect(html).not.toContain('<base href');
        // The original relative reference should be gone.
        expect(html).not.toContain('src="pic.png"');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves remote image URLs untouched even when inlining', () => {
      const html = renderCanvasHtml(
        { title: 'Remote', body: '![x](https://example.com/a.png)', baseDir: '/workspace/space' },
        { inlineImages: true },
      );
      expect(html).toContain('https://example.com/a.png');
      expect(html).not.toContain('data:');
    });
  });

  describe('loadCanvasForExport', () => {
    it('returns an error when no workspace is configured', async () => {
      vi.mocked(getConfigValue).mockReturnValue(null as never);
      expect((await loadCanvasForExport('space-1'))).toEqual({ error: 'no_workspace' });
    });

    it('strips frontmatter and derives the title from the space description', async () => {
      vi.mocked(getSpace).mockResolvedValue({ folder: 'my-space', description: 'My Title' } as never);
      vi.mocked(readCanvas).mockReturnValue('---\nskills: [a]\n---\n# Body content');

      const result = (await loadCanvasForExport('space-1'));
      expect(result).toEqual({
        title: 'My Title',
        body: '# Body content',
        baseDir: path.join('/workspace', 'my-space'),
      });
    });

    it('returns not_found when the space has no folder', async () => {
      vi.mocked(getSpace).mockResolvedValue({ folder: null, description: 'x' } as never);
      expect((await loadCanvasForExport('space-1'))).toEqual({ error: 'not_found' });
    });

    it('resolves a workspace .md file pseudo-space', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-export-file-'));
      try {
        const filePath = path.join(dir, 'notes.md');
        fs.writeFileSync(filePath, '# File body');
        const id = `__file__${encodeURIComponent(filePath)}`;
        const result = (await loadCanvasForExport(id));
        expect(result).toEqual({ title: 'notes', body: '# File body', baseDir: dir });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
