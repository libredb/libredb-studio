/**
 * What every console command runs with, and the small pieces they share: the run's context, the grid a command
 * answers, resource resolution through discovery, the namespace a statement reads, kubectl's printed forms of an
 * age and a list, and the bounded cache `explain` keeps its OpenAPI documents in.
 *
 * Server-only: it reads through the provider's client.
 */
import { QueryError } from "@/lib/db/errors";
import type { QueryWarning } from "@/lib/types";
import type { KubernetesCall } from "../client";
import type { IndexedResource } from "../discovery";
import { typeMissingSentence } from "../errors";
import { KUBERNETES_TYPE, KUBERNETES_WINDOW_MARGIN_MS } from "../limits";
import type { KubernetesSurface } from "../objects";
import { resolveResource } from "../resolve";
import { KUBECTL_SENTENCES } from "./commands";

/** The OpenAPI group documents `explain` has read, by their immutable URL; the oldest goes first past the bound. */
export class ExplainCache {
  private readonly documents = new Map<string, unknown>();

  constructor(private readonly entries: number) {}

  get(url: string): unknown {
    return this.documents.get(url);
  }

  set(url: string, document: unknown): void {
    this.documents.delete(url);
    this.documents.set(url, document);
    while (this.documents.size > this.entries) this.documents.delete(this.documents.keys().next().value as string);
  }

  get size(): number {
    return this.documents.size;
  }
}

/** One run of one statement. */
export interface KubectlContext {
  readonly surface: KubernetesSurface;
  /**
   * A fresh call for the next request: the run's signal (a cancel, or the session's end) and the time the statement
   * has left, so the query timeout bounds the whole statement and not each request (`statementCall`).
   */
  readonly call: () => KubernetesCall;
  /** Milliseconds since the epoch: the clock ages are printed against. */
  readonly now: () => number;
  readonly explainCache: ExplainCache;
  /** The connection's query timeout, the statement's whole time, which a --request-timeout stays 5 s below. */
  readonly queryTimeoutMs: number;
  /** The build's version for the version command; null when the build names none. */
  readonly appVersion: string | null;
}

/** The one grid a statement answers. */
export interface KubectlGrid {
  readonly fields: string[];
  readonly rows: Record<string, unknown>[];
  readonly columnTypes?: Record<string, string>;
  readonly warnings?: QueryWarning[];
  /** Set when the command itself bounded the answer, as an unpaged list past 5,000 rows is. */
  readonly bounded?: true;
}

/** The sentence of a statement that used the connection's whole query timeout before its next request. */
export const STATEMENT_DEADLINE_SENTENCE =
  "The statement reached the connection's query timeout before it finished: narrow it with -n, -l or --field-selector, or raise the query timeout.";

/**
 * The calls of one statement: each hands its request the time left before the statement's deadline, so pages,
 * reads and streams chained by one statement share one query timeout; once none is left, the next request is
 * refused with a sentence and never sent.
 */
export function statementCall(signal: AbortSignal, deadline: number, now: () => number): () => KubernetesCall {
  return () => {
    const left = deadline - now();
    if (left <= 0) throw new QueryError(STATEMENT_DEADLINE_SENTENCE, KUBERNETES_TYPE);
    return { signal, timeoutMs: left };
  };
}

const TYPE_ECHO = /^[A-Za-z0-9.-]{1,253}$/;

/**
 * The resource a statement's type names, as kubectl resolves it; an unknown name reads discovery again once before
 * the sentence, as kubectl refreshes its cache. A category (`all`, a CRD's own) names several types, which v1 refuses.
 */
export async function resolveType(context: KubectlContext, text: string): Promise<IndexedResource> {
  const discovery = context.surface.discovery;
  const first = resolveResource(await discovery.get(), text);
  const resolution = first.kind === "unknown" ? resolveResource(await discovery.refresh(), text) : first;
  if (resolution.kind === "category") throw new QueryError(KUBECTL_SENTENCES.oneType, KUBERNETES_TYPE);
  if (resolution.kind === "unknown")
    throw new QueryError(
      `${typeMissingSentence(TYPE_ECHO.test(text) ? text : "named in the statement")}; list the types it serves with kubectl api-resources.`,
      KUBERNETES_TYPE,
    );
  return resolution.resource;
}

