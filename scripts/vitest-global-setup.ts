/*
 * Guarantees native modules match Node's ABI before any test runs.
 *
 * `npm test` handles this via its pretest hook, but running `npx vitest` (or
 * an editor's test integration, or a watch process started before an app
 * build) bypasses npm scripts entirely. Those paths used to fail with 146
 * confusing ERR_DLOPEN_FAILED errors that looked like broken tests rather
 * than a stale binary.
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default function setup(): void {
  execFileSync(process.execPath, [path.join(here, 'ensure-native.js'), 'node'], {
    cwd: path.join(here, '..'),
    stdio: 'inherit',
  });
}
