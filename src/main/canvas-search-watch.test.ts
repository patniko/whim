import { EventEmitter } from "events";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasSearchWatch } from "./canvas-search-watch";

const fixture = vi.hoisted(() => ({
  callbacks: [] as ((event: string, filename: string) => void)[],
}));
vi.mock("fs", () => ({
  watch: vi.fn((_root, _options, callback) => {
    fixture.callbacks.push(callback);
    return Object.assign(new EventEmitter(), { close: vi.fn() });
  }),
}));
beforeEach(() => {
  vi.useFakeTimers();
  fixture.callbacks = [];
});
afterEach(() => vi.useRealTimers());

describe("incremental canvas index notifications", () => {
  it("invalidates only a changed canvas and yields between bounded scan batches", async () => {
    const invalidate = vi.fn();
    const scan = vi.fn().mockReturnValueOnce({ cursor: "next" }).mockReturnValue({});
    const notify = vi.fn();
    const watcher = new CanvasSearchWatch(invalidate, scan, notify);
    watcher.start("/synthetic/workspace");
    fixture.callbacks[0]("change", "space/canvas.md");
    fixture.callbacks[0]("rename", "space/.whim-save-11111111-1111-4111-8111-111111111111");
    fixture.callbacks[0]("rename", "space/canvas.md");
    fixture.callbacks[0]("change", ".whim/events/a.jsonl");
    await vi.runAllTimersAsync();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(
      path.resolve("/synthetic/workspace/space/canvas.md"),
    );
    expect(scan.mock.calls).toEqual([
      ["/synthetic/workspace", undefined],
      ["/synthetic/workspace", "next"],
    ]);
    expect(notify).toHaveBeenCalledExactlyOnceWith();
    watcher.stop();
  });
  it("rescans directory moves but rejects notifications from a previous workspace", async () => {
    const invalidate = vi.fn();
    const scan = vi.fn().mockReturnValue({});
    const watcher = new CanvasSearchWatch(invalidate, scan, vi.fn());
    watcher.start("/synthetic/old");
    watcher.start("/synthetic/new");
    fixture.callbacks[0]("rename", "space");
    await vi.runAllTimersAsync();
    expect(scan).not.toHaveBeenCalled();
    fixture.callbacks[1]("rename", ".whim/archive");
    await vi.runAllTimersAsync();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith();
    watcher.stop();
  });
  it("surfaces indexing failures instead of leaking an unhandled timer error", async () => {
    const notify = vi.fn();
    const watcher = new CanvasSearchWatch(
      () => {
        throw new Error("Index unavailable");
      },
      vi.fn(),
      notify,
    );
    watcher.start("/synthetic/workspace");
    fixture.callbacks[0]("change", "space/canvas.md");
    await vi.runAllTimersAsync();
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "Canvas search indexing failed: Index unavailable",
    );
    watcher.stop();
  });
});
