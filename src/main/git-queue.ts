import { startTiming } from '../shared/performance';

interface Job<T = unknown> {
  finishWait: (ok?: boolean) => void;
  run: (signal: AbortSignal) => Promise<T>;
  background: boolean;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Only index/ref mutations queue. Read-only status never waits for the network. */
export class GitQueue {
  private jobs: Job[] = [];
  private active: { controller: AbortController; background: boolean } | undefined;
  private stopped = false;

  enqueue<T>(run: (signal: AbortSignal) => Promise<T>, background = false): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Git scheduling stopped'));
    if (this.jobs.length >= 64) return Promise.reject(new Error('Git queue full'));
    if (!background && this.active?.background) this.active.controller.abort();
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ run, background, resolve: value => resolve(value as T), reject, finishWait: startTiming('git.queue') });
      this.pump();
    });
  }

  private pump(): void {
    if (this.active) return;
    const foreground = this.jobs.findIndex(job => !job.background);
    const job = this.jobs.splice(foreground < 0 ? 0 : foreground, 1)[0];
    if (!job) return;
    job.finishWait();
    const controller = new AbortController();
    this.active = { controller, background: job.background };
    void job.run(controller.signal).then(job.resolve, job.reject).finally(() => {
      this.active = undefined;
      this.pump();
    });
  }

  cancelBackground(): void {
    if (this.active?.background) this.active.controller.abort();
    for (const job of this.jobs.filter(job => job.background)) {
      job.finishWait(false);
      job.reject(new Error('Git poll cancelled'));
    }
    this.jobs = this.jobs.filter(job => !job.background);
  }

  async drain(): Promise<void> {
    this.cancelBackground();
    await this.enqueue(async () => undefined);
  }
}
