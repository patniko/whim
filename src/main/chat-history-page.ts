import type Database from "better-sqlite3";
import type {
  ChatMessage,
  ApprovalMessage,
  ToolCallMessage,
  ElicitationMessage,
} from "../shared/chat-types";
import type { ChatHistoryPage, PageRequest } from "../shared/paging";
import { decodeCursor, encodeCursor, pageLimit } from "./paged-queries";

export function createChatProjection(db: Database.Database): void {
  db.exec(`
    CREATE TABLE chat_messages (
      agent_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
      kind TEXT NOT NULL, identity TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(agent_id, id)
    );
    CREATE INDEX idx_chat_messages_page ON chat_messages(agent_id, seq DESC, id);
    CREATE INDEX idx_chat_messages_identity ON chat_messages(agent_id, kind, identity);
    CREATE TABLE chat_projection (agent_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
    CREATE TRIGGER chat_projection_delete AFTER DELETE ON agent_chat_events BEGIN
      DELETE FROM chat_messages WHERE agent_id = old.agent_id;
      DELETE FROM chat_projection WHERE agent_id = old.agent_id;
    END;
  `);
}

interface RawEvent {
  seq: number;
  event_id: string | null;
  type: string;
  timestamp: string;
  payload: string;
}

export function projectChatHistory(db: Database.Database, agentId: string): number {
  const previous =
    (
      db.prepare("SELECT seq FROM chat_projection WHERE agent_id = ?").get(agentId) as
        | { seq: number }
        | undefined
    )?.seq ?? 0;
  let watermark = previous;
  const insert =
    db.prepare(`INSERT INTO chat_messages(agent_id,id,seq,kind,identity,payload) VALUES (?,?,?,?,?,?)
    ON CONFLICT(agent_id,id) DO UPDATE SET payload=excluded.payload`);
  const update = (kind: string, identity: string, apply: (message: ChatMessage) => ChatMessage) => {
    const row = db
      .prepare(
        "SELECT id,payload FROM chat_messages WHERE agent_id=? AND kind=? AND identity=? ORDER BY seq DESC LIMIT 1",
      )
      .get(agentId, kind, identity) as { id: string; payload: string } | undefined;
    if (row)
      db.prepare("UPDATE chat_messages SET payload=? WHERE agent_id=? AND id=?").run(
        JSON.stringify(apply(JSON.parse(row.payload))),
        agentId,
        row.id,
      );
  };
  // Materialize once, row-by-row in the storage worker. Subsequent reads only
  // normalize the appended suffix; no page parses the full transcript in a UI.
  db.transaction(() => {
    const events = db.prepare(
      "SELECT seq,event_id,type,timestamp,payload FROM agent_chat_events WHERE agent_id=? AND seq>? ORDER BY seq LIMIT 1",
    );
    for (
      let raw = events.get(agentId, watermark) as RawEvent | undefined;
      raw;
      raw = events.get(agentId, watermark) as RawEvent | undefined
    ) {
      if (Buffer.byteLength(raw.payload) > 16 * 1024 * 1024)
        throw new Error("Persisted chat event exceeds the 16 MiB normalization budget");
      const data = JSON.parse(raw.payload);
      if (!data || typeof data !== "object" || data._serializationError)
        throw new Error("Invalid persisted chat payload");
      const type = raw.type.replace(/^(user|assistant|tool|session)_/, "$1.");
      const timestamp = raw.timestamp;
      let id = `history:${agentId}:${raw.event_id ?? raw.seq}`;
      let message: ChatMessage | undefined;
      let identity = "";
      if (type === "user.message") {
        if (data.messageId || raw.event_id) id = `user:${data.messageId || raw.event_id}`;
        const content = data.content || data.prompt || data.message || "";
        if (content) message = { id, type: "user", content, timestamp };
      } else if (type === "assistant.message") {
        if (data.messageId) id = `assistant:${data.messageId}`;
        const content = data.content || data.message || "";
        if (content) message = { id, type: "assistant", content, isStreaming: false, timestamp };
      } else if (type === "assistant.reasoning") {
        identity = data.reasoningId || "";
        if (identity) id = `reasoning:${identity}`;
        if (data.content)
          message = {
            id,
            type: "reasoning",
            reasoningId: identity,
            content: data.content,
            isStreaming: false,
            timestamp,
          };
      } else if (type === "tool.execution_start") {
        identity = data.toolCallId || "";
        message = {
          id,
          type: "tool_call",
          toolCallId: identity,
          toolName: data.toolName || "tool",
          args: data.arguments || data.toolArgs || {},
          completed: false,
          timestamp,
        };
      } else if (type === "tool.execution_complete") {
        update("tool_call", data.toolCallId || "", (value) => ({
          ...(value as ToolCallMessage),
          completed: true,
          success: data.success !== false,
          result:
            typeof data.result === "string"
              ? data.result
              : (data.result?.detailedContent ?? data.result?.content ?? ""),
          error: data.error?.message,
        }));
      } else if (type === "permission.requested") {
        const request = data.permissionRequest || data;
        identity = data.requestId || request.toolCallId || "";
        message = {
          id,
          type: "approval",
          requestId: identity,
          agentId,
          permissionKind: request.kind || "permission",
          intention: request.intention,
          path: request.path || request.fileName,
          responded: false,
          timestamp,
        };
      } else if (type === "permission.completed") {
        update("approval", data.requestId || "", (value) => ({
          ...(value as ApprovalMessage),
          responded: true,
          approved: [
            "approved",
            "approve-once",
            "approve-for-session",
            "approve-for-location",
          ].includes(data.result?.kind),
        }));
      } else if (type === "elicitation.requested") {
        identity = data.requestId || "";
        message = {
          id,
          type: "elicitation",
          requestId: identity,
          agentId,
          message: data.message || "",
          requestedSchema: data.requestedSchema,
          mode: data.mode,
          elicitationSource: data.elicitationSource,
          responded: false,
          timestamp,
        };
      } else if (type === "elicitation.completed") {
        update("elicitation", data.requestId || "", (value) => ({
          ...(value as ElicitationMessage),
          responded: true,
          action: data.action,
          content: data.content,
        }));
      } else if (type === "session.error") {
        message = {
          id,
          type: "session_event",
          eventType: "error",
          message: data.message || "Unknown error",
          timestamp,
        };
      }
      if (message)
        insert.run(agentId, id, raw.seq, message.type, identity, JSON.stringify(message));
      watermark = raw.seq;
    }
    db.prepare(
      "INSERT INTO chat_projection(agent_id,seq) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET seq=excluded.seq",
    ).run(agentId, watermark);
  })();
  return watermark;
}

