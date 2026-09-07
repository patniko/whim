import type { Space } from "./types";
import type { ChatMessage } from "./chat-types";
import type { AgentListAllItem } from "./ipc-contract";

/** List rows deliberately cannot be used as document contents. */
export type SpaceSummary = Omit<Space, "body" | "raw_text" | "attachments"> & {
  agentCounts?: { running: number; waiting: number; failed: number; total: number };
};

export function toSpaceSummary(space: SpaceSummary): SpaceSummary {
  return {
    id: space.id,
    description: space.description,
    client: space.client,
    due_at: space.due_at,
    due_at_utc: space.due_at_utc,
    recurrence: space.recurrence,
    completed_at: space.completed_at,
    folder: space.folder,
    session_id: space.session_id,
    source_skill_id: space.source_skill_id,
    status: space.status,
    created_at: space.created_at,
    updated_at: space.updated_at,
    ...(space.agentCounts ? { agentCounts: space.agentCounts } : {}),
  };
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface SpacePageRequest extends PageRequest {
  filter?: "open" | "closed" | "all";
  query?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
  /** Current global rank of the first row, not a frozen snapshot offset. */
  offset?: number;
}

export interface SpacePage extends Page<SpaceSummary> {
  counts: { open: number; closed: number; scheduled?: number; recurring?: number };
}

export interface ChatHistoryPage extends Page<ChatMessage> {
  /** Highest durable event sequence included in this snapshot. */
  watermark: number;
  /** Only old, unmirrored SDK/CLI sessions and explicitly ephemeral agents. */
  legacySession?: boolean;
}

export interface AgentPageRequest extends PageRequest {
  query?: string;
  spaceId?: string;
  includePages?: boolean;
  activeOnly?: boolean;
}

export interface ActivityPageRequest extends PageRequest {
  dayStart?: string;
  weekStart?: string;
}

export interface ActivityPage extends Page<import("./activity-types").ActivityRow> {
  closedCounts?: { today: number; week: number; total: number };
}

/** Text fields are previews. Fetch agent:get before opening the full prompt. */
export interface AgentPage extends Page<AgentListAllItem> {
  counts: { running: number; waiting: number; completed: number; failed: number };
}
