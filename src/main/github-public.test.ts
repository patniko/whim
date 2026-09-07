import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  detectSSOError,
  fetchRepoMetadata,
  isRepoPublic,
  getAuthenticatedLogin,
  forkRepo,
  prepareForkedWriteContext,
} from './github-public';

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function setupFetch(handler: FetchHandler): void {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    return (await handler(url, init));
  }));
}

function jsonResponse(body: any, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe('github-public', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('detectSSOError', () => {
    it('returns null for 200 responses', () => {
      const resp = new Response('', { status: 200, headers: { 'x-github-sso': 'partial-results' } });
      expect(detectSSOError(resp)).toBeNull();
    });

    it('returns null for 401/403 without sso header', () => {
      const r1 = new Response('', { status: 401, headers: {} });
      const r2 = new Response('', { status: 403, headers: {} });
      expect(detectSSOError(r1)).toBeNull();
      expect(detectSSOError(r2)).toBeNull();
    });

    it('parses authorize url from x-github-sso header', () => {
      const resp = new Response('', {
        status: 403,
        headers: { 'x-github-sso': 'required; url=https://github.com/orgs/example/sso?return_to=foo' },
      });
      const info = detectSSOError(resp);
      expect(info).not.toBeNull();
      expect(info!.status).toBe(403);
      expect(info!.authorizeUrl).toBe('https://github.com/orgs/example/sso?return_to=foo');
    });

    it('handles sso header without url', () => {
      const resp = new Response('', {
        status: 401,
        headers: { 'x-github-sso': 'partial-results; organizations=acme' },
      });
      const info = detectSSOError(resp);
      expect(info).not.toBeNull();
      expect(info!.authorizeUrl).toBeUndefined();
      expect(info!.ssoHeader).toContain('partial-results');
    });
  });

  describe('fetchRepoMetadata', () => {
    it('fetches public repo without auth header', async () => {
      const seenAuth: (string | null)[] = [];
      setupFetch(async (url, init) => {
        seenAuth.push((init?.headers as any)?.['Authorization'] ?? null);
        expect(url).toBe('https://api.github.com/repos/github/copilot-sdk');
        return jsonResponse({
          owner: { login: 'github' },
          name: 'copilot-sdk',
          private: false,
          default_branch: 'main',
          fork: false,
        });
      });

      const meta = await fetchRepoMetadata('github', 'copilot-sdk', 'org-sso-token');
      expect('error' in meta).toBe(false);
      if ('error' in meta) return;
      expect(meta.owner).toBe('github');
      expect(meta.repo).toBe('copilot-sdk');
      expect(meta.isPrivate).toBe(false);
      expect(meta.defaultBranch).toBe('main');
      expect(seenAuth).toEqual([null]); // no auth on first call
    });

    it('retries with token on 404 to handle private repos', async () => {
      const calls: Array<{ auth: string | null }> = [];
      setupFetch(async (_url, init) => {
        const auth = (init?.headers as any)?.['Authorization'] ?? null;
        calls.push({ auth });
        if (auth) {
          return jsonResponse({
            owner: { login: 'acme' },
            name: 'secret',
            private: true,
            default_branch: 'main',
            fork: false,
          });
        }
        return textResponse('not found', { status: 404 });
      });

      const meta = await fetchRepoMetadata('acme', 'secret', 'tok');
      expect('error' in meta).toBe(false);
      if ('error' in meta) return;
      expect(meta.isPrivate).toBe(true);
      expect(calls.map(c => c.auth)).toEqual([null, 'token tok']);
    });

    it('surfaces sso info on 403 authed retry', async () => {
      setupFetch(async (_url, init) => {
        const auth = (init?.headers as any)?.['Authorization'] ?? null;
        if (auth) {
          return textResponse('forbidden', {
            status: 403,
            headers: { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' },
          });
        }
        return textResponse('not found', { status: 404 });
      });

      const meta = await fetchRepoMetadata('acme', 'private', 'tok');
      expect('error' in meta).toBe(true);
      if (!('error' in meta)) return;
      expect(meta.sso?.authorizeUrl).toBe('https://github.com/orgs/acme/sso');
    });

    it('parses parent for forks', async () => {
      setupFetch(async () => jsonResponse({
        owner: { login: 'me' },
        name: 'copilot-sdk',
        private: false,
        default_branch: 'main',
        fork: true,
        parent: { owner: { login: 'github' }, name: 'copilot-sdk' },
      }));

      const meta = await fetchRepoMetadata('me', 'copilot-sdk');
      expect('error' in meta).toBe(false);
      if ('error' in meta) return;
      expect(meta.fork).toBe(true);
      expect(meta.parent).toEqual({ owner: 'github', repo: 'copilot-sdk' });
    });
  });

  describe('isRepoPublic', () => {
    it('returns true for public repos', async () => {
      setupFetch(async () => jsonResponse({
        owner: { login: 'github' }, name: 'copilot-sdk', private: false, default_branch: 'main', fork: false,
      }));
      expect(await isRepoPublic('github', 'copilot-sdk')).toBe(true);
    });

    it('returns null on error', async () => {
      setupFetch(async () => textResponse('boom', { status: 500 }));
      expect(await isRepoPublic('a', 'b')).toBeNull();
    });
  });

  describe('getAuthenticatedLogin', () => {
    it('returns login on success', async () => {
      setupFetch(async (url) => {
        expect(url).toBe('https://api.github.com/user');
        return jsonResponse({ login: 'octocat' });
      });
      const result = await getAuthenticatedLogin('tok');
      expect(result).toBe('octocat');
    });

    it('returns sso info on 403', async () => {
      setupFetch(async () => textResponse('', {
        status: 403,
        headers: { 'x-github-sso': 'required; url=https://example/sso' },
      }));
      const result = await getAuthenticatedLogin('tok');
      expect(typeof result).toBe('object');
      if (typeof result === 'string') return;
      expect(result.sso?.authorizeUrl).toBe('https://example/sso');
    });
  });

  describe('forkRepo', () => {
    it('returns fork details on 202 and polls until ready', async () => {
      let metadataCalls = 0;
      setupFetch(async (url, init) => {
        if (url.endsWith('/forks') && init?.method === 'POST') {
          return jsonResponse(
            {
              owner: { login: 'octocat' },
              name: 'copilot-sdk',
              html_url: 'https://github.com/octocat/copilot-sdk',
              clone_url: 'https://github.com/octocat/copilot-sdk.git',
            },
            { status: 202 },
          );
        }
        // fetchRepoMetadata follow-up
        metadataCalls++;
        if (metadataCalls === 1) {
          // First poll: fork not yet ready (404)
          return textResponse('not found', { status: 404 });
        }
        return jsonResponse({
          owner: { login: 'octocat' }, name: 'copilot-sdk',
          private: false, default_branch: 'main', fork: true,
          parent: { owner: { login: 'github' }, name: 'copilot-sdk' },
        });
      });

      const result = await forkRepo('github', 'copilot-sdk', 'tok', { timeoutMs: 5000, pollIntervalMs: 5 });
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.owner).toBe('octocat');
      expect(result.repo).toBe('copilot-sdk');
      expect(result.preExisting).toBe(false);
      expect(result.htmlUrl).toBe('https://github.com/octocat/copilot-sdk');
    });

    it('marks preExisting=true on 200 response', async () => {
      setupFetch(async (url, init) => {
        if (url.endsWith('/forks') && init?.method === 'POST') {
          return jsonResponse({
            owner: { login: 'octocat' }, name: 'copilot-sdk',
            html_url: 'https://github.com/octocat/copilot-sdk',
            clone_url: 'https://github.com/octocat/copilot-sdk.git',
          }, { status: 200 });
        }
        return jsonResponse({
          owner: { login: 'octocat' }, name: 'copilot-sdk',
          private: false, default_branch: 'main', fork: true,
        });
      });

      const result = await forkRepo('github', 'copilot-sdk', 'tok');
      expect('error' in result).toBe(false);
      if ('error' in result) return;
      expect(result.preExisting).toBe(true);
    });

    it('returns sso error when fork POST is sso-gated', async () => {
      setupFetch(async () => textResponse('forbidden', {
        status: 403,
        headers: { 'x-github-sso': 'required; url=https://github.com/orgs/x/sso' },
      }));
      const result = await forkRepo('x', 'y', 'tok');
      expect('error' in result).toBe(true);
      if (!('error' in result)) return;
      expect(result.sso?.authorizeUrl).toBe('https://github.com/orgs/x/sso');
    });
  });

  describe('prepareForkedWriteContext', () => {
    it('reuses existing fork when one is detected', async () => {
      setupFetch(async (url) => {
        if (url.endsWith('/user')) return jsonResponse({ login: 'octocat' });
        if (url.endsWith('/repos/octocat/copilot-sdk')) {
          return jsonResponse({
            owner: { login: 'octocat' }, name: 'copilot-sdk',
            private: false, default_branch: 'main', fork: true,
            parent: { owner: { login: 'github' }, name: 'copilot-sdk' },
          });
        }
        throw new Error(`Unexpected call ${url}`);
      });

      const ctx = await prepareForkedWriteContext('github', 'copilot-sdk', 'tok');
      expect('error' in ctx).toBe(false);
      if ('error' in ctx) return;
      expect(ctx.owner).toBe('octocat');
      expect(ctx.repo).toBe('copilot-sdk');
      expect(ctx.created).toBe(false);
      expect(ctx.upstream).toEqual({ owner: 'github', repo: 'copilot-sdk' });
    });

    it('creates a new fork when the user has none for this upstream', async () => {
      let forkCreated = false;
      setupFetch(async (url, init) => {
        if (url.endsWith('/user')) return jsonResponse({ login: 'octocat' });
        if (url.endsWith('/repos/octocat/copilot-sdk')) {
          if (init?.method === undefined || init.method === 'GET') {
            if (!forkCreated) {
              // Pre-fork: user has no fork yet
              return textResponse('not found', { status: 404 });
            }
            return jsonResponse({
              owner: { login: 'octocat' }, name: 'copilot-sdk',
              private: false, default_branch: 'main', fork: true,
              parent: { owner: { login: 'github' }, name: 'copilot-sdk' },
            });
          }
        }
        if (url.endsWith('/repos/github/copilot-sdk/forks') && init?.method === 'POST') {
          forkCreated = true;
          return jsonResponse(
            {
              owner: { login: 'octocat' }, name: 'copilot-sdk',
              html_url: 'https://github.com/octocat/copilot-sdk',
              clone_url: 'https://github.com/octocat/copilot-sdk.git',
            },
            { status: 202 },
          );
        }
        throw new Error(`Unexpected call ${url}`);
      });

      const ctx = await prepareForkedWriteContext('github', 'copilot-sdk', 'tok');
      expect('error' in ctx).toBe(false);
      if ('error' in ctx) return;
      expect(ctx.owner).toBe('octocat');
      expect(ctx.repo).toBe('copilot-sdk');
      expect(ctx.created).toBe(true);
      expect(ctx.htmlUrl).toBe('https://github.com/octocat/copilot-sdk');
    });

    it('propagates sso error from /user', async () => {
      setupFetch(async () => textResponse('forbidden', {
        status: 403,
        headers: { 'x-github-sso': 'required; url=https://example/sso' },
      }));
      const ctx = await prepareForkedWriteContext('github', 'copilot-sdk', 'tok');
      expect('error' in ctx).toBe(true);
      if (!('error' in ctx)) return;
      expect(ctx.sso?.authorizeUrl).toBe('https://example/sso');
    });
  });
});
