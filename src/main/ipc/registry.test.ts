import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WEB_ACCESS, webAccessFor } from '../../shared/web-access';

/**
 * A static ratchet over the "one implementation, two transports" rule.
 *
 * Loading the real registry needs Electron, so instead of booting the app this
 * reads the source. That is enough, because the thing worth protecting is a
 * source-level property: a command classified `allow` must actually exist
 * somewhere, and every registration must go through `registerIpcHandler` so
 * the web gateway can see it.
 *
 * Without this, a handler registered straight on `ipcMain.handle` would work
 * perfectly on the desktop and return a 501 in the browser — with nothing
 * failing until someone opened that screen over the network.
 */

const MAIN_DIR = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [full];
  });
}

const SOURCES = sourceFiles(MAIN_DIR).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

function registeredChannels(): Set<string> {
  const found = new Set<string>();
  for (const { text } of SOURCES) {
    for (const match of text.matchAll(/registerIpcHandler\(\s*'([^']+)'/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

describe('ipc handler registry', () => {
  it('is the only way handlers get registered', () => {
    const offenders = SOURCES.filter(
      ({ file, text }) => !file.endsWith(path.join('ipc', 'registry.ts')) && /\bipcMain\.handle\(/.test(text),
    ).map(({ file }) => path.relative(MAIN_DIR, file));

    expect(offenders).toEqual([]);
  });

  it('classifies every channel it registers', () => {
    const unclassified = [...registeredChannels()].filter((channel) => webAccessFor(channel) === null);
    expect(unclassified).toEqual([]);
  });

  it('registers every channel the web remote is allowed to reach', () => {
    const registered = registeredChannels();
    const gatewaySource = fs.readFileSync(path.join(MAIN_DIR, 'web', 'gateway.ts'), 'utf8');
    const gatewayBody = gatewaySource.slice(gatewaySource.indexOf('const HANDLERS'));
    const implementedByGateway = new Set(
      [...gatewayBody.matchAll(/^\s{2}'([^']+)':/gm)].map((match) => match[1]),
    );

    const unreachable = Object.entries(WEB_ACCESS)
      .filter(([, access]) => access === 'allow')
      .map(([channel]) => channel)
      // `registerHandler` (typed-handler.ts) registers through the registry too,
      // but with a generic channel argument, so match those separately.
      .filter((channel) => !registered.has(channel) && !implementedByGateway.has(channel))
      .filter((channel) => !SOURCES.some(({ text }) => text.includes(`registerHandler('${channel}'`)));

    expect(unreachable).toEqual([]);
  });
});
