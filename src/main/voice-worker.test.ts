import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { build } from "esbuild";
import { performance } from "perf_hooks";

const fixture = vi.hoisted(() => ({ worker: "", created: 0 }));
vi.mock("electron", () => ({
  app: { getPath: () => path.join(os.tmpdir(), "unused-voice-cache") },
}));
vi.mock("worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(_file: string | URL, options?: import("worker_threads").WorkerOptions) {
        super(fixture.worker, options);
        fixture.created++;
      }
    },
  };
});
import { preloadModel, shutdownVoice, transcribeAudio } from "./voice";

let directory: string;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "whim-voice-worker-"));
  fixture.worker = path.join(directory, "worker.cjs");
  await build({
    entryPoints: [path.resolve("src/main/voice-worker.ts")],
    outfile: fixture.worker,
    bundle: true,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "synthetic-speech",
        setup(context) {
          context.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
            path: "fixture",
            namespace: "speech",
          }));
          context.onLoad({ filter: /.*/, namespace: "speech" }, () => ({
            contents: `export async function pipeline() {
            return async audio => {
              if (audio[0] === -42) process.exit(9);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
              if (audio[0] === -1) throw new Error('Synthetic inference failure');
              return {text: ' sample ' + audio[0] + ' '};
            };
          }`,
          }));
        },
      },
    ],
  });
});
afterEach(() => shutdownVoice());
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("off-main speech", () => {
  it("does not create a worker on preload and keeps the main loop responsive during inference", async () => {
    const created = fixture.created;
    preloadModel();
    expect(fixture.created).toBe(created);
    let ticks = 0;
    const start = performance.now();
    const timer = setInterval(() => {
      ticks++;
    }, 10);
    try {
      expect(await transcribeAudio(new Float32Array([2]))).toBe("sample 2");
      expect(performance.now() - start).toBeGreaterThanOrEqual(120);
      expect(ticks).toBeGreaterThanOrEqual(5);
    } finally {
      clearInterval(timer);
    }
  });

  it("bounds admission and rejects invalid samples without poisoning later requests", async () => {
    const pending = Array.from({ length: 5 }, (_, i) => transcribeAudio([i]));
    await expect(transcribeAudio([6])).rejects.toThrow("busy");
    expect(await Promise.all(pending)).toEqual([
      "sample 0",
      "sample 1",
      "sample 2",
      "sample 3",
      "sample 4",
    ]);
    await expect(transcribeAudio([])).rejects.toThrow("PCM");
    await expect(transcribeAudio([NaN])).rejects.toThrow("invalid samples");
    await expect(transcribeAudio([-1])).rejects.toThrow("Synthetic inference failure");
    expect(await transcribeAudio([7])).toBe("sample 7");
  });

  it("rejects admitted requests on worker failure and restarts on explicit retry", async () => {
    await expect(transcribeAudio([-42])).rejects.toThrow("exited (9)");
    expect(await transcribeAudio([3])).toBe("sample 3");
  });
});
