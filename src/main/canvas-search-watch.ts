import * as fs from "fs";
import * as path from "path";

/** One watcher per workspace, with bounded scan batches on the storage thread. */
export class CanvasSearchWatch {
  private watcher?: fs.FSWatcher;
  private root?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private scanning = false;
  private dirty = false;
  private allFiles = false;
  private changedFiles = new Set<string>();

  constructor(
    private readonly invalidate: (file?: string) => void,
    private readonly scan: (root: string, cursor?: string) => { cursor?: string },
    private readonly notify: (error?: string) => void,
  ) {}

  start(root: string): void {
    if (this.root === root) return;
    this.stop();
    const generation = this.generation;
    this.watcher = fs.watch(root, { recursive: true, persistent: false }, (event, filename) => {
      if (generation !== this.generation) return;
      // Directory renames include archive/unarchive and Git directory changes.
      if (event !== "rename" && filename && !String(filename).endsWith("canvas.md")) return;
      const relative = filename ? String(filename).replace(/\\/g, "/") : "";
      // Atomic publication also renames a temporary file; only the final canvas changed.
      if (/^\.whim-save-[0-9a-f-]{36}$/.test(path.basename(relative))) return;
      if (
        relative.startsWith(".git/") ||
        relative === ".git" ||
        (relative.startsWith(".whim/") &&
          relative !== ".whim/archive" &&
          !relative.startsWith(".whim/archive/"))
      )
        return;
      if (!relative.endsWith("canvas.md") || this.changedFiles.size >= 256) {
        this.allFiles = true;
        this.changedFiles.clear();
      } else if (!this.allFiles) {
        this.changedFiles.add(path.resolve(root, relative));
      }
      this.dirty = true;
      this.schedule();
    });
    this.root = root;
    this.watcher.on("error", (error) => {
      if (generation !== this.generation) return;
      this.stop();
      this.notify(`Canvas search watcher failed: ${error.message}`);
    });
  }

  private schedule(): void {
    if (this.timer || this.scanning || !this.root) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dirty = false;
      this.scanning = true;
      const step = (cursor?: string) => {
        if (generation !== this.generation || !this.root) return;
        try {
          if (cursor === undefined) {
            if (this.allFiles) this.invalidate();
            else for (const file of this.changedFiles) this.invalidate(file);
            this.allFiles = false;
            this.changedFiles.clear();
          }
          const next = this.scan(this.root, cursor).cursor;
          if (next) setImmediate(() => step(next));
          else {
            this.scanning = false;
            this.notify();
            if (this.dirty) this.schedule();
          }
        } catch (error) {
          this.scanning = false;
          this.notify(
            `Canvas search indexing failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (this.dirty) this.schedule();
        }
      };
      step();
    }, 250);
    this.timer.unref();
  }

  stop(): void {
    this.generation++;
    this.watcher?.close();
    this.watcher = undefined;
    this.root = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    this.scanning = false;
    this.allFiles = false;
    this.changedFiles.clear();
  }
}
