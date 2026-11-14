/**
 * Global single-process in-memory async mutex.
 * Guarantees that pre-flight read and attendance write occur sequentially.
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  public async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => { };

    const waitPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previousQueue = this.queue;
    this.queue = (async () => {
      try {
        await previousQueue;
      } catch {
        // Ignore previous errors so the queue never permanently deadlocks
      }
      await waitPromise;
    })();

    await previousQueue;

    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const momAttendanceMutex = new AsyncMutex();

