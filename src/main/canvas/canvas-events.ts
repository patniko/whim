/**
 * Main-process fan-out for canvas artifact changes.
 *
 * Kept separate from the renderer broadcast so main-process consumers (the
 * tray, for one) can react without a window having to exist.
 */
import { EventEmitter } from 'events';

export interface ArtifactPublishedEvent {
  spaceId: string;
  artifactId: string;
  title: string;
}

const emitter = new EventEmitter();
// Several main-process surfaces may listen; the default of 10 is a warning
// threshold rather than a real limit, but there is no reason to trip it.
emitter.setMaxListeners(20);

export function emitArtifactPublished(event: ArtifactPublishedEvent): void {
  emitter.emit('published', event);
}

/** Subscribe to artifact publications. Returns an unsubscribe function. */
export function onArtifactPublished(listener: (event: ArtifactPublishedEvent) => void): () => void {
  emitter.on('published', listener);
  return () => { emitter.off('published', listener); };
}
