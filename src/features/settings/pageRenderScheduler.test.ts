import { describe, expect, it, vi } from 'vitest';
import { PageRenderScheduler } from './pageRenderScheduler';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('PageRenderScheduler', () => {
  it('starts no more than four native tasks and drains the queue', async () => {
    const scheduler = new PageRenderScheduler(4);
    const gates = Array.from({ length: 8 }, () => deferred<void>());
    const started: number[] = [];
    const tasks = gates.map((gate, index) => scheduler.schedule(async () => {
      started.push(index);
      await gate.promise;
      return index;
    }));

    await flush();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    for (const gate of gates) gate.resolve();
    await expect(Promise.all(tasks.map((task) => task.promise))).resolves.toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('cancels queued work without calling its native render function', async () => {
    const scheduler = new PageRenderScheduler(4);
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const running = gates.map((gate) => scheduler.schedule(() => gate.promise));
    const queuedRun = vi.fn(async () => 'should not run');
    const queued = scheduler.schedule(queuedRun);

    await flush();
    expect(queued.cancel()).toBe(true);
    await expect(queued.promise).resolves.toBeUndefined();
    expect(queuedRun).not.toHaveBeenCalled();

    for (const gate of gates) gate.resolve();
    await Promise.all(running.map((task) => task.promise));
    await flush();
    expect(queuedRun).not.toHaveBeenCalled();
  });

  it('lets a running task settle after cancellation for optional caching', async () => {
    const scheduler = new PageRenderScheduler(4);
    const gate = deferred<string>();
    const task = scheduler.schedule(() => gate.promise);

    await flush();
    expect(task.cancel()).toBe(false);
    gate.resolve('finished');
    await expect(task.promise).resolves.toBe('finished');
  });

  it('cancelAll drops queued work and suppresses late running errors', async () => {
    const scheduler = new PageRenderScheduler(2);
    const first = deferred<void>();
    const second = deferred<void>();
    const running = [
      scheduler.schedule(() => first.promise),
      scheduler.schedule(() => second.promise),
    ];
    const queuedRun = vi.fn(async () => 'queued');
    const queued = scheduler.schedule(queuedRun);

    await flush();
    scheduler.cancelAll();
    await expect(queued.promise).resolves.toBeUndefined();
    first.reject(new Error('late native failure'));
    second.resolve();
    await expect(running[0].promise).resolves.toBeUndefined();
    await expect(running[1].promise).resolves.toBeUndefined();
    expect(queuedRun).not.toHaveBeenCalled();
  });
});
