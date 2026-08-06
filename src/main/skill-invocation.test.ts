import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let workspace = '';
const spaces: any[] = [];
const skills = new Map<string, any>();
const launchCalls: any[] = [];

vi.mock('./config', () => ({
  getConfigValue: (key: string) => (key === 'workspace' ? workspace : undefined),
}));

vi.mock('./database', () => ({
  createSpace: (input: any, skillId?: string) => {
    const space = { id: `space-${spaces.length + 1}`, description: input.body, source_skill_id: skillId, folder: null };
    spaces.push(space);
    return space;
  },
  assignSpaceFolder: (spaceId: string, folder: string) => {
    const space = spaces.find(s => s.id === spaceId);
    if (space) space.folder = folder;
  },
  getSkill: (id: string) => skills.get(id) ?? null,
  getLatestSpaceForSkill: (skillId: string) =>
    [...spaces].reverse().find(s => s.source_skill_id === skillId) ?? null,
  hasActiveAgentForSpace: () => false,
  updateCanvasContent: vi.fn(),
}));

vi.mock('./workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace')>()),
  createSpaceFolder: (root: string, spaceId: string, _description: string) => {
    fs.mkdirSync(path.join(root, spaceId), { recursive: true });
    return spaceId;
  },
  scheduleAutoCommit: vi.fn(),
}));

vi.mock('./agent-service', () => ({
  launchDocumentAgent: (...args: any[]) => {
    launchCalls.push(args);
    return Promise.resolve({ agentId: 'agent-1', sessionId: 'session-1' });
  },
}));

import { invokeSkill } from './skill-invocation';
import { parseFrontmatter } from './frontmatter';
import { WHIM_REPORT_CANVAS_ID } from './canvas/sdk-canvas-provider';

function addSkill(id: string, frontmatter: string): void {
  const dir = path.join(workspace, '.agents', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(filePath, `---\nname: ${id}\ndescription: test skill\n${frontmatter}\n---\n\nDo the thing.\n`);
  skills.set(id, { id, name: id, description: 'test skill', filePath });
}

function frontmatterOf(canvasContent: string): any {
  return parseFrontmatter<any>(canvasContent).frontmatter;
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-skill-invocation-'));
  spaces.length = 0;
  skills.clear();
  launchCalls.length = 0;
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('canvas opt-in', () => {
  it('leaves ordinary skills untouched, so no existing skill gains canvas tools', async () => {
    addSkill('plain', '');
    const result = await invokeSkill({ skillId: 'plain' }) as any;

    const fm = frontmatterOf(result.canvasContent);
    expect(fm.canvas_artifacts).toBeUndefined();
    expect(fm.instructions).not.toContain('Report artifact');
  });

  it('enables the built-in canvas for a skill that asks for one', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    expect(frontmatterOf(result.canvasContent).canvas_artifacts).toBe(WHIM_REPORT_CANVAS_ID);
  });

  it('carries a named canvas type through', async () => {
    addSkill('reporter', 'canvas: question-board');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    expect(frontmatterOf(result.canvasContent).canvas_artifacts).toBe('question-board');
  });

  it('records an explicit opt-out rather than dropping it', async () => {
    addSkill('reporter', 'canvas: false');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    expect(frontmatterOf(result.canvasContent).canvas_artifacts).toBe(false);
  });

  it('records the space mode a skill asked for', async () => {
    addSkill('reporter', 'canvas: true\nspace_mode: new');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    expect(frontmatterOf(result.canvasContent).space_mode).toBe('new');
  });

  it('ignores an unrecognised space mode instead of persisting nonsense', async () => {
    addSkill('reporter', 'canvas: true\nspace_mode: sideways');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    expect(frontmatterOf(result.canvasContent).space_mode).toBeUndefined();
  });
});

describe('the canvas contract', () => {
  it('tells the agent to publish, since registering a canvas does not make it use one', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    const instructions = frontmatterOf(result.canvasContent).instructions as string;
    expect(instructions).toContain('Report artifact (required)');
    expect(instructions).toContain('open_canvas');
    expect(instructions).toContain('publish');
  });

  it('names the two failure modes that would otherwise pass silently', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    const instructions = frontmatterOf(result.canvasContent).instructions as string;
    // An empty report and a failed publish both look identical to a run that
    // simply never produced anything.
    expect(instructions).toContain('If you found nothing, still publish a report');
    expect(instructions).toContain('If `publish` returns an error');
  });

  it('warns that networked assets will not render', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter' }) as any;

    expect(frontmatterOf(result.canvasContent).instructions).toContain('blocked when the report is displayed');
  });

  it('passes the same instructions to the agent that the document records', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter', run: true }) as any;

    const instructions = frontmatterOf(result.canvasContent).instructions as string;
    expect(launchCalls[0][3].promptOverride).toBe(instructions);
  });

  it('keeps the caller intent alongside the contract', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter', intent: 'focus on last week' }) as any;

    expect(frontmatterOf(result.canvasContent).instructions).toContain('focus on last week');
  });
});

