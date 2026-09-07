import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { coveredOffset, hashFile, parseManifest, readLines, writeAll } from './persistence-snapshot';

vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));

let directory: string;
let file: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-snapshot-io-'));
  file = path.join(directory, 'fixture.jsonl');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('streamed persistence IO', () => {
  it('preserves UTF-8 crossing buffer boundaries and distinguishes a torn final line', () => {
    const text = 'x'.repeat(64 * 1024 - 1) + '\u20ac';
    fs.writeFileSync(file, text + '\n' + 'last');
    expect([...readLines(file)]).toEqual([
      { text, number: 1, terminated: true },
      { text: 'last', number: 2, terminated: false },
    ]);
    expect([...readLines(file, Buffer.byteLength(text + '\n'))]).toEqual([
      { text: 'last', number: 1, terminated: false },
    ]);
  });

  it('hashes only covered bytes and rejects truncated or non-newline coverage', () => {
    fs.writeFileSync(file, 'old\nnew\n');
    const sha256 = crypto.createHash('sha256').update('old\n').digest('hex');
    expect(hashFile(file, 4)).toBe(sha256);
    expect(coveredOffset(file, { path: '2024-01/events-001.jsonl', bytes: 4, sha256 })).toBe(4);
    expect(() => coveredOffset(file, {
      path: '2024-01/events-001.jsonl', bytes: 3, sha256: hashFile(file, 3),
    })).toThrow('incomplete final line');
    fs.writeFileSync(file, 'old');
    expect(() => coveredOffset(file, { path: '2024-01/events-001.jsonl', bytes: 4, sha256 })).toThrow('conflicts');
  });

  it('handles short writes without losing UTF-8 bytes', () => {
    const write = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation((...args: unknown[]) => {
      const [fd, buffer, offset, length] = args;
      if (typeof fd === 'number' && Buffer.isBuffer(buffer) && typeof offset === 'number' && typeof length === 'number') {
        return write(fd, buffer, offset, Math.min(length, 3));
      }
      throw new Error('Unexpected write signature');
    });
    const fd = fs.openSync(file, 'wx');
    try { writeAll(fd, 'long \u20ac payload\n'); } finally { fs.closeSync(fd); }
    expect(fs.readFileSync(file, 'utf8')).toBe('long \u20ac payload\n');
  });

  it('rejects unsupported manifests, duplicate coverage and unsafe paths', () => {
    expect(() => parseManifest({ version: 2, covered: [], garbage: [] })).toThrow('Unsupported snapshot');
    const entry = { path: '2024-01/events-001.jsonl', bytes: 0, sha256: 'a'.repeat(64) };
    expect(() => parseManifest({ version: 1, covered: [entry, entry], garbage: [] })).toThrow('Invalid covered segment');
    expect(() => parseManifest({ version: 1, covered: [], garbage: ['../outside'] })).toThrow('Invalid snapshot garbage path');
  });
});
