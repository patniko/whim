import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseGitRemote, launchCloudAgentWithFallback } from './cloud-agent';

describe('cloud-agent', () => {
  describe('parseGitRemote', () => {
    it('parses HTTPS remote URL', () => {
      const result = parseGitRemote('https://github.com/octocat/hello-world.git');
      expect(result).toEqual({ owner: 'octocat', repo: 'hello-world' });
    });

    it('parses HTTPS remote URL without .git suffix', () => {
      const result = parseGitRemote('https://github.com/octocat/hello-world');
      expect(result).toEqual({ owner: 'octocat', repo: 'hello-world' });
    });

    it('parses SSH remote URL', () => {
      const result = parseGitRemote('git@github.com:octocat/hello-world.git');
      expect(result).toEqual({ owner: 'octocat', repo: 'hello-world' });
    });

    it('parses SSH remote URL without .git suffix', () => {
      const result = parseGitRemote('git@github.com:octocat/hello-world');
      expect(result).toEqual({ owner: 'octocat', repo: 'hello-world' });
    });

    it('handles org repos', () => {
      const result = parseGitRemote('https://github.com/my-org/my-repo.git');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo' });
    });

    it('handles repos with underscores and dots in name', () => {
      const result = parseGitRemote('https://github.com/user/my_repo.v2.git');
      expect(result).toEqual({ owner: 'user', repo: 'my_repo' });
    });

    it('returns null for non-GitHub URLs', () => {
      const result = parseGitRemote('https://gitlab.com/user/repo.git');
      expect(result).toBeNull();
    });

    it('returns null for invalid URLs', () => {
      expect(parseGitRemote('')).toBeNull();
      expect(parseGitRemote('not-a-url')).toBeNull();
    });

    it('handles URLs with trailing whitespace/newline', () => {
      const result = parseGitRemote('https://github.com/patniko/space.git\n');
      expect(result).toEqual({ owner: 'patniko', repo: 'space' });
    });

    it('handles HTTPS URL with embedded credentials', () => {
      const result = parseGitRemote('https://user:token@github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });
  });

  describe('launchCloudAgentWithFallback', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete process.env.COPILOT_API_URL;
    });

    function jsonResponse(body: any, init: { status?: number; headers?: Record<string, string> } = {}): Response {
      return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      });
    }

    function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
      return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
    }

    function setupFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
      vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
        const url = typeof input === 'string' ? input : input.url;
        return (await handler(url, init));
      }));
    }

    it('returns the job result on success without fallback metadata', async () => {
      process.env.COPILOT_API_URL = 'https://api.example.com';
      setupFetch(async (url, init) => {
        expect(url).toBe('https://api.example.com/agents/swe/v1/jobs/me/repo');
        expect(init?.method).toBe('POST');
        return jsonResponse({
          job_id: 'job-1', session_id: 'sess-1',
          actor: { id: 'u1', login: 'me' },
          created_at: '2026-06-03T00:00:00Z', updated_at: '2026-06-03T00:00:00Z',
        });
      });

      const out = await launchCloudAgentWithFallback('me', 'repo', 'do thing', 'tok');
      expect('error' in out).toBe(false);
      if ('error' in out) return;
      expect(out.result.jobId).toBe('job-1');
      expect(out.fallback).toBeUndefined();
    });

    it('falls back to a fork when upstream returns SSO-gated 403 on a public repo', async () => {
      process.env.COPILOT_API_URL = 'https://api.example.com';
      let upstreamPosts = 0;
      let forkPosts = 0;
      let forkExists = false;
      setupFetch(async (url, init) => {
        // Job launch endpoints
        if (url.startsWith('https://api.example.com/agents/swe/v1/jobs/')) {
          if (url.endsWith('/github/copilot-sdk')) {
            upstreamPosts++;
            return textResponse('forbidden', {
              status: 403,
              headers: { 'x-github-sso': 'required; url=https://github.com/orgs/github/sso' },
            });
          }
          if (url.endsWith('/octocat/copilot-sdk')) {
            forkPosts++;
            return jsonResponse({
              job_id: 'job-fork', session_id: 'sess-fork',
              actor: { id: 'u1', login: 'octocat' },
              created_at: '2026-06-03T00:00:00Z', updated_at: '2026-06-03T00:00:00Z',
            });
          }
        }
        // Public-repo metadata probe for upstream — works unauthenticated
        if (url === 'https://api.github.com/repos/github/copilot-sdk') {
          return jsonResponse({
            owner: { login: 'github' }, name: 'copilot-sdk',
            private: false, default_branch: 'main', fork: false,
          });
        }
        // Authenticated user lookup
        if (url === 'https://api.github.com/user') {
          return jsonResponse({ login: 'octocat' });
        }
        // Check whether user already has a fork — only after fork POST does it appear
        if (url === 'https://api.github.com/repos/octocat/copilot-sdk') {
          if (!forkExists) return textResponse('not found', { status: 404 });
          return jsonResponse({
            owner: { login: 'octocat' }, name: 'copilot-sdk',
            private: false, default_branch: 'main', fork: true,
            parent: { owner: { login: 'github' }, name: 'copilot-sdk' },
          });
        }
        // Fork POST
        if (url === 'https://api.github.com/repos/github/copilot-sdk/forks' && init?.method === 'POST') {
          forkExists = true;
          return jsonResponse({
            owner: { login: 'octocat' }, name: 'copilot-sdk',
            html_url: 'https://github.com/octocat/copilot-sdk',
            clone_url: 'https://github.com/octocat/copilot-sdk.git',
          }, { status: 202 });
        }
        throw new Error(`Unexpected call: ${url} (${init?.method ?? 'GET'})`);
      });

      const out = await launchCloudAgentWithFallback('github', 'copilot-sdk', 'review PR', 'org-sso-tok');
      expect('error' in out).toBe(false);
      if ('error' in out) return;
      expect(upstreamPosts).toBe(1);
      expect(forkPosts).toBe(1);
      expect(out.result.jobId).toBe('job-fork');
      expect(out.fallback).toBeDefined();
      expect(out.fallback!.effectiveOwner).toBe('octocat');
      expect(out.fallback!.effectiveRepo).toBe('copilot-sdk');
      expect(out.fallback!.upstream).toEqual({ owner: 'github', repo: 'copilot-sdk' });
      expect(out.fallback!.reason).toBe('sso_blocked');
      expect(out.fallback!.forkUrl).toBe('https://github.com/octocat/copilot-sdk');
      expect(out.fallback!.forkCreated).toBe(true);
    });

    it('does not fork when upstream SSO error hits a private repo', async () => {
      process.env.COPILOT_API_URL = 'https://api.example.com';
      setupFetch(async (url, init) => {
        if (url.startsWith('https://api.example.com/agents/swe/v1/jobs/')) {
          return textResponse('forbidden', {
            status: 403,
            headers: { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso' },
          });
        }
        // Public-probe (no auth) → 404
        if (url === 'https://api.github.com/repos/acme/secret' && !((init?.headers as any)?.['Authorization'])) {
          return textResponse('not found', { status: 404 });
        }
        // Auth probe → 200 private
        if (url === 'https://api.github.com/repos/acme/secret' && (init?.headers as any)?.['Authorization']) {
          return jsonResponse({
            owner: { login: 'acme' }, name: 'secret',
            private: true, default_branch: 'main', fork: false,
          });
        }
        throw new Error(`Unexpected call: ${url}`);
      });

      const out = await launchCloudAgentWithFallback('acme', 'secret', 'do', 'tok');
      expect('error' in out).toBe(true);
      if (!('error' in out)) return;
      expect(out.sso?.authorizeUrl).toBe('https://github.com/orgs/acme/sso');
      expect(out.suggestion).toContain('SSO');
    });

    it('honors enableForkFallback=false', async () => {
      process.env.COPILOT_API_URL = 'https://api.example.com';
      const calls: string[] = [];
      setupFetch(async (url) => {
        calls.push(url);
        return textResponse('forbidden', {
          status: 403,
          headers: { 'x-github-sso': 'required; url=https://github.com/orgs/github/sso' },
        });
      });

      const out = await launchCloudAgentWithFallback('github', 'copilot-sdk', 'do', 'tok', { enableForkFallback: false });
      expect('error' in out).toBe(true);
      if (!('error' in out)) return;
      expect(out.sso).toBeDefined();
      // Only the upstream POST should have been attempted (no fork probing).
      expect(calls.every(u => u.includes('/agents/swe/v1/jobs/'))).toBe(true);
    });
  });
});