describe('run provenance', () => {  it('stamps each occurrence, so a reused space can tell new output from old', async () => {
    addSkill('reporter', 'canvas: true');
    const first = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;
    const second = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;

    const firstRun = frontmatterOf(first.canvasContent).skill_invocation.run_id;
    const secondRun = frontmatterOf(second.canvasContent).skill_invocation.run_id;

    expect(firstRun).toBeTruthy();
    expect(secondRun).not.toBe(firstRun);
  });

  it('records that the scheduler started the run', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;

    expect(frontmatterOf(result.canvasContent).skill_invocation.source).toBe('schedule');
  });
});

describe('space reuse', () => {
  it('refreshes the skill\'s existing space instead of creating one per run', async () => {
    addSkill('reporter', 'canvas: true');
    const first = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;
    const second = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;

    expect(second.space.id).toBe(first.space.id);
    expect(spaces).toHaveLength(1);
  });

  it('creates a new space each run when the skill asks for one', async () => {
    addSkill('reporter', 'canvas: true\nspace_mode: new');
    const first = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;
    const second = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;

    expect(second.space.id).not.toBe(first.space.id);
    expect(spaces).toHaveLength(2);
  });

  it('leaves skills without canvases on the existing one-space-per-run behaviour', async () => {
    addSkill('plain', '');
    const first = await invokeSkill({ skillId: 'plain' }) as any;
    const second = await invokeSkill({ skillId: 'plain' }) as any;

    expect(second.space.id).not.toBe(first.space.id);
  });

  it('opts a non-canvas skill into reuse when it asks explicitly', async () => {
    addSkill('plain', 'space_mode: reuse');
    const first = await invokeSkill({ skillId: 'plain' }) as any;
    const second = await invokeSkill({ skillId: 'plain' }) as any;

    expect(second.space.id).toBe(first.space.id);
  });

  it('tells the refreshing run about the report already in the space', async () => {
    addSkill('reporter', 'canvas: true');
    const first = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;
    const spaceDir = path.join(workspace, first.space.folder);

    // Stand in for a previous run's published artifact.
    const artifactDir = path.join(spaceDir, 'reports', 'open-questions');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'index.html'), '<h1>3 open questions</h1>');
    fs.writeFileSync(path.join(artifactDir, 'manifest.json'), JSON.stringify({
      artifactId: 'open-questions',
      spaceId: first.space.id,
      title: 'Open questions',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      publishedAt: '2024-01-01T00:00:00.000Z',
    }));

    const second = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;
    const instructions = frontmatterOf(second.canvasContent).instructions as string;

    expect(instructions).toContain('Refreshing an existing report');
    expect(instructions).toContain('open-questions');
    expect(instructions).toContain('Publish to the same `artifactId`');
  });

  it('does not add refresh framing to a first run', async () => {
    addSkill('reporter', 'canvas: true');
    const result = await invokeSkill({ skillId: 'reporter', source: 'schedule' }) as any;

    expect(frontmatterOf(result.canvasContent).instructions).not.toContain('Refreshing an existing report');
  });
});
