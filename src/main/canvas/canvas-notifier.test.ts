import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  Notification: class {
    static isSupported = () => notificationsSupported;
    static shown: Array<{ title: string; body: string }> = [];
    private handlers = new Map<string, () => void>();
    constructor(public options: { title: string; body: string }) {}
    on(event: string, handler: () => void): void { this.handlers.set(event, handler); }
    show(): void {
      shown.push({ title: this.options.title, body: this.options.body });
      lastClick = this.handlers.get('click') ?? null;
    }
  },
}));

vi.mock('./artifact-window', () => ({
  openArtifactWindow: (opts: unknown) => { opened.push(opts); },
}));

let windows: Array<{ isDestroyed: () => boolean; isFocused: () => boolean }> = [];
let notificationsSupported = true;
const shown: Array<{ title: string; body: string }> = [];
const opened: unknown[] = [];
let lastClick: (() => void) | null = null;

import { buildCanvasNotification, notifyCanvasRun } from './canvas-notifier';
import {
  beginCanvasRun,
  recordCanvasPublication,
  reportCanvasRun,
  endCanvasRun,
  resetCanvasRuns,
} from './canvas-outcome';
import type { CanvasArtifact } from './artifact-store';
import type { CanvasRunResult } from './canvas-outcome';

function artifact(artifactId: string, overrides: Partial<CanvasArtifact> = {}): CanvasArtifact {
  return {
    artifactId,
    spaceId: 'space-1',
    title: artifactId,
    published: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  } as CanvasArtifact;
}

function result(overrides: Partial<CanvasRunResult> = {}): CanvasRunResult {
  return {
    outcome: 'published',
    spaceId: 'space-1',
    scheduled: true,
    published: [{ artifactId: 'questions', title: 'Open questions', status: '3 open questions' }],
    ...overrides,
  };
}

beforeEach(() => {
  resetCanvasRuns();
  windows = [];
  notificationsSupported = true;
  shown.length = 0;
  opened.length = 0;
  lastClick = null;
});

describe('canvas run outcome', () => {
  it('reports what a run published', () => {
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1', skillId: 'skill-1', runId: 'run-1', scheduled: true });
    recordCanvasPublication('a1', artifact('questions', { status: '3 open questions' }));

    expect(reportCanvasRun('a1')).toEqual({
      outcome: 'published',
      spaceId: 'space-1',
      skillId: 'skill-1',
      runId: 'run-1',
      scheduled: true,
      published: [{ artifactId: 'questions', title: 'questions', status: '3 open questions' }],
    });
  });

  it('calls a run that published nothing no-output, since the contract asked for an empty state', () => {
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1' });

    expect(reportCanvasRun('a1')).toMatchObject({ outcome: 'no-output', published: [] });
  });

  it('counts a republished artifact once, because the user cares that it exists', () => {
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1' });
    recordCanvasPublication('a1', artifact('questions', { status: 'first' }));
    recordCanvasPublication('a1', artifact('questions', { status: 'second' }));

    const reported = reportCanvasRun('a1');
    expect(reported?.published).toEqual([{ artifactId: 'questions', title: 'questions', status: 'second' }]);
  });

  it('reports only once, so a repeated idle cannot notify twice', () => {
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1' });
    recordCanvasPublication('a1', artifact('questions'));

    expect(reportCanvasRun('a1')).not.toBeNull();
    expect(reportCanvasRun('a1')).toBeNull();
  });

  it('has nothing to report for a run that was never canvas-enabled', () => {
    expect(reportCanvasRun('unknown')).toBeNull();
  });

  it('treats a restart as a fresh attempt judged on its own output', () => {
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1' });
    recordCanvasPublication('a1', artifact('questions'));
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1' });

    expect(reportCanvasRun('a1')).toMatchObject({ outcome: 'no-output' });
  });

  it('ignores publications from an agent that is not tracked', () => {
    recordCanvasPublication('ghost', artifact('questions'));

    expect(reportCanvasRun('ghost')).toBeNull();
  });

  it('forgets a run once its agent is gone', () => {
    beginCanvasRun({ agentId: 'a1', spaceId: 'space-1' });
    endCanvasRun('a1');

    expect(reportCanvasRun('a1')).toBeNull();
  });
});

describe('buildCanvasNotification', () => {
  it('announces a scheduled run using the space title and artifact status', () => {
    const notification = buildCanvasNotification(result(), { spaceLabel: 'Open questions', anyWindowFocused: false });

    expect(notification).toMatchObject({
      title: 'Open questions',
      body: '3 open questions',
      target: { spaceId: 'space-1', artifactId: 'questions' },
    });
  });

  it('stays silent when a run published nothing', () => {
    expect(buildCanvasNotification(result({ outcome: 'no-output', published: [] }), { anyWindowFocused: false })).toBeNull();
  });

  it('stays silent for a manual run the user is already watching', () => {
    expect(buildCanvasNotification(result({ scheduled: false }), { anyWindowFocused: true })).toBeNull();
  });

  it('still notifies a scheduled run even while whim has focus, since nothing was raised', () => {
    expect(buildCanvasNotification(result(), { anyWindowFocused: true })).not.toBeNull();
  });

  it('notifies a manual run when the user has looked away', () => {
    expect(buildCanvasNotification(result({ scheduled: false }), { anyWindowFocused: false })).not.toBeNull();
  });

  it('mentions the extra reports when a run published more than one', () => {
    const notification = buildCanvasNotification(result({
      published: [
        { artifactId: 'a', title: 'A' },
        { artifactId: 'b', title: 'B', status: 'Second' },
      ],
    }), { anyWindowFocused: false });

    expect(notification?.body).toBe('Second (+1 more)');
    expect(notification?.target.artifactId).toBe('b');
  });

  it('falls back to the artifact title when the space has no label', () => {
    const notification = buildCanvasNotification(result({
      published: [{ artifactId: 'questions', title: 'Open questions' }],
    }), { anyWindowFocused: false });

    expect(notification?.title).toBe('Open questions');
  });
});

describe('notifyCanvasRun', () => {
  it('opens the artifact when the user clicks the notification', () => {
    notifyCanvasRun(result(), 'Open questions');

    expect(shown).toEqual([{ title: 'Open questions', body: '3 open questions' }]);
    lastClick?.();
    expect(opened[0]).toMatchObject({ spaceId: 'space-1', artifactId: 'questions', focus: true });
  });

  it('shows nothing for a run with no output', () => {
    notifyCanvasRun(result({ outcome: 'no-output', published: [] }));

    expect(shown).toEqual([]);
  });

  it('does nothing where the platform has no notifications', () => {
    notificationsSupported = false;

    expect(() => notifyCanvasRun(result())).not.toThrow();
    expect(shown).toEqual([]);
  });
});