/**
 * The namespace a request is sent to: none for a cluster-scoped resource or with -A, else -n, else the connection's
 * default namespace, as kubectl falls back to its context's.
 */
export function namespaceFor(
  context: KubectlContext,
  resource: Pick<IndexedResource, "namespaced">,
  statement: { readonly namespace?: string; readonly allNamespaces?: boolean },
): string | undefined {
  if (!resource.namespaced || statement.allNamespaces === true) return undefined;
  return statement.namespace ?? context.surface.endpoint.defaultNamespace;
}

/** The deadline of a --request-timeout in milliseconds, refused when it does not end 5 s before the query timeout. */
export function requestTimeoutMs(context: KubectlContext, seconds: number): number {
  const ms = Math.round(seconds * 1000);
  const most = context.queryTimeoutMs - KUBERNETES_WINDOW_MARGIN_MS;
  if (ms > most)
    throw new QueryError(
      `--request-timeout may be at most ${Math.floor(most / 1000)} s here: the connection's query timeout less 5 s. Nothing was sent.`,
      KUBERNETES_TYPE,
    );
  return ms;
}

/**
 * kubectl's age: `HumanDuration` of Kubernetes' duration package, so a grid reads `5m`, `3h12m` or `2d4h` as kubectl
 * prints them, and `<invalid>` for a time well in the future (`ageOf` answers `<unknown>` for an absent one).
 */
export function humanDuration(ms: number): string {
  const seconds = Math.trunc(ms / 1000);
  if (seconds < -1) return "<invalid>";
  if (seconds < 0) return "0s";
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.trunc(seconds / 60);
  if (minutes < 10) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
  }
  if (minutes < 180) return `${minutes}m`;
  const hours = Math.trunc(minutes / 60);
  if (hours < 8) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  }
  if (hours < 48) return `${hours}h`;
  if (hours < 24 * 8) {
    const rest = hours % 24;
    return rest === 0 ? `${Math.trunc(hours / 24)}d` : `${Math.trunc(hours / 24)}d${rest}h`;
  }
  if (hours < 24 * 365 * 2) return `${Math.trunc(hours / 24)}d`;
  if (hours < 24 * 365 * 8) {
    const days = Math.trunc(hours / 24) % 365;
    const years = Math.trunc(hours / 24 / 365);
    return days === 0 ? `${years}y` : `${years}y${days}d`;
  }
  return `${Math.trunc(hours / 24 / 365)}y`;
}

/** The age of an RFC 3339 time against the context's clock, as kubectl prints it. */
export function ageOf(context: Pick<KubectlContext, "now">, time: unknown): string {
  const at = typeof time === "string" && time !== "" ? Date.parse(time) : Number.NaN;
  return Number.isNaN(at) ? "<unknown>" : humanDuration(context.now() - at);
}

/** Go's `sort.Strings` order: by UTF-16 code unit, never by locale, so a key order is the same on every machine. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A list as Go's `%v` prints a string slice: `[get list watch]`. */
export function goList(values: readonly unknown[]): string {
  return `[${values.map((value) => String(value)).join(" ")}]`;
}

/** A plain JSON object, or undefined. */
export function objectOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** A string field, or undefined. */
export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Runs `work` on each item in turn, keeping the order: the requests of one statement go one after another. */
export async function inTurn<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    // oxlint-disable-next-line no-await-in-loop -- one request after another, so the order and the load are fixed.
    results.push(await work(item));
  }
  return results;
}

/** A grid of text columns. */
export function textGrid(fields: readonly string[], rows: readonly (readonly unknown[])[]): KubectlGrid {
  return {
    fields: [...fields],
    rows: rows.map((cells) => Object.fromEntries(fields.map((field, index) => [field, cells[index] ?? null]))),
    columnTypes: Object.fromEntries(fields.map((field) => [field, "string"])),
  };
}
