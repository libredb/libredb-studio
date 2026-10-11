/**
 * `get` as a table: the list form and its row window (the skip-scan, the 5,000 boundary, the 410 restart and the
 * halved page), the named form, and the columns -A, --show-labels, -L, -o wide and -o name add, with a planted
 * Secret marker that no cell may carry.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { NodeRequest } from "@/lib/db/http/node-transport";
import { TransportError } from "@/lib/db/http/node-transport";
import { getList, getNamed, ROWS_CAP_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/get-list";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import { STATEMENT_DEADLINE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/context";
import {
  CONSOLE_NOW,
  consoleContext,
  markerSecret,
  routes,
  SECRET_MARKER,
  sentLines,
  tableAnswer,
  textAnswer,
} from "../../../../helpers/kubernetes-console";
import { jsonAnswer, statusAnswer } from "../../../../helpers/kubernetes-transport";

type Get = Extract<KubectlStatement, { readonly command: "get" }>;

function get(text: string): Get {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "get") throw new Error(`not a get: ${text}`);
  return parsed.statement;
}

const POD_COLUMNS = [
  { name: "Name" },
  { name: "Ready" },
  { name: "Status" },
  { name: "Restarts", type: "integer" },
  { name: "Age" },
  { name: "IP", priority: 1 },
];

/** A list of `count` pods named pod-0 onward, paged by `limit` and `continue` as the server pages it. */
function pagedPods(count: number, options: { readonly expireAt?: number; readonly expiries?: number } = {}) {
  let expiries = options.expiries ?? 0;
  return (request: NodeRequest) => {
    const search = new URL(request.url).searchParams;
    const start = Number(search.get("continue") ?? "0");
    if (options.expireAt !== undefined && start === options.expireAt && expiries > 0) {
      expiries -= 1;
      return statusAnswer(410, "Expired");
    }
    const limit = Number(search.get("limit"));
    const end = Math.min(count, start + limit);
    const rows = Array.from({ length: end - start }, (_unused, index) => ({
      cells: [`pod-${start + index}`, "1/1", "Running", 0, "5m", "10.0.0.1"],
    }));
    return tableAnswer(POD_COLUMNS, rows, end < count ? { continue: String(end) } : {});
  };
}

function podsRoute(count: number, options?: Parameters<typeof pagedPods>[1]) {
  const answer = pagedPods(count, options);
  return (request: NodeRequest, line: string) =>
    line.startsWith("GET /api/v1/namespaces/shop/pods?") ? answer(request) : routes({})(request, line);
}

