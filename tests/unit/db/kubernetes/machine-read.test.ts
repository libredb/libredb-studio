import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import {
  ExplainCache,
  type KubectlContext,
  machineRowLimit,
} from "@/lib/db/providers/platform/kubernetes/console/context";
import { AGENT_PAGING_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/paging";
import { runKubectl } from "@/lib/db/providers/platform/kubernetes/console/run";
import {
  MACHINE_DEADLINE_SENTENCE,
  MACHINE_ESTIMATE_SENTENCE,
  MACHINE_PROFILE_SENTENCE,
  MACHINE_WATCH_SENTENCE,
  readKubectlForMachine,
} from "@/lib/db/providers/platform/kubernetes/machine-read";
import { fakeCluster, manyRows, testSurface } from "../../../helpers/kubernetes-cluster";
import { CONSOLE_NOW, consoleContext, tableAnswer } from "../../../helpers/kubernetes-console";
import type { KubernetesAnswerFn } from "../../../helpers/kubernetes-transport";

const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 200, maxResultBytes: 262_144 };

function machine(
  answer = fakeCluster({ lists: { "/api/v1/namespaces/shop/pods": manyRows("web", 3) } }),
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
) {
  const { surface, transport } = testSurface(answer, { database: "shop" });
  const session = { surface, explainCache: new ExplainCache(8), lifetime: new AbortController().signal };
  const options = {
    readOnly: true,
    seams: { now: () => CONSOLE_NOW, sleep: sleep ?? (() => new Promise<void>(() => {})) },
    appVersion: "0.18.2",
  };
  return { session, options, transport };
}

describe("readKubectlForMachine", () => {
  test("reads a list under the profile", async () => {
    const { session, options } = machine();
    const result = await readKubectlForMachine(session, "get pods -n shop", BUDGET, undefined, options);
    expect(result.rowCount).toBe(3);
  });

  test("refuses unless opened under the read-only profile", async () => {
    const { session, options } = machine();
    await expect(
      readKubectlForMachine(session, "get pods", BUDGET, undefined, { ...options, readOnly: false }),
    ).rejects.toThrow(MACHINE_PROFILE_SENTENCE);
  });

  test("refuses an invalid budget as the SQL providers do", async () => {
    const { session, options } = machine();
    await expect(
      readKubectlForMachine(session, "get pods", { ...BUDGET, maxResultRows: 0 }, undefined, options),
    ).rejects.toThrow("maxResultRows must be a positive integer");
  });

  test("refuses estimate-plan, watch and the paging clause before any request", async () => {
    const { session, options, transport } = machine();
    await expect(readKubectlForMachine(session, "get pods", BUDGET, "estimate-plan", options)).rejects.toThrow(
      MACHINE_ESTIMATE_SENTENCE,
    );
    await expect(readKubectlForMachine(session, "get pods -n shop -w", BUDGET, undefined, options)).rejects.toThrow(
      MACHINE_WATCH_SENTENCE,
    );
    await expect(
      readKubectlForMachine(session, "get pods -n shop\n# libredb:page offset=0 limit=5", BUDGET, undefined, options),
    ).rejects.toThrow(AGENT_PAGING_SENTENCE);
    expect(transport.calls.filter((call) => !call.method.startsWith("GET /api"))).toEqual([]);
  });

  test("the statement deadline bounds a cold discovery, and the caller stops waiting", async () => {
    let expire: () => void = () => {};
    const never = new Promise<never>(() => {});
    const { session, options } = machine(
      (_request, line) => (line === "GET /api" ? never : fakeCluster()(_request, line)),
      () =>
        new Promise<void>((resolve) => {
          expire = resolve;
        }),
    );
    const read = readKubectlForMachine(session, "get pods -n shop", BUDGET, undefined, options);
    expire();
    await expect(read).rejects.toThrow(MACHINE_DEADLINE_SENTENCE);
  });

  test("a shared discovery load is not cancelled by one caller's deadline", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstDiscovery = true;
    const cluster = fakeCluster({ lists: { "/api/v1/namespaces/shop/pods": manyRows("web", 3) } });
    const answer: KubernetesAnswerFn = async (request, line) => {
      if (line === "GET /api" && firstDiscovery) {
        firstDiscovery = false;
        await held;
      }
      return cluster(request, line);
    };
    const { session, options } = machine(answer);
    const expiring = readKubectlForMachine(session, "get pods -n shop", BUDGET, undefined, {
      ...options,
      seams: { ...options.seams, sleep: () => Promise.resolve() },
    });
    const waiting = readKubectlForMachine(session, "get pods -n shop", BUDGET, undefined, options);
    await expect(expiring).rejects.toThrow(MACHINE_DEADLINE_SENTENCE);
    release();
    expect((await waiting).rowCount).toBe(3);
  });

  test("refuses past the row budget with the SQL providers' sentence", async () => {
    const { session, options } = machine(
      fakeCluster({ lists: { "/api/v1/namespaces/shop/pods": manyRows("web", 5) } }),
    );
    await expect(
      readKubectlForMachine(session, "get pods -n shop", { ...BUDGET, maxResultRows: 4 }, undefined, options),
    ).rejects.toThrow("Read-only execution exceeded the row budget: 5 rows > 4 allowed");
  });

  test("refuses past the byte budget with the SQL providers' sentence", async () => {
    const { session, options } = machine();
    await expect(
      readKubectlForMachine(session, "get pods -n shop", { ...BUDGET, maxResultBytes: 10 }, undefined, options),
    ).rejects.toThrow(/Read-only execution exceeded the byte budget: \d+ bytes > 10 allowed/);
  });

  test("a refusal is a QueryError, so the tool layer settles it as a repairable statement failure", async () => {
    const { session, options } = machine();
    await expect(
      readKubectlForMachine(session, "get pods -n shop -w", BUDGET, undefined, options),
    ).rejects.toBeInstanceOf(QueryError);
  });
});

