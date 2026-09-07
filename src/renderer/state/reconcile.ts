/** IPC collections contain plain JSON values, not class instances or cycles. */
export function equalPayload(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalPayload(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && equalPayload(a[key], b[key]));
}

/** Keep unchanged rows even when a new IPC snapshot reorders the collection. */
export function reconcileByKey<T>(previous: T[], incoming: T[], key: (item: T) => string): T[] {
  const byKey = new Map(previous.map(item => [key(item), item]));
  const next = incoming.map(item => {
    const old = byKey.get(key(item));
    return old !== undefined && equalPayload(old, item) ? old : item;
  });
  return next.length === previous.length && next.every((item, index) => item === previous[index])
    ? previous : next;
}
