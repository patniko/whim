import { BrowserWindow, dialog, shell } from 'electron';
import type { CopilotSession, GetAuthStatusResponse } from '@microsoft/copilot-sdk';
import { getCopilotClient, getCopilotInitError, initCopilot, resetAfterAuthChange } from './ai';
import { sendToAllWindows } from './ipc/typed-handler';
import type {
  CopilotAuthSource,
  CopilotAuthState,
  GitHubSignInMethod,
  GitHubSignInProgress,
  GitHubSignInResult,
} from '../shared/ipc-contract';

/**
 * GitHub sign-in through the runtime's built-in login. Credentials go to the
 * same store the Copilot CLI uses, so signing in here also signs in the CLI
 * (and vice versa), and the runtime also picks up a `gh` login or token in the
 * environment on its own.
 */

const SIGNED_OUT: CopilotAuthState = { signedIn: false, login: null, host: null, source: null };

/** Begin's first step, one blocking advance, and an optional consent step, with headroom. */
const MAX_SIGN_IN_STEPS = 8;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function authSource(authType: GetAuthStatusResponse['authType']): CopilotAuthSource {
  switch (authType) {
    case 'user': return 'sign-in';
    case 'gh-cli': return 'github-cli';
    case 'env': return 'environment';
    default: return 'other';
  }
}

async function runningClient() {
  await initCopilot();
  const client = getCopilotClient();
  if (!client) throw new Error(getCopilotInitError() || 'Copilot runtime is not running.');
  return client;
}

export async function getCopilotAuthState(): Promise<CopilotAuthState> {
  try {
    const status = await (await runningClient()).getAuthStatus();
    if (!status.isAuthenticated) return SIGNED_OUT;
    return {
      signedIn: true,
      login: status.login ?? null,
      host: status.host ?? null,
      source: authSource(status.authType),
    };
  } catch (err) {
    return { ...SIGNED_OUT, error: errorMessage(err) };
  }
}

/**
 * Accounts RPCs are session-scoped. A tool-less session hosts them and is
 * deleted afterwards so it never shows up in the CLI's session list.
 */
async function withAccountsSession<T>(run: (session: CopilotSession) => Promise<T>): Promise<T> {
  const client = await runningClient();
  const session = await client.createSession({
    tools: { availableTools: [] },
    permissions: { onRequest: async () => ({ kind: 'reject' as const }) },
  });
  try {
    return await run(session);
  } finally {
    await session.disconnect().catch(() => {});
    await client.deleteSession(session.sessionId).catch(() => {});
  }
}

async function announceAuthChange(): Promise<CopilotAuthState> {
  await resetAfterAuthChange();
  const state = await getCopilotAuthState();
  sendToAllWindows('auth:changed', state);
  return state;
}

/** Ask before storing the token in plain text when the OS credential store is unavailable. */
async function confirmPlaintextStorage(): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Store in Plain Text', 'Cancel Sign-In'],
    defaultId: 1,
    cancelId: 1,
    message: 'Secure credential storage is not available',
    detail: 'Whim can save your GitHub sign-in in plain text in the Copilot configuration file instead. Anyone with access to your user account could read it.',
  };
  const parent = BrowserWindow.getFocusedWindow();
  const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
  return response === 0;
}

interface ActiveSignIn {
  cancelled: boolean;
  cancel?: () => Promise<void>;
}

type LoginRpc = CopilotSession['rpc']['accounts']['login'];
type LoginStep = Awaited<ReturnType<LoginRpc['advance']>>;

let activeSignIn: ActiveSignIn | null = null;

/**
 * Act on each step until the flow completes. Returns false when cancelled and
 * throws when the flow fails; the caller cancels the flow in both cases.
 */