describe("the agent path stops reading at maxRows + 1", () => {
  test.each([
    ["get pods -n shop", "/api/v1/namespaces/shop/pods"],
    ["get pods -n shop -o yaml", "/api/v1/namespaces/shop/pods"],
    ["events -n shop", "/api/v1/namespaces/shop/events"],
    ["top pod -n shop", "/apis/metrics.k8s.io/v1beta1/namespaces/shop/pods"],
  ])("%s asks for 201 rows and is refused past 200", async (statement, path) => {
    const { session, options, transport } = machine(fakeCluster({ lists: { [path]: manyRows("x", 600) } }));
    await expect(readKubectlForMachine(session, statement, BUDGET, undefined, options)).rejects.toThrow(
      "Read-only execution exceeded the row budget: 201 rows > 200 allowed",
    );
    const reads = transport.calls.map((call) => call.method).filter((line) => line.includes(path));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("limit=201");
  });

  test("describe reads an object's events one row past the budget", async () => {
    const path = "/api/v1/namespaces/shop/events";
    const cluster = fakeCluster({
      lists: { [path]: manyRows("x", 600) },
      objects: { "/api/v1/namespaces/shop/pods/web": { kind: "Pod", metadata: { name: "web", namespace: "shop" } } },
    });
    const { session, options, transport } = machine((request, line) =>
      line === "GET /api/v1/namespaces/shop/pods/web?includeObject=None"
        ? tableAnswer([{ name: "Name" }], [{ cells: ["web"] }])
        : cluster(request, line),
    );
    await expect(
      readKubectlForMachine(session, "describe pod web -n shop", BUDGET, undefined, options),
    ).rejects.toThrow(/Read-only execution exceeded the row budget/);
    const reads = transport.calls.map((call) => call.method).filter((line) => line.includes(path));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain("limit=201");
  });

  test("the editor's console still reads up to its own caps", async () => {
    const path = "/api/v1/namespaces/shop/pods";
    const { context, transport } = consoleContext(fakeCluster({ lists: { [path]: manyRows("x", 600) } }));
    const grid = await runKubectl(context, "get pods -n shop");
    expect(grid.rows).toHaveLength(600);
    const reads = transport.calls.map((call) => call.method).filter((line) => line.includes(path));
    expect(reads.map((line) => new URL(line.slice(4), "https://x").searchParams.get("limit"))).toEqual(["500", "500"]);
  });
});

describe("machineRowLimit", () => {
  const editor = {} as KubectlContext;
  const agent = { machine: { maxRows: 200, maxBytes: 262_144 } } as KubectlContext;

  test("an editor run keeps the command's own limit", () => {
    expect(machineRowLimit(editor, 500)).toBe(500);
  });

  test("an agent run reads at most one row past its budget, never past the command's own limit", () => {
    expect(machineRowLimit(agent, 500)).toBe(201);
    expect(machineRowLimit(agent, 100)).toBe(100);
  });
});
