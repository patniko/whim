import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeHistoryPage, type HistorySession } from "./runtime-history-loader";
import * as storage from "../storage";

vi.mock("../storage", () => ({
  openRuntimeHistory: vi.fn(),
  appendRuntimeHistory: vi.fn(),
  queryRuntimeHistory: vi.fn(),
  assertWorkspaceContext: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(storage.openRuntimeHistory).mockResolvedValue(undefined);
  vi.mocked(storage.queryRuntimeHistory).mockResolvedValue({
    items: [],
    total: 0,
    nextCursor: null,
    watermark: 0,
  });
});

function session(read: HistorySession["rpc"]["eventLog"]["read"]): HistorySession {
  // The loader deliberately uses only this typed RPC surface.
  return { sessionId: "session", rpc: { eventLog: { read } } };
}

describe("cursor-based SDK history loading", () => {
  it("serializes bounded imports, shares concurrent reads, and never calls getEvents", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        events: [{ id: "e1", type: "assistant.message", timestamp: "t", data: { content: "one" } }],
        cursor: "first",
        hasMore: true,
      })
      .mockResolvedValueOnce({ events: [], cursor: "last", hasMore: false });
    const current = session(read);
    await Promise.all([
      loadRuntimeHistoryPage("agent", current, true),
      loadRuntimeHistoryPage("agent", current, true, { limit: 5 }),
    ]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith({
      cursor: "first",
      max: 32,
      includeEphemeral: false,
      waitMs: 0,
    });
    expect(storage.appendRuntimeHistory).toHaveBeenNthCalledWith(
      1,
      "agent",
      "session",
      [
        {
          id: "e1",
          type: "assistant.message",
          timestamp: "t",
          payload: '{"content":"one"}',
        },
      ],
      "first",
    );
    expect(storage.queryRuntimeHistory).toHaveBeenCalledTimes(2);
  });

  it("resumes from the acknowledged cursor after an RPC failure", async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockResolvedValueOnce({ events: [], cursor: "next", hasMore: false });
    const current = session(read);
    vi.mocked(storage.openRuntimeHistory).mockResolvedValue("saved");
    await expect(loadRuntimeHistoryPage("agent", current, false)).rejects.toThrow("disconnected");
    await loadRuntimeHistoryPage("agent", current, false);
    expect(read).toHaveBeenLastCalledWith({
      cursor: "saved",
      max: 32,
      includeEphemeral: false,
      waitMs: 0,
    });
  });

  it("rejects a stuck cursor and a replaced workspace instead of silently dropping history", async () => {
    vi.mocked(storage.openRuntimeHistory).mockResolvedValue("same");
    const read = vi.fn().mockResolvedValue({ events: [], cursor: "same", hasMore: true });
    await expect(loadRuntimeHistoryPage("agent", session(read), false)).rejects.toThrow(
      "did not advance",
    );
    vi.mocked(storage.assertWorkspaceContext).mockImplementationOnce(() => {
      throw new Error("Stale workspace");
    });
    await expect(loadRuntimeHistoryPage("agent", session(read), false)).rejects.toThrow(
      "Stale workspace",
    );
    expect(storage.appendRuntimeHistory).not.toHaveBeenCalled();
  });
});
