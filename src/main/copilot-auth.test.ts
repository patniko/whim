import { beforeEach, describe, expect, it, vi } from 'vitest';

const { shell, dialog, ai, sendToAllWindows, login, accounts, client } = vi.hoisted(() => {
  const login = { begin: vi.fn(), advance: vi.fn(), cancel: vi.fn(async () => {}) };
  const accounts = { login, set: vi.fn(async () => ({ ok: true })) };
  const session = { sessionId: 'auth-session', rpc: { accounts }, disconnect: vi.fn(async () => {}) };
  const client = {
    getAuthStatus: vi.fn(),
    createSession: vi.fn(async () => session),
    deleteSession: vi.fn(async () => {}),
  };
  return {
    shell: { openExternal: vi.fn(async () => {}) },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    ai: {
      getCopilotClient: vi.fn(() => client),
      getCopilotInitError: vi.fn(() => null),
      initCopilot: vi.fn(async () => {}),
      resetAfterAuthChange: vi.fn(async () => {}),
    },
    sendToAllWindows: vi.fn(),
    login, accounts, client,
  };
});

vi.mock('electron', () => ({ shell, dialog, BrowserWindow: { getFocusedWindow: () => null } }));
vi.mock('./ai', () => ai);
vi.mock('./ipc/typed-handler', () => ({ sendToAllWindows }));

import { cancelGitHubSignIn, getCopilotAuthState, signInToGitHub, signOutOfGitHub } from './copilot-auth';

const signedOut = { isAuthenticated: false, statusMessage: 'Not authenticated' };
const octocat = { isAuthenticated: true, authType: 'user', login: 'octocat', host: 'https://github.com' };
const completed = { kind: 'completed', result: { status: 'completed', login: 'octocat', host: 'https://github.com' } };

describe('copilot-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.getAuthStatus.mockResolvedValue(signedOut);
    login.cancel.mockResolvedValue(undefined);
  });

  it('describes where the credential comes from', async () => {
    client.getAuthStatus.mockResolvedValueOnce({ ...octocat, authType: 'gh-cli' });
    await expect(getCopilotAuthState()).resolves.toEqual({
      signedIn: true, login: 'octocat', host: 'https://github.com', source: 'github-cli',
    });
  });

  it('signs in through the browser, then announces the new account', async () => {
    const report = vi.fn();
    login.begin.mockResolvedValue({ flowId: 'f1', step: { kind: 'open-url', url: 'https://github.com/login/oauth/authorize?x=1' } });
    login.advance.mockImplementation(async () => {
      client.getAuthStatus.mockResolvedValue(octocat);
      return completed;
    });

    const result = await signInToGitHub('web', report);

    expect(login.begin).toHaveBeenCalledWith({ kind: 'githubDotCom', method: 'web' });
    expect(report).toHaveBeenCalledWith({ kind: 'browser' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?x=1');
    const state = { signedIn: true, login: 'octocat', host: 'https://github.com', source: 'sign-in' };
    expect(result).toEqual({ ok: true, state });
    expect(ai.resetAfterAuthChange).toHaveBeenCalled();
    expect(sendToAllWindows).toHaveBeenCalledWith('auth:changed', state);
    expect(login.cancel).not.toHaveBeenCalled();
    // The session that hosted the flow must not linger in the CLI's session list.
    expect(client.deleteSession).toHaveBeenCalledWith('auth-session');
  });

  it('reports the device code for the user to enter', async () => {
    const report = vi.fn();
    login.begin.mockResolvedValue({
      flowId: 'f2',
      step: { kind: 'device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 899, interval: 5 },
    });
    login.advance.mockImplementation(async () => {
      client.getAuthStatus.mockResolvedValue(octocat);
      return completed;
    });

    await expect(signInToGitHub('device-code', report)).resolves.toMatchObject({ ok: true });
    expect(report).toHaveBeenCalledWith({
      kind: 'device-code', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresIn: 899,
    });
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('stores the token in plain text only after the user agrees', async () => {
    login.begin.mockResolvedValue({ flowId: 'f3', step: { kind: 'open-url', url: 'https://github.com/login' } });
    login.advance
      .mockResolvedValueOnce({ kind: 'completed', result: { status: 'needs-plaintext-consent' } })
      .mockImplementationOnce(async () => {
        client.getAuthStatus.mockResolvedValue(octocat);
        return completed;
      });

    await expect(signInToGitHub('web', vi.fn())).resolves.toMatchObject({ ok: true });
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(login.advance).toHaveBeenLastCalledWith({ flowId: 'f3', input: 'allow' });
  });

  it('returns the runtime error and releases the flow', async () => {
    login.begin.mockResolvedValue({ flowId: 'f4', step: { kind: 'open-url', url: 'https://github.com/login' } });
    login.advance.mockResolvedValue({ kind: 'error', message: 'The authorization request was denied.' });

    await expect(signInToGitHub('web', vi.fn())).resolves.toEqual({ ok: false, error: 'The authorization request was denied.' });
    expect(login.cancel).toHaveBeenCalledWith({ flowId: 'f4' });
    expect(sendToAllWindows).not.toHaveBeenCalled();
  });

  it('resolves as cancelled when the user cancels while waiting on the browser', async () => {
    login.begin.mockResolvedValue({ flowId: 'f5', step: { kind: 'open-url', url: 'https://github.com/login' } });
    login.advance.mockImplementation(() => new Promise((_, reject) => {
      login.cancel.mockImplementation(async () => reject(new Error('Login flow cancelled')));
    }));

    const pending = signInToGitHub('web', vi.fn());
    await vi.waitFor(() => expect(login.advance).toHaveBeenCalled());
    await cancelGitHubSignIn();

    await expect(pending).resolves.toEqual({ ok: false, cancelled: true });
    expect(ai.resetAfterAuthChange).not.toHaveBeenCalled();
  });

  it('allows only one sign-in at a time', async () => {
    login.begin.mockResolvedValue({ flowId: 'f6', step: { kind: 'open-url', url: 'https://github.com/login' } });
    let finish!: (step: unknown) => void;
    login.advance.mockImplementation(() => new Promise(resolve => { finish = resolve; }));

    const first = signInToGitHub('web', vi.fn());
    await vi.waitFor(() => expect(login.advance).toHaveBeenCalled());
    await expect(signInToGitHub('web', vi.fn())).resolves.toEqual({ ok: false, error: 'A sign-in is already in progress.' });
    client.getAuthStatus.mockResolvedValue(octocat);
    finish(completed);
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('leaves a GitHub CLI login for gh to remove', async () => {
    client.getAuthStatus.mockResolvedValue({ ...octocat, authType: 'gh-cli' });

    const state = await signOutOfGitHub();

    expect(state).toMatchObject({ signedIn: true, source: 'github-cli' });
    expect(state.error).toContain('gh auth logout');
    expect(accounts.set).not.toHaveBeenCalled();
  });

  it('signs out a stored sign-in and announces it', async () => {
    client.getAuthStatus.mockResolvedValueOnce(octocat).mockResolvedValue(signedOut);

    const state = await signOutOfGitHub();

    expect(accounts.set).toHaveBeenCalledWith({ command: { kind: 'logout' } });
    expect(state).toEqual({ signedIn: false, login: null, host: null, source: null });
    expect(ai.resetAfterAuthChange).toHaveBeenCalled();
    expect(sendToAllWindows).toHaveBeenCalledWith('auth:changed', state);
  });
});
