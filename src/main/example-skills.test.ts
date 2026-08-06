import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter';

/**
 * The shipped examples are the reference for how a canvas skill is written, so
 * they have to stay loadable by the same code that loads a user's own skills.
 * A silently invalid example teaches the wrong shape.
 */
const EXAMPLES_DIR = path.join(__dirname, '..', '..', 'examples', 'skills');

function exampleSkills(): string[] {
  return fs.readdirSync(EXAMPLES_DIR).filter(entry =>
    fs.statSync(path.join(EXAMPLES_DIR, entry)).isDirectory(),
  );
}

function readSkill(slug: string): { frontmatter: Record<string, unknown>; body: string } {
  const content = fs.readFileSync(path.join(EXAMPLES_DIR, slug, 'SKILL.md'), 'utf-8');
  const parsed = parseFrontmatter<Record<string, unknown>>(content);
  return { frontmatter: parsed.frontmatter, body: parsed.body };
}

describe('example skills', () => {
  it('ships at least one example', () => {
    expect(exampleSkills().length).toBeGreaterThan(0);
  });

  it.each(exampleSkills())('%s carries the frontmatter the skill watcher requires', (slug) => {
    const { frontmatter, body } = readSkill(slug);

    expect(typeof frontmatter.name).toBe('string');
    expect(String(frontmatter.name).trim()).not.toBe('');
    expect(String(frontmatter.description).trim()).not.toBe('');
    expect(body.trim()).not.toBe('');
  });

  it.each(exampleSkills())('%s uses a schedule the scheduler understands', (slug) => {
    const { frontmatter } = readSkill(slug);
    if (frontmatter.schedule === undefined) return;

    expect(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly']).toContain(frontmatter.schedule);
    if (frontmatter.schedule_time !== undefined) {
      expect(String(frontmatter.schedule_time)).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it.each(exampleSkills())('%s uses canvas settings whim recognises', (slug) => {
    const { frontmatter } = readSkill(slug);
    if (frontmatter.canvas !== undefined) {
      expect(['boolean', 'string']).toContain(typeof frontmatter.canvas);
    }
    if (frontmatter.space_mode !== undefined) {
      expect(['reuse', 'new']).toContain(frontmatter.space_mode);
    }
  });
});

describe('look-for-open-questions', () => {
  it('opts into a canvas report, since that is the point of the example', () => {
    const { frontmatter } = readSkill('look-for-open-questions');

    expect(frontmatter.canvas).toBe(true);
    expect(frontmatter.space_mode).toBe('reuse');
  });

  it('runs on a schedule, because a proactive skill nobody triggers is useless', () => {
    const { frontmatter } = readSkill('look-for-open-questions');

    expect(frontmatter.schedule).toBe('weekdays');
    expect(frontmatter.schedule_time).toBe('08:30');
  });

  it('tells the run what to do when it finds nothing', () => {
    const { body } = readSkill('look-for-open-questions');

    expect(body.toLowerCase()).toContain('if nothing is open');
  });

  it('tells the run to read the previous report, since it reuses its space', () => {
    const { body } = readSkill('look-for-open-questions');

    expect(body).toContain('data.json');
    expect(body.toLowerCase()).toContain('previous report');
  });
});
