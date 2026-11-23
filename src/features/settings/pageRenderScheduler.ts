export interface ScheduledPageTask<T> {
  /** Resolves with undefined when a queued task is cancelled before starting. */
  promise: Promise<T | undefined>;
  /** Returns true only when queued work was cancelled before starting. */
  cancel: () => boolean;
}

interface QueueEntry<T> {
  run: () => Promise<T> | T;
  resolve: (value: T | undefined) => void;
  reject: (reason?: unknown) => void;
  started: boolean;
  cancelled: boolean;
}

/**
 * Small per-document render queue. Native rendering is bounded independently
 * from React mounting, so a fast scroll cannot create an unbounded task burst.
 */
export class PageRenderScheduler {
  private readonly queue: QueueEntry<unknown>[] = [];
  private readonly running = new Set<QueueEntry<unknown>>();

  constructor(private readonly concurrency = 4) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError('Render concurrency must be a positive integer');
    }
  }

  schedule<T>(run: () => Promise<T> | T): ScheduledPageTask<T> {
    let entry!: QueueEntry<T>;
    const promise = new Promise<T | undefined>((resolve, reject) => {
      entry = { run, resolve, reject, started: false, cancelled: false };
      this.queue.push(entry as QueueEntry<unknown>);
    });
    this.pump();

    return {
      promise,
      cancel: () => this.cancel(entry as QueueEntry<unknown>),
    };
  }

  /** Cancel queued work and mark running work stale without aborting native calls. */
  cancelAll(): void {
    for (const entry of this.queue) {
      entry.cancelled = true;
      entry.resolve(undefined);
    }
    this.queue.length = 0;
    for (const entry of this.running) entry.cancelled = true;
  }

  private cancel(entry: QueueEntry<unknown>): boolean {
    // Native calls already in progress cannot be aborted. Leave them visible
    // to the loader so a quick unmount/remount can still receive the result.
    if (entry.started) return false;
    if (!entry.cancelled) {
      entry.cancelled = true;
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      entry.resolve(undefined);
    }
    return true;
  }

  private pump(): void {
    while (this.running.size < this.concurrency && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      if (entry.cancelled) {
        entry.resolve(undefined);
        continue;
      }

      entry.started = true;
      this.running.add(entry);
      void Promise.resolve()
        .then(() => entry.run())
        .then(
          (value) => entry.resolve(value),
          (error: unknown) => {
            // A cancelled running task still settles its public promise, but
            // never surfaces a late native error to an unmounted consumer.
            if (entry.cancelled) entry.resolve(undefined);
            else entry.reject(error);
          },
        )
        .finally(() => {
          this.running.delete(entry);
          this.pump();
        });
    }
  }
}
