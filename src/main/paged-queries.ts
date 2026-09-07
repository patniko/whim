import type Database from "better-sqlite3";
import type {
  PageRequest,
  SpacePageRequest,
  SpacePage,
  SpaceSummary,
  Page,
} from "../shared/paging";
import type { SpaceEvent } from "../shared/ipc-contract";
import type { AgentSession } from "../shared/types";
import type {
  AgentPageRequest,
  AgentPage,
  ActivityPageRequest,
  ActivityPage,
} from "../shared/paging";
import type { ActivityRow } from "../shared/activity-types";

type Key = string | number;
type Order = readonly [expression: string, direction: "ASC" | "DESC"];

export function pageLimit(request: PageRequest): number {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("Invalid page request");
  const limit = request.limit ?? 60;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Page limit must be between 1 and 100");
  return limit;
}

export function encodeCursor(scope: string, keys: Key[]): string {
  return Buffer.from(JSON.stringify({ scope, keys })).toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined,
  scope: string,
  length: number,
): Key[] | null {
  if (cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.length > 8192) throw new Error("Invalid page cursor");
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  if (
    value?.scope !== scope ||
    !Array.isArray(value.keys) ||
    value.keys.length !== length ||
    !value.keys.every(
      (key: unknown) =>
        typeof key === "string" || (typeof key === "number" && Number.isFinite(key)),
    )
  ) {
    throw new Error("Invalid or mismatched page cursor");
  }
  return value.keys;
}

function seek(order: readonly Order[], keys: Key[] | null): { sql: string; args: Key[] } {
  if (!keys) return { sql: "1", args: [] };
  const args: Key[] = [];
  const clauses = order.map(([expression, direction], index) => {
    const equal = order.slice(0, index).map(([previous], j) => {
      args.push(keys[j]);
      return `${previous} = ?`;
    });
    args.push(keys[index]);
    return `(${[...equal, `${expression} ${direction === "ASC" ? ">" : "<"} ?`].join(" AND ")})`;
  });
  return { sql: `(${clauses.join(" OR ")})`, args };
}

const SPACE_COLUMNS =
  "id, description, client, due_at, due_at_utc, recurrence, completed_at, folder, session_id, source_skill_id, status, created_at, updated_at";
const SPACE_ORDER: readonly Order[] = [
  ["(status = 'done')", "ASC"],
  ["(status != 'in_progress')", "ASC"],
  ["(due_at_utc IS NULL)", "ASC"],
  ["COALESCE(due_at_utc, '')", "ASC"],
  ["updated_at", "DESC"],
  ["id", "ASC"],
];
const SEARCH_ORDER: readonly Order[] = [
  ["updated_at", "DESC"],
  ["id", "ASC"],
];