describe("the list form", () => {
  test("reads the window's rows as the server's Table columns, in the default namespace", async () => {
    const { context, transport } = consoleContext(podsRoute(3));
    const grid = await getList(context, get("kubectl get pods"), { offset: 0, limit: 50 });
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/pods?limit=50&includeObject=None"]);
    expect(grid.fields).toEqual(["Name", "Ready", "Status", "Restarts", "Age"]);
    expect(grid.rows[0]).toEqual({ Name: "pod-0", Ready: "1/1", Status: "Running", Restarts: 0, Age: "5m" });
    expect(grid.columnTypes?.Restarts).toBe("integer");
  });

  test("with no Default namespace the statement reads default, as kubectl does", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/default/pods?limit=50&includeObject=None": tableAnswer(POD_COLUMNS, []),
    });
    const { context, transport } = consoleContext(answer, { connection: { database: "" } });
    await getList(context, get("get pods"), { offset: 0, limit: 50 });
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/default/pods?limit=50&includeObject=None"]);
  });

  test("-o wide adds the columns of a priority above 0; -o name is kubectl's kind.group/name", async () => {
    const { context } = consoleContext(podsRoute(1));
    expect((await getList(context, get("get pods -o wide"), { offset: 0, limit: 5 })).fields).toEqual([
      "Name",
      "Ready",
      "Status",
      "Restarts",
      "Age",
      "IP",
    ]);
    expect(await getList(context, get("get po -o name"), { offset: 0, limit: 5 })).toEqual({
      fields: ["name"],
      rows: [{ name: "pod/pod-0" }],
      columnTypes: { name: "string" },
    });
    const deployments = consoleContext(
      routes({
        "GET /apis/apps/v1/namespaces/shop/deployments?limit=5&includeObject=None": tableAnswer(
          [{ name: "Name" }],
          [{ cells: ["web"] }],
        ),
      }),
    );
    expect((await getList(deployments.context, get("get deploy -o name"), { offset: 0, limit: 5 })).rows).toEqual([
      { name: "deployment.apps/web" },
    ]);
  });

  test("-o name prints a StorageClass's object name, not its printer's decorated Name cell", async () => {
    const defaultClass = {
      cells: ["local-path (default)"],
      object: { kind: "PartialObjectMetadata", metadata: { name: "local-path" } },
    };
    const answer = routes({
      "GET /apis/storage.k8s.io/v1/storageclasses?limit=5&includeObject=Metadata": tableAnswer(
        [{ name: "Name" }],
        [defaultClass],
      ),
      "GET /apis/storage.k8s.io/v1/storageclasses/local-path?includeObject=Metadata": tableAnswer(
        [{ name: "Name" }],
        [defaultClass],
      ),
    });
    const { context, transport } = consoleContext(answer);
    expect((await getList(context, get("kubectl get storageclasses -o name"), { offset: 0, limit: 5 })).rows).toEqual([
      { name: "storageclass.storage.k8s.io/local-path" },
    ]);
    expect((await getNamed(context, get("kubectl get sc local-path -o name"))).rows).toEqual([
      { name: "storageclass.storage.k8s.io/local-path" },
    ]);
    expect(sentLines(transport)).toEqual([
      "GET /apis/storage.k8s.io/v1/storageclasses?limit=5&includeObject=Metadata",
      "GET /apis/storage.k8s.io/v1/storageclasses/local-path?includeObject=Metadata",
    ]);
  });

  test("a cluster-scoped type is read without a namespace, whatever -n says", async () => {
    const answer = routes({
      "GET /api/v1/nodes?limit=5&includeObject=None": tableAnswer([{ name: "Name" }], [{ cells: ["n1"] }]),
    });
    const { context, transport } = consoleContext(answer);
    await getList(context, get("get nodes -n shop"), { offset: 0, limit: 5 });
    expect(sentLines(transport)).toEqual(["GET /api/v1/nodes?limit=5&includeObject=None"]);
  });

  test("-A, --show-labels and -L read metadata and add kubectl's columns, a Secret's values never among them", async () => {
    const secret = markerSecret();
    const answer = routes({
      "GET /api/v1/secrets?limit=5&labelSelector=app%3Dweb&includeObject=Metadata": tableAnswer(
        [{ name: "Name" }, { name: "Type" }, { name: "Data", type: "integer" }],
        [{ cells: ["db", "Opaque", 2], object: { kind: "PartialObjectMetadata", metadata: secret.metadata } }],
      ),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await getList(context, get("kubectl get secrets -A --show-labels -L app,team -l app=web"), {
      offset: 0,
      limit: 5,
    });
    expect(sentLines(transport)).toEqual([
      "GET /api/v1/secrets?limit=5&labelSelector=app%3Dweb&includeObject=Metadata",
    ]);
    expect(grid.fields).toEqual(["NAMESPACE", "Name", "Type", "Data", "LABELS", "APP", "TEAM"]);
    expect(grid.rows).toEqual([
      { NAMESPACE: "shop", Name: "db", Type: "Opaque", Data: 2, LABELS: "app=web", APP: "web", TEAM: "" },
    ]);
    expect(JSON.stringify(grid)).not.toContain(SECRET_MARKER);
  });

  test("a label column whose header repeats a Table column is numbered, so no two columns share a name", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods?limit=5&includeObject=Metadata": tableAnswer(
        [{ name: "Name" }, { name: "NAME" }],
        [{ cells: ["web", "x"], object: { metadata: { name: "web" } } }],
      ),
    });
    const { context } = consoleContext(answer);
    const grid = await getList(context, get("get pods -L example.com/name"), { offset: 0, limit: 5 });
    expect(grid.fields).toEqual(["Name", "NAME", "NAME (2)"]);
    expect(grid.rows[0]).toEqual({ Name: "web", NAME: "x", "NAME (2)": "" });
  });
});

