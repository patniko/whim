import { mergeInWorker } from '../../renderer/canvas/merge-client';
import type { CanvasSaveResult } from '../../shared/ipc-contract';

/** A save acknowledgement belongs to the submitted revision, not later typing. */
export class DocumentSave {
  private revision = 0;
  private saved = 0;
  private pending?: Promise<void>;
  private rebase?: { base: string; disk: string };

  constructor(
    private readonly read: () => string,
    private readonly replace: (text: string) => void,
    private readonly write: (text: string) => Promise<CanvasSaveResult>,
  ) {}

  changed(): void { this.revision++; }
  hasDirty(): boolean { return this.revision !== this.saved || !!this.rebase; }

  flush(): Promise<void> {
    if (this.pending) return this.pending;
    const work = this.save().finally(() => { if (this.pending === work) this.pending = undefined; });
    this.pending = work;
    return work;
  }

  private async save(): Promise<void> {
    while (this.hasDirty()) {
      if (this.rebase) {
        let applied = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const revision = this.revision;
          const result = await mergeInWorker(this.rebase.base, this.read(), this.rebase.disk);
          if (revision !== this.revision) continue;
          this.replace(result.merged);
          this.rebase = undefined;
          applied = true;
          if (result.hasConflicts) {
            this.changed();
            throw new Error('Concurrent edits were preserved. Review the merged document before saving again.');
          }
          break;
        }
        if (!applied) throw new Error('Document changed during merge. Newer text is kept; retry saving.');
        if (!this.hasDirty()) return;
      }
      const revision = this.revision;
      const text = this.read();
      const result = await this.write(text);
      if (!result.success) throw new Error(result.error || 'Document could not save. Your text is kept.');
      this.saved = revision;
      if (typeof result.content === 'string' && result.content !== text) {
        if (revision === this.revision) this.replace(result.content);
        else this.rebase = { base: text, disk: result.content };
      }
    }
  }
}
