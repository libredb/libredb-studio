/**
 * What every command shares: kubectl's age and list forms, the explain cache's bound, resolution through discovery
 * (one refresh on an unknown name, a category refused), the namespace a request goes to, and the request timeout.
 */
import { describe, expect, test } from "bun:test";
import {
  ageOf,
  byCodeUnit,
  ExplainCache,
  goList,
  humanDuration,
  inTurn,
  namespaceFor,
  objectOf,
  requestTimeoutMs,
  resolveType,
  STATEMENT_DEADLINE_SENTENCE,
  statementCall,
  stringOf,
  textGrid,
} from "@/lib/db/providers/platform/kubernetes/console/context";
import { consoleContext, routes } from "../../../../helpers/kubernetes-console";

describe("byCodeUnit: kubectl's key order", () => {
  test("orders by UTF-16 code unit, as Go's sort.Strings does, never by locale", () => {
    const keys = ["b", "a", "B", "app.kubernetes.io/name", "_x", "\u00e9", "z", "a"];
    expect([...keys].sort(byCodeUnit)).toEqual(["B", "_x", "a", "a", "app.kubernetes.io/name", "b", "z", "\u00e9"]);
  });
});

describe("humanDuration: kubectl's age", () => {
  test.each([
    [-2_000, "<invalid>"],
    [-500, "0s"],
    [-1_500, "0s"],
    [0, "0s"],
    [119_000, "119s"],
    [120_000, "2m"],
    [125_000, "2m5s"],
    [599_000, "9m59s"],
    [600_000, "10m"],
    [179 * 60_000, "179m"],
    [3 * 3_600_000, "3h"],
    [3 * 3_600_000 + 12 * 60_000, "3h12m"],
    [8 * 3_600_000, "8h"],
    [47 * 3_600_000, "47h"],
    [48 * 3_600_000, "2d"],
    [52 * 3_600_000, "2d4h"],
    [8 * 86_400_000, "8d"],
    [729 * 86_400_000, "729d"],
    [730 * 86_400_000, "2y"],
    [800 * 86_400_000, "2y70d"],
    [9 * 365 * 86_400_000, "9y"],
  ])("%d ms is %s", (ms, text) => {
    expect(humanDuration(ms)).toBe(text);
  });

  test("ageOf reads an RFC 3339 time against the context's clock, and <unknown> for none", () => {
    const now = { now: () => Date.UTC(2026, 9, 10, 12, 0, 0) };
    expect(ageOf(now, "2026-10-10T11:55:00Z")).toBe("5m");
    expect(ageOf(now, "")).toBe("<unknown>");
    expect(ageOf(now, null)).toBe("<unknown>");
    expect(ageOf(now, "soon")).toBe("<unknown>");
  });
});

describe("the small forms", () => {
  test("goList prints Go's %v of a slice", () => {
    expect(goList(["get", "list"])).toBe("[get list]");
    expect(goList([])).toBe("[]");
  });

  test("objectOf and stringOf take only their own shape", () => {
    expect(objectOf({ a: 1 })).toEqual({ a: 1 });
    expect(objectOf([1])).toBeUndefined();
    expect(objectOf(null)).toBeUndefined();
    expect(stringOf("x")).toBe("x");
    expect(stringOf(1)).toBeUndefined();
  });

  test("textGrid keys each row by the fields, typed as text", () => {
    expect(textGrid(["A", "B"], [["1"], ["2", "3"]])).toEqual({
      fields: ["A", "B"],
      rows: [
        { A: "1", B: null },
        { A: "2", B: "3" },
      ],
      columnTypes: { A: "string", B: "string" },
    });
  });

  test("inTurn runs each item after the one before, keeping the order", async () => {
    const order: number[] = [];
    const results = await inTurn([3, 1, 2], async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      order.push(value);
      return value * 10;
    });
    expect(order).toEqual([3, 1, 2]);
    expect(results).toEqual([30, 10, 20]);
  });
});

describe("ExplainCache", () => {
  test("keeps the most recent entries up to its bound, a read of one refreshing nothing but a write moving it last", () => {
    const cache = new ExplainCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 3);
    cache.set("c", 4);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(3);
    expect(cache.get("c")).toBe(4);
    expect(cache.size).toBe(2);
  });
});

describe("resolveType", () => {
  test("an exact name resolves without a second discovery read", async () => {
    const { context, transport } = consoleContext(routes({}));
    expect((await resolveType(context, "deploy")).resource).toBe("deployments");
    expect(transport.calls.map((call) => call.method)).toEqual(["GET /api", "GET /apis"]);
  });

  test("an unknown name reads discovery again once, then answers kubectl's sentence; a strange name is not echoed", async () => {
    const { context, transport } = consoleContext(routes({}));
    await expect(resolveType(context, "gizmos")).rejects.toThrow(
      'the server doesn\'t have a resource type "gizmos"; list the types it serves with kubectl api-resources.',
    );
    expect(transport.calls).toHaveLength(4);
    await expect(resolveType(context, "giz mos")).rejects.toThrow('resource type "named in the statement"');
  });

  test("a category names several types, which one statement does not read", async () => {
    const { context } = consoleContext(routes({}));
    await expect(resolveType(context, "all")).rejects.toThrow("kubectl get reads one type per statement in v1");
  });
});

describe("namespaceFor and requestTimeoutMs", () => {
  test("-n, else the connection's default; none for -A or a cluster-scoped type", () => {
    const { context } = consoleContext(routes({}), { connection: { database: "web" } });
    expect(namespaceFor(context, { namespaced: true }, {})).toBe("web");
    expect(namespaceFor(context, { namespaced: true }, { namespace: "shop" })).toBe("shop");
    expect(namespaceFor(context, { namespaced: true }, { namespace: "shop", allNamespaces: true })).toBeUndefined();
    expect(namespaceFor(context, { namespaced: false }, { namespace: "shop" })).toBeUndefined();
  });

  test("a request timeout ends at least 5 s before the query timeout", () => {
    const { context } = consoleContext(routes({}), { queryTimeoutMs: 30_000 });
    expect(requestTimeoutMs(context, 25)).toBe(25_000);
    expect(requestTimeoutMs(context, 0.5)).toBe(500);
    expect(() => requestTimeoutMs(context, 25.5)).toThrow("--request-timeout may be at most 25 s here");
  });
});

describe("statementCall", () => {
  test("each call hands its request the time the statement has left, and none past the deadline", () => {
    let clock = 1_000;
    const signal = new AbortController().signal;
    const call = statementCall(signal, 31_000, () => clock);
    expect(call()).toEqual({ signal, timeoutMs: 30_000 });
    clock = 21_000;
    expect(call().timeoutMs).toBe(10_000);
    clock = 31_000;
    expect(() => call()).toThrow(STATEMENT_DEADLINE_SENTENCE);
  });
});
