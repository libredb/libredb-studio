import { RequestRefusal } from "@/lib/db/console/dialect";
import { QueryCancelledError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { TaggedObject } from "@/lib/db/console/tagged-json";
import type { ProviderLimiter, RunRegistry } from "@/lib/db/utils/bounded-limiter";
import type { QueryResult } from "@/lib/types";
import type { WeaviateAnswer, WeaviateConsoleOp, WeaviateOp, WeaviateRequest, WeaviateSend } from "./client";
import { answerFailure, graphqlFailure } from "./errors";
import { encodeGraphql, encodeRest } from "./graphql";
import {
  parseWeaviateRequest,
  type WeaviatePlan,
  type WeaviateSearchModel,
  weaviatePhase0,
  weaviatePhase1,
} from "./request";
import { weaviateResult } from "./results";
import { WEAVIATE_BOUNDS } from "./routes";
import { readWeaviateClass, type WeaviateCollectionFacts, weaviateCollectionFacts } from "./schema";
import {
  initialPath,
  serverHas,
  versionText,
  type WeaviatePath,
  type WeaviatePathKind,
  type WeaviateVersion,
} from "./versions";

/**
 * Runs one console request (#1566 spec 3.3, 5, W6): phase 0 with no call, then one limiter permit held for the
 * whole request, and strictly one call after another:
 *
 * 1. the collection's definition (`GET /v1/schema/{collection}`) for every route that reads a collection, so phase 1
 *    can check the tenancy rule, the properties and the vector the request names; for `GET /v1/schema/{collection}`
 *    itself that one read is the answer;
 * 2. the tenant's own record (`GET /v1/schema/{collection}/tenants/{tenant}`) for every route that names a tenant,
 *    which never wakes it (spec A.4), and a refusal with no further call unless the tenant is HOT (W6);
 * 3. the request itself: for a search or aggregate, over REST or GraphQL as the version decides, with the one
 *    fallback of spec 3.3 when the server answers that the chosen path is switched off; the path that answered is
 *    remembered for the session, so the next search goes straight to it.
 *
 * One deadline, fixed when the request arrives and before the queue: 10 s for a metadata route and 30 s for an
 * object read, a search or an aggregate, at most the connection's query timeout and below Weaviate's 60 s write
 * timeout (spec A.7). A run registered under its `queryId` can be cancelled; nothing is retried but the fallback,
 * which is a different request and a read.
 */

/** What failed, for errors.ts to word: a non-success answer, or what the transport threw. */
export type WeaviateFailure =
  | { readonly kind: "answer"; readonly op: WeaviateOp; readonly answer: WeaviateAnswer }
  | { readonly kind: "thrown"; readonly op: WeaviateOp; readonly error: unknown };

/** The session's memory of which path answered, per search kind (spec 3.3). */
export interface WeaviatePathState {
  get(kind: WeaviatePathKind): WeaviatePath | undefined;
  set(kind: WeaviatePathKind, path: WeaviatePath): void;
}

export interface WeaviateExecution {
  /** The client's send, narrowed to the operations a console request reaches. */
  readonly send: WeaviateSend<WeaviateOp>;
  readonly limiter: ProviderLimiter;
  readonly runs: RunRegistry;
  /** The version `GET /v1/meta` reported at connect. */
  readonly version: WeaviateVersion;
  readonly paths: WeaviatePathState;
  /** The Studio error for a failure (errors.ts). */
  readonly fail: (failure: WeaviateFailure) => Error;
  /** The connection's query timeout in ms, which bounds every deadline; absent where none is set. */
  readonly queryTimeoutMs?: number;
  /** The clock; only a test passes another. */
  readonly now?: () => number;
  /** The deadline's signal; only a test passes another. */
  readonly deadline?: (ms: number) => AbortSignal;
}

const METADATA_OPS: ReadonlySet<WeaviateConsoleOp> = new Set([
  "meta",
  "schema",
  "collection",
  "shards",
  "tenants",
  "tenant",
  "aliases",
  "alias",
  "nodes",
  "collection_nodes",
]);

/** The routes that read a collection and so need its definition first. */
const READS_COLLECTION: ReadonlySet<WeaviateConsoleOp> = new Set([
  "shards",
  "tenants",
  "tenant",
  "collection_nodes",
  "objects",
  "object",
  "search_bm25",
  "search_hybrid",
  "search_near_vector",
  "search_near_object",
  "aggregate",
]);

/** The statuses under which a tenant answers a read without being woken: HOT, and ACTIVE, its older name. */
const READABLE_TENANT: ReadonlySet<string> = new Set(["HOT", "ACTIVE"]);

const ok = (answer: WeaviateAnswer): boolean => answer.status >= 200 && answer.status < 300;

/** The deadline, in ms, of a request to `op`: a metadata route's or a read's, at most the query timeout. */
export function weaviateDeadlineMs(op: WeaviateConsoleOp, queryTimeoutMs: number | undefined): number {
  const own = METADATA_OPS.has(op) ? WEAVIATE_BOUNDS.metadataDeadlineMs : WEAVIATE_BOUNDS.searchDeadlineMs;
  return queryTimeoutMs === undefined || queryTimeoutMs <= 0 ? own : Math.min(own, queryTimeoutMs);
}

function refuseLater(message: string, key: string | null = null): never {
  throw new RequestRefusal(message, 1, key);
}

/** The tenant's status from its record; the record names the status `activityStatus`. */
function tenantStatus(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const status =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { activityStatus?: unknown }).activityStatus
        : undefined;
    return typeof status === "string" ? status : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function pathKindOf(op: WeaviateConsoleOp): WeaviatePathKind {
  return op === "search_near_vector" ? "near-vector" : "other";
}

/** Whether a failed answer says the path itself is switched off on this server, the one case the other path is tried. */
function pathSwitchedOff(answer: WeaviateAnswer, path: WeaviatePath): boolean {
  const failure = path === "graphql" ? graphqlFailure(answer) : answerFailure(answer);
  if (failure === undefined) return false;
  return path === "graphql"
    ? failure.category === "graphql-disabled"
    : failure.category === "route-absent" || failure.category === "rest-search-disabled";
}

export async function executeWeaviate(
  text: string,
  queryId: string | undefined,
  run: WeaviateExecution,
): Promise<QueryResult> {
  const now = run.now ?? Date.now;
  const startedAt = now();
  const plan0 = weaviatePhase0(parseWeaviateRequest(text));
  const op = plan0.route.op;
  const deadlineMs = weaviateDeadlineMs(op, run.queryTimeoutMs);
  const deadline = (run.deadline ?? ((ms: number) => AbortSignal.timeout(ms)))(deadlineMs);
  const handle = run.runs.begin(queryId, deadline);
  const stopped = (): Error => {
    const reason: unknown = handle.signal.reason;
    if (reason instanceof QueryCancelledError) return reason;
    return new TimeoutError(`The request did not finish within its ${deadlineMs / 1000} s deadline.`);
  };
  /** One call; a thrown failure is worded, and an answer is handed back whatever its status. */
  const raw = async (request: WeaviateRequest): Promise<WeaviateAnswer> => {
    try {
      return await run.send(request, handle.signal);
    } catch (error) {
      const unreachable = error instanceof TransportError && error.kind === "unreachable";
      if (handle.signal.aborted && !unreachable) throw stopped();
      throw run.fail({ kind: "thrown", op: request.op, error });
    }
  };
  /** One call whose failure is the request's failure. */
  const call = async (request: WeaviateRequest): Promise<WeaviateAnswer> => {
    const answer = await raw(request);
    const failed = request.op === "graphql" ? graphqlFailure(answer) !== undefined : !ok(answer);
    if (failed) throw run.fail({ kind: "answer", op: request.op, answer });
    return answer;
  };
  try {
    let ticket: Awaited<ReturnType<ProviderLimiter["acquire"]>>;
    try {
      ticket = await run.limiter.acquire(handle.signal);
    } catch (error) {
      if (handle.signal.aborted) throw stopped();
      throw error;
    }
    try {
      const collectionParams: Record<string, string> =
        plan0.collection === null ? {} : { collection: plan0.collection };
      let facts: WeaviateCollectionFacts | null = null;
      if (plan0.collection !== null && (READS_COLLECTION.has(op) || op === "collection")) {
        const answer = await call({ op: "collection", params: collectionParams, query: {} });
        if (op === "collection") {
          return weaviateResult(answer.text, resultShape(plan0, null, null), { executionTime: now() - startedAt });
        }
        facts = weaviateCollectionFacts(readWeaviateClass(JSON.parse(answer.text), plan0.collection));
      }
      const plan = facts === null ? plan0 : weaviatePhase1(plan0, facts);
      if (plan.tenant !== null && plan.collection !== null && op !== "tenant") {
        const record = await call({
          op: "tenant",
          params: { collection: plan.collection, tenant: plan.tenant },
          query: {},
        });
        const status = tenantStatus(record.text);
        if (!READABLE_TENANT.has(status)) {
          refuseLater(
            `The tenant ${JSON.stringify(plan.tenant)} is ${status}. Studio does not activate a tenant by reading it, so nothing was read: set the tenant HOT on the server first.`,
            "tenant",
          );
        }
      }
      const params = op === "objects" ? {} : { ...plan.request.params, ...collectionParams };
      if (plan.search === null) {
        const answer = await call({ op, params, query: plan.query });
        return weaviateResult(answer.text, resultShape(plan, facts, null), { executionTime: now() - startedAt });
      }
      const kind = pathKindOf(op);
      const first = run.paths.get(kind) ?? initialPath(run.version, kind);
      const send = (path: WeaviatePath): Promise<WeaviateAnswer> =>
        raw(
          path === "rest"
            ? { op, params, query: {}, body: encodeRest(plan.body as TaggedObject, plan.search as WeaviateSearchModel) }
            : {
                op: "graphql",
                params: {},
                query: {},
                body: encodeGraphql(plan.search as WeaviateSearchModel, facts as WeaviateCollectionFacts),
              },
        );
      let path = first;
      let answer = await send(path);
      if (pathSwitchedOff(answer, path)) {
        const other: WeaviatePath = path === "rest" ? "graphql" : "rest";
        const second = await send(other);
        if (pathSwitchedOff(second, other)) {
          refuseLater(
            `This Weaviate server (${versionText(run.version)}) serves this search neither over REST search, which it lacks or keeps behind EXPERIMENTAL_REST_SEARCH_ENABLED, nor over GraphQL, which it has disabled. Browsing the collections still works.`,
          );
        }
        path = other;
        answer = second;
      }
      const failed = path === "graphql" ? graphqlFailure(answer) !== undefined : !ok(answer);
      if (failed) throw run.fail({ kind: "answer", op: path === "graphql" ? "graphql" : op, answer });
      run.paths.set(kind, path);
      return weaviateResult(answer.text, resultShape(plan, facts, path, run.version), {
        executionTime: now() - startedAt,
      });
    } finally {
      ticket.release();
    }
  } finally {
    handle.end();
  }
}

/** Whether a where filter holds a WithinGeoRange condition at any level. */
function holdsGeoRange(filter: unknown): boolean {
  if (typeof filter !== "object" || filter === null) return false;
  const node = filter as { readonly operator?: unknown; readonly operands?: unknown };
  if (node.operator === "WithinGeoRange") return true;
  return Array.isArray(node.operands) && node.operands.some(holdsGeoRange);
}

/**
 * An aggregate filtered by WithinGeoRange counts 0 on the 1.37 line while Get finds the objects (measured on 1.37.4:
 * 0 against 500; 1.38.22 and 1.40.2 count 500), so a count from such a server says so.
 */
function geoAggregateNote(plan: WeaviatePlan, version: WeaviateVersion | undefined) {
  const search = plan.search;
  if (version === undefined || search === null || search.op !== "aggregate" || !holdsGeoRange(search.where)) return [];
  if (serverHas(version, GEO_AGGREGATE_SINCE)) return [];
  return [
    {
      message: `Weaviate ${versionText(version)} counts an aggregate filtered by WithinGeoRange as 0 even where objects match (measured on 1.37.4); read the objects with a search, or count on 1.38 or later.`,
    },
  ];
}

/** The first line measured to count a WithinGeoRange aggregate correctly. */
const GEO_AGGREGATE_SINCE = [1, 38, 0] as const;

function resultShape(
  plan: WeaviatePlan,
  facts: WeaviateCollectionFacts | null,
  path: WeaviatePath | null,
  version?: WeaviateVersion,
) {
  const pathNote = [
    ...(path === null ? [] : [{ message: path === "rest" ? "Answered via REST search." : "Answered via GraphQL." }]),
    ...geoAggregateNote(plan, version),
  ];
  return {
    op: plan.route.op,
    facts,
    path,
    model: plan.search,
    // The next page is read with after, which takes neither offset nor sort: no notice for a list that names either.
    limit:
      plan.route.op === "objects" && !Object.hasOwn(plan.query, "offset") && !Object.hasOwn(plan.query, "sort")
        ? Number(plan.query.limit)
        : null,
    afterGiven: Object.hasOwn(plan.query, "after"),
    warnings: [...plan.warnings, ...pathNote],
  };
}
