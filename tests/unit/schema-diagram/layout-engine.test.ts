import { describe, expect, mock, test } from "bun:test";

import { createLayoutEngine } from "@/components/schema-diagram/layout-engine";
import type { ElkGraphInput, ElkGraphOutput, LayoutRunner } from "@/components/schema-diagram/layout-engine";

const GRAPH: ElkGraphInput = { id: "root", layoutOptions: {}, children: [], edges: [] };
const WORKER_RESULT: ElkGraphOutput = { id: "root", children: [{ id: "a", x: 1, y: 2 }] };
const BUNDLED_RESULT: ElkGraphOutput = { id: "root", children: [{ id: "a", x: 9, y: 9 }] };

function runner(impl: Partial<LayoutRunner>): LayoutRunner {
  return {
    layout: impl.layout ?? (() => Promise.resolve(WORKER_RESULT)),
    dispose: impl.dispose ?? (() => {}),
  };
}

/**
 * Minimal Worker double for the default worker runner. elk-api only needs
 * `postMessage`/`onmessage` (via PromisedWorker) plus `addEventListener` and
 * `terminate`; replies echo the message id the way the real ELK worker does.
 */
class FakeElkWorker {
  static last: FakeElkWorker | null = null;
  onmessage: ((event: { data: { id: number; data: unknown } }) => void) | null = null;
  terminated = 0;
  respond = true;
  private errorListeners: Array<(event: unknown) => void> = [];

  constructor(_url?: unknown) {
    FakeElkWorker.last = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "error") this.errorListeners.push(listener);
  }

  postMessage(msg: { id: number; cmd: string }): void {
    if (!this.respond) return;
    const data = msg.cmd === "layout" ? WORKER_RESULT : true;
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, data } }));
  }

  terminate(): void {
    this.terminated += 1;
  }

  emitError(event: { message?: string }): void {
    for (const listener of this.errorListeners) listener(event);
  }
}

async function withGlobalWorker<T>(workerImpl: unknown, fn: () => Promise<T>): Promise<T> {
  const savedWorker = (globalThis as Record<string, unknown>).Worker;
  (globalThis as Record<string, unknown>).Worker = workerImpl;
  try {
    return await fn();
  } finally {
    (globalThis as Record<string, unknown>).Worker = savedWorker;
  }
}

describe("createLayoutEngine (default runners)", () => {
  test("lays out a graph via the bundled elk when no Worker is available", async () => {
    // Force the worker-unavailable branch deterministically (bun defines a
    // global Worker; the default worker path is environment-dependent).
    const savedWorker = (globalThis as Record<string, unknown>).Worker;
    delete (globalThis as Record<string, unknown>).Worker;
    try {
      const engine = createLayoutEngine();
      const result = await engine.layout({
        id: "root",
        layoutOptions: { "elk.algorithm": "layered" },
        children: [
          { id: "a", width: 100, height: 50 },
          { id: "b", width: 100, height: 50 },
        ],
        edges: [{ id: "a->b", sources: ["a"], targets: ["b"] }],
      });
      expect(result).not.toBeNull();
      const positions = new Map((result?.children ?? []).map((c) => [c.id, c]));
      expect(typeof positions.get("a")?.x).toBe("number");
      expect(typeof positions.get("b")?.x).toBe("number");
      // layered layout must actually separate the two nodes
      expect(positions.get("a")?.x).not.toBe(positions.get("b")?.x);
      await engine.dispose();
    } finally {
      (globalThis as Record<string, unknown>).Worker = savedWorker;
    }
  });

  test("lays out via the worker-backed ELK when the Worker responds", async () => {
    await withGlobalWorker(FakeElkWorker, async () => {
      const bundledFactory = mock(() => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })));
      const engine = createLayoutEngine({ createBundledRunner: bundledFactory });

      expect(await engine.layout(GRAPH)).toEqual(WORKER_RESULT);
      expect(bundledFactory).not.toHaveBeenCalled();

      await engine.dispose();
      expect(FakeElkWorker.last?.terminated).toBe(1);
    });
  });

  test("falls back to bundled when the Worker constructor throws", async () => {
    class ThrowingWorker {
      constructor() {
        throw new Error("worker asset missing");
      }
    }
    await withGlobalWorker(ThrowingWorker, async () => {
      const engine = createLayoutEngine({
        createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
      });

      expect(await engine.layout(GRAPH)).toEqual(BUNDLED_RESULT);
      await engine.dispose();
    });
  });

  test("terminates the worker and falls back when ELK cannot wrap it", async () => {
    // elk-api rejects workers without a postMessage function, which exercises
    // the terminate-and-rethrow path of the default worker runner.
    class NoPostMessageWorker {
      static last: NoPostMessageWorker | null = null;
      terminated = 0;
      constructor(_url?: unknown) {
        NoPostMessageWorker.last = this;
      }
      addEventListener(): void {}
      terminate(): void {
        this.terminated += 1;
      }
    }
    await withGlobalWorker(NoPostMessageWorker, async () => {
      const engine = createLayoutEngine({
        createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
      });

      expect(await engine.layout(GRAPH)).toEqual(BUNDLED_RESULT);
      expect(NoPostMessageWorker.last?.terminated).toBe(1);
      await engine.dispose();
    });
  });

  test("a worker error event rejects the in-flight layout and falls back", async () => {
    await withGlobalWorker(FakeElkWorker, async () => {
      const engine = createLayoutEngine({
        createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
      });

      // The worker is constructed synchronously by the first layout call;
      // silence it so the layout stays in flight, then fire the error event
      // once the race in the worker runner is attached.
      const resultPromise = engine.layout(GRAPH);
      const worker = FakeElkWorker.last;
      expect(worker).not.toBeNull();
      if (worker) worker.respond = false;
      await new Promise((resolve) => setTimeout(resolve, 10));
      worker?.emitError({ message: "worker crashed" });

      expect(await resultPromise).toEqual(BUNDLED_RESULT);
      expect(worker?.terminated).toBe(1);
      await engine.dispose();
    });
  });
});

