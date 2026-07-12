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