describe("the row window", () => {
  test("page three of 500, with the route's probe row, chains continue inside one call", async () => {
    const { context, transport } = consoleContext(podsRoute(2_000));
    const grid = await getList(context, get("get pods"), { offset: 1_000, limit: 501 });
    expect(grid.rows).toHaveLength(501);
    expect(grid.rows[0].Name).toBe("pod-1000");
    expect(grid.rows[500].Name).toBe("pod-1500");
    expect(sentLines(transport)).toEqual([
      "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=500&continue=500&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=500&continue=1000&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=1&continue=1500&includeObject=None",
    ]);
  });

  test("a window past the end of the list answers the rows there are", async () => {
    const { context } = consoleContext(podsRoute(30));
    expect((await getList(context, get("get pods"), { offset: 20, limit: 51 })).rows).toHaveLength(10);
    expect((await getList(context, get("get pods"), { offset: 40, limit: 51 })).rows).toEqual([]);
  });

  test("the last page before 5,000 may read the 5,001st row for the route's probe, and no further", async () => {
    const { context, transport } = consoleContext(podsRoute(6_000));
    const grid = await getList(context, get("get pods"), { offset: 4_500, limit: 501 });
    expect(grid.rows).toHaveLength(501);
    expect(grid.rows[500].Name).toBe("pod-5000");
    expect(sentLines(transport).at(-1)).toBe(
      "GET /api/v1/namespaces/shop/pods?limit=1&continue=5000&includeObject=None",
    );
    const wide = consoleContext(podsRoute(6_000));
    expect((await getList(wide.context, get("get pods"), { offset: 4_900, limit: 500 })).rows).toHaveLength(101);
  });

  test("a window at or past 5,000 answers the sentence and lists nothing", async () => {
    const { context, transport } = consoleContext(podsRoute(6_000));
    await expect(getList(context, get("get pods"), { offset: 5_000, limit: 501 })).rejects.toThrow(ROWS_CAP_SENTENCE);
    expect(sentLines(transport)).toEqual([]);
  });

  test("an expired continue restarts the scan once from the beginning; a second answers the sentence", async () => {
    const once = consoleContext(podsRoute(1_200, { expireAt: 500, expiries: 1 }));
    expect((await getList(once.context, get("get pods"), { offset: 600, limit: 10 })).rows[0].Name).toBe("pod-600");
    expect(sentLines(once.transport)).toEqual([
      "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=110&continue=500&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=110&continue=500&includeObject=None",
    ]);
    const twice = consoleContext(podsRoute(1_200, { expireAt: 500, expiries: 2 }));
    await expect(getList(twice.context, get("get pods"), { offset: 600, limit: 10 })).rejects.toThrow(
      "The list changed on the server while Studio read it page by page",
    );
  });

  test("a metadata page past the 16 MiB cap is read again with half the page size", async () => {
    let first = true;
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=Metadata": () => {
        if (first) {
          first = false;
          throw new TransportError("too-large", "x");
        }
        return tableAnswer(POD_COLUMNS, []);
      },
      "GET /api/v1/namespaces/shop/pods?limit=250&includeObject=Metadata": tableAnswer(POD_COLUMNS, [
        { cells: ["web", "1/1", "Running", 0, "5m", "x"], object: { metadata: { labels: {} } } },
      ]),
    });
    const { context } = consoleContext(answer);
    const grid = await getList(context, get("get pods --show-labels"), { offset: 0, limit: 500 });
    expect(grid.rows).toEqual([
      { Name: "web", Ready: "1/1", Status: "Running", Restarts: 0, Age: "5m", LABELS: "<none>" },
    ]);
  });

  test("with no window the first 5,000 rows are shown, with a warning when the list holds more", async () => {
    const { context } = consoleContext(podsRoute(5_001));
    const grid = await getList(context, get("get pods"), undefined);
    expect(grid.rows).toHaveLength(5_000);
    expect(grid.bounded).toBe(true);
    expect(grid.warnings?.[0].message).toContain("more than 5,000 objects");
    const exact = consoleContext(podsRoute(5_000));
    expect((await getList(exact.context, get("get pods"), undefined)).warnings).toBeUndefined();
  });

  test("one query timeout bounds the statement: a page that meets the deadline is never sent", async () => {
    let clock = CONSOLE_NOW;
    const pages = podsRoute(1_500);
    const { context, transport } = consoleContext(
      (request, line) => {
        // Each page of the list takes 15 s; discovery takes none.
        if (line.includes("/pods?")) clock += 15_000;
        return pages(request, line);
      },
      { queryTimeoutMs: 30_000, now: () => clock },
    );
    await expect(getList(context, get("get pods"), { offset: 0, limit: 1_500 })).rejects.toThrow(
      STATEMENT_DEADLINE_SENTENCE,
    );
    expect(sentLines(transport)).toEqual([
      "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None",
      "GET /api/v1/namespaces/shop/pods?limit=500&continue=500&includeObject=None",
    ]);
  });

  test("--request-timeout must end 5 s before the query timeout", async () => {
    const { context, transport } = consoleContext(podsRoute(1), { queryTimeoutMs: 30_000 });
    await expect(getList(context, get("get pods --request-timeout=26s"), { offset: 0, limit: 5 })).rejects.toThrow(
      "--request-timeout may be at most 25 s here: the connection's query timeout less 5 s. Nothing was sent.",
    );
    expect(sentLines(transport)).toEqual([]);
    expect((await getList(context, get("get pods --request-timeout=25s"), { offset: 0, limit: 5 })).rows).toHaveLength(
      1,
    );
    expect(transport.requests.at(-1)?.url).toContain("/pods?");
  });
});

