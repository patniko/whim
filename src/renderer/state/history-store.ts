import type { SpaceEvent } from '../../shared/ipc-contract';
import { reconcileByKey } from './reconcile';

export interface HistoryState {
  page: import('../../shared/paging').Page<import('../../shared/activity-types').ActivityRow> | null;
  /** Most-recent timeline events (matches `whimAPI.listEvents(limit)`). */
  events: SpaceEvent[];
}

type Listener = () => void;

function createInitialHistoryState(): HistoryState {
  return { events: [], page: null };
}

class HistoryStore {
  private state: HistoryState = createInitialHistoryState();
  private listeners: Set<Listener> = new Set();
  private requestCounter = 0;
  private latestRequestId = 0;

  getState(): Readonly<HistoryState> {
    return this.state;
  }

  setPage(page: NonNullable<HistoryState['page']>): void {
    this.state = { ...this.state, page };
    this.notify();
  }

  setEvents(events: SpaceEvent[]): void {
    events = reconcileByKey(this.state.events, events, event => event.id);
    if (events === this.state.events) return;
    this.state = { ...this.state, events };
    this.notify();
  }

  reset(): void {
    this.state = createInitialHistoryState();
    this.nextRequestId();
    this.notify();
  }

  // -- Stale-fetch guards -----------------------------------------------------

  nextRequestId(): number {
    this.requestCounter += 1;
    this.latestRequestId = this.requestCounter;
    return this.latestRequestId;
  }

  isCurrentRequest(id: number): boolean {
    return id === this.latestRequestId;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -- Derived state helpers --------------------------------------------------

  /** Group events by their space_id (skips events without a space). */
  getEventsBySpace(): Map<string, SpaceEvent[]> {
    const map = new Map<string, SpaceEvent[]>();
    for (const event of this.state.events) {
      const id = event.space_id;
      if (!id) continue;
      const list = map.get(id);
      if (list) list.push(event);
      else map.set(id, [event]);
    }
    return map;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const historyStore = new HistoryStore();
