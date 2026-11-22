import { describe, expect, it } from 'vitest';
import { redactWebResult } from './web-redaction';

describe('redactWebResult', () => {
  it('leaves channels with no redactor exactly as they were', () => {
    const spaces = [{ id: 's1', title: 'Ship it' }];
    expect(redactWebResult('space:list', spaces)).toBe(spaces);
  });
});
