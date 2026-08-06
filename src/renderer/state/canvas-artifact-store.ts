import type { SpaceCanvasArtifact } from '../../shared/types';

export interface CanvasArtifactState {
  /** Published artifacts keyed by space id, newest first. */
  bySpace: Map<string, SpaceCanvasArtifact[]>;
}

type Listener = () => void;

/**
 * Which spaces have a canvas artifact to open.
 *
 * Kept separate from the space store because artifacts live on disk rather than
 * in the spaces projection: they arrive on their own schedule, and a run that
 * republishes a report should not force the whole space list to reload.
 */
class CanvasArtifactStore {
  private state: CanvasArtifactState = { bySpace: new Map() };
  private listeners: Set<Listener> = new Set();

  getState(): Readonly<CanvasArtifactState> {
    return this.state;
  }

  /** Replace the whole index — used by the snapshot loader. */
  setArtifacts(artifacts: SpaceCanvasArtifact[]): void {
    const bySpace = new Map<string, SpaceCanvasArtifact[]>();
    for (const artifact of artifacts) {
      const list = bySpace.get(artifact.spaceId);
      if (list) list.push(artifact);
      else bySpace.set(artifact.spaceId, [artifact]);
    }
    this.state = { bySpace };
    this.notify();
  }

  /** Replace one space's artifacts, leaving every other space untouched. */
  setSpaceArtifacts(spaceId: string, artifacts: SpaceCanvasArtifact[]): void {
    const bySpace = new Map(this.state.bySpace);
    if (artifacts.length === 0) bySpace.delete(spaceId);
    else bySpace.set(spaceId, artifacts);
    this.state = { bySpace };
    this.notify();
  }

  getSpaceArtifacts(spaceId: string): SpaceCanvasArtifact[] {
    return this.state.bySpace.get(spaceId) ?? [];
  }

  /** The artifact a space's chip should open: the most recent one. */
  getPrimary(spaceId: string): SpaceCanvasArtifact | null {
    return this.state.bySpace.get(spaceId)?.[0] ?? null;
  }

  clear(): void {
    if (this.state.bySpace.size === 0) return;
    this.state = { bySpace: new Map() };
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const canvasArtifactStore = new CanvasArtifactStore();
