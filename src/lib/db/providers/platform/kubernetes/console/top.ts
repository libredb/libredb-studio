/**
 * `kubectl top pod` and `kubectl top node` through `metrics.k8s.io`, printed as kubectl prints them: CPU in
 * millicores (`250m`), memory in mebibytes rounded down (`64Mi`), a pod's usage the sum of its containers'. Node
 * percentages are usage over the node's allocatable, truncated, and are shown only when this identity may list
 * nodes and the node list fits one statement; a node the metrics do not cover reads `<unknown>`. --sort-by sorts by
 * CPU or memory, largest first. Every list is read in pages of 500 with `continue`, within 5,000 objects.
 * A server without the metrics API answers kubectl's sentence that metrics-server is not there.
 *
 * Quantities are read with Kubernetes' own suffixes (`n`, `u`, `m`, `k`, `M`, `G`, `T`, `P`, `E`, `Ki` to `Ei`,
 * exponents) as exact fractions, and rounded up to a whole milli-unit or unit as `resource.Quantity` rounds.
 */
import { QueryError } from "@/lib/db/errors";
import { ACCEPT_JSON } from "../client";
import { findResource, type IndexedResource } from "../discovery";
import { KubernetesRequestError, KubernetesResponseTooLargeError } from "../errors";
import { KUBERNETES_MAX_STATEMENT_ROWS, KUBERNETES_PAGE_SIZE, KUBERNETES_TYPE } from "../limits";
import { redactResponse } from "../redaction";
import { type KubeTable, parseTable, scanTable } from "../table";
import { type KubectlContext, type KubectlGrid, objectOf, stringOf, textGrid } from "./context";
import type { KubectlStatement } from "./parse";

type TopStatement = Extract<KubectlStatement, { readonly command: "top" }>;

type Json = Readonly<Record<string, unknown>>;

export const METRICS_ABSENT_SENTENCE =
  "Metrics API not available: this cluster serves no metrics.k8s.io, so install metrics-server to read kubectl top.";

const NODE_PERCENT_WARNING =
  "CPU(%) and MEMORY(%) need the nodes' allocatable resources, and this identity may not list nodes, so they are left out.";

const NODE_SIZE_WARNING =
  "CPU(%) and MEMORY(%) need the nodes' allocatable resources, and the node list is larger than one statement reads, so they are left out.";

const METRICS_CAP_SENTENCE = "More than 5,000 objects report metrics: narrow kubectl top with -l or -n.";

const BINARY: Readonly<Record<string, number>> = { Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60 };
const DECIMAL: Readonly<Record<string, number>> = { n: -9, u: -6, m: -3, "": 0, k: 3, M: 6, G: 9, T: 12, P: 15, E: 18 };

// The build targets ES2017, which has no bigint literals, so the few constants are built once.
const ZERO_N = BigInt(0);
const ONE_N = BigInt(1);
const TWO_N = BigInt(2);
const TEN_N = BigInt(10);
const THOUSAND_N = BigInt(1000);
const MEBIBYTE_N = BigInt(1024 * 1024);

/** A quantity as an exact fraction: numerator over denominator. */
interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** The largest exponent a quantity may carry, `1e30` or `1e-30`: no metric a cluster reports comes near it. */
const MAX_EXPONENT = 30;

/**
 * A Kubernetes quantity as an exact fraction, or undefined when the text is not one. The answer comes from the API
 * server, so the digits (at most 40 on each side of the point) and the exponent are bounded before any BigInt work:
 * an unbounded exponent would hold the event loop for seconds, and such a value reads as unreadable.
 */
export function parseQuantity(text: string): Fraction | undefined {
  const match =
    /^([+-]?)([0-9]{1,40}(?:\.[0-9]{0,40})?|\.[0-9]{1,40})(?:([eE][+-]?[0-9]{1,2})|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE])?)$/.exec(
      text,
    );
  if (match === null) return undefined;
  const [, sign, digits, exponent, suffix = ""] = match;
  if (exponent !== undefined && Math.abs(Number(exponent.slice(1))) > MAX_EXPONENT) return undefined;
  const [whole, fraction = ""] = digits.split(".");
  let numerator = BigInt(`${whole}${fraction}` === "" ? "0" : `${whole}${fraction}`);
  let denominator = TEN_N ** BigInt(fraction.length);
  if (sign === "-") numerator = -numerator;
  const scale = (power: bigint, base: bigint) => {
    if (power >= ZERO_N) numerator *= base ** power;
    else denominator *= base ** -power;
  };
  if (exponent !== undefined) scale(BigInt(exponent.slice(1)), TEN_N);
  else if (suffix in BINARY) scale(BigInt(BINARY[suffix]), TWO_N);
  else scale(BigInt(DECIMAL[suffix]), TEN_N);
  return { numerator, denominator };
}

