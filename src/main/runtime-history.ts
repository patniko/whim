import Database from "better-sqlite3";
import {
  createChatProjection,
  projectChatHistory,
  queryChatHistoryPage,
} from "./chat-history-page";
import type { PageRequest } from "../shared/paging";

export interface RuntimeHistoryEvent {
  id: string;
  type: string;
  timestamp: string;
  payload: string;
}

interface History {
  db: Database.Database;
  sessionId: string;
  cursor?: string;
  seq: number;
}

/** Worker-owned disposable projections. Ephemeral sessions never touch disk. */
export class RuntimeHistory {
  private histories = new Map<string, History>();

  open(agentId: string, sessionId: string, ephemeral: boolean): string | undefined {
    const existing = this.histories.get(agentId);
    if (existing?.sessionId === sessionId) {
      this.histories.delete(agentId);
      this.histories.set(agentId, existing);
      return existing.cursor;
    }
    if (existing) this.remove(agentId);
    while (this.histories.size >= 8) this.remove(this.histories.keys().next().value!);
    // SQLite owns and removes an unnamed temporary database on close. Unlike
    // :memory:, the normal-session projection has a bounded page cache.
    const db = new Database(ephemeral ? ":memory:" : "");
    try {
      db.pragma("cache_size = -2048");
      db.pragma(`temp_store = ${ephemeral ? "MEMORY" : "FILE"}`);
      db.exec(`CREATE TABLE agent_chat_events (
        agent_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL,
        type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(agent_id, seq), UNIQUE(agent_id, event_id)
      )`);
      createChatProjection(db);
      this.histories.set(agentId, { db, sessionId, seq: 0 });
    } catch (error) {
      db.close();
      throw error;
    }
    return undefined;
  }

  append(agentId: string, sessionId: string, events: RuntimeHistoryEvent[], cursor: string): void {
    const history = this.get(agentId, sessionId);
    if (events.length > 32 || !cursor) throw new Error("Invalid runtime history batch");
    let bytes = 0;
    for (const event of events) {
      bytes += Buffer.byteLength(event.payload);
      if (!event.id || !event.type || !event.timestamp || bytes > 16 * 1024 * 1024)
        throw new Error("Runtime history batch exceeds its identity or 16 MiB budget");
    }
    let seq = history.seq;
    history.db.transaction(() => {
      const insert = history.db.prepare(`INSERT INTO agent_chat_events
        (agent_id,seq,event_id,type,timestamp,payload) VALUES (?,?,?,?,?,?)
        ON CONFLICT(agent_id,event_id) DO NOTHING`);
      for (const event of events) {
        const result = insert.run(
          agentId,
          seq + 1,
          event.id,
          event.type,
          event.timestamp,
          event.payload,
        );
        if (result.changes) seq++;
      }
      // Normalize every bounded batch so the final read does not monopolize
      // the persistence worker for a whole legacy transcript.
      projectChatHistory(history.db, agentId);
    })();
    history.seq = seq;
    history.cursor = cursor;
  }

  page(agentId: string, sessionId: string, request: PageRequest = {}) {
    const result = queryChatHistoryPage(this.get(agentId, sessionId).db, agentId, request, `runtime:${agentId}:${sessionId}`);
    // Runtime event ordinals are not durable mirror ordinals. Identified
    // messages reconcile live overlap; never suppress live mirror events
    // using an unrelated sequence domain.
    return { ...result, watermark: 0 };
  }

  remove(agentId: string): void {
    this.histories.get(agentId)?.db.close();
    this.histories.delete(agentId);
  }

  close(): void {
    for (const agentId of this.histories.keys()) this.remove(agentId);
  }

  private get(agentId: string, sessionId: string): History {
    const history = this.histories.get(agentId);
    if (!history || history.sessionId !== sessionId)
      throw new Error("Runtime history expired; reopen the conversation to reload it");
    return history;
  }
}