async function driveSignIn(
  login: LoginRpc,
  flowId: string,
  first: LoginStep,
  flow: ActiveSignIn,
  report: (progress: GitHubSignInProgress) => void,
): Promise<boolean> {
  let step = first;
  for (let i = 0; i < MAX_SIGN_IN_STEPS; i++) {
    if (flow.cancelled) return false;
    switch (step.kind) {
      case 'completed':
        if (step.result.status === 'completed') return true;
        if (step.result.status === 'needs-plaintext-consent') {
          const allow = await confirmPlaintextStorage();
          step = await login.advance(allow ? { flowId, input: 'allow' } : { flowId });
          continue;
        }
        if (step.result.status === 'declined') {
          throw new Error('Sign-in was cancelled, so your GitHub token was not saved.');
        }
        throw new Error('This account needs an account selection that Whim does not support.');
      case 'error':
        throw new Error(step.message);
      case 'input-required':
        throw new Error(`Sign-in asked for input Whim cannot provide: ${step.prompt}`);
      case 'open-url':
        report({ kind: 'browser' });
        try {
          await shell.openExternal(step.url);
        } catch {
          throw new Error('Could not open your browser. Sign in with a code instead.');
        }
        break;
      case 'device-code':
        report({ kind: 'device-code', userCode: step.userCode, verificationUri: step.verificationUri, expiresIn: step.expiresIn });
        break;
      // 'awaiting' and 'needs-interaction': the runtime is still working.
    }
    // Blocks until the user finishes in the browser, or the code expires.
    step = await login.advance({ flowId });
  }
  if (flow.cancelled) return false;
  throw new Error('Sign-in did not finish.');
}

/**
 * Run the interactive GitHub sign-in. `web` opens the browser and waits for its
 * callback; `device-code` reports a code for the user to enter on github.com.
 * Resolves once the account is signed in, the user cancels, or the flow fails.
 */
export async function signInToGitHub(
  method: GitHubSignInMethod,
  report: (progress: GitHubSignInProgress) => void,
): Promise<GitHubSignInResult> {
  if (activeSignIn) return { ok: false, error: 'A sign-in is already in progress.' };
  const flow: ActiveSignIn = { cancelled: false };
  activeSignIn = flow;
  let signedIn = false;
  try {
    signedIn = await withAccountsSession(async (session) => {
      const login = session.rpc.accounts.login;
      const { flowId, step } = await login.begin({ kind: 'githubDotCom', method });
      flow.cancel = () => login.cancel({ flowId });
      let done = false;
      try {
        done = await driveSignIn(login, flowId, step, flow, report);
        return done;
      } finally {
        // Release the browser callback listener or device-code poll.
        if (!done) await login.cancel({ flowId }).catch(() => {});
      }
    });
  } catch (err) {
    if (!flow.cancelled) return { ok: false, error: errorMessage(err) };
  } finally {
    if (activeSignIn === flow) activeSignIn = null;
  }
  if (!signedIn) return { ok: false, cancelled: true };

  const state = await announceAuthChange();
  return state.signedIn
    ? { ok: true, state }
    : { ok: false, error: state.error || 'Sign-in finished, but Copilot still reports no signed-in account.' };
}

/** Abandon the sign-in in progress, if any. Its pending call resolves as cancelled. */
export async function cancelGitHubSignIn(): Promise<void> {
  const flow = activeSignIn;
  if (!flow) return;
  flow.cancelled = true;
  await flow.cancel?.().catch(() => {});
}

/**
 * Sign out of the account Whim and the Copilot CLI share. Credentials from the
 * GitHub CLI or the environment are not Whim's to remove.
 */
export async function signOutOfGitHub(): Promise<CopilotAuthState> {
  const current = await getCopilotAuthState();
  if (!current.signedIn) return current;
  if (current.source !== 'sign-in') {
    return {
      ...current,
      error: current.source === 'github-cli'
        ? 'This account comes from the GitHub CLI. Run `gh auth logout` to sign out.'
        : 'This account comes from a token in the environment. Remove the token to sign out.',
    };
  }
  try {
    const result = await withAccountsSession((session) => session.rpc.accounts.set({ command: { kind: 'logout' } }));
    if (!result.ok) return { ...current, error: 'Copilot could not sign out this account.' };
  } catch (err) {
    return { ...current, error: errorMessage(err) };
  }
  return announceAuthChange();
}