/** The fraction times `scale`, rounded up, as `Quantity.ScaledValue` rounds. */
function ceilScaled(value: Fraction, scale: bigint): bigint {
  const scaled = value.numerator * scale;
  const quotient = scaled / value.denominator;
  return scaled % value.denominator > ZERO_N ? quotient + ONE_N : quotient;
}

/** `Quantity.MilliValue`. */
export function milliValue(value: Fraction): bigint {
  return ceilScaled(value, THOUSAND_N);
}

/** `Quantity.Value`. */
export function wholeValue(value: Fraction): bigint {
  return ceilScaled(value, ONE_N);
}

const ZERO: Fraction = { numerator: ZERO_N, denominator: ONE_N };

function quantityOf(text: unknown, where: string): Fraction {
  const value = typeof text === "string" ? parseQuantity(text) : undefined;
  if (value === undefined)
    throw new QueryError(`The metrics answer for ${where} holds a quantity Studio cannot read.`, KUBERNETES_TYPE);
  return value;
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b];
  while (y !== ZERO_N) [x, y] = [y, x % y];
  return x;
}

/**
 * The sum of fractions over their least common denominator, so a pod of many containers keeps its denominator as
 * small as its largest one rather than their product.
 */
export function sumQuantities(values: readonly Fraction[]): Fraction {
  return values.reduce((total, value) => {
    const common = (total.denominator / gcd(total.denominator, value.denominator)) * value.denominator;
    return {
      numerator: total.numerator * (common / total.denominator) + value.numerator * (common / value.denominator),
      denominator: common,
    };
  }, ZERO);
}

const cpuText = (value: Fraction): string => `${milliValue(value)}m`;
const memoryText = (value: Fraction): string => `${wholeValue(value) / MEBIBYTE_N}Mi`;

/** kubectl's percentage: usage over allocatable in milli-units, times 100, truncated. */
function percent(usage: Fraction, allocatable: Fraction): string {
  const available = milliValue(allocatable);
  if (available === ZERO_N) return "<unknown>";
  return `${Math.trunc((Number(milliValue(usage)) / Number(available)) * 100)}%`;
}

/**
 * The items of one list, walked with `continue` in pages of 500 within the 5,000 a statement reads; `more` says the
 * list holds past them. Each page is redacted before it is read.
 */
async function itemsOf(
  context: KubectlContext,
  target: IndexedResource,
  namespace: string | undefined,
  labelSelector: string | undefined,
): Promise<{ readonly items: readonly Json[]; readonly more: boolean }> {
  const read = async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await context.surface.client.json(
      {
        op: "list",
        target,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          limit: page.limit,
          ...(labelSelector === undefined ? {} : { labelSelector }),
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...context.call(), accept: ACCEPT_JSON },
    );
    return parseTable(redactResponse(target, body));
  };
  const scan = await scanTable(read, {
    offset: 0,
    limit: KUBERNETES_MAX_STATEMENT_ROWS,
    pageSize: KUBERNETES_PAGE_SIZE,
  });
  return { items: scan.rows.map((row) => row.object ?? {}), more: scan.more };
}

/** The metrics of one list, refused past the 5,000 a statement reads. */
async function metricsOf(
  context: KubectlContext,
  target: IndexedResource,
  namespace: string | undefined,
  labelSelector: string | undefined,
): Promise<readonly Json[]> {
  const { items, more } = await itemsOf(context, target, namespace, labelSelector);
  if (more) throw new QueryError(METRICS_CAP_SENTENCE, KUBERNETES_TYPE);
  return items;
}

interface Usage {
  readonly namespace: string;
  readonly name: string;
  readonly cpu: Fraction;
  readonly memory: Fraction;
}

function sorted(usages: readonly Usage[], sortBy: TopStatement["sortBy"]): readonly Usage[] {
  if (sortBy === undefined) return usages;
  const key = (usage: Usage) => (sortBy === "cpu" ? milliValue(usage.cpu) : wholeValue(usage.memory));
  return [...usages].sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));
}

