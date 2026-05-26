export const DOWNLOAD_CONCURRENCY = 6;
export const UPLOAD_CONCURRENCY = 4;

export class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly cap: number) {
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
            if (next) setTimeout(() => next(), 0);
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

  reset(): void {
    this.slots = this.cap;
    this.queue.length = 0;
  }
}
