/**
 * Fields a paired browser may not see, on channels it may otherwise call.
 *
 * `web-access.ts` classifies whole channels, and `settings-access.ts` filters
 * `settings:get` by key. This is the third case both of those left out: a
 * channel whose *answer* is mostly safe and partly not.
 *
 * `cli:runtime-status` is the one that forced the issue. It was denied
 * outright, and the deny was defensible — the reply carries an absolute path
 * on the host filesystem. But the renderer reads it during boot to decide
 * between the setup flow and the real interface, so denying the channel did
 * not merely hide a path, it stopped the browser interface from starting at
 * all. The path is one field of five; the other four (does a runtime exist,
 * is it compatible, which version, which minimum) are exactly what a paired
 * device needs and reveal nothing about the host's layout.
 *
 * So the path is replaced rather than the channel refused. The replacement is
 * chosen to keep the reply *true*: the renderer only ever tests this field for
 * presence, and a runtime that is configured is honestly described as
 * configured. Every other field is passed through untouched, because a
 * redaction that lies about compatibility would route the remote user into a
 * setup flow they cannot complete.
 */

/** Stands in for a host path the browser has no business reading. */
export const REDACTED_TARGET = 'configured';

type Redactor = (result: unknown) => unknown;

const REDACTORS: Record<string, Redactor> = {
  'cli:runtime-status': (result) => {
    if (!result || typeof result !== 'object') return result;
    const status = result as Record<string, unknown>;
    // Preserve "there is no runtime" exactly: null is the signal the renderer
    // branches on, and replacing it would claim a runtime that isn't there.
    if (status.target === null || status.target === undefined) return { ...status, target: null };
    return { ...status, target: REDACTED_TARGET };
  },
};

/** Apply the channel's field-level redaction, if it has one. */
export function redactWebResult(channel: string, result: unknown): unknown {
  const redact = REDACTORS[channel];
  return redact ? redact(result) : result;
}

/** Channels whose replies are filtered field by field. */
export function redactedChannels(): string[] {
  return Object.keys(REDACTORS);
}
