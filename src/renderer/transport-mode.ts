/**
 * Which transport the renderer is talking over.
 *
 * The renderer is deliberately transport-agnostic — it reads `window.whimAPI`
 * and nothing else — and that is worth keeping. But one decision genuinely
 * differs between the two: how eagerly to poll.
 *
 * On the desktop a poll is an in-process IPC message costing effectively
 * nothing, so a 1.5s safety-net poll alongside the event subscription is free
 * insurance. Over the web remote the identical poll is an authenticated HTTPS
 * round trip that consumes a rate-limit token, and a couple of open subagent
 * views were enough to exhaust the budget on their own and turn the whole
 * interface into a wall of 429s.
 *
 * The events those polls back up are forwarded over the WebSocket already
 * (see `event-hub.ts`), so the remote can afford a far slower net without
 * losing correctness — it loses only the recovery time after a dropped event.
 */

/** True when this renderer is running in a browser against the web remote. */
export function isWebRemote(): boolean {
  return typeof window !== 'undefined' && (window as any).__whimTransport === 'web';
}

/**
 * Scale a safety-net poll interval for the current transport.
 *
 * Callers pass the desktop interval they already wanted; this stretches it
 * where a round trip is expensive. Anything that is the *only* source of an
 * update must not use this — it is for polls that shadow a live subscription.
 */
export function backupPollIntervalMs(desktopMs: number): number {
  return isWebRemote() ? Math.max(desktopMs, 15_000) : desktopMs;
}
