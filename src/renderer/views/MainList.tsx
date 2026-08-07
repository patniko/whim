import React from 'react';
import { spaceStore } from '../state/space-store';
import { useStore } from './useStore';
import { SpacesList } from './SpacesList';
import type { SpacesListActions } from './SpacesList';
import { AgentsList } from './AgentsList';
import type { AgentsListActions } from './AgentsList';
import { SkillsList } from './SkillsList';
import { HistoryView } from './HistoryView';

/**
 * Orchestrator component for the four main filterable lists. Reads the
 * current filter from `spaceStore` and renders one of the four list
 * components.
 *
 * Wires action callbacks (onSpaceClick, onDelete, etc.) through to the
 * selected list component. The callbacks are owned by the mount caller —
 * during the React migration these are thin shims back to the legacy
 * `window.*` action functions in app.ts. Phase 7 replaces those shims
 * with proper React handlers as the imperative code is deleted.
 */
export interface MainListProps {
  spacesActions: SpacesListActions;
  agentsActions: AgentsListActions;
  skillsActions: {
    onSkillClick: (skillId: string) => void;
    onRunNow: (skillId: string) => void;
    onSchedule: (skillId: string) => void;
    onCreateSpace: (skillId: string) => void;
    onOpenFolder: (skillId: string) => void;
    onDelete: (skillId: string) => void;
  };
  historyActions: {
    onCardClick: (spaceId: string) => void;
    onUnarchive: (spaceId: string) => void;
  };
}

export function MainList(props: MainListProps): React.ReactElement {
  const { filter, searchResults, searchMode, activeSearchQuery } = useStore(spaceStore);

  // Search-on-spaces overrides filter routing
  if (searchResults !== null && filter !== 'agents' && filter !== 'skills') {
    return <SpacesList {...props.spacesActions} searchResults={searchResults} />;
  }

  switch (filter) {
    case 'agents':
      return (
        <AgentsList
          {...props.agentsActions}
          filterQuery={searchMode ? activeSearchQuery || undefined : undefined}
        />
      );
    case 'skills':
      return (
        <SkillsList
          {...props.skillsActions}
          filterQuery={searchMode ? activeSearchQuery || undefined : undefined}
        />
      );
    case 'closed':
      return <HistoryView {...props.historyActions} />;
    case 'open':
    default:
      return <SpacesList {...props.spacesActions} searchResults={null} />;
  }
}
