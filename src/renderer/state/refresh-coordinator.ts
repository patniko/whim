import { recordTiming } from '../../shared/performance';
type Load = (isCurrent: () => boolean) => Promise<void>;

interface Request {
  revision: number;
  dirty: boolean;
  force: boolean;
  again: boolean;
  load: Load;
  running?: Promise<void>;
}

export interface RefreshTiming {
  collection: string;
  requests: number;
  failures: number;
  lastDurationMs: number;
  maxDurationMs: number;
  totalDurationMs: number;
}

/**
 * One flight per resource. Events during a flight invalidate its result and
 * request one trailing read; ordinary concurrent readers join the same flight.
 */
export class RefreshCoordinator {
  private generation = 0;
  private requests = new Map<string, Request>();
  private timings = new Map<string, RefreshTiming>();

  constructor(private readonly visible: () => boolean) {}

  reset(): void {
    this.generation += 1;
    this.requests.clear();
    this.timings.clear();
  }

  getTimings(): RefreshTiming[] {
    return [...this.timings.values()].map(timing => ({ ...timing }));
  }

  invalidate(key: string): void {
    const request = this.requests.get(key);
    if (request) {
      request.revision += 1;
      request.dirty = true;
    }
  }

  request(key: string, load: Load, force = false): Promise<void> {
    let request = this.requests.get(key);
    if (!request) {
      request = { revision: 0, dirty: true, force, again: false, load };
      this.requests.set(key, request);
    }
    request.load = load;
    request.force ||= force;
    if (request.running) {
      request.again ||= request.dirty;
      return request.running;
    }
    request.dirty = true;
    if (!this.visible() && !request.force) return Promise.resolve();

    const current = request;
    const generation = this.generation;
    const running = (async () => {
      while (generation === this.generation && current.dirty && (this.visible() || current.force)) {
        const revision = current.revision;
        const forced = current.force;
        current.dirty = false;
        current.force = false;
        current.again = false;
        const start = performance.now();
        let failed = false;
        try {
          await current.load(() => generation === this.generation && revision === current.revision);
        } catch {
          failed = true;
          // Never log an IPC error's message: it may contain document content.
          console.error('[refresh] collection request failed', { collection: key.split(':')[0] });
          if (forced || current.force) throw new Error(`Unable to refresh ${key.split(':')[0]}`);
        } finally {
          if (generation === this.generation) {
            const collection = key.split(':')[0];
            const duration = performance.now() - start;
            recordTiming('renderer.refresh', duration, !failed);
            const previous = this.timings.get(collection);
            this.timings.set(collection, {
              collection, requests: (previous?.requests ?? 0) + 1,
              failures: (previous?.failures ?? 0) + Number(failed),
              lastDurationMs: duration, maxDurationMs: Math.max(previous?.maxDurationMs ?? 0, duration),
              totalDurationMs: (previous?.totalDurationMs ?? 0) + duration,
            });
          }
        }
        if (!current.again) break;
      }
    })().finally(() => {
      current.running = undefined;
      current.force = false;
    });
    current.running = running;
    return running;
  }

  flush(): Promise<void> {
    return Promise.all([...this.requests.entries()]
      .filter(([, request]) => request.dirty)
      .map(([key, request]) => this.request(key, request.load))).then(() => {});
  }
}
