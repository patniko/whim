/**
 * Request auditing and abuse limits for the web remote.
 *
 * Two separate concerns, deliberately kept apart from authentication:
 *
 *  - **Audit** — a bounded, redacted record of what was invoked, by whom, and
 *    from where. The server previously kept a single `lastError` string, which
 *    tells you nothing after the fact. Anything that could carry a credential
 *    or workspace content is dropped before it reaches the buffer; only the
 *    channel name and shape of the call are kept.
 *
 *  - **Rate limiting** — the authenticator throttles *failed* logins, but an
 *    authenticated caller could previously hammer `/api/invoke` without limit,
 *    and every one of those calls does real work (spawning agents, touching
 *    the filesystem). A per-identity token bucket bounds that.
 */

export type AuditOutcome = 'ok' | 'denied' | 'error' | 'rate-limited';

export interface AuditEntry {
  at: number;
  method: string;
  /** Path only — the query string is dropped because it can carry `?token=`. */
  path: string;
  channel: string | null;
  status: number;
  outcome: AuditOutcome;
  /** Device label when the caller used a session, `token` for the bootstrap credential. */
  identity: string;
  remoteAddress: string;
  durationMs: number;
}

const MAX_ENTRIES = 200;

/** Query strings and request bodies can both carry secrets; keep neither. */
export function redactPath(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  return path.length > 200 ? `${path.slice(0, 200)}…` : path;
}

/**
 * IPv6-mapped IPv4 (`::ffff:192.168.1.5`) is noise in a log and breaks
 * grouping, since the same host can appear under both forms.
 */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

export class WebRemoteAuditLog {
  private entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }

  /** Most recent first. */
  recent(limit = 50): AuditEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  clear(): void {
    this.entries = [];
  }
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next request would be allowed. Only set when blocked. */
  retryAfterSeconds: number;
}

/**
 * Token bucket with a burst allowance separate from the sustained rate.
 *
 * The original bucket tied the two together: 60 tokens refilling at 60/min,
 * so a burst *was* a minute's entire budget. That looked generous and was
 * not. A cold page load spends a dozen calls before it paints, each open
 * subagent view polls on a timer, and a reload starts over without waiting
 * for a refill — so a normal session ran the bucket dry and the interface
 * filled with 429s while doing nothing unusual.
 *
 * Splitting the two lets each be set for what it actually guards. `capacity`
 * absorbs the legitimate spikes — a boot, a phone waking up and refreshing
 * every panel at once. `ratePerWindow` is the ceiling a runaway loop settles
 * to, and remains far below what a compromised client would want.
 */
export class WebRemoteRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity = 240,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    /**
     * Defaults to `capacity`, which is the classic one-knob token bucket. The
     * server passes both explicitly; leaving the default coupled keeps the
     * class honest for callers that only care about a single rate.
     */
    private readonly ratePerWindow = capacity,
  ) {}

  check(identity: string): RateLimitDecision {
    const now = this.now();
    const bucket = this.buckets.get(identity) ?? { tokens: this.capacity, updatedAt: now };

    const refill = ((now - bucket.updatedAt) / this.windowMs) * this.ratePerWindow;
    const tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, refill));

    if (tokens < 1) {
      this.buckets.set(identity, { tokens, updatedAt: now });
      const perToken = this.windowMs / this.ratePerWindow;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(((1 - tokens) * perToken) / 1000)) };
    }

    this.buckets.set(identity, { tokens: tokens - 1, updatedAt: now });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(): void {
    this.buckets.clear();
  }
}
