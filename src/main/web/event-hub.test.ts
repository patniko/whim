import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_ONLY_EVENT_CHANNELS,
  currentEventSequence,
  mirrorRendererEvent,
  mirroredEventChannels,
  replayEventsSince,
  resetWebRemoteEventState,
  subscribeWebRemoteEvents,
  type WebRemoteEvent,
} from './event-hub';

beforeEach(() => {
  resetWebRemoteEventState();
});

describe('web remote event hub', () => {
  it('normalizes dynamic chat channels', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeWebRemoteEvents(callback);

    mirrorRendererEvent('chat:event:agent-1', { type: 'assistant.message', content: 'hi' });
    unsubscribe();

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'chat:event',
      payload: { agentId: 'agent-1', type: 'assistant.message', content: 'hi' },
    }));
  });

  it('normalizes space event payloads', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeWebRemoteEvents(callback);

    mirrorRendererEvent('space:processed', 'space-1');
    mirrorRendererEvent('space:title-updated', { spaceId: 'space-1', title: 'New title' });
    unsubscribe();

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'space:processed',
      payload: { spaceId: 'space-1' },
    }));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'space:title-updated',
      payload: { spaceId: 'space-1', title: 'New title' },
    }));
  });

  it('mirrors canvas + git sync events for live updates', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeWebRemoteEvents(callback);

    mirrorRendererEvent('canvas:content-updated', { spaceId: 'space-1', content: '# hi' });
    mirrorRendererEvent('workspace:git-sync-changed', { available: true, branch: 'main', ahead: 1, behind: 0 });
    mirrorRendererEvent('workspace:committed');
    unsubscribe();

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'canvas:content-updated',
      payload: { spaceId: 'space-1', content: '# hi' },
    }));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'workspace:git-sync-changed',
      payload: { available: true, branch: 'main', ahead: 1, behind: 0 },
    }));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ channel: 'workspace:committed' }));
  });

  it('does not emit disallowed renderer events', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeWebRemoteEvents(callback);

    mirrorRendererEvent('settings:changed', { unsafe: true });
    unsubscribe();

    expect(callback).not.toHaveBeenCalled();
  });

  describe('sequencing and replay', () => {
    it('assigns monotonic sequence numbers', () => {
      const callback = vi.fn();
      const unsubscribe = subscribeWebRemoteEvents(callback);

      mirrorRendererEvent('workspace:committed');
      mirrorRendererEvent('workspace:committed');
      unsubscribe();

      expect(callback.mock.calls.map(([event]) => event.seq)).toEqual([1, 2]);
      expect(currentEventSequence()).toBe(2);
    });

    it('does not consume a sequence number for a rejected event', () => {
      mirrorRendererEvent('settings:changed', { unsafe: true });
      expect(currentEventSequence()).toBe(0);
    });

    it('replays only the events a client missed', () => {
      mirrorRendererEvent('space:processed', 'space-1');
      mirrorRendererEvent('space:processed', 'space-2');
      mirrorRendererEvent('space:processed', 'space-3');

      const result = replayEventsSince(1);
      expect(result.kind).toBe('events');
      if (result.kind !== 'events') return;
      expect(result.events.map((event) => event.seq)).toEqual([2, 3]);
    });

    it('returns nothing when the client is already current', () => {
      mirrorRendererEvent('workspace:committed');
      const result = replayEventsSince(1);
      expect(result).toEqual({ kind: 'events', events: [] });
    });

    it('demands a resync on first connect', () => {
      mirrorRendererEvent('workspace:committed');
      expect(replayEventsSince(0)).toEqual({ kind: 'resync-required' });
    });

    it('demands a resync when the client is ahead of the server, e.g. after a restart', () => {
      mirrorRendererEvent('workspace:committed');
      expect(replayEventsSince(99)).toEqual({ kind: 'resync-required' });
    });

    it('demands a resync rather than silently replaying a partial gap', () => {
      // Overflow the 500-entry buffer so the earliest events are evicted.
      for (let i = 0; i < 600; i += 1) mirrorRendererEvent('workspace:committed');
      expect(replayEventsSince(1)).toEqual({ kind: 'resync-required' });

      const recent = replayEventsSince(599);
      expect(recent.kind).toBe('events');
      if (recent.kind !== 'events') return;
      expect(recent.events.map((event) => event.seq)).toEqual([600]);
    });
  });
});

describe('event channel classification', () => {
  /**
   * The API surface is the single definition of what the renderer listens to.
   * Scanning it here means adding an event to whim-api.ts forces a decision
   * about whether the web remote should see it — the alternative is a
   * hand-kept list that silently stops matching reality, which is exactly the
   * failure this branch exists to fix.
   */
  const surface = readFileSync(join(__dirname, '..', '..', 'shared', 'whim-api.ts'), 'utf-8');

  const subscribedChannels = [
    ...new Set([...surface.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map((m) => m[1])),
  ].sort();

  it('finds the channels the renderer actually subscribes to', () => {
    // A regex that silently matches nothing would make every case below pass.
    expect(subscribedChannels.length).toBeGreaterThan(30);
    expect(subscribedChannels).toContain('agent:status-changed');
  });

  it('classifies every subscribed channel as mirrored or desktop-only', () => {
    const mirrored = mirroredEventChannels();
    const unclassified = subscribedChannels.filter(
      (channel) => !mirrored.has(channel) && !DESKTOP_ONLY_EVENT_CHANNELS.has(channel),
    );
    expect(unclassified).toEqual([]);
  });

  it('never classifies a channel as both', () => {
    const mirrored = mirroredEventChannels();
    const both = [...DESKTOP_ONLY_EVENT_CHANNELS].filter((channel) => mirrored.has(channel));
    expect(both).toEqual([]);
  });

  it('replays the original channel and arguments alongside the flattened view', () => {
    resetWebRemoteEventState();
    const received: WebRemoteEvent[] = [];
    const unsubscribe = subscribeWebRemoteEvents((event) => received.push(event));

    mirrorRendererEvent('chat:event:agent-7', { type: 'assistant.message' });
    unsubscribe();

    // The lightweight client reads the flattened form...
    expect(received[0].channel).toBe('chat:event');
    // ...while the full renderer needs the channel it actually subscribed to.
    expect(received[0].source).toEqual({
      channel: 'chat:event:agent-7',
      args: [{ type: 'assistant.message' }],
    });
  });
});
