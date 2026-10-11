/**
 * `kubectl top`: kubectl's CPU and memory formats from exact quantities, pod sums, -A, --sort-by, node percentages
 * only where nodes are readable, `<unknown>` rows, and the sentence when the metrics API is absent.
 */
import { describe, expect, test } from "bun:test";
import { TransportError } from "@/lib/db/http/node-transport";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import {
  METRICS_ABSENT_SENTENCE,
  milliValue,
  parseQuantity,
  readTop,
  sumQuantities,
  wholeValue,
} from "@/lib/db/providers/platform/kubernetes/console/top";
import { consoleContext, listAnswer, routes, sentLines } from "../../../../helpers/kubernetes-console";
import { CORE_DISCOVERY, discoveryList } from "../../../../helpers/kubernetes-discovery";
import { jsonAnswer, statusAnswer } from "../../../../helpers/kubernetes-transport";

type Top = Extract<KubectlStatement, { readonly command: "top" }>;

function top(text: string): Top {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "top") throw new Error(`not top: ${text}`);
  return parsed.statement;
}

const podMetrics = (name: string, namespace: string, usages: readonly [string, string][]) => ({
  metadata: { name, namespace },
  containers: usages.map(([cpu, memory], index) => ({ name: `c${index}`, usage: { cpu, memory } })),
});

const nodeMetrics = (name: string, cpu: string, memory: string) => ({ metadata: { name }, usage: { cpu, memory } });
const node = (name: string, cpu: string, memory: string) => ({
  metadata: { name },
  status: { allocatable: { cpu, memory } },
});

describe("top pod", () => {
  test("each pod's containers summed, in millicores and mebibytes, rounded as kubectl rounds", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500": listAnswer([
        podMetrics("web", "shop", [
          ["1500000n", "65536Ki"],
          ["2m", "1Mi"],
        ]),
        podMetrics("api", "shop", [["0", "1048575"]]),
      ]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await readTop(context, top("kubectl top pod"));
    expect(sentLines(transport)).toEqual(["GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500"]);
    expect(grid.fields).toEqual(["NAME", "CPU(cores)", "MEMORY(bytes)"]);
    expect(grid.rows).toEqual([
      { NAME: "web", "CPU(cores)": "4m", "MEMORY(bytes)": "65Mi" },
      { NAME: "api", "CPU(cores)": "0m", "MEMORY(bytes)": "0Mi" },
    ]);
  });

  test("-A adds NAMESPACE; --sort-by sorts largest first; -l reaches the query", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/pods?limit=500&labelSelector=app%3Dweb": listAnswer([
        podMetrics("small", "a", [["1m", "10Mi"]]),
        podMetrics("big", "b", [["5m", "5Mi"]]),
      ]),
    });
    const { context } = consoleContext(answer);
    expect((await readTop(context, top("top pods -A -l app=web --sort-by=cpu"))).rows).toEqual([
      { NAMESPACE: "b", NAME: "big", "CPU(cores)": "5m", "MEMORY(bytes)": "5Mi" },
      { NAMESPACE: "a", NAME: "small", "CPU(cores)": "1m", "MEMORY(bytes)": "10Mi" },
    ]);
    expect(
      (await readTop(context, top("top pods -A -l app=web --sort-by=memory"))).rows.map((row) => row.NAME),
    ).toEqual(["small", "big"]);
  });

  test("a server without the metrics API answers kubectl's sentence and sends nothing", async () => {
    const answer = routes({ "GET /apis": jsonAnswer(discoveryList([])) });
    const { context, transport } = consoleContext(answer);
    await expect(readTop(context, top("top pod"))).rejects.toThrow(METRICS_ABSENT_SENTENCE);
    expect(sentLines(transport)).toEqual([]);
  });

  test("a usage past the quantity bounds answers the unreadable-quantity sentence at once", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500": listAnswer([
        podMetrics("web", "shop", [["1e999999999", "1Mi"]]),
      ]),
    });
    const { context } = consoleContext(answer);
    await expect(readTop(context, top("top pod"))).rejects.toThrow(
      "The metrics answer for pod web holds a quantity Studio cannot read.",
    );
  });

  test("an unreadable quantity answers a sentence", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500": listAnswer([
        podMetrics("web", "shop", [["lots", "1Mi"]]),
      ]),
    });
    const { context } = consoleContext(answer);
    await expect(readTop(context, top("top pod"))).rejects.toThrow(
      "The metrics answer for pod web holds a quantity Studio cannot read.",
    );
  });
});

