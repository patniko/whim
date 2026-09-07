/** A send acknowledgement can arrive before or after its snapshot row. */
export function acknowledgeUserMessage<T extends { id: string }>(
  messages: T[],
  localId: string,
  messageId: string,
): T[] {
  const id = `user:${messageId}`;
  const existing = messages.some((message) => message.id === id);
  return existing
    ? messages.filter((message) => message.id !== localId)
    : messages.map((message) => (message.id === localId ? { ...message, id } : message));
}

export function mergeHistoryWithLocal<T extends { id: string }>(
  history: T[],
  current: T[],
  localIds: ReadonlySet<string>,
): T[] {
  const ids = new Set(history.map((message) => message.id));
  return [
    ...history,
    ...current.filter((message) => localIds.has(message.id) && !ids.has(message.id)),
  ];
}

export function orderTranscript<T extends { sequence?: number }>(messages: T[]): T[] {
  return [...messages].sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity));
}
