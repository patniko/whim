import { describe, expect, it } from 'vitest';
import { detectMentionBeforeCaret, filterMentionCandidates, normalizeMentionLaunchText } from './mentions';

describe('mention helpers', () => {
  it('detects an @ query immediately before the caret', () => {
    expect(detectMentionBeforeCaret('ask @agent', 10)).toEqual({
      from: 4,
      to: 10,
      query: 'agent',
    });
    expect(detectMentionBeforeCaret('@', 1)).toEqual({
      from: 0,
      to: 1,
      query: '',
    });
  });

  it('ignores emails and non-mention text', () => {
    expect(detectMentionBeforeCaret('me@example.com', 14)).toBeNull();
    expect(detectMentionBeforeCaret('hello agent', 11)).toBeNull();
  });

  it('filters candidates case-insensitively and preserves metadata', () => {
    expect(
      filterMentionCandidates(
        [
          { handle: 'reviewer', emoji: '🔎', model: 'gpt-4o' },
          { handle: 'builder' },
          { handle: 'Researcher' },
        ],
        're',
      ),
    ).toEqual([{ handle: 'reviewer', emoji: '🔎', model: 'gpt-4o' }, { handle: 'Researcher' }]);
  });

  it('normalizes launch text for duplicate mention suppression', () => {
    expect(normalizeMentionLaunchText('  please   review @agent  ')).toBe('please review @agent');
    expect(normalizeMentionLaunchText('\n@agent\t\t')).toBe('@agent');
  });
});
