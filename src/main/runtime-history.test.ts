import { afterEach, describe, expect, it } from "vitest";
import { RuntimeHistory, type RuntimeHistoryEvent } from "./runtime-history";

const history = new RuntimeHistory();
afterEach(() => history.close());
function event(
  id: number,
  type = "assistant.message",
  data: object = { messageId: String(id), content: `Message ${id}` },
): RuntimeHistoryEvent {
  return { id: String(id), type, timestamp: "2026-09-07", payload: JSON.stringify(data) };
}

describe.each([false, true])("bounded runtime history (ephemeral=%s)", (ephemeral) => {
  it("normalizes batches, pages older messages and retains cross-page completions", () => {
    expect(history.open("agent", "session", ephemeral)).toBeUndefined();
    history.append(
      "agent",
      "session",
      [
        event(1, "tool.execution_start", { toolCallId: "tool", toolName: "view" }),
        event(2, "permission.requested", { requestId: "request", kind: "write" }),
        event(3, "elicitation.requested", { requestId: "question", message: "Choose" }),
      ],
      "3",
    );
    for (let offset = 4; offset < 1004; offset += 20)
      history.append(
        "agent",
        "session",
        Array.from({ length: 20 }, (_, i) => event(offset + i)),
        String(offset + 19),
      );
    history.append(
      "agent",
      "session",
      [
        event(1004, "tool.execution_complete", {
          toolCallId: "tool",
          success: true,
          result: "done",
        }),
        event(1005, "permission.completed", {
          requestId: "request",
          result: { kind: "approve-once" },
        }),
      ],
      "1005",
    );
    expect(history.open("agent", "session", ephemeral)).toBe("1005");
    const first = history.page("agent", "session", { limit: 20 });
    expect(first.items).toHaveLength(21);
    expect(first.items[0]).toMatchObject({ type: "elicitation", responded: false });
    expect(first.total).toBe(1003);
    expect(first.watermark).toBe(0);
    let page = first;
    while (page.nextCursor)
      page = history.page("agent", "session", { cursor: page.nextCursor, limit: 100 });
    expect(page.items.slice(0, 2)).toMatchObject([
      { type: "tool_call", completed: true, result: "done" },
      { type: "approval", responded: true, approved: true },
    ]);
    history.append("agent", "session", [event(1003)], "1005");
    expect(history.page("agent", "session").total).toBe(1003);
  });

  it("rolls back corrupt batches without advancing the cursor or losing prior content", () => {
    history.open("agent", "session", ephemeral);
    history.append("agent", "session", [event(1)], "one");
    expect(() =>
      history.append("agent", "session", [event(2), { ...event(3), payload: "invalid" }], "bad"),
    ).toThrow();
    expect(history.open("agent", "session", ephemeral)).toBe("one");
    expect(history.page("agent", "session").total).toBe(1);
    history.append("agent", "session", [event(2)], "two");
    expect(history.page("agent", "session").total).toBe(2);
  });

  it("rejects oversized batches and invalidates replaced sessions", () => {
    history.open("agent", "session", ephemeral);
    expect(() =>
      history.append(
        "agent",
        "session",
        Array.from({ length: 33 }, (_, i) => event(i)),
        "large",
      ),
    ).toThrow("batch");
    history.append("agent", "session", [event(1)], "one");
    history.append("agent", "session", [event(2)], "two");
    const cursor = history.page("agent", "session", { limit: 1 }).nextCursor!;
    history.open("agent", "replacement", ephemeral);
    expect(() => history.page("agent", "session")).toThrow("expired");
    expect(() => history.page("agent", "replacement", { cursor })).toThrow("cursor");
    expect(history.page("agent", "replacement").items).toEqual([]);
  });
});