describe("createLayoutEngine", () => {
  test("uses the worker runner when available", async () => {
    const bundledFactory = mock(() => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })));
    const engine = createLayoutEngine({
      createWorkerRunner: () => Promise.resolve(runner({})),
      createBundledRunner: bundledFactory,
    });

    const result = await engine.layout(GRAPH);
    expect(result).toEqual(WORKER_RESULT);
    expect(bundledFactory).not.toHaveBeenCalled();
  });

  test("falls back to the bundled runner when no worker is available", async () => {
    const engine = createLayoutEngine({
      createWorkerRunner: () => Promise.resolve(null),
      createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
    });

    expect(await engine.layout(GRAPH)).toEqual(BUNDLED_RESULT);
  });

  test("disposes a failing worker runner and falls back to bundled", async () => {
    const dispose = mock(() => {});
    const engine = createLayoutEngine({
      createWorkerRunner: () =>
        Promise.resolve(runner({ layout: () => Promise.reject(new Error("worker exploded")), dispose })),
      createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
    });

    expect(await engine.layout(GRAPH)).toEqual(BUNDLED_RESULT);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("does not retry the worker after it failed once", async () => {
    const workerFactory = mock(() => Promise.resolve(runner({ layout: () => Promise.reject(new Error("boom")) })));
    const engine = createLayoutEngine({
      createWorkerRunner: workerFactory,
      createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
    });

    await engine.layout(GRAPH);
    await engine.layout(GRAPH);
    expect(workerFactory).toHaveBeenCalledTimes(1);
  });

  test("times out a hanging worker layout and falls back", async () => {
    const dispose = mock(() => {});
    const engine = createLayoutEngine({
      createWorkerRunner: () => Promise.resolve(runner({ layout: () => new Promise(() => {}), dispose })),
      createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
      timeoutMs: 20,
    });

    expect(await engine.layout(GRAPH)).toEqual(BUNDLED_RESULT);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("returns null when both runners fail", async () => {
    const engine = createLayoutEngine({
      createWorkerRunner: () => Promise.resolve(null),
      createBundledRunner: () => Promise.reject(new Error("no elk at all")),
    });

    expect(await engine.layout(GRAPH)).toBeNull();
  });

  test("worker factory rejection is treated as unavailable", async () => {
    const engine = createLayoutEngine({
      createWorkerRunner: () => Promise.reject(new Error("no worker support")),
      createBundledRunner: () => Promise.resolve(runner({ layout: () => Promise.resolve(BUNDLED_RESULT) })),
    });

    expect(await engine.layout(GRAPH)).toEqual(BUNDLED_RESULT);
  });

  test("dispose tears down the worker runner", async () => {
    const dispose = mock(() => {});
    const engine = createLayoutEngine({
      createWorkerRunner: () => Promise.resolve(runner({ dispose })),
      createBundledRunner: () => Promise.resolve(runner({})),
    });

    await engine.layout(GRAPH);
    await engine.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
