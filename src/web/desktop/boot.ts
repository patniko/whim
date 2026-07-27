/*
 * Boots the full whim renderer inside a browser.
 *
 * The renderer is entirely transport-agnostic: it reads `window.whimAPI` and
 * nothing else. So serving the real desktop UI over the web needs no fork of
 * it — only this: prove we have a session, install a browser-backed bridge on
 * the window, and then load the very same bundle the desktop runs.
 *
 * Load order is the whole trick. `app.js` runs on evaluation and immediately
 * starts calling the API, so it is injected from here rather than referenced
 * in the HTML — it must not execute until the bridge exists.
 */
import { establishSession, hasSession, WebRemoteClient } from '../lib/client';
import { createWebTransport } from './transport';
import { createWhimAPI } from '../../shared/whim-api';

async function boot(): Promise<void> {
  if (!(await establishSessionFromUrl()) && !(await hasSession())) {
    await promptForToken();
  }

  const { transport, dispatch } = createWebTransport({
    onUnauthorized: () => showFatal('Session expired', 'Reload and pair this device again.'),
  });

  (window as any).whimAPI = createWhimAPI(transport);
  (window as any).__platform = transport.platform;

  const client = new WebRemoteClient();
  client.connect(
    (event) => dispatch(event),
    () => {},
    () => showFatal('Signed out', 'This device is no longer paired.'),
    // A missed-event gap means in-memory state is unreliable. The renderer has
    // no incremental resync path, so the honest recovery is a reload.
    () => window.location.reload(),
  );

  await loadRenderer();
}

/**
 * Pair from a `?token=` in the URL, which is what the QR code in Settings
 * encodes.
 *
 * The token is stripped from the address bar immediately, before the exchange
 * is even attempted: it must not survive into history, a bookmark, or a
 * screenshot of a shared screen.
 */
async function establishSessionFromUrl(): Promise<boolean> {
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) return false;

  window.history.replaceState({}, '', window.location.pathname);
  try {
    await establishSession(token);
    return true;
  } catch {
    // Fall through to the manual prompt, which can report the failure with
    // somewhere for the user to correct it.
    return false;
  }
}

/** Inject the desktop renderer bundle now that `window.whimAPI` exists. */
function loadRenderer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/desktop/app.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load the whim interface.'));
    document.body.appendChild(script);
  });
}

/**
 * Pair this device.
 *
 * The token is a one-time credential: it is exchanged for an HttpOnly cookie
 * and never stored by the page, so a stolen bundle or a shoulder-surfed URL
 * doesn't carry lasting access.
 */
function promptForToken(): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'web-boot';
    overlay.innerHTML = `
      <form class="web-boot-card" novalidate>
        <h1>whim</h1>
        <p>Enter the access token from Settings &rarr; Web remote.</p>
        <input type="password" autocomplete="one-time-code" autocapitalize="off"
               autocorrect="off" spellcheck="false" placeholder="Access token" required>
        <button type="submit">Pair this device</button>
        <p class="web-boot-error" role="alert" hidden></p>
      </form>`;
    document.body.appendChild(overlay);

    const form = overlay.querySelector('form')!;
    const input = overlay.querySelector('input')!;
    const button = overlay.querySelector('button')!;
    const error = overlay.querySelector('.web-boot-error') as HTMLElement;

    input.focus();
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;

      button.disabled = true;
      error.hidden = true;
      try {
        await establishSession(input.value.trim());
        overlay.remove();
        resolve();
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : 'Sign-in failed.';
        error.hidden = false;
        button.disabled = false;
        input.select();
      }
    });
  });
}

function showFatal(title: string, detail: string): void {
  const existing = document.querySelector('.web-boot-fatal');
  if (existing) return;

  const panel = document.createElement('div');
  panel.className = 'web-boot web-boot-fatal';
  panel.innerHTML = `
    <div class="web-boot-card">
      <h1>${title}</h1>
      <p>${detail}</p>
      <button type="button">Reload</button>
    </div>`;
  panel.querySelector('button')!.addEventListener('click', () => window.location.reload());
  document.body.appendChild(panel);
}

boot().catch((err) => {
  console.error('[web] boot failed', err);
  showFatal('Could not start whim', err instanceof Error ? err.message : String(err));
});
