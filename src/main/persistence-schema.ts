import Database from 'better-sqlite3';

/** Log-backed entities only. Skills, canvas text and local session IDs have other authorities. */
export const SNAPSHOT_COLUMNS = {
  spaces: 'id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, source_skill_id, attachments, status, created_at, updated_at',
  space_events: 'id, space_id, event_type, due_at, due_at_utc, completed_at, recurrence_json, created_at',
  canvas_agents: 'id, space_id, selected_text, session_id, pid, status, created_at, updated_at',
  agent_sessions: 'id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at',
  agent_chat_events: 'agent_id, seq, event_id, type, timestamp, payload',
  subagent_records: 'id, parent_agent_id, tool_call_id, agent_name, display_name, description, agent_type, status, started_at, completed_at, duration_ms, model, total_tokens, total_tool_calls, error, streaming_content, streaming_content_path, turns_json, turns_path, progress_json, created_at, updated_at',
  subagent_tool_calls: 'subagent_id, parent_agent_id, tool_call_id, tool_name, arguments_json, result, result_path, success, error, started_at, completed_at, created_at',
} as const;

export type SnapshotTable = keyof typeof SNAPSHOT_COLUMNS;

export const SNAPSHOT_OPERATIONS: Record<SnapshotTable, string> = {
  spaces: 'space.create',
  space_events: 'intent_event.log',
  canvas_agents: 'canvas_agent.created',
  agent_sessions: 'agent_session.created',
  agent_chat_events: 'agent_chat.appended',
  subagent_records: 'subagent.created',
  subagent_tool_calls: 'subagent_tool.created',
};

export function createPersistenceSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT, raw_text TEXT,
      client TEXT, due_at TEXT, due_at_utc TEXT, recurrence TEXT,
      completed_at TEXT, folder TEXT, session_id TEXT, source_skill_id TEXT,
      attachments TEXT DEFAULT '[]', canvas_content TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'captured',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE canvas_agents (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, selected_text TEXT NOT NULL,
      session_id TEXT NOT NULL, pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, space_id TEXT,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      summary TEXT DEFAULT '', working_dir TEXT,
      source TEXT NOT NULL DEFAULT 'sdk', persona_handle TEXT,
      quoted_text TEXT, comment_thread_id TEXT,
      run_location TEXT NOT NULL DEFAULT 'local',
      cca_job_id TEXT, cca_repository TEXT, cca_effective_repository TEXT,
      cca_fallback_json TEXT, cca_result_json TEXT,
      yolo_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_chat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT,
      type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(agent_id, seq)
    );
    CREATE INDEX idx_agent_chat_events_agent_seq ON agent_chat_events(agent_id, seq);
    CREATE TABLE space_events (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, event_type TEXT NOT NULL,
      due_at TEXT, due_at_utc TEXT, completed_at TEXT, recurrence_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    );
    CREATE TABLE subagent_records (
      id TEXT PRIMARY KEY, parent_agent_id TEXT NOT NULL,
      tool_call_id TEXT, agent_name TEXT NOT NULL,
      display_name TEXT, description TEXT, agent_type TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER,
      model TEXT, total_tokens INTEGER, total_tool_calls INTEGER,
      error TEXT, streaming_content TEXT DEFAULT '', streaming_content_path TEXT,
      turns_json TEXT DEFAULT '[]', turns_path TEXT, progress_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE subagent_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subagent_id TEXT NOT NULL, parent_agent_id TEXT NOT NULL,
      tool_call_id TEXT, tool_name TEXT NOT NULL,
      arguments_json TEXT, result TEXT, result_path TEXT,
      success INTEGER DEFAULT 1, error TEXT,
      started_at INTEGER, completed_at INTEGER, created_at TEXT NOT NULL,
      FOREIGN KEY (subagent_id) REFERENCES subagent_records(id)
    );
  `);
}
