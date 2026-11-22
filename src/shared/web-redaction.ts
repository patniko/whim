/**
 * Fields a paired browser may not see, on channels it may otherwise call.
 *
 * `web-access.ts` classifies whole channels, and `settings-access.ts` filters
 * `settings:get` by key. This is the third case both of those leave out: a
 * channel whose *answer* is mostly safe and partly not, such as a status reply
 * that also names an absolute path on the host.
 *
 * Register a redactor here rather than denying the whole channel when a
 * paired device needs the rest of the reply. A redactor should rebuild its
 * reply field by field instead of spreading the original, so a field added
 * to the handler later stays hidden until someone decides it is safe to send.
 *
 * No channel needs one today: the Copilot runtime status that prompted this
 * module, with its host path, was replaced by the GitHub account state.
 */

type Redactor = (result: unknown) => unknown;

const REDACTORS: Record<string, Redactor> = {};

/** Apply the channel's field-level redaction, if it has one. */
export function redactWebResult(channel: string, result: unknown): unknown {
  const redact = REDACTORS[channel];
  return redact ? redact(result) : result;
}

/** Channels whose replies are filtered field by field. */
export function redactedChannels(): string[] {
  return Object.keys(REDACTORS);
}
