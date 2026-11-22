// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CopilotAuthState, GitHubSignInProgress, GitHubSignInResult } from '../shared/ipc-contract';
import { describeAuthState, mountGitHubAccount, type GitHubAccountApi } from './github-account';

const signedOut: CopilotAuthState = { signedIn: false, login: null, host: null, source: null };
const octocat: CopilotAuthState = { signedIn: true, login: 'octocat', host: 'https://github.com', source: 'sign-in' };

function setup(state: CopilotAuthState) {
  document.body.innerHTML = `
    <span id="status"></span>
    <button id="sign-in"></button><button id="use-code"></button><button id="cancel"></button><button id="sign-out"></button>
    <div id="code"><code id="code-value"></code><button id="copy"></button></div>`;
  let progress: (p: GitHubSignInProgress) => void = () => {};
  let finish!: (result: GitHubSignInResult) => void;
  const api = {
    getAuthState: vi.fn(async () => state),
    signInToGitHub: vi.fn(() => new Promise<GitHubSignInResult>(resolve => { finish = resolve; })),
    cancelGitHubSignIn: vi.fn(async () => ({ ok: true as const })),
    signOutOfGitHub: vi.fn(async () => signedOut),
    onAuthChanged: vi.fn(() => () => {}),
    onSignInProgress: vi.fn((callback: (p: GitHubSignInProgress) => void) => { progress = callback; return () => {}; }),
    openExternal: vi.fn(async () => ({})),
  } satisfies GitHubAccountApi;
  const el = (id: string) => document.getElementById(id)!;
  const onState = vi.fn();
  const account = mountGitHubAccount(api, {
    status: el('status'),
    signIn: el('sign-in') as HTMLButtonElement,
    useCode: el('use-code') as HTMLButtonElement,
    cancel: el('cancel') as HTMLButtonElement,
    signOut: el('sign-out') as HTMLButtonElement,
    code: el('code'),
    codeValue: el('code-value'),
    copyCode: el('copy') as HTMLButtonElement,
  }, onState);
  const visible = (id: string) => !el(id).classList.contains('hidden');
  return { api, account, el, visible, onState, progress: (p: GitHubSignInProgress) => progress(p), finish: (r: GitHubSignInResult) => finish(r) };
}

describe('GitHub account control', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('offers sign-in when signed out and sign-out only for a stored sign-in', async () => {
    const out = setup(signedOut);
    await out.account.refresh();
    expect(out.el('status').textContent).toBe('Not signed in');
    expect([out.visible('sign-in'), out.visible('use-code'), out.visible('sign-out')]).toEqual([true, true, false]);

    const viaGh = setup({ ...octocat, source: 'github-cli' });
    await viaGh.account.refresh();
    expect(viaGh.el('status').textContent).toBe('Signed in as @octocat (from the GitHub CLI)');
    expect([viaGh.visible('sign-in'), viaGh.visible('sign-out')]).toEqual([false, false]);

    const stored = setup(octocat);
    await stored.account.refresh();
    expect(stored.visible('sign-out')).toBe(true);
    expect(stored.onState).toHaveBeenLastCalledWith(octocat);
  });

  it('shows the device code while signing in with a code, then the account', async () => {
    const ui = setup(signedOut);
    await ui.account.refresh();
    ui.el('use-code').click();
    expect(ui.api.signInToGitHub).toHaveBeenCalledWith('device-code');
    expect(ui.visible('cancel')).toBe(true);

    ui.progress({ kind: 'device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 899 });
    expect(ui.visible('code')).toBe(true);
    expect(ui.el('code-value').textContent).toBe('ABCD-1234');
    expect(ui.el('status').textContent).toBe('Enter this code at github.com/login/device');

    ui.finish({ ok: true, state: octocat });
    await vi.waitFor(() => expect(ui.el('status').textContent).toBe('Signed in as @octocat'));
    expect([ui.visible('code'), ui.visible('cancel')]).toEqual([false, false]);
  });

  it('shows why a sign-in failed and offers it again', async () => {
    const ui = setup(signedOut);
    await ui.account.refresh();
    ui.el('sign-in').click();
    ui.finish({ ok: false, error: 'The authorization request was denied.' });
    await vi.waitFor(() => expect(ui.el('status').textContent).toBe('The authorization request was denied.'));
    expect(ui.el('status').classList.contains('github-account-error')).toBe(true);
    expect(ui.visible('sign-in')).toBe(true);
  });

  it('names a GitHub Enterprise host', () => {
    expect(describeAuthState({ ...octocat, host: 'https://acme.ghe.com' })).toBe('Signed in as @octocat on acme.ghe.com');
  });
});
