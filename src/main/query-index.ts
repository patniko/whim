import type Database from "better-sqlite3";
import { createChatProjection } from "./chat-history-page";

/** Probe the actual linked SQLite, not its version string or compile flags. */
export function verifySearchCapabilities(db: Database.Database): void {
  db.function("whim_lower", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? value.toLowerCase() : "",
  );
  db.exec("CREATE VIRTUAL TABLE temp.whim_fts_probe USING fts5(value, tokenize='trigram')");
  try {
    db.prepare("INSERT INTO temp.whim_fts_probe(value) VALUES (?)").run("Alpha substring ÄBC");
    const row = db
      .prepare("SELECT count(*) AS n FROM temp.whim_fts_probe WHERE value LIKE '%PHA%'")
      .get() as { n: number };
    if (row.n !== 1) throw new Error("SQLite trigram LIKE support is required");
  } finally {
    db.exec("DROP TABLE temp.whim_fts_probe");
  }
}

export function createQueryIndexes(db: Database.Database): void {
  verifySearchCapabilities(db);
  createChatProjection(db);
  db.exec(`
    CREATE INDEX idx_spaces_order ON spaces(
      (status = 'done'), (status != 'in_progress'), (due_at_utc IS NULL),
      COALESCE(due_at_utc, ''), updated_at DESC, id);
    CREATE INDEX idx_spaces_updated ON spaces(updated_at DESC, id);
    CREATE INDEX idx_spaces_status ON spaces(status);
    CREATE INDEX idx_spaces_completed ON spaces(status, COALESCE(completed_at, updated_at) DESC, id);
    CREATE INDEX idx_spaces_skill_created ON spaces(source_skill_id, created_at DESC, id);
    CREATE INDEX idx_space_events_time ON space_events(created_at DESC, id);
    CREATE INDEX idx_space_events_space_time ON space_events(space_id, created_at DESC, id);
    CREATE INDEX idx_agent_sessions_created ON agent_sessions(created_at DESC, id);
    CREATE INDEX idx_agent_sessions_space_status ON agent_sessions(space_id, status);
    CREATE INDEX idx_agent_sessions_status_time ON agent_sessions(status, updated_at);
    CREATE INDEX idx_agent_chat_event_identity ON agent_chat_events(agent_id, event_id);
    CREATE INDEX idx_agent_chat_type_time ON agent_chat_events(type, timestamp, agent_id);
    CREATE INDEX idx_agent_chat_agent_type_seq ON agent_chat_events(agent_id, type, seq);
    CREATE INDEX idx_subagent_started ON subagent_records(started_at);
    CREATE INDEX idx_subagent_parent ON subagent_records(parent_agent_id, started_at);
    CREATE VIRTUAL TABLE agent_search USING fts5(prompt, summary, tokenize='trigram');
    CREATE TRIGGER agents_search_insert AFTER INSERT ON agent_sessions BEGIN
      INSERT INTO agent_search(rowid,prompt,summary) VALUES(new.rowid,whim_lower(new.prompt),whim_lower(new.summary));
    END;
    CREATE TRIGGER agents_search_delete AFTER DELETE ON agent_sessions BEGIN
      DELETE FROM agent_search WHERE rowid=old.rowid;
    END;
    CREATE TRIGGER agents_search_update AFTER UPDATE OF prompt,summary ON agent_sessions BEGIN
      DELETE FROM agent_search WHERE rowid=old.rowid;
      INSERT INTO agent_search(rowid,prompt,summary) VALUES(new.rowid,whim_lower(new.prompt),whim_lower(new.summary));
    END;
    INSERT INTO agent_search(rowid,prompt,summary) SELECT rowid,whim_lower(prompt),whim_lower(summary) FROM agent_sessions;
    CREATE VIRTUAL TABLE space_search USING fts5(
      description, body, canvas_content, content='spaces', content_rowid='rowid',
      tokenize='trigram');
    CREATE TRIGGER spaces_search_insert AFTER INSERT ON spaces BEGIN
      INSERT INTO space_search(rowid, description, body, canvas_content)
      VALUES (new.rowid, new.description, new.body, new.canvas_content);
    END;
    CREATE TRIGGER spaces_search_delete AFTER DELETE ON spaces BEGIN
      INSERT INTO space_search(space_search, rowid, description, body, canvas_content)
      VALUES ('delete', old.rowid, old.description, old.body, old.canvas_content);
    END;
    CREATE TRIGGER spaces_search_update AFTER UPDATE OF description, body, canvas_content ON spaces BEGIN
      INSERT INTO space_search(space_search, rowid, description, body, canvas_content)
      VALUES ('delete', old.rowid, old.description, old.body, old.canvas_content);
      INSERT INTO space_search(rowid, description, body, canvas_content)
      VALUES (new.rowid, new.description, new.body, new.canvas_content);
    END;
    INSERT INTO space_search(space_search) VALUES ('rebuild');
  `);
}
