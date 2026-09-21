import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createPersistenceSchema } from "./persistence-schema";
import { createQueryIndexes } from "./query-index";
import { queryChatHistoryPage } from "./chat-history-page";
import { acknowledgeUserMessage } from "../shared/chat-identity";

let db: Database.Database;
let sequence: number;
beforeEach(() => {
  db = new Database(":memory:");
  createPersistenceSchema(db);
  createQueryIndexes(db);
  sequence = 0;
});
afterEach(() => db.close());
function append(type: string, payload: object, agent = "agent") {
  sequence++;
  db.prepare(
    "INSERT INTO agent_chat_events(agent_id,seq,event_id,type,timestamp,payload) VALUES (?,?,?,?,?,?)",
  ).run(agent, sequence, `e${sequence}`, type, "2026-01-01", JSON.stringify(payload));
}

describe("durable normalized transcript pages", () => {
  it("includes outstanding stored controls even before the newest ordinary page", () => {
    append("permission.requested", { requestId: "approval", permissionRequest: { kind: "write" } });
    append("elicitation.requested", { requestId: "question", message: "Synthetic question" });
    for (let i = 0; i < 100; i++) append("assistant.message", { messageId: String(i), content: "Answer" });
    const page = queryChatHistoryPage(db, "agent", { limit: 5 });
    expect(page.items.map(message => message.type)).toEqual(["approval", "elicitation", ...Array(5).fill("assistant")]);
    expect(page.items.map(message => message.sequence)).toEqual([1, 2, 98, 99, 100, 101, 102]);
    expect(page.total).toBe(102);
    const older = queryChatHistoryPage(db, "agent", { limit: 5, cursor: page.nextCursor! });
    expect(older.items.map(message => message.sequence)).toEqual([93, 94, 95, 96, 97]);
  });
  it("does not turn empty SDK bookkeeping messages into visible transcript rows", () => {
    append("assistant.message", { messageId: "empty", content: "" });
    append("assistant.reasoning", { reasoningId: "empty", content: "" });
    append("user.message", { content: "" });
    expect(queryChatHistoryPage(db, "agent")).toEqual({
      items: [],
      total: 0,
      watermark: 3,
      nextCursor: null,
    });
  });
  it("pages chronologically, keeps persistent IDs, exact counts and excludes usage payloads", () => {
    db.transaction(() => {
      for (let i = 0; i < 1000; i++) {
        append("assistant.message", { messageId: String(i), content: `Message ${i}` });
        append("assistant.usage", { inputTokens: 1000 });
      }
    })();
    const page = queryChatHistoryPage(db, "agent", { limit: 20 });
    expect(page.total).toBe(1000);
    expect(page.watermark).toBe(2000);
    expect(page.items.map((row) => row.id)).toEqual(
      Array.from({ length: 20 }, (_, i) => `assistant:${980 + i}`),
    );
    const next = queryChatHistoryPage(db, "agent", { cursor: page.nextCursor!, limit: 20 });
    expect(next.items[19].id).toBe("assistant:979");
    expect(queryChatHistoryPage(db, "agent", { limit: 20 })).toEqual(page);
    expect(() => queryChatHistoryPage(db, "other", { cursor: page.nextCursor! })).toThrow();
  });
  it("retains tool and permission completions across arbitrary page boundaries", () => {
    append("tool.execution_start", { toolCallId: "tool", toolName: "view" });
    append("permission.requested", { requestId: "request", permissionRequest: { kind: "read" } });
    for (let i = 0; i < 30; i++)
      append("assistant.message", { messageId: String(i), content: String(i) });
    append("tool.execution_complete", {
      toolCallId: "tool",
      success: true,
      result: { content: "done" },
    });
    append("permission.completed", { requestId: "request", result: { kind: "approve-once" } });
    const page = queryChatHistoryPage(db, "agent", { limit: 30 });
    const older = queryChatHistoryPage(db, "agent", { cursor: page.nextCursor! });
    expect(older.items).toMatchObject([
      { type: "tool_call", toolCallId: "tool", completed: true, result: "done" },
      { type: "approval", requestId: "request", responded: true, approved: true },
    ]);
  });
  it("correlates SDK permission completions independently from actionable broker IDs", () => {
    append("permission.requested", {
      requestId: "rpc-first", permissionRequest: { toolCallId: "tool-first", kind: "write" },
    });
    append("permission.requested", {
      requestId: "rpc-second", permissionRequest: { toolCallId: "tool-second", kind: "write" },
    });
    expect(queryChatHistoryPage(db, "agent").items).toMatchObject([
      { requestId: "tool-first", responded: false },
      { requestId: "tool-second", responded: false },
    ]);
    append("permission.completed", { requestId: "rpc-first", result: { kind: "approve-once" } });
    expect(queryChatHistoryPage(db, "agent").items).toMatchObject([
      { requestId: "tool-first", responded: true, approved: true },
      { requestId: "tool-second", responded: false },
    ]);
    append("permission.completed", { requestId: "rpc-second", result: { kind: "reject" } });
    expect(queryChatHistoryPage(db, "agent").items).toMatchObject([
      { requestId: "tool-first", responded: true, approved: true },
      { requestId: "tool-second", responded: true, approved: false },
    ]);
  });
  it("applies only the suffix after a read and invalidates projections on transcript deletion", () => {
    append("tool.execution_start", { toolCallId: "tool", toolName: "view" });
    expect(queryChatHistoryPage(db, "agent").items[0]).toMatchObject({ completed: false });
    append("tool.execution_complete", { toolCallId: "tool", success: false, result: "failed" });
    expect(queryChatHistoryPage(db, "agent").items[0]).toMatchObject({
      completed: true,
      success: false,
    });
    db.prepare("DELETE FROM agent_chat_events WHERE agent_id=?").run("agent");
    expect(queryChatHistoryPage(db, "agent")).toEqual({
      items: [],
      total: 0,
      watermark: 0,
      nextCursor: null,
    });
  });
  it("bounds returned bytes without dropping messages", () => {
    for (let i = 0; i < 6; i++)
      append("assistant.message", { messageId: String(i), content: "x".repeat(1024 * 1024) });
    const page = queryChatHistoryPage(db, "agent");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4 * 1024 * 1024);
    expect(page.items).toHaveLength(3);
    const older = queryChatHistoryPage(db, "agent", { cursor: page.nextCursor! });
    expect(older.items.map((row) => row.id)).toEqual(["assistant:0", "assistant:1", "assistant:2"]);
    expect(older.nextCursor).toBeNull();
  });
  it("fails explicitly for corrupt payloads without stamping a successful projection", () => {
    db.prepare(
      "INSERT INTO agent_chat_events(agent_id,seq,type,timestamp,payload) VALUES ('agent',1,'assistant.message','t','invalid')",
    ).run();
    expect(() => queryChatHistoryPage(db, "agent")).toThrow();
    expect(db.prepare("SELECT * FROM chat_projection").all()).toEqual([]);
  });
  it("reconciles send acknowledgements on either side of the history response", () => {
    append("user.message", { messageId: "sdk-id", content: "hello" });
    const canonical = queryChatHistoryPage(db, "agent").items[0];
    expect(canonical.id).toBe("user:sdk-id");
    const local = { ...canonical, id: "local" };
    expect(acknowledgeUserMessage([local, canonical], "local", "sdk-id")).toEqual([canonical]);
    expect(acknowledgeUserMessage([local], "local", "sdk-id")).toEqual([canonical]);
  });
});
