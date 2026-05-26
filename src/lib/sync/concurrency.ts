export const DOWNLOAD_CONCURRENCY = 6;
export const UPLOAD_CONCURRENCY = 4;

export class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly cap: number) {
    if (cap < 1) throw new RangeError(`Semaphore cap must be >= 1, got ${cap}`);
    this.slots = cap;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        if (this.slots > 0) {
          this.slots--;
          fn().then(resolve, reject).finally(() => {
            this.slots++;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(attempt);
        }
      };
      attempt();
    });
  }

  get queued(): number {
    return this.queue.length;
  }

  /** For test teardown only. Call only after all in-flight tasks have finished. */
  reset(): void {
    this.slots = this.cap;
    this.queue.length = 0;
  }
}

export class CoalescingQueue {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly pendingFns = new Map<string, () => Promise<void>>();

  constructor(private readonly semaphore: Semaphore) {}

  enqueue(key: string, fn: () => Promise<void>): void {
    if (this.inFlight.has(key)) {
      this.pendingFns.set(key, fn);
      return;
    }
    this._run(key, fn);
  }

  private _run(key: string, fn: () => Promise<void>): void {
    const p = this.semaphore.run(fn)
      .catch((err: unknown) => {
        console.warn(`[CoalescingQueue] task failed for key "${key}":`, err);
      })
      .finally(() => {
        this.inFlight.delete(key);
        const nextFn = this.pendingFns.get(key);
        if (nextFn) {
          this.pendingFns.delete(key);
          this._run(key, nextFn);
        }
      });
    this.inFlight.set(key, p);
  }

  /**
   * Resolves when all currently in-flight tasks (and any they trigger) complete.
   * Only safe when the total set of work is finite. Do not call while new tasks
   * are being continuously enqueued.
   */
  async flush(): Promise<void> {
    const snapshot = [...this.inFlight.values()];
    if (snapshot.length === 0) return;
    await Promise.allSettled(snapshot);
    await this.flush();
  }

  /** Number of keys currently in-flight (including those waiting on the semaphore). */
  get activeCount(): number {
    return this.inFlight.size;
  }

  /** For test teardown only. Call only after all in-flight tasks have finished. */
  reset(): void {
    this.inFlight.clear();
    this.pendingFns.clear();
  }
}

export const downloadSemaphore = new Semaphore(DOWNLOAD_CONCURRENCY);
export const uploadSemaphore = new Semaphore(UPLOAD_CONCURRENCY);
export const downloadQueue = new CoalescingQueue(downloadSemaphore);
export const uploadQueue = new CoalescingQueue(uploadSemaphore);
