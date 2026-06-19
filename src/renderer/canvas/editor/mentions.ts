export interface MentionCandidate {
  handle: string;
  emoji?: string;
  model?: string;
}

export interface TextMentionQuery {
  from: number;
  to: number;
  query: string;
}

export function normalizeMentionLaunchText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function detectMentionBeforeCaret(text: string, caret: number): TextMentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w-]*)$/.exec(before);
  if (!match) return null;
  const query = match[2];
  return {
    from: caret - query.length - 1,
    to: caret,
    query,
  };
}

export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const q = query.toLowerCase();
  return candidates
    .filter((candidate) => candidate.handle.toLowerCase().includes(q))
    .slice(0, limit);
}
