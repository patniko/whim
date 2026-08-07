/**
 * Keeping one unavailable input from costing the whole interface.
 *
 * The renderer starts by reading three things in parallel and branching on
 * them. That was a `Promise.all`, which is right when the inputs are all
 * required and wrong here: over the web remote one of the three is refused by
 * design, so the combined promise rejected, the continuation never ran, and
 * the page stayed blank — an app that worked perfectly and simply never
 * started.
 *
 * The inputs are independent, so a failure in one should cost exactly that
 * one. These helpers make that the easy thing to write, and give the fallback
 * a place to be documented rather than being an inline `?? null` whose
 * consequences nobody has thought about.
 */

/** What the renderer assumes when it cannot see the host's CLI runtime. */
export const UNKNOWN_CLI_RUNTIME = {
  source: 'unknown',
  target: null as string | null,
  version: null as string | null,
  compatible: false,
  minVersion: '',
};

/**
 * Read one boot input, substituting `fallback` if it is unavailable.
 *
 * The fallback must be an honest description of not knowing, not a cheerful
 * default: boot branches on these values, and a fallback that claims a
 * working runtime would skip the setup flow the user actually needs.
 */
export async function bootValue<T>(
  read: () => Promise<T>,
  fallback: T,
  label: string,
  warn: (message: string, err: unknown) => void = (message, err) => console.warn(message, err),
): Promise<T> {
  try {
    return await read();
  } catch (err) {
    warn(`[boot] ${label} unavailable; continuing without it`, err);
    return fallback;
  }
}
