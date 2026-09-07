import type { SpaceSummary as Space, SpacePage } from '../../shared/paging';
import { toSpaceSummary } from '../../shared/paging';
import type { RecallMatch } from '../../shared/types';
import { reconcileByKey } from './reconcile';

export type SpaceFilter = 'open' | 'agents' | 'skills' | 'closed';

export interface SpaceState {
  spaces: Space[];
  page: SpacePage | null;
  hydrated: boolean;
  filter: SpaceFilter;
  searchResults: Space[] | null;
  searchMode: boolean;
  activeSearchQuery: string;
  focusedSpaceId: string | null;
  focusedSummary: Space | null;
  canvasSpaceId: string | null;
  /** Index of the keyboard-selected row in the currently displayed list (-1 = none). */
  selectedIndex: number;
  /** Transient "similar previous space" hints, keyed by space id. */
  recallHints: Map<string, RecallMatch>;
}

type Listener = () => void;

class SpaceStore {
  private state: SpaceState = {
    spaces: [],
    page: null,
    hydrated: false,
    filter: 'open',
    searchResults: null,
    searchMode: false,
    activeSearchQuery: '',
    focusedSpaceId: null,
    focusedSummary: null,
    canvasSpaceId: null,
    selectedIndex: -1,
    recallHints: new Map(),
  };
  private listeners: Set<Listener> = new Set();
  /** Monotonic counter for stale-fetch detection (replaces app.ts:renderGeneration). */
  private requestCounter = 0;
  private latestRequestId = 0;

  getState(): Readonly<SpaceState> {
    return this.state;
  }

  setSpaces(spaces: Space[]): void {
    spaces = reconcileByKey(this.state.spaces, spaces, space => space.id);
    if (spaces === this.state.spaces && this.state.hydrated) return;
    this.state = { ...this.state, spaces, hydrated: true };
    this.notify();
  }

  setPage(page: SpacePage): void {
    const spaces = reconcileByKey(this.state.spaces, page.items, space => space.id);
    const selectedId = this.state.spaces[this.state.selectedIndex]?.id;
    this.state = {
      ...this.state, spaces, page: { ...page, items: spaces }, hydrated: true,
      searchResults: this.state.searchMode && this.state.activeSearchQuery ? spaces : null,
      focusedSummary: spaces.find(space => space.id === this.state.focusedSpaceId) ?? this.state.focusedSummary,
      selectedIndex: selectedId ? spaces.findIndex(space => space.id === selectedId) : -1,
    };
    this.notify();
  }

  /**
   * Insert a space at the top of the list, or replace it in place if a space
   * with the same id already exists. Used for optimistic insertion right after
   * creation so the new row renders without a full list reload.
   */
  upsertSpace(space: Space): void {
    space = toSpaceSummary(space);
    this.nextRequestId();
    const existingIdx = this.state.spaces.findIndex(s => s.id === space.id);
    let spaces: Space[];
    if (existingIdx >= 0) {
      spaces = this.state.spaces.slice();
      spaces[existingIdx] = space;
    } else {
      spaces = [space, ...this.state.spaces];
    }
    spaces = reconcileByKey(this.state.spaces, spaces, item => item.id);
    if (spaces === this.state.spaces) return;
    this.state = { ...this.state, spaces };
    this.notify();
  }

  updateSpaceTitle(id: string, title: string): void {
    this.nextRequestId();
    let changed = false;
    const spaces = this.state.spaces.map((space) => {
      if (space.id !== id || space.description === title) return space;
      changed = true;
      return { ...space, description: title };
    });
    if (!changed) return;
    this.state = { ...this.state, spaces };
    this.notify();
  }

  setFilter(filter: SpaceFilter): void {
    if (filter === this.state.filter) return;
    this.nextRequestId();
    this.state = { ...this.state, filter };
    this.notify();
  }

  setSearchResults(results: Space[] | null): void {
    if (results && this.state.searchResults) {
      results = reconcileByKey(this.state.searchResults, results, space => space.id);
    }
    if (results === this.state.searchResults) return;
    this.state = { ...this.state, searchResults: results };
    this.notify();
  }

  setSearchMode(searchMode: boolean): void {
    this.state = { ...this.state, searchMode };
    this.notify();
  }

  setActiveSearchQuery(query: string): void {
    this.nextRequestId();
    this.state = { ...this.state, activeSearchQuery: query };
    this.notify();
  }

  setFocusedSpace(id: string | null): void {
    this.state = { ...this.state, focusedSpaceId: id, focusedSummary: id ? this.getSpace(id) ?? null : null };
    this.notify();
  }

  setFocusedSummary(space: Space | null): void {
    if (space && space.id !== this.state.focusedSpaceId) return;
    this.state = { ...this.state, focusedSummary: space ? toSpaceSummary(space) : null };
    this.notify();
  }

  setCanvasSpace(id: string | null): void {
    this.state = { ...this.state, canvasSpaceId: id };
    this.notify();
  }

  setSelectedIndex(index: number): void {
    if (index === this.state.selectedIndex) return;
    this.state = { ...this.state, selectedIndex: index };
    this.notify();
  }

  // -- Recall hints -----------------------------------------------------------

  setRecallHint(spaceId: string, match: RecallMatch | null): void {
    const next = new Map(this.state.recallHints);
    if (match) next.set(spaceId, match);
    else next.delete(spaceId);
    this.state = { ...this.state, recallHints: next };
    this.notify();
  }

  // -- Stale-fetch guards (replaces app.ts:renderGeneration) ------------------

  /** Reserve a new request id. Latest reservation wins. */
  nextRequestId(): number {
    this.requestCounter += 1;
    this.latestRequestId = this.requestCounter;
    return this.latestRequestId;
  }

  /** True if the given id is still the latest reserved id. */
  isCurrentRequest(id: number): boolean {
    return id === this.latestRequestId;
  }

  reset(): void {
    this.nextRequestId();
    this.state = {
      ...this.state, spaces: [], page: null, hydrated: false, searchResults: null, searchMode: false,
      activeSearchQuery: '', focusedSpaceId: null, focusedSummary: null, canvasSpaceId: null,
      selectedIndex: -1, recallHints: new Map(),
    };
    this.notify();
  }

  /** Subscribe to state changes. Returns an unsubscribe function (useSyncExternalStore-compatible). */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -- Derived state helpers --------------------------------------------------

  /** Return spaces matching the current filter (or search results when active). */
  getFilteredSpaces(): Space[] {
    const { spaces, filter, searchResults } = this.state;
    if (searchResults !== null) return searchResults;

    switch (filter) {
      case 'open':
        return spaces.filter(i => i.status !== 'done');
      case 'closed':
        return spaces.filter(i => i.status === 'done');
      case 'agents':
      case 'skills':
        return spaces;
      default:
        return spaces;
    }
  }

  getSpace(id: string): Space | undefined {
    return this.state.spaces.find(i => i.id === id) ?? (this.state.focusedSummary?.id === id ? this.state.focusedSummary : undefined);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const spaceStore = new SpaceStore();