export function querySpacePage(db: Database.Database, request: SpacePageRequest = {}): SpacePage {
  const limit = pageLimit(request);
  const filter = request.filter ?? "all";
  if (!["all", "open", "closed"].includes(filter)) throw new Error("Invalid space filter");
  if (
    request.query !== undefined &&
    (typeof request.query !== "string" || request.query.length > 1024)
  )
    throw new Error("Invalid search query");
  const query = request.query ?? "";
  const scope = JSON.stringify(["spaces", filter, query]);
  const order = query ? SEARCH_ORDER : SPACE_ORDER;
  const boundary = seek(order, decodeCursor(request.cursor, scope, order.length));
  const conditions = [
    filter === "open" ? "status != 'done'" : filter === "closed" ? "status = 'done'" : "1",
  ];
  const args: Key[] = [];
  if (query) {
    // FTS5 trigram LIKE is a candidate index. The residual LIKE retains SQLite's
    // ASCII-only case folding, Unicode behavior, and legacy % / _ wildcards.
    // Short patterns use SQLite's bounded-memory scan in the storage worker.
    const pattern = `%${query}%`;
    if (!query.includes("\0") && query.split(/[%_]/u).some((part) => [...part].length >= 3)) {
      conditions.push(`rowid IN (
        SELECT rowid FROM space_search WHERE description LIKE ?
        UNION SELECT rowid FROM space_search WHERE body LIKE ?
        UNION SELECT rowid FROM space_search WHERE canvas_content LIKE ?)`);
      args.push(pattern, pattern, pattern);
    }
    conditions.push("(description LIKE ? OR body LIKE ? OR canvas_content LIKE ?)");
    args.push(pattern, pattern, pattern);
  }
  const where = conditions.join(" AND ");
  const total = (
    db.prepare(`SELECT count(*) AS n FROM spaces WHERE ${where}`).get(...args) as { n: number }
  ).n;
  const offset =
    request.cursor === undefined
      ? 0
      : total -
        (
          db
            .prepare(`SELECT count(*) AS n FROM spaces WHERE ${where} AND ${boundary.sql}`)
            .get(...args, ...boundary.args) as { n: number }
        ).n;
  const counts = db
    .prepare(`SELECT count(*) FILTER (WHERE status != 'done') AS open,
    count(*) FILTER (WHERE status = 'done') AS closed,
    count(*) FILTER (WHERE due_at_utc IS NOT NULL OR due_at IS NOT NULL) AS scheduled,
    count(*) FILTER (WHERE recurrence IS NOT NULL AND recurrence != '') AS recurring FROM spaces`)
    .get() as SpacePage["counts"];
  const items = db
    .prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE ${where} AND ${boundary.sql}
    ORDER BY ${order.map(([expr, dir]) => `${expr} ${dir}`).join(", ")} LIMIT ?`)
    .all(...args, ...boundary.args, limit + 1) as SpaceSummary[];
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  const last = items[items.length - 1];
  const keys =
    last &&
    (query
      ? [last.updated_at, last.id]
      : [
          Number(last.status === "done"),
          Number(last.status !== "in_progress"),
          Number(last.due_at_utc === null),
          last.due_at_utc ?? "",
          last.updated_at,
          last.id,
        ]);
  const agentCounts = db.prepare(`SELECT count(*) AS total,
    count(*) FILTER (WHERE status='running') AS running,
    count(*) FILTER (WHERE status='waiting-approval') AS waiting,
    count(*) FILTER (WHERE status='failed') AS failed FROM agent_sessions WHERE space_id=?`);
  for (const item of items)
    item.agentCounts = agentCounts.get(item.id) as NonNullable<SpaceSummary["agentCounts"]>;
  return {
    items,
    total,
    offset,
    counts,
    nextCursor: hasMore && keys ? encodeCursor(scope, keys) : null,
  };
}

export function querySpaceEventPage(
  db: Database.Database,
  request: PageRequest = {},
): Page<SpaceEvent> {
  const limit = pageLimit(request);
  const order: Order[] = [
    ["e.created_at", "DESC"],
    ["e.id", "ASC"],
  ];
  const boundary = seek(order, decodeCursor(request.cursor, "space-events", 2));
  const items = db
    .prepare(`SELECT e.*, s.description AS space_description, s.client AS space_client, s.session_id
    FROM space_events e LEFT JOIN spaces s ON s.id = e.space_id WHERE ${boundary.sql}
    ORDER BY e.created_at DESC, e.id ASC LIMIT ?`)
    .all(...boundary.args, limit + 1) as SpaceEvent[];
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  const last = items[items.length - 1];
  return {
    items,
    total: (db.prepare("SELECT count(*) AS n FROM space_events").get() as { n: number }).n,
    nextCursor: hasMore && last ? encodeCursor("space-events", [last.created_at, last.id]) : null,
  };
}

export type AgentSummaryRow = Pick<
  AgentSession,
  | "id"
  | "session_id"
  | "space_id"
  | "prompt"
  | "status"
  | "summary"
  | "source"
  | "persona_handle"
  | "quoted_text"
  | "run_location"
  | "yolo_mode"
  | "created_at"
>;

export function queryAgentPage(
  db: Database.Database,
  request: AgentPageRequest = {},
): Page<AgentSummaryRow> & { counts: AgentPage["counts"] } {
  const limit = pageLimit(request);
  if (
    request.query !== undefined &&
    (typeof request.query !== "string" || request.query.length > 1024)
  )
    throw new Error("Invalid worker query");
  if (request.spaceId !== undefined && typeof request.spaceId !== "string")
    throw new Error("Invalid space ID");
  if (request.includePages !== undefined && typeof request.includePages !== "boolean")
    throw new Error("Invalid page inclusion flag");
  if (request.activeOnly !== undefined && typeof request.activeOnly !== "boolean")
    throw new Error("Invalid active worker flag");
  const scope = JSON.stringify([
    "agents",
    request.query ?? "",
    request.spaceId ?? "",
    !!request.includePages,
    !!request.activeOnly,
  ]);
  const boundary = seek(
    [
      ["created_at", "DESC"],
      ["id", "ASC"],
    ],
    decodeCursor(request.cursor, scope, 2),
  );
  const where = ["1"];
  const args: Key[] = [];
  if (request.activeOnly) where.push("status IN ('running','waiting-approval')");
  if (request.spaceId) {
    where.push(
      request.includePages ? "(space_id = ? OR (space_id >= ? AND space_id < ?))" : "space_id = ?",
    );
    args.push(request.spaceId);
    if (request.includePages)
      args.push(`__page__${request.spaceId}/`, `__page__${request.spaceId}0`);
  }
  if (request.query) {
    // Deliberately uses the same JS Unicode lowercase + literal substring
    // semantics as the former renderer worker filter (not SQL LIKE wildcards).
    const pattern = `%${request.query.toLowerCase()}%`;
    if (
      !request.query.includes("\0") &&
      request.query.split(/[%_]/u).some((part) => [...part].length >= 3)
    ) {
      where.push(`rowid IN (SELECT rowid FROM agent_search WHERE prompt LIKE ?
        UNION SELECT rowid FROM agent_search WHERE summary LIKE ?)`);
      args.push(pattern, pattern);
    }
    where.push("(instr(whim_lower(prompt), ?) > 0 OR instr(whim_lower(summary), ?) > 0)");
    args.push(request.query.toLowerCase(), request.query.toLowerCase());
  }

  const predicate = where.join(" AND ");
  const total = (
    db.prepare(`SELECT count(*) AS n FROM agent_sessions WHERE ${predicate}`).get(...args) as {
      n: number;
    }
  ).n;
  const offset =
    request.cursor === undefined
      ? 0
      : total -
        (
          db
            .prepare(
              `SELECT count(*) AS n FROM agent_sessions WHERE ${predicate} AND ${boundary.sql}`,
            )
            .get(...args, ...boundary.args) as { n: number }
        ).n;
  const items = db
    .prepare(`SELECT id, session_id, space_id, substr(prompt,1,160) AS prompt, status,
    substr(summary,1,300) AS summary, source, persona_handle, substr(quoted_text,1,160) AS quoted_text,
    run_location, yolo_mode, created_at FROM agent_sessions WHERE ${predicate} AND ${boundary.sql}
    ORDER BY created_at DESC, id ASC LIMIT ?`)
    .all(...args, ...boundary.args, limit + 1) as AgentSummaryRow[];
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  const last = items[items.length - 1];
  const counts = db
    .prepare(`SELECT count(*) FILTER (WHERE status = 'running') AS running,
    count(*) FILTER (WHERE status = 'waiting-approval') AS waiting,
    count(*) FILTER (WHERE status = 'completed') AS completed,
    count(*) FILTER (WHERE status = 'failed') AS failed FROM agent_sessions`)
    .get() as AgentPage["counts"];
  return {
    items,
    counts,
    total,
    offset,
    nextCursor: hasMore && last ? encodeCursor(scope, [last.created_at, last.id]) : null,
  };
}

export function queryActivityPage(
  db: Database.Database,
  request: ActivityPageRequest = {},
): ActivityPage {
  const limit = pageLimit(request);
  for (const boundary of [request.dayStart, request.weekStart]) {
    if (
      boundary !== undefined &&
      (typeof boundary !== "string" ||
        !Number.isFinite(Date.parse(boundary)) ||
        new Date(boundary).toISOString() !== boundary)
    ) {
      throw new Error("Invalid activity time boundary");
    }
  }
  const boundary = seek(
    [
      ["stamp", "DESC"],
      ["key", "ASC"],
    ],
    decodeCursor(request.cursor, "activity", 2),
  );
  const timeline = `WITH timeline AS (
      SELECT 'space-' || id AS key, id AS space_id, NULL AS event_id, COALESCE(completed_at, updated_at) AS stamp
        FROM spaces WHERE status = 'done'
      UNION ALL
      SELECT 'event-' || e.id AS key, e.space_id, e.id AS event_id, e.created_at AS stamp
        FROM space_events e WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id=e.space_id AND s.status='done')
    )`;
  const rows = db
    .prepare(
      `${timeline} SELECT * FROM timeline WHERE ${boundary.sql} ORDER BY stamp DESC,key ASC LIMIT ?`,
    )
    .all(...boundary.args, limit + 1) as {
    key: string;
    space_id: string;
    event_id: string | null;
    stamp: string;
  }[];
  const more = rows.length > limit;
  if (more) rows.pop();
  const total = (
    db.prepare(`${timeline} SELECT count(*) AS n FROM timeline`).get() as { n: number }
  ).n;
  const offset =
    request.cursor === undefined
      ? 0
      : total -
        (
          db
            .prepare(`${timeline} SELECT count(*) AS n FROM timeline WHERE ${boundary.sql}`)
            .get(...boundary.args) as { n: number }
        ).n;
  const spaceQuery =
    db.prepare(`SELECT description, client, session_id, recurrence, created_at, completed_at,
      (SELECT count(*) FROM agent_sessions a WHERE a.space_id=s.id) AS agents,
      (SELECT count(*) FROM space_events e WHERE e.space_id=s.id AND e.event_type='recycled') AS recycled,
      EXISTS(SELECT 1 FROM space_events e WHERE e.space_id=s.id AND e.event_type='recurrence_dismissed') AS dismissed
      FROM spaces s WHERE s.id=?`);
  const eventQuery = db.prepare("SELECT event_type FROM space_events WHERE id=?");
  const items = rows.map((row) => {
    const space = spaceQuery.get(row.space_id) as
      | {
          description: string;
          client: string | null;
          session_id: string | null;
          recurrence: string | null;
          created_at: string;
          completed_at: string | null;
          agents: number;
          recycled: number;
          dismissed: number;
        }
      | undefined;
    const event = row.event_id
      ? (eventQuery.get(row.event_id) as { event_type: string })
      : undefined;
    const hadWork = !!space?.session_id || !!space?.agents;
    const dismissed = event ? event.event_type === "recurrence_dismissed" : !!space?.dismissed;
    const minutes = space?.completed_at
      ? Math.floor((Date.parse(space.completed_at) - Date.parse(space.created_at)) / 60000)
      : 0;
    return {
      key: row.key,
      kind: row.event_id ? "event" : "space",
      spaceId: row.event_id ? null : row.space_id,
      at: Date.parse(row.stamp),
      title: space?.description || "Deleted space",
      client: space?.client ?? null,
      icon: hadWork ? "▶" : space?.recurrence ? "↻" : "✓",
      variant: dismissed
        ? "dismissed"
        : hadWork
          ? "session"
          : space?.recurrence
            ? "recurring"
            : "completed",
      agentCount: space?.agents ?? 0,
      hasSession: !!space?.session_id,
      rescheduled: row.event_id ? 0 : (space?.recycled ?? 0),
      duration:
        row.event_id || minutes <= 0
          ? ""
          : minutes < 60
            ? `${minutes}m`
            : minutes < 1440
              ? `${Math.floor(minutes / 60)}h`
              : `${Math.floor(minutes / 1440)}d`,
    } satisfies ActivityRow;
  });
  const last = rows[rows.length - 1];
  const closedCounts =
    request.dayStart !== undefined && request.weekStart !== undefined
      ? (db
          .prepare(`SELECT count(*) AS total,
        count(*) FILTER (WHERE unixepoch(COALESCE(completed_at,updated_at)) >= unixepoch(?)) AS today,
        count(*) FILTER (WHERE unixepoch(COALESCE(completed_at,updated_at)) >= unixepoch(?)) AS week
        FROM spaces WHERE status='done'`)
          .get(request.dayStart, request.weekStart) as NonNullable<ActivityPage["closedCounts"]>)
      : undefined;
  return {
    items,
    total,
    offset,
    ...(closedCounts ? { closedCounts } : {}),
    nextCursor: more && last ? encodeCursor("activity", [last.stamp, last.key]) : null,
  };
}
