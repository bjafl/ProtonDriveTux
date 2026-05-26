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
