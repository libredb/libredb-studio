import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
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
import {
  CONSOLE_NOW,
  consoleContext,
  listAnswer,
  routes,
  sentLines,
  tableAnswer,
  textAnswer,
} from "../../../helpers/kubernetes-console";
import { jsonAnswer, type KubernetesAnswerFn } from "../../../helpers/kubernetes-transport";

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

describe("an over-size document on the agent path", () => {
  test("a document over the byte budget is refused with the byte sentence, not shown as a placeholder", async () => {
    const big = {
      kind: "ConfigMap",
      metadata: { name: "big", namespace: "shop" },
      // The agent's copy masks every data value and keeps every key, so the bulk is in the keys.
      data: Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`key-${index}`, "x"])),
    };
    const { session, options } = machine(routes({ "GET /api/v1/namespaces/shop/configmaps/big": jsonAnswer(big) }));
    await expect(
      readKubectlForMachine(session, "get configmap big -n shop -o yaml", BUDGET, undefined, options),
    ).rejects.toThrow(/Read-only execution exceeded the byte budget: \d+ bytes > 262144 allowed/);
  });

  test("a named read refused as too large is the byte sentence at the cap it passed", async () => {
    const { session, options } = machine(
      routes({
        "GET /api/v1/namespaces/shop/configmaps/huge": () => {
          throw new TransportError("too-large", "x");
        },
      }),
    );
    await expect(
      readKubectlForMachine(session, "get configmap huge -n shop -o json", BUDGET, undefined, options),
    ).rejects.toThrow("Read-only execution exceeded the byte budget: 2097152 bytes > 262144 allowed");
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

describe("logs on the agent path", () => {
  const POD = "GET /api/v1/namespaces/shop/pods";

  function pod(name: string, containers: readonly string[]) {
    return {
      metadata: { name, namespace: "shop" },
      spec: { nodeName: "node-1", containers: containers.map((container) => ({ name: container })) },
      status: { phase: "Running" },
    };
  }

  const logLine = (name: string, container: string, tail: number, limitBytes = 262_144) =>
    `${POD}/${name}/log?container=${container}&tailLines=${tail}&limitBytes=${limitBytes}&timestamps=true`;

  /** The tailLines and limitBytes of every log request sent. */
  function logQueries(transport: { readonly requests: readonly { readonly url: string }[] }) {
    return transport.requests
      .map((request) => new URL(request.url))
      .filter((url) => url.pathname.endsWith("/log"))
      .map((url) => ({
        pod: url.pathname.split("/").at(-2),
        container: url.searchParams.get("container"),
        tailLines: url.searchParams.get("tailLines"),
        limitBytes: url.searchParams.get("limitBytes"),
      }));
  }

  test("a named pod with two containers and --all-containers reads floor(200 / 2) lines from each", async () => {
    const { session, options, transport } = machine(
      routes({
        [`${POD}/web`]: jsonAnswer(pod("web", ["app", "sidecar"])),
        [logLine("web", "app", 100)]: textAnswer("2026-10-10T11:00:00Z a\n"),
        [logLine("web", "sidecar", 100)]: textAnswer("2026-10-10T11:00:01Z b\n"),
      }),
    );
    const result = await readKubectlForMachine(session, "logs web --all-containers", BUDGET, undefined, options);
    expect(logQueries(transport)).toEqual([
      { pod: "web", container: "app", tailLines: "100", limitBytes: "262144" },
      { pod: "web", container: "sidecar", tailLines: "100", limitBytes: "262144" },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.warnings).toEqual([
      {
        message:
          "kubectl reads every line when --tail is absent; Studio read the last 100 lines of each of the 2 log stream(s), the most this read may carry. Ask for fewer with --tail.",
      },
    ]);
  });

  test("streams x --tail past the budget is refused before any log is read", async () => {
    const { session, options, transport } = machine(
      routes({ [`${POD}/web`]: jsonAnswer(pod("web", ["a", "b", "c"])) }),
    );
    await expect(
      readKubectlForMachine(session, "logs web --all-containers --tail=100", BUDGET, undefined, options),
    ).rejects.toThrow("Read-only execution exceeded the row budget: 300 rows > 200 allowed");
    expect(sentLines(transport)).toEqual([`${POD}/web`]);
    expect(logQueries(transport)).toEqual([]);
  });

  test("a selector keeps the console's default of 10 per stream", async () => {
    const { session, options, transport } = machine(
      routes({
        [`${POD}?limit=500&labelSelector=app%3Dweb`]: listAnswer([pod("p1", ["app"]), pod("p2", ["app"])]),
        [logLine("p1", "app", 10)]: textAnswer(""),
        [logLine("p2", "app", 10)]: textAnswer(""),
      }),
    );
    const result = await readKubectlForMachine(session, "logs -l app=web", BUDGET, undefined, options);
    expect(logQueries(transport)).toEqual([
      { pod: "p1", container: "app", tailLines: "10", limitBytes: "262144" },
      { pod: "p2", container: "app", tailLines: "10", limitBytes: "262144" },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  test("an explicit --limit-bytes above the budget is clamped to it", async () => {
    const { session, options, transport } = machine(
      routes({
        [`${POD}/web-1`]: jsonAnswer(pod("web-1", ["app"])),
        [logLine("web-1", "app", 200)]: textAnswer(""),
      }),
    );
    // 1 MiB is the most the parser admits for --limit-bytes, four times the byte budget.
    await readKubectlForMachine(session, "logs web-1 --limit-bytes=1048576", BUDGET, undefined, options);
    expect(logQueries(transport)).toEqual([{ pod: "web-1", container: "app", tailLines: "200", limitBytes: "262144" }]);
  });

  test("a --limit-bytes under the budget is sent as written", async () => {
    const { session, options, transport } = machine(
      routes({
        [`${POD}/web-1`]: jsonAnswer(pod("web-1", ["app"])),
        [logLine("web-1", "app", 5, 2048)]: textAnswer(""),
      }),
    );
    await readKubectlForMachine(session, "logs web-1 --tail=5 --limit-bytes=2048", BUDGET, undefined, options);
    expect(logQueries(transport)).toEqual([{ pod: "web-1", container: "app", tailLines: "5", limitBytes: "2048" }]);
  });

  test("a stream answering more lines than the budget stops the read before the next stream", async () => {
    const flood = Array.from({ length: 250 }, (_unused, index) => `line ${index}`).join("\n");
    const { session, options, transport } = machine(
      routes({
        [`${POD}/web`]: jsonAnswer(pod("web", ["a", "b", "c"])),
        [logLine("web", "a", 50)]: textAnswer(flood),
        [logLine("web", "b", 50)]: textAnswer(""),
        [logLine("web", "c", 50)]: textAnswer(""),
      }),
    );
    await expect(
      readKubectlForMachine(session, "logs web --all-containers --tail=50", BUDGET, undefined, options),
    ).rejects.toThrow("Read-only execution exceeded the row budget: 250 rows > 200 allowed");
    expect(logQueries(transport).map((query) => query.container)).toEqual(["a"]);
  });
});
