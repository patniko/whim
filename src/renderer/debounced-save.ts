export class DebouncedSave {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private saved = 0;
  private pending: Promise<void> | undefined;
  constructor(private readonly write: () => Promise<void>, private readonly failed: (error: unknown) => void) {}
  hasDirty(): boolean { return this.version !== this.saved; }
  schedule(): void {
    this.version++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(this.failed); }, 500);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending.then(() => this.saved !== this.version ? this.flush() : undefined);
    const operation = (async () => {
      while (this.saved !== this.version) {
        const version = this.version;
        await this.write();
        this.saved = version;
      }
    })().finally(() => { if (this.pending === operation) this.pending = undefined; });
    this.pending = operation;
    return operation;
  }
}