describe("top node", () => {
  test("percentages over allocatable, truncated; a node without metrics reads <unknown>", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([
        nodeMetrics("n1", "250m", "1Gi"),
        nodeMetrics("n2", "1999m", "3Gi"),
        nodeMetrics("ghost", "1m", "1Mi"),
      ]),
      "GET /api/v1/nodes?limit=500": listAnswer([
        node("n1", "2", "4Gi"),
        node("n2", "2", "4Gi"),
        node("n3", "2", "4Gi"),
      ]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await readTop(context, top("kubectl top node"));
    expect(sentLines(transport)).toEqual([
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500",
      "GET /api/v1/nodes?limit=500",
    ]);
    expect(grid.fields).toEqual(["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"]);
    expect(grid.rows).toEqual([
      { NAME: "n1", "CPU(cores)": "250m", "CPU(%)": "12%", "MEMORY(bytes)": "1024Mi", "MEMORY(%)": "25%" },
      { NAME: "n2", "CPU(cores)": "1999m", "CPU(%)": "99%", "MEMORY(bytes)": "3072Mi", "MEMORY(%)": "75%" },
      { NAME: "ghost", "CPU(cores)": "1m", "CPU(%)": "<unknown>", "MEMORY(bytes)": "1Mi", "MEMORY(%)": "<unknown>" },
      {
        NAME: "n3",
        "CPU(cores)": "<unknown>",
        "CPU(%)": "<unknown>",
        "MEMORY(bytes)": "<unknown>",
        "MEMORY(%)": "<unknown>",
      },
    ]);
  });

  test("an identity that may not list nodes sees no percentages, and a warning says why", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([nodeMetrics("n1", "250m", "1Gi")]),
      "GET /api/v1/nodes?limit=500": statusAnswer(403, "Forbidden"),
    });
    const { context } = consoleContext(answer);
    const grid = await readTop(context, top("top node"));
    expect(grid.fields).toEqual(["NAME", "CPU(cores)", "MEMORY(bytes)"]);
    expect(grid.warnings?.[0].message).toContain("this identity may not list nodes");
  });

  test("a server that lists no nodes resource shows no percentages either; a zero allocatable reads <unknown>", async () => {
    const coreWithoutNodes = discoveryList([
      {
        versions: [
          {
            version: "v1",
            resources: (
              CORE_DISCOVERY.items as { versions: { resources: { resource: string }[] }[] }[]
            )[0].versions[0].resources.filter((entry) => entry.resource !== "nodes"),
          },
        ],
      },
    ]);
    const without = consoleContext(
      routes({
        "GET /api": jsonAnswer(coreWithoutNodes),
        "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([]),
      }),
    );
    expect((await readTop(without.context, top("top node"))).fields).toHaveLength(3);
    const zero = consoleContext(
      routes({
        "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([nodeMetrics("n1", "1m", "1Mi")]),
        "GET /api/v1/nodes?limit=500": listAnswer([node("n1", "0", "0")]),
      }),
    );
    expect((await readTop(zero.context, top("top node"))).rows[0]["CPU(%)"]).toBe("<unknown>");
  });

  test("the nodes are read in pages of 500 with continue", async () => {
    const many = Array.from({ length: 501 }, (_unused, index) => node(`n${index}`, "2", "4Gi"));
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([nodeMetrics("n500", "1", "2Gi")]),
      "GET /api/v1/nodes?limit=500": listAnswer(many.slice(0, 500), { continue: "500" }),
      "GET /api/v1/nodes?limit=500&continue=500": listAnswer(many.slice(500)),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await readTop(context, top("top node"));
    expect(sentLines(transport)).toEqual([
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500",
      "GET /api/v1/nodes?limit=500",
      "GET /api/v1/nodes?limit=500&continue=500",
    ]);
    expect(grid.rows[0]).toEqual({
      NAME: "n500",
      "CPU(cores)": "1000m",
      "CPU(%)": "50%",
      "MEMORY(bytes)": "2048Mi",
      "MEMORY(%)": "50%",
    });
  });

  test("a node page past the response cap, or more than 5,000 nodes, leaves the percentages out with a warning", async () => {
    const tooLarge = consoleContext(
      routes({
        "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([nodeMetrics("n1", "250m", "1Gi")]),
        "GET /api/v1/nodes?limit=500": () => {
          throw new TransportError("too-large", "x");
        },
      }),
    );
    const large = await readTop(tooLarge.context, top("top node"));
    expect(large.fields).toEqual(["NAME", "CPU(cores)", "MEMORY(bytes)"]);
    expect(large.rows).toEqual([{ NAME: "n1", "CPU(cores)": "250m", "MEMORY(bytes)": "1024Mi" }]);
    expect(large.warnings?.[0].message).toContain("the node list is larger than one statement reads");
    const pages: Record<string, ReturnType<typeof listAnswer>> = {
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([nodeMetrics("n1", "250m", "1Gi")]),
    };
    for (let start = 0; start < 5_000; start += 500) {
      const line = start === 0 ? "GET /api/v1/nodes?limit=500" : `GET /api/v1/nodes?limit=500&continue=${start}`;
      pages[line] = listAnswer(
        Array.from({ length: 500 }, (_unused, index) => node(`n${start + index}`, "2", "4Gi")),
        { continue: String(start + 500) },
      );
    }
    const capped = consoleContext(routes(pages));
    const many = await readTop(capped.context, top("top node"));
    expect(many.fields).toHaveLength(3);
    expect(many.warnings?.[0].message).toContain("the node list is larger than one statement reads");
  });

  test("more than 5,000 objects reporting metrics answer the sentence to narrow", async () => {
    const pages: Record<string, ReturnType<typeof listAnswer>> = {};
    for (let start = 0; start < 5_000; start += 500) {
      const line =
        start === 0
          ? "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500"
          : `GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500&continue=${start}`;
      pages[line] = listAnswer(
        Array.from({ length: 500 }, (_unused, index) => podMetrics(`p${start + index}`, "shop", [["1m", "1Mi"]])),
        { continue: String(start + 500) },
      );
    }
    const { context } = consoleContext(routes(pages));
    await expect(readTop(context, top("top pod"))).rejects.toThrow(
      "More than 5,000 objects report metrics: narrow kubectl top with -l or -n.",
    );
  });

  test("another failure of the nodes read is raised", async () => {
    const answer = routes({
      "GET /apis/metrics.k8s.io/v1beta1/nodes?limit=500": listAnswer([]),
      "GET /api/v1/nodes?limit=500": statusAnswer(500, "InternalError"),
    });
    const { context } = consoleContext(answer);
    await expect(readTop(context, top("top node"))).rejects.toThrow("(HTTP 500, reason InternalError)");
  });
});

