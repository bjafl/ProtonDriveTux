// @vitest-environment node

import { describe, it, expect } from "vitest";
import { Semaphore } from "../lib/sync/concurrency";

describe("Semaphore", () => {
  it("runs tasks up to cap concurrently and no more", async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let peak = 0;

    const tasks = Array.from({ length: 5 }, () =>
      sem.run(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((r) => setTimeout(r, 20));
        concurrent--;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBe(3);
  });

  it("queued getter returns count of tasks waiting for a slot", async () => {
    const sem = new Semaphore(1);
    let resolve1!: () => void;
    const p1 = sem.run(() => new Promise<void>((r) => { resolve1 = r; }));
    const p2 = sem.run(() => Promise.resolve());
    const p3 = sem.run(() => Promise.resolve());

    expect(sem.queued).toBe(2);

    resolve1();
    await p1;
    await Promise.resolve(); // flush microtasks
    expect(sem.queued).toBe(1);

    await Promise.all([p2, p3]);
    expect(sem.queued).toBe(0);
  });

  it("releases its slot even when fn throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    let ran = false;
    await sem.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("executes queued tasks in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    let releaseFirst!: () => void;
    const first = sem.run(
      () => new Promise<void>((r) => { releaseFirst = r; }),
    );
    const t2 = sem.run(async () => { order.push(2); });
    const t3 = sem.run(async () => { order.push(3); });
    const t4 = sem.run(async () => { order.push(4); });
    releaseFirst();
    await Promise.all([first, t2, t3, t4]);
    expect(order).toEqual([2, 3, 4]);
  });
});