async function topPods(
  context: KubectlContext,
  statement: TopStatement,
  metrics: IndexedResource,
): Promise<KubectlGrid> {
  const namespace = statement.allNamespaces
    ? undefined
    : (statement.namespace ?? context.surface.endpoint.defaultNamespace);
  const usages = (await metricsOf(context, metrics, namespace, statement.labelSelector)).map((item): Usage => {
    const metadata = objectOf(item.metadata) ?? {};
    const name = stringOf(metadata.name) ?? "";
    const containers = Array.isArray(item.containers) ? item.containers.map((entry) => objectOf(entry) ?? {}) : [];
    const usage = (resource: "cpu" | "memory") =>
      sumQuantities(
        containers.map((container) => quantityOf(objectOf(container.usage)?.[resource] ?? "0", `pod ${name}`)),
      );
    return { namespace: stringOf(metadata.namespace) ?? "", name, cpu: usage("cpu"), memory: usage("memory") };
  });
  const fields = [...(statement.allNamespaces ? ["NAMESPACE"] : []), "NAME", "CPU(cores)", "MEMORY(bytes)"];
  return textGrid(
    fields,
    sorted(usages, statement.sortBy).map((usage) => {
      const cells: unknown[] = statement.allNamespaces ? [usage.namespace] : [];
      cells.push(usage.name, cpuText(usage.cpu), memoryText(usage.memory));
      return cells;
    }),
  );
}

type Allocatable = ReadonlyMap<string, { readonly cpu: Fraction; readonly memory: Fraction }>;

/**
 * The nodes' allocatable CPU and memory by name, or the warning that says why the percentages are left out: this
 * identity may not list nodes, or the node list is past what one statement reads (more than 5,000 nodes, or a page
 * past the response cap). Usage is answered either way, as kubectl answers it without the percentages.
 */
async function allocatable(
  context: KubectlContext,
  labelSelector: string | undefined,
): Promise<{ readonly nodes: Allocatable } | { readonly warning: string }> {
  const nodes = findResource(await context.surface.discovery.get(), "", "nodes");
  if (nodes === undefined || !nodes.verbs.includes("list")) return { warning: NODE_PERCENT_WARNING };
  try {
    const { items, more } = await itemsOf(context, nodes, undefined, labelSelector);
    if (more) return { warning: NODE_SIZE_WARNING };
    const read: Allocatable = new Map(
      items.map((node) => {
        const name = stringOf(objectOf(node.metadata)?.name) ?? "";
        const resources = objectOf(objectOf(node.status)?.allocatable) ?? {};
        return [
          name,
          {
            cpu: quantityOf(resources.cpu ?? "0", `node ${name}`),
            memory: quantityOf(resources.memory ?? "0", `node ${name}`),
          },
        ];
      }),
    );
    return { nodes: read };
  } catch (error) {
    if (error instanceof KubernetesRequestError && error.status === 403) return { warning: NODE_PERCENT_WARNING };
    if (error instanceof KubernetesResponseTooLargeError) return { warning: NODE_SIZE_WARNING };
    throw error;
  }
}

async function topNodes(
  context: KubectlContext,
  statement: TopStatement,
  metrics: IndexedResource,
): Promise<KubectlGrid> {
  const usages = (await metricsOf(context, metrics, undefined, statement.labelSelector)).map((item): Usage => {
    const name = stringOf(objectOf(item.metadata)?.name) ?? "";
    const usage = objectOf(item.usage) ?? {};
    return {
      namespace: "",
      name,
      cpu: quantityOf(usage.cpu ?? "0", `node ${name}`),
      memory: quantityOf(usage.memory ?? "0", `node ${name}`),
    };
  });
  const read = await allocatable(context, statement.labelSelector);
  if ("warning" in read) {
    const grid = textGrid(
      ["NAME", "CPU(cores)", "MEMORY(bytes)"],
      sorted(usages, statement.sortBy).map((usage) => [usage.name, cpuText(usage.cpu), memoryText(usage.memory)]),
    );
    return { ...grid, warnings: [{ message: read.warning }] };
  }
  const { nodes } = read;
  const rows = sorted(usages, statement.sortBy).map((usage) => {
    const node = nodes.get(usage.name);
    return [
      usage.name,
      cpuText(usage.cpu),
      node === undefined ? "<unknown>" : percent(usage.cpu, node.cpu),
      memoryText(usage.memory),
      node === undefined ? "<unknown>" : percent(usage.memory, node.memory),
    ];
  });
  // A node the metrics do not cover is printed as kubectl prints it.
  const reported = new Set(usages.map((usage) => usage.name));
  for (const name of nodes.keys()) {
    if (!reported.has(name)) rows.push([name, "<unknown>", "<unknown>", "<unknown>", "<unknown>"]);
  }
  return textGrid(["NAME", "CPU(cores)", "CPU(%)", "MEMORY(bytes)", "MEMORY(%)"], rows);
}

export async function readTop(context: KubectlContext, statement: TopStatement): Promise<KubectlGrid> {
  const index = await context.surface.discovery.get();
  const metrics = findResource(index, "metrics.k8s.io", statement.resource === "pod" ? "pods" : "nodes");
  if (metrics === undefined) throw new QueryError(METRICS_ABSENT_SENTENCE, KUBERNETES_TYPE);
  return statement.resource === "pod" ? topPods(context, statement, metrics) : topNodes(context, statement, metrics);
}
