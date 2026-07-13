export interface ElkGraphChild {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export interface ElkGraphEdge {
  id: string;
  sources: string[];
  targets: string[];
}

export interface ElkGraphInput {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkGraphChild[];
  edges: ElkGraphEdge[];
}

export interface ElkGraphOutput {
  id: string;
  children?: ElkGraphChild[];
}

export interface LayoutRunner {
  layout(graph: ElkGraphInput): Promise<ElkGraphOutput>;
  dispose(): void;
}

export interface LayoutEngineDeps {
  createWorkerRunner?: () => Promise<LayoutRunner | null>;
  createBundledRunner?: () => Promise<LayoutRunner>;
  timeoutMs?: number;
}

export interface LayoutEngine {
  layout(graph: ElkGraphInput): Promise<ElkGraphOutput | null>;
  dispose(): Promise<void>;
}

interface ElkInstance {
  layout(graph: ElkGraphInput): Promise<ElkGraphOutput>;
}

type ElkConstructor = new (options?: { workerFactory?: (url?: string) => Worker }) => ElkInstance;

/**
 * ELK can loop effectively forever on pathological inputs (kieler/elkjs#258);
 * the worker is terminated after this deadline and layout falls back to the
 * main-thread bundled build.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Off-main-thread ELK. The worker wrapper file is resolved statically by
 * Next.js (webpack and Turbopack both understand the literal
 * `new Worker(new URL(...))` pattern). In environments where the asset does
 * not exist — the tsup npm-package build does not emit worker chunks — the
 * worker fires an error event and the engine falls back to the bundled build,
 * so embedded consumers transparently get main-thread layout.
 */
async function createDefaultWorkerRunner(): Promise<LayoutRunner | null> {
  if (typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./elk.worker.ts", import.meta.url));
  } catch {
    return null;
  }

  const workerError = new Promise<never>((_, reject) => {
    worker.addEventListener("error", (event) => {
      reject(new Error(`ELK worker failed: ${(event as ErrorEvent).message || "unknown error"}`));
    });
  });

  try {
    const mod = await import("elkjs/lib/elk-api.js");
    const ELK = (mod.default ?? mod) as unknown as ElkConstructor;
    const elk = new ELK({ workerFactory: () => worker });
    return {
      layout: (graph) => Promise.race([elk.layout(graph), workerError]),
      dispose: () => worker.terminate(),
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

/** Main-thread ELK: works in the browser, Node, and happy-dom tests alike. */
async function createDefaultBundledRunner(): Promise<LayoutRunner> {
  const mod = await import("elkjs/lib/elk.bundled.js");
  const ELK = (mod.default ?? mod) as unknown as ElkConstructor;
  const elk = new ELK();
  return {
    layout: (graph) => elk.layout(graph),
    dispose: () => {},
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ELK layout timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Layout engine with a cached worker that is abandoned permanently after its
 * first failure (error or timeout). `layout` resolves to null when no ELK
 * implementation could produce a result — callers keep the grid fallback.
 */
export function createLayoutEngine(deps: LayoutEngineDeps = {}): LayoutEngine {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createWorkerRunner = deps.createWorkerRunner ?? createDefaultWorkerRunner;
  const createBundledRunner = deps.createBundledRunner ?? createDefaultBundledRunner;

  let workerRunnerPromise: Promise<LayoutRunner | null> | null = null;
  let bundledRunnerPromise: Promise<LayoutRunner> | null = null;

  async function layout(graph: ElkGraphInput): Promise<ElkGraphOutput | null> {
    if (!workerRunnerPromise) {
      workerRunnerPromise = createWorkerRunner().catch(() => null);
    }
    const workerRunner = await workerRunnerPromise;
    if (workerRunner) {
      try {
        return await withTimeout(workerRunner.layout(graph), timeoutMs);
      } catch {
        workerRunner.dispose();
        workerRunnerPromise = Promise.resolve(null);
      }
    }

    try {
      if (!bundledRunnerPromise) {
        bundledRunnerPromise = createBundledRunner();
      }
      const bundledRunner = await bundledRunnerPromise;
      return await bundledRunner.layout(graph);
    } catch {
      bundledRunnerPromise = null;
      return null;
    }
  }

  async function dispose(): Promise<void> {
    const workerRunner = await workerRunnerPromise?.catch(() => null);
    workerRunner?.dispose();
    workerRunnerPromise = Promise.resolve(null);
    const bundledRunner = await bundledRunnerPromise?.catch(() => null);
    bundledRunner?.dispose();
  }

  return { layout, dispose };
}
