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
 * chosen to keep the reply *true*: the renderer only tests this field for
 * presence, and a runtime that is configured is honestly described as
 * configured. The other fields are named individually rather than spread —
 * see `projectRuntimeStatus` for why that distinction matters.
 */
import type { IpcCommandResult } from './ipc-contract';

/** Stands in for a host path the browser has no business reading. */
export const REDACTED_TARGET = 'configured';

type RuntimeStatus = IpcCommandResult<'cli:runtime-status'>;

/**
 * Rebuild the reply field by field instead of spreading the original.
 *
 * The spread version was shorter and quietly wrong: it forwarded every key the
 * handler happened to return, so the day someone adds `configPath`, `logFile`
 * or a diagnostics blob to the runtime status, it would reach every paired
 * browser without anyone deciding to send it and without a test failing. That
 * is exactly the leak this module exists to prevent, so the safe direction has
 * to be the default rather than the thing we remember to do.
 *
 * Naming the fields inverts it. `satisfies RuntimeStatus` stops compiling if a
 * field leaves the contract, and a field *added* to the contract is simply
 * absent from the response until someone comes here and classifies it —
 * omission being the failure mode worth having.
 */
function projectRuntimeStatus(status: Record<string, unknown>): RuntimeStatus {
  return {
    source: status.source as RuntimeStatus['source'],
    // Preserve "there is no runtime" exactly: null is the signal the renderer
    // branches on, and replacing it would claim a runtime that isn't there.
    target: status.target === null || status.target === undefined ? null : REDACTED_TARGET,
    version: (status.version ?? null) as string | null,
    compatible: Boolean(status.compatible),
    minVersion: String(status.minVersion ?? ''),
  } satisfies RuntimeStatus;
}

type Redactor = (result: unknown) => unknown;

const REDACTORS: Record<string, Redactor> = {
  'cli:runtime-status': (result) => {
    if (!result || typeof result !== 'object') return result;
    return projectRuntimeStatus(result as Record<string, unknown>);
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
