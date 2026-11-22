import type {
  CopilotAuthState,
  GitHubSignInMethod,
  GitHubSignInProgress,
  GitHubSignInResult,
} from '../shared/ipc-contract';

/**
 * The GitHub sign-in control shared by onboarding and Settings. Copilot runs
 * inside Whim and signs in with the runtime's built-in GitHub login, whose
 * credential the Copilot CLI on this computer shares.
 */

export interface GitHubAccountApi {
  getAuthState(): Promise<CopilotAuthState>;
  signInToGitHub(method: GitHubSignInMethod): Promise<GitHubSignInResult>;
  cancelGitHubSignIn(): Promise<{ ok: true }>;
  signOutOfGitHub(): Promise<CopilotAuthState>;
  onAuthChanged(callback: (state: CopilotAuthState) => void): () => void;
  onSignInProgress(callback: (progress: GitHubSignInProgress) => void): () => void;
  openExternal(url: string): Promise<unknown>;
}

export interface GitHubAccountElements {
  status: HTMLElement;
  signIn: HTMLButtonElement;
  useCode: HTMLButtonElement;
  cancel: HTMLButtonElement;
  /** Omitted where signing out is not offered (onboarding). */
  signOut?: HTMLButtonElement;
  /** Device-code panel: the code and a button that copies it and opens GitHub. */
  code: HTMLElement;
  codeValue: HTMLElement;
  copyCode: HTMLButtonElement;
}

export function describeAuthState(state: CopilotAuthState): string {
  if (!state.signedIn) return state.error || 'Not signed in';
  let who = state.login ? `@${state.login}` : 'your GitHub account';
  if (state.host && !/^https?:\/\/github\.com\/?$/i.test(state.host)) {
    try { who += ` on ${new URL(state.host).host}`; } catch { /* show the login alone */ }
  }
  const via = state.source === 'github-cli' ? ' (from the GitHub CLI)'
    : state.source === 'environment' ? ' (from an environment token)'
      : '';
  return `Signed in as ${who}${via}`;
}

export function mountGitHubAccount(
  api: GitHubAccountApi,
  els: GitHubAccountElements,
  onState?: (state: CopilotAuthState) => void,
): { refresh(): Promise<void>; dispose(): void } {
  let signingIn = false;
  let deviceCode: { userCode: string; verificationUri: string } | null = null;

  const show = (el: HTMLElement | undefined, visible: boolean) => el?.classList.toggle('hidden', !visible);

  function setStatus(text: string, tone: 'normal' | 'error' = 'normal'): void {
    els.status.textContent = text;
    els.status.classList.toggle('github-account-error', tone === 'error');
  }

  function render(state: CopilotAuthState, error?: string): void {
    if (error) setStatus(error, 'error');
    else setStatus(describeAuthState(state), state.signedIn || !state.error ? 'normal' : 'error');
    show(els.signIn, !state.signedIn);
    show(els.useCode, !state.signedIn);
    show(els.cancel, false);
    show(els.code, false);
    // Credentials from `gh` or the environment are not Whim's to remove.
    show(els.signOut, state.signedIn && state.source === 'sign-in');
    onState?.(state);
  }

  async function refresh(): Promise<void> {
    if (signingIn) return;
    render(await api.getAuthState());
  }

  async function signIn(method: GitHubSignInMethod): Promise<void> {
    if (signingIn) return;
    signingIn = true;
    deviceCode = null;
    setStatus(method === 'web' ? 'Opening your browser…' : 'Getting a sign-in code…');
    show(els.signIn, false);
    show(els.useCode, false);
    show(els.signOut, false);
    show(els.cancel, true);
    let result: GitHubSignInResult;
    try {
      result = await api.signInToGitHub(method);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      signingIn = false;
    }
    if (result.ok) {
      render(result.state);
    } else {
      const state = await api.getAuthState();
      render(state, result.cancelled ? undefined : result.error || 'Sign-in failed.');
    }
  }

  const offProgress = api.onSignInProgress((progress) => {
    if (!signingIn) return;
    if (progress.kind === 'browser') {
      setStatus('Finish signing in to GitHub in your browser…');
      return;
    }
    deviceCode = { userCode: progress.userCode, verificationUri: progress.verificationUri };
    els.codeValue.textContent = progress.userCode;
    setStatus(`Enter this code at ${progress.verificationUri.replace(/^https?:\/\//, '')}`);
    show(els.code, true);
  });

  const offChanged = api.onAuthChanged((state) => {
    if (!signingIn) render(state);
  });

  els.signIn.addEventListener('click', () => void signIn('web'));
  els.useCode.addEventListener('click', () => void signIn('device-code'));
  els.cancel.addEventListener('click', () => void api.cancelGitHubSignIn());
  els.copyCode.addEventListener('click', async () => {
    if (!deviceCode) return;
    await navigator.clipboard.writeText(deviceCode.userCode).catch(() => {});
    await api.openExternal(deviceCode.verificationUri);
  });
  els.signOut?.addEventListener('click', async () => {
    if (!window.confirm('Sign out of GitHub? This also signs out the Copilot CLI on this computer.')) return;
    const state = await api.signOutOfGitHub();
    render(state, state.error);
  });

  return {
    refresh,
    dispose() {
      offProgress();
      offChanged();
    },
  };
}
