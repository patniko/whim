import { describe, expect, it, vi } from 'vitest';
import { bootValue, UNKNOWN_CLI_RUNTIME } from './boot-guard';

/**
 * These cover the shape of the bug, not just the helper.
 *
 * The failure was never that a call failed — calls fail all the time. It was
 * that a *single* failed call, on a channel deliberately withheld from the web
 * remote, prevented every later step of boot from running. So what is asserted
 * here is the combination: the other reads still land, and the failed one
 * degrades to something boot can branch on.
 */
describe('bootValue', () => {
  it('passes a successful read straight through', async () => {
    await expect(bootValue(() => Promise.resolve('/work'), null, 'workspace_root')).resolves.toBe('/work');
  });

  it('substitutes the fallback when the read is refused', async () => {
    const warn = vi.fn();
    const denied = () => Promise.reject(new Error('"cli:runtime-status" is not available over the web remote.'));

    await expect(bootValue(denied, UNKNOWN_CLI_RUNTIME, 'cli runtime status', warn))
      .resolves.toEqual(UNKNOWN_CLI_RUNTIME);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  /**
   * The regression itself. `Promise.all` over raw reads rejects if any one of
   * them does; wrapped in bootValue it resolves, which is what lets the
   * continuation — and therefore `mountReactLists()` — run at all.
   */
  it('lets a batch of boot reads resolve even when one is unavailable', async () => {
    const warn = vi.fn();
    const results = await Promise.all([
      bootValue(() => Promise.resolve('/work'), null, 'workspace_root', warn),
      bootValue(() => Promise.resolve('gpt-5'), null, 'model', warn),
      bootValue(() => Promise.reject(new Error('denied')), UNKNOWN_CLI_RUNTIME, 'cli', warn),
    ]);

    expect(results[0]).toBe('/work');
    expect(results[1]).toBe('gpt-5');
    expect(results[2]).toEqual(UNKNOWN_CLI_RUNTIME);
  });

  /**
   * The fallback decides which way boot branches, so it has to describe not
   * knowing. A truthy `target` or `compatible: true` would skip the setup flow
   * and send the user into an interface backed by a runtime we never found.
   */
  it('describes an unknown runtime as unusable rather than fine', () => {
    expect(UNKNOWN_CLI_RUNTIME.target).toBeNull();
    expect(UNKNOWN_CLI_RUNTIME.compatible).toBe(false);
  });
});
