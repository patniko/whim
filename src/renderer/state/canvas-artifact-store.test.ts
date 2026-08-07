import { describe, it, expect, beforeEach } from 'vitest';
import { canvasArtifactStore } from './canvas-artifact-store';
import type { SpaceCanvasArtifact } from '../../shared/types';

function artifact(spaceId: string, artifactId: string, publishedAt: string): SpaceCanvasArtifact {
  return {
    artifactId,
    spaceId,
    title: artifactId,
    published: true,
    updatedAt: publishedAt,
    publishedAt,
    url: `whim-artifact://space/${spaceId}/${artifactId}/index.html`,
  };
}

beforeEach(() => {
  canvasArtifactStore.clear();
});

describe('canvasArtifactStore', () => {
  it('groups a flat snapshot by space', () => {
    canvasArtifactStore.setArtifacts([
      artifact('space-1', 'questions', '2024-01-02T00:00:00.000Z'),
      artifact('space-2', 'digest', '2024-01-01T00:00:00.000Z'),
      artifact('space-1', 'older', '2024-01-01T00:00:00.000Z'),
    ]);

    expect(canvasArtifactStore.getSpaceArtifacts('space-1').map(a => a.artifactId)).toEqual(['questions', 'older']);
    expect(canvasArtifactStore.getSpaceArtifacts('space-2').map(a => a.artifactId)).toEqual(['digest']);
  });

  it('offers the first artifact as the one a chip opens', () => {
    canvasArtifactStore.setArtifacts([
      artifact('space-1', 'newest', '2024-06-01T00:00:00.000Z'),
      artifact('space-1', 'older', '2024-01-01T00:00:00.000Z'),
    ]);

    expect(canvasArtifactStore.getPrimary('space-1')?.artifactId).toBe('newest');
  });

  it('has no artifact for a space that produced none', () => {
    expect(canvasArtifactStore.getPrimary('space-1')).toBeNull();
    expect(canvasArtifactStore.getSpaceArtifacts('space-1')).toEqual([]);
  });

  it('refreshes one space without disturbing the others', () => {
    canvasArtifactStore.setArtifacts([
      artifact('space-1', 'questions', '2024-01-01T00:00:00.000Z'),
      artifact('space-2', 'digest', '2024-01-01T00:00:00.000Z'),
    ]);

    canvasArtifactStore.setSpaceArtifacts('space-1', [artifact('space-1', 'refreshed', '2024-06-01T00:00:00.000Z')]);

    expect(canvasArtifactStore.getPrimary('space-1')?.artifactId).toBe('refreshed');
    expect(canvasArtifactStore.getPrimary('space-2')?.artifactId).toBe('digest');
  });

  it('drops a space whose artifacts have all gone', () => {
    canvasArtifactStore.setArtifacts([artifact('space-1', 'questions', '2024-01-01T00:00:00.000Z')]);

    canvasArtifactStore.setSpaceArtifacts('space-1', []);

    expect(canvasArtifactStore.getPrimary('space-1')).toBeNull();
  });

  it('notifies subscribers so the chip appears without a reload', () => {
    let notifications = 0;
    const unsubscribe = canvasArtifactStore.subscribe(() => { notifications++; });

    canvasArtifactStore.setArtifacts([artifact('space-1', 'questions', '2024-01-01T00:00:00.000Z')]);
    canvasArtifactStore.setSpaceArtifacts('space-1', []);
    unsubscribe();
    canvasArtifactStore.setArtifacts([]);

    expect(notifications).toBe(2);
  });

  it('does not notify when clearing an already empty index', () => {
    let notifications = 0;
    canvasArtifactStore.subscribe(() => { notifications++; });

    canvasArtifactStore.clear();

    expect(notifications).toBe(0);
  });
});
