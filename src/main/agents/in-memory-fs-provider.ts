import * as posixPath from 'path/posix';
import type { SessionFsProvider, SessionFsFileInfo } from '@microsoft/copilot-sdk';

interface FsEntry {
  content: string;
  isDir: boolean;
  mtime: string;
  birthtime: string;
}

function enoent(p: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, '${p}'`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

function normalize(p: string): string {
  return posixPath.normalize(p).replace(/\/+$/, '') || '/';
}

/**
 * In-memory SessionFsProvider for ephemeral (zero-persistence) agent sessions.
 * All data lives in a Map and is garbage-collected when the provider is released.
 */
export class InMemoryFsProvider implements SessionFsProvider {
  private store = new Map<string, FsEntry>();

  constructor() {
    // Seed root directory
    const now = new Date().toISOString();
    this.store.set('/', { content: '', isDir: true, mtime: now, birthtime: now });
  }

  async readFile(path: string): Promise<string> {
    const p = normalize(path);
    const entry = this.store.get(p);
    if (!entry || entry.isDir) throw enoent(p);
    return entry.content;
  }

  async writeFile(path: string, content: string, _mode?: number): Promise<void> {
    const p = normalize(path);
    this.ensureParentDirs(p);
    const now = new Date().toISOString();
    const existing = this.store.get(p);
    this.store.set(p, {
      content,
      isDir: false,
      mtime: now,
      birthtime: existing?.birthtime ?? now,
    });
  }

  async appendFile(path: string, content: string, _mode?: number): Promise<void> {
    const p = normalize(path);
    this.ensureParentDirs(p);
    const now = new Date().toISOString();
    const existing = this.store.get(p);
    this.store.set(p, {
      content: (existing && !existing.isDir ? existing.content : '') + content,
      isDir: false,
      mtime: now,
      birthtime: existing?.birthtime ?? now,
    });
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(normalize(path));
  }

  async stat(path: string): Promise<SessionFsFileInfo> {
    const p = normalize(path);
    const entry = this.store.get(p);
    if (!entry) throw enoent(p);
    return {
      isFile: !entry.isDir,
      isDirectory: entry.isDir,
      size: entry.isDir ? 0 : Buffer.byteLength(entry.content, 'utf-8'),
      mtime: entry.mtime,
      birthtime: entry.birthtime,
    };
  }

  async mkdir(path: string, recursive: boolean, _mode?: number): Promise<void> {
    const p = normalize(path);
    if (this.store.has(p)) return;

    if (recursive) {
      this.ensureParentDirs(p);
      this.mkdirSingle(p);
    } else {
      const parent = posixPath.dirname(p);
      const parentEntry = this.store.get(parent);
      if (!parentEntry || !parentEntry.isDir) throw enoent(parent);
      this.mkdirSingle(p);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const p = normalize(path);
    const entry = this.store.get(p);
    if (!entry || !entry.isDir) throw enoent(p);

    const prefix = p === '/' ? '/' : p + '/';
    const names: string[] = [];
    for (const key of this.store.keys()) {
      if (key === p) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      // Only direct children (no further slashes)
      if (rest && !rest.includes('/')) {
        names.push(rest);
      }
    }
    return names.sort();
  }

  async readdirWithTypes(path: string): Promise<Array<{ name: string; type: 'file' | 'directory' }>> {
    const p = normalize(path);
    const entry = this.store.get(p);
    if (!entry || !entry.isDir) throw enoent(p);

    const prefix = p === '/' ? '/' : p + '/';
    const entries: Array<{ name: string; type: 'file' | 'directory' }> = [];
    for (const [key, e] of this.store.entries()) {
      if (key === p) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest && !rest.includes('/')) {
        entries.push({ name: rest, type: e.isDir ? 'directory' : 'file' });
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    const p = normalize(path);
    const entry = this.store.get(p);
    if (!entry) {
      if (force) return;
      throw enoent(p);
    }

    if (entry.isDir && recursive) {
      // Remove all descendants
      const prefix = p === '/' ? '/' : p + '/';
      for (const key of [...this.store.keys()]) {
        if (key.startsWith(prefix)) this.store.delete(key);
      }
    }
    this.store.delete(p);
  }

  async rename(src: string, dest: string): Promise<void> {
    const s = normalize(src);
    const d = normalize(dest);
    const entry = this.store.get(s);
    if (!entry) throw enoent(s);

    this.ensureParentDirs(d);

    if (entry.isDir) {
      // Move directory and all descendants
      const prefix = s === '/' ? '/' : s + '/';
      const toMove: Array<[string, FsEntry]> = [];
      for (const [key, e] of this.store.entries()) {
        if (key === s || key.startsWith(prefix)) {
          toMove.push([key, e]);
        }
      }
      for (const [key] of toMove) this.store.delete(key);
      for (const [key, e] of toMove) {
        const newKey = key === s ? d : d + key.slice(s.length);
        this.store.set(newKey, e);
      }
    } else {
      this.store.delete(s);
      this.store.set(d, entry);
    }
  }

  // ── Private helpers ─────────────────────────────────────

  private mkdirSingle(p: string): void {
    if (this.store.has(p)) return;
    const now = new Date().toISOString();
    this.store.set(p, { content: '', isDir: true, mtime: now, birthtime: now });
  }

  private ensureParentDirs(p: string): void {
    const parts = p.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i];
      this.mkdirSingle(current);
    }
  }
}
