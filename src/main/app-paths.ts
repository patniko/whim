import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Stable, productName-independent directory name for the app's user data.
 *
 * Settings (config.json) live under `app.getPath('userData')`, which Electron
 * derives from the app's `productName`. That name has changed over time (dev
 * builds use "whim"; older packaged builds used "Copilot Whim"), so each variant
 * silently read/wrote a *different* folder — making saved settings (e.g. a
 * persona's `yolo` flag) appear not to persist across restarts/upgrades.
 *
 * Pinning `userData` to a fixed location keeps every build pointed at the same
 * config.json.
 */
export const USER_DATA_DIR_NAME = 'whim';

/**
 * Pin `userData` to `<appData>/whim` so it no longer depends on `productName`.
 *
 * This runs as an import-time side effect because several modules
 * (config.ts, ai.ts, migration.ts, voice.ts) resolve
 * `app.getPath('userData')` at module-load time. The build is CommonJS, so
 * importing this module *first* in main.ts guarantees the path is pinned before
 * any of those modules are evaluated.
 *
 * Must be called before the app `ready` event, which import-time execution
 * satisfies.
 */
try {
  const userDataPath = path.join(app.getPath('appData'), USER_DATA_DIR_NAME);
  fs.mkdirSync(userDataPath, { recursive: true });
  app.setPath('userData', userDataPath);
} catch (err) {
  console.error('[app-paths] Failed to pin userData path:', err);
}
