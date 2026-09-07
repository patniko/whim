import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createPersistenceSchema } from "./persistence-schema";
import { createQueryIndexes, verifySearchCapabilities } from "./query-index";
import {
  querySpacePage,
  querySpaceEventPage,
  queryAgentPage,
  queryActivityPage,
} from "./paged-queries";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("recursive_triggers = ON");
  createPersistenceSchema(db);
  createQueryIndexes(db);
});
afterEach(() => db.close());

function insert(id: string, text: string, status = "captured") {
  db.prepare(`INSERT INTO spaces(id,description,body,raw_text,status,created_at,updated_at)
    VALUES (?,?,?,?,?,'2026-01-01','2026-01-02')`).run(
    id,
    text,
    `${text} document`,
    "private raw",
    status,
  );
}

describe("bounded summary queries", () => {
  it("probes the linked native trigram implementation", () => {
    expect(() => verifySearchCapabilities(db)).not.toThrow();
  });
  it("pages 1000 rows once each with exact counts and no document fields", () => {
    db.transaction(() => {
      for (let i = 0; i < 1000; i++)
        insert(String(i).padStart(4, "0"), `Space ${i}`, i < 10 ? "done" : "captured");
    })();
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = querySpacePage(db, { cursor, limit: 37 });
      expect(page.offset).toBe(ids.length);
      expect(page.total).toBe(1000);
      expect(page.counts).toEqual({ open: 990, closed: 10, scheduled: 0, recurring: 0 });
      expect(page.items.length).toBeLessThanOrEqual(37);
      page.items.forEach((row) => {
        expect(row).not.toHaveProperty("body");
        expect(row).not.toHaveProperty("raw_text");
        expect(row).not.toHaveProperty("canvas_content");
        expect(row).not.toHaveProperty("attachments");
      });
      ids.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(1000);
    expect(ids.slice(-10)).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i).padStart(4, "0")),
    );
  });
  it("keeps exact SQLite case, substring and wildcard semantics", () => {
    ["Alpha abc", "älpha ÄBC", "100%_real", "xxxyyy", "a\nb", "under_score", "abc\0def"].forEach(
      (text, i) => insert(String(i), text),
    );
    for (const query of [
      "PHA",
      "ä",
      "ÄBC",
      "%",
      "_",
      "a_b",
      "xxy",
      "er_",
      "a\nb",
      "100%_",
      "abc\0def",
    ]) {
      const pattern = `%${query}%`;
      const legacy = db
        .prepare(
          "SELECT id FROM spaces WHERE description LIKE ? OR body LIKE ? OR canvas_content LIKE ? ORDER BY updated_at DESC,id",
        )
        .all(pattern, pattern, pattern);
      expect(querySpacePage(db, { query }).items.map((row) => ({ id: row.id }))).toEqual(legacy);
    }
  });
  it("reconciles canvas/title edits, replacement, archive and deletion", () => {
    insert("s", "Before");
    db.prepare("UPDATE spaces SET canvas_content = ? WHERE id = ?").run("External needle", "s");
    expect(querySpacePage(db, { query: "needle" }).total).toBe(1);
    db.prepare("UPDATE spaces SET canvas_content = '', status = 'done' WHERE id = 's'").run();
    expect(querySpacePage(db, { query: "needle" }).total).toBe(0);
    expect(querySpacePage(db, { filter: "closed" }).total).toBe(1);
    db.prepare(
      "INSERT OR REPLACE INTO spaces(id,description,created_at,updated_at) VALUES ('s','Replacement','t','t')",
    ).run();
    expect(querySpacePage(db, { query: "Before" }).total).toBe(0);
    expect(querySpacePage(db, { query: "Replacement" }).total).toBe(1);
    db.prepare("DELETE FROM spaces WHERE id = 's'").run();
    expect(querySpacePage(db, { query: "Replacement" }).total).toBe(0);
  });
  it("rejects invalid limits and cross-query cursors", () => {
    insert("a", "one");
    insert("b", "two");
    const cursor = querySpacePage(db, { limit: 1 }).nextCursor!;
    expect(() => querySpacePage(db, { cursor, filter: "closed" })).toThrow();
    for (const limit of [0, -1, 101, Infinity, 1.2])
      expect(() => querySpacePage(db, { limit })).toThrow();
  });
  it("pages equal-time history events with deterministic IDs", () => {
    insert("gone", "History space");
    for (const id of ["a", "b", "c"])
      db.prepare(
        "INSERT INTO space_events(id,space_id,event_type,created_at) VALUES (?,'gone','completed','t')",
      ).run(id);
    const first = querySpaceEventPage(db, { limit: 2 });
    expect(first.total).toBe(3);
    expect(
      querySpaceEventPage(db, { cursor: first.nextCursor!, limit: 2 }).items.map((row) => row.id),
    ).toEqual(["c"]);
  });
  it("searches worker previews using full indexed text with literal Unicode substring semantics", () => {
    const insert =
      db.prepare(`INSERT INTO agent_sessions(id,session_id,prompt,summary,status,created_at,updated_at)
      VALUES (?, 'session', ?, ?, 'running', 't', 't')`);
    insert.run("a", "x".repeat(1000) + "ÄBC %_ literal", "summary");
    insert.run("b", "other", "a long summary");
    for (const query of ["äbc", "%_", "summary", "xxx"]) {
      const page = queryAgentPage(db, { query });
      const expected = db
        .prepare("SELECT id,prompt,summary FROM agent_sessions ORDER BY id")
        .all() as { id: string; prompt: string; summary: string }[];
      expect(page.items.map((item) => item.id)).toEqual(
        expected
          .filter(
            (row) =>
              row.prompt.toLowerCase().includes(query) || row.summary.toLowerCase().includes(query),
          )
          .map((row) => row.id),
      );
      page.items.forEach((row) => expect(row.prompt.length).toBeLessThanOrEqual(160));
    }
    expect(queryAgentPage(db, { limit: 1 }).counts.running).toBe(2);
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT seq FROM agent_chat_events WHERE agent_id=? AND event_id=?",
      )
      .all("a", "b");
    expect(JSON.stringify(plan)).toContain("idx_agent_chat_event_identity");
  });
  it("counts closed spaces once, and keeps loose activity independent of loaded space pages", () => {
    insert("closed", "Closed", "done");
    insert("open", "Open");
    const event = db.prepare(
      "INSERT INTO space_events(id,space_id,event_type,created_at) VALUES (?,?,'recycled','2026-01-03')",
    );
    event.run("one", "closed");
    event.run("two", "closed");
    event.run("three", "open");
    const first = queryActivityPage(db, { limit: 1 });
    expect(first.total).toBe(2);
    expect(first.items[0]).toMatchObject({ kind: "event", key: "event-three" });
    const next = queryActivityPage(db, { cursor: first.nextCursor! });
    expect(next.offset).toBe(1);
    expect(next.items[0]).toMatchObject({ kind: "space", key: "space-closed", rescheduled: 2 });
  });
  it("includes canvas-page workers without depending on the global worker page", () => {
    const write =
      db.prepare(`INSERT INTO agent_sessions(id,session_id,space_id,prompt,summary,status,created_at,updated_at)
      VALUES (?,'session',?,'prompt','summary','running','t','t')`);
    write.run("a", "other");
    write.run("b", "canvas");
    write.run("c", "__page__canvas/page");
    write.run("d", "__page__canvas-other/page");
    const first = queryAgentPage(db, { spaceId: "canvas", includePages: true, limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual(["b"]);
    expect(first.total).toBe(2);
    const next = queryAgentPage(db, {
      spaceId: "canvas",
      includePages: true,
      cursor: first.nextCursor!,
    });
    expect(next.items.map((row) => row.id)).toEqual(["c"]);
    expect(next.offset).toBe(1);
    expect(() => queryAgentPage(db, { spaceId: "canvas", cursor: first.nextCursor! })).toThrow();
  });
  it("returns global closed counts using the client local-day boundaries, not the current page", () => {
    insert("older", "Older", "done");
    insert("today", "Today", "done");
    db.prepare("UPDATE spaces SET completed_at=? WHERE id=?").run(
      "2026-01-02T07:59:00.000Z",
      "older",
    );
    db.prepare("UPDATE spaces SET completed_at=? WHERE id=?").run(
      "2026-01-02T08:01:00.000Z",
      "today",
    );
    const page = queryActivityPage(db, {
      limit: 1,
      dayStart: "2026-01-02T08:00:00.000Z",
      weekStart: "2025-12-28T08:00:00.000Z",
    });
    expect(page.items).toHaveLength(1);
    expect(page.closedCounts).toEqual({ today: 1, week: 2, total: 2 });
    expect(() => queryActivityPage(db, { dayStart: "not-a-date" })).toThrow();
  });
  it("measures bounded summary payloads at 1000 spaces without document transfer", () => {
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) insert(String(i), `Synthetic ${i}`);
    })();
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const page = querySpacePage(db, { limit: 60 });
      samples.push(performance.now() - start);
      bytes = Buffer.byteLength(JSON.stringify(page));
      expect(page.items).toHaveLength(60);
      expect(page.total).toBe(1000);
    }
    const p95 = samples.sort((a, b) => a - b)[28];
    expect(p95).toBeLessThan(50);
    expect(bytes).toBeLessThan(100 * 1024);
    console.info("[perf:summary-fixture]", {
      rows: 1000,
      returned: 60,
      samples: 30,
      p95Ms: p95,
      bytes,
    });
  });
});