export function queryChatHistoryPage(
  db: Database.Database,
  agentId: string,
  request: PageRequest = {},
  scope = `chat:${agentId}`,
): ChatHistoryPage {
  if (typeof agentId !== "string" || !agentId) throw new Error("Invalid agent ID");
  const limit = pageLimit(request);
  const keys = decodeCursor(request.cursor, scope, 1);
  if (keys && (!Number.isSafeInteger(keys[0]) || Number(keys[0]) < 1))
    throw new Error("Invalid history cursor");
  const watermark = projectChatHistory(db, agentId);
  const before = keys ? Number(keys[0]) : watermark + 1;
  const rows = db
    .prepare(
      "SELECT seq,payload FROM chat_messages WHERE agent_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
    )
    .iterate(agentId, before, limit + 1) as Iterable<{ seq: number; payload: string }>;
  const total = (
    db.prepare("SELECT count(*) AS n FROM chat_messages WHERE agent_id=?").get(agentId) as {
      n: number;
    }
  ).n;
  const items: (ChatMessage & { sequence: number })[] = [];
  let bytes = Buffer.byteLength(JSON.stringify({
    items: [], total, watermark, nextCursor: encodeCursor(scope, [before]),
  }));
  let last: number | undefined;
  let more = false;
  for (const row of rows) {
    if (items.length === limit) {
      more = true;
      break;
    }
    const size = Buffer.byteLength(row.payload) + Buffer.byteLength(JSON.stringify({ sequence: row.seq }));
    if (size > 4 * 1024 * 1024 || (items.length === 0 && bytes + size > 4 * 1024 * 1024))
      throw new Error(
        "Transcript message exceeds the 4 MiB page budget; use the full transcript export",
      );
    if (bytes + size > 4 * 1024 * 1024) {
      more = true;
      break;
    }
    bytes += size;
    items.push({ ...JSON.parse(row.payload), sequence: row.seq });
    last = row.seq;
  }
  if (!keys) {
    const ids = new Set(items.map(message => message.id));
    const pending = db.prepare(`SELECT id,seq,payload FROM chat_messages WHERE agent_id=?
      AND kind IN ('approval','elicitation') AND json_extract(payload,'$.responded')=0 ORDER BY seq`)
      .iterate(agentId) as Iterable<{ id: string; seq: number; payload: string }>;
    for (const row of pending) {
      if (ids.has(row.id)) continue;
      bytes += Buffer.byteLength(row.payload) + Buffer.byteLength(JSON.stringify({ sequence: row.seq }));
      if (bytes > 4 * 1024 * 1024) throw new Error("Pending interactions exceed the 4 MiB transcript page budget");
      items.push({ ...JSON.parse(row.payload), sequence: row.seq });
    }
  }
  return {
    items: items.sort((a, b) => a.sequence - b.sequence),
    total,
    watermark,
    nextCursor: more && last !== undefined ? encodeCursor(scope, [last]) : null,
  };
}