describe("quantities", () => {
  test.each([
    ["1", "1000", "1"],
    ["1.5", "1500", "2"],
    [".5", "500", "1"],
    ["5.", "5000", "5"],
    ["100m", "100", "1"],
    ["1500000n", "2", "1"],
    ["250u", "1", "1"],
    ["2k", "2000000", "2000"],
    ["1Mi", "1048576000", "1048576"],
    ["1e3", "1000000", "1000"],
    ["1E", "1000000000000000000000", "1000000000000000000"],
    ["-1", "-1000", "-1"],
  ])("%s", (text, milli, whole) => {
    const value = parseQuantity(text);
    if (value === undefined) throw new Error("expected a quantity");
    expect(String(milliValue(value))).toBe(milli);
    expect(String(wholeValue(value))).toBe(whole);
  });

  test("text that is not a quantity", () => {
    for (const text of ["", "x", "1.2.3", "1Ki2", "1 Mi"]) expect(parseQuantity(text)).toBeUndefined();
  });

  test("a quantity past the bounds Studio reads is not one: a long mantissa or a large exponent", () => {
    const digits = (count: number) => "1".repeat(count);
    for (const text of [
      "1e999999999",
      "1e31",
      "1e-31",
      "1e100",
      digits(41),
      `0.${digits(41)}`,
      `.${digits(41)}`,
      `${digits(41)}Mi`,
    ])
      expect(parseQuantity(text)).toBeUndefined();
    for (const text of ["1e30", "1e-30", "1E+2", digits(40), `${digits(40)}.${digits(40)}`, `.${digits(40)}`])
      expect(parseQuantity(text)).toBeDefined();
  });

  test("a sum keeps the smallest common denominator, so many fractions stay small", () => {
    const fraction = parseQuantity(`0.${"1".repeat(40)}`);
    if (fraction === undefined) throw new Error("expected a quantity");
    const total = sumQuantities(Array.from({ length: 1_000 }, () => fraction));
    expect(String(total.denominator)).toBe(`1${"0".repeat(40)}`);
    expect(String(total.numerator)).toBe(`${"1".repeat(40)}000`);
    const mixed = sumQuantities([
      parseQuantity("1.5") as never,
      parseQuantity("250m") as never,
      parseQuantity("1Ki") as never,
    ]);
    expect(String(milliValue(mixed))).toBe("1025750");
  });
});