describe("the named form", () => {
  test("one Table read per name, in the order named", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": tableAnswer(POD_COLUMNS, [
        { cells: ["web", "1/1", "Running", 0, "5m", "x"] },
      ]),
      "GET /api/v1/namespaces/shop/pods/api?includeObject=None": tableAnswer(POD_COLUMNS, [
        { cells: ["api", "0/1", "Pending", 3, "1m", "y"] },
      ]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await getNamed(context, get("get pod/web pod/api"));
    expect(grid.rows.map((row) => row.Name)).toEqual(["web", "api"]);
    expect(sentLines(transport)).toEqual([
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None",
      "GET /api/v1/namespaces/shop/pods/api?includeObject=None",
    ]);
  });

  test("a missing object fails the statement, unless --ignore-not-found skips it", async () => {
    const answer = routes({ "GET /api/v1/namespaces/shop/pods/web?includeObject=None": statusAnswer(404, "NotFound") });
    const failing = consoleContext(answer);
    await expect(getNamed(failing.context, get("get pod web"))).rejects.toThrow(
      "pods web was not found in the namespace shop (404 Not Found).",
    );
    const skipping = consoleContext(answer);
    expect(await getNamed(skipping.context, get("get pod web --ignore-not-found"))).toEqual({
      fields: ["Name"],
      rows: [],
      columnTypes: { Name: "string" },
    });
  });

  test("a type the server stopped serving is not a missing object, with or without --ignore-not-found", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/pods/web?includeObject=None": textAnswer("404 page not found", 404),
    });
    const { context } = consoleContext(answer);
    await expect(getNamed(context, get("get pod web --ignore-not-found"))).rejects.toThrow(
      'the server doesn\'t have a resource type "pods"',
    );
  });

  test("a named Secret with --show-labels keeps its labels and never its values", async () => {
    const secret = markerSecret();
    const answer = routes({
      "GET /api/v1/namespaces/shop/secrets/db?includeObject=Metadata": tableAnswer(
        [{ name: "Name" }],
        [{ cells: ["db"], object: secret }],
      ),
    });
    const { context } = consoleContext(answer);
    const grid = await getNamed(context, get("get secret db --show-labels"));
    expect(grid.rows).toEqual([{ Name: "db", LABELS: "app=web" }]);
    expect(JSON.stringify(grid)).not.toContain(SECRET_MARKER);
  });

  test("a name the request policy refuses sends nothing", async () => {
    const { context, transport } = consoleContext(routes({}));
    await expect(getNamed(context, get("get configmap 'a%2Fb'"))).rejects.toBeInstanceOf(QueryError);
    expect(sentLines(transport)).toEqual([]);
  });

  test("an unknown type reads discovery again once, then answers kubectl's sentence", async () => {
    const { context, transport } = consoleContext(routes({}));
    await expect(getList(context, get("get gizmos"), { offset: 0, limit: 5 })).rejects.toThrow(
      'the server doesn\'t have a resource type "gizmos"; list the types it serves with kubectl api-resources.',
    );
    expect(transport.calls.map((call) => call.method)).toEqual(["GET /api", "GET /apis", "GET /api", "GET /apis"]);
  });
});

describe("jsonAnswer is the transport's 2xx", () => {
  test("a plain list where a Table was asked reads as Name and Created", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/configmaps?limit=5&includeObject=None": jsonAnswer({
        kind: "ConfigMapList",
        metadata: {},
        items: [{ metadata: { name: "conf", creationTimestamp: "2026-10-10T11:00:00Z" } }],
      }),
    });
    const { context } = consoleContext(answer);
    expect((await getList(context, get("get configmaps"), { offset: 0, limit: 5 })).rows).toEqual([
      { Name: "conf", Created: "2026-10-10T11:00:00Z" },
    ]);
  });
});
