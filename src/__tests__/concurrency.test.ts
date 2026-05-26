// @vitest-environment node

import { describe, it, expect } from "vitest";
import { Semaphore, CoalescingQueue } from "../lib/sync/concurrency";

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

describe("CoalescingQueue", () => {
  it("runs at most one task per key concurrently", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });

    queue.enqueue("k", async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await block;
      concurrent--;
    });
    queue.enqueue("k", async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      concurrent--;
    });

    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBe(1);
  });

  it("collapses multiple pending enqueues — only latest fn re-runs", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    const ran: string[] = [];
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });

    queue.enqueue("k", async () => { await block; ran.push("first"); });
    queue.enqueue("k", async () => { ran.push("second"); });  // pending
    queue.enqueue("k", async () => { ran.push("third"); });   // overwrites pending

    release();
    await new Promise((r) => setTimeout(r, 30));
    // "second" was overwritten before it ever ran
    expect(ran).toEqual(["first", "third"]);
  });

  it("independent keys run in parallel up to semaphore cap", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    let concurrent = 0;
    let peak = 0;
    const barrier = new Promise<void>((r) => setTimeout(r, 20));
    const task = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await barrier;
      concurrent--;
    };

    queue.enqueue("a", task);
    queue.enqueue("b", task);
    queue.enqueue("c", task);

    await new Promise((r) => setTimeout(r, 50));
    expect(peak).toBe(3);
  });

  it("allows re-enqueue for same key after first run completes", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    let ran = 0;

    queue.enqueue("k", async () => { ran++; });
    await new Promise((r) => setTimeout(r, 20));
    queue.enqueue("k", async () => { ran++; });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(2);
  });

  it("allows re-enqueue after fn throws", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);

    queue.enqueue("k", () => Promise.reject(new Error("fail")));
    await new Promise((r) => setTimeout(r, 20));

    let ran = false;
    queue.enqueue("k", async () => { ran = true; });
    await queue.flush();
    expect(ran).toBe(true);
  });

  it("serializes different keys at semaphore cap=1", async () => {
    const sem = new Semaphore(1);
    const queue = new CoalescingQueue(sem);
    const order: string[] = [];
    let releaseA!: () => void;
    const blockA = new Promise<void>((r) => { releaseA = r; });

    queue.enqueue("a", async () => { await blockA; order.push("a"); });
    queue.enqueue("b", async () => { order.push("b"); });

    releaseA();
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["a", "b"]);
  });
});
