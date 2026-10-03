/**
 * One console request, run.
 *
 * The text goes through the console's grammar and every rule that reads the text alone, then the version gates, with
 * no call and no permit, so a refused text costs the server nothing. An accepted request is one run under the
 * caller's id, so `cancelQuery` reaches it while it runs and while it waits; it takes one limiter permit for the whole
 * request and holds one deadline, which its wait for the permit, its metadata reads and its execution call share: 10
 * seconds for a metadata route and 30 for a query or a search, each capped by the connection's query timeout. The
 * metadata reads are made for this request and never kept, because a wrong vector for a changed schema is costly on
 * the server: one DescribeCollection for a query, a get or a search, and one DescribeIndex where the request's checks
 * need the index. The calls are issued strictly one after another, so a request never has two in flight.
 *
 * A DescribeIndex refused for want of a privilege is passed on as unreadable, never raised, so a search that names no
 * metric and no parameter still runs; a collection with no index answers an index list with no entry. A rule that
 * needs the schema refuses after those reads and before any execution call. Every failure goes through errors.ts's
 * table, worded with the request's own route. A metadata route's answer becomes named, typed columns.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseType, QueryResult } from "@/lib/db/types";
import {
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import { serverText } from "@/lib/db/utils/server-text";
import { countLabel } from "@/lib/db/vector/count";
import {
  type CallOptions,
  type DescribeIndexRequest,
  type MilvusClient,
  MilvusError,
  type WireIndexDescription,
  type WireKeyValuePair,
} from "./client";
import { type MilvusErrorConnection, type MilvusErrorContext, toMilvusError, toProviderError } from "./errors";
import { fieldTypeText } from "./milvus-vocabulary";
import { statisticsRowCount } from "./monitoring";
import {
  type IndexReading,
  type MilvusOperation,
  type MilvusPhase0,
  milvusMetadataReads,
  milvusPhase0,
  milvusPhase1,
  milvusVersionGates,
  parseMilvusRequest,
} from "./request";
import { countResult, queryResult, searchResult, tableResult } from "./results";
import { describedSchema, indexParam } from "./schema";
import { MILVUS_PARTITIONS_LISTED } from "./source";
import { type MilvusVersion, versionGateRefusal } from "./versions";

const PROVIDER: DatabaseType = "milvus";

/** A request's one deadline, before the connection's query timeout caps it. */
export const MILVUS_METADATA_DEADLINE_MS = 10_000;
export const MILVUS_ENTITIES_DEADLINE_MS = 30_000;

/** Every client method a console request can call: reads only. */
export type MilvusExecuteClient = Pick<
  MilvusClient,
  | "listDatabases"
  | "describeDatabase"
  | "showCollections"
  | "describeCollection"
  | "describeIndex"
  | "getLoadState"
  | "getLoadingProgress"
  | "getCollectionStatistics"
  | "showPartitions"
  | "listAliases"
  | "describeAlias"
  | "query"
  | "search"
  | "hybridSearch"
>;

export interface MilvusExecuteContext {
  /** The connection's database; a `dbName` in the body overrides it. */
  readonly database: string;
  /** GetVersion's answer at connect, which the version gates read. */
  readonly version: MilvusVersion;
  /** The provider instance's limiter: a console request and a panel share its bound. */
  readonly limiter: ProviderLimiter;
  /** The provider instance's runs, which `cancelQuery` reaches. */
  readonly runs: RunRegistry;
  /** The connection's query timeout, which caps every request's deadline. */
  readonly queryTimeoutMs: number;
  /** Aborted by `disconnect()`. */
  readonly lifetime: AbortSignal;
  readonly errors: MilvusErrorConnection;
  readonly secretForms: readonly string[];
  readonly now: () => number;
}

type EntityOperation = Extract<MilvusOperation, { readonly kind: "query" | "count" | "search" | "hybridSearch" }>;
type MetadataOperation = Exclude<MilvusOperation, EntityOperation>;

/** What the calls of one request share. */
interface Run {
  readonly client: MilvusExecuteClient;
  readonly call: CallOptions;
  readonly errors: MilvusErrorContext;
  readonly secretForms: readonly string[];
  readonly elapsed: () => number;
}

const NOT_READ: IndexReading = { kind: "not-read" };
const INDEX_NOT_EXIST = 700;

/** The collection a query, a get or a search names; a metadata route reads no schema first. */
function entityCollection(request: MilvusPhase0): string | undefined {
  switch (request.op) {
    case "entities/query":
    case "entities/get":
    case "entities/search":
    case "entities/hybrid_search":
      return request.collection;
    default:
      return undefined;
  }
}

/** One call of the request, its failure worded by errors.ts's table. */
async function send<T>(run: Run, invoke: (call: CallOptions) => Promise<T>): Promise<T> {
  try {
    return await invoke(run.call);
  } catch (error) {
    throw toProviderError(error, run.errors);
  }
}

/** A collection's index descriptions; with `absentIsNone`, a collection with no index is a list with no entry. */
async function indexDescriptions(
  run: Run,
  request: DescribeIndexRequest,
  absentIsNone: boolean,
): Promise<readonly WireIndexDescription[]> {
  try {
    return (await run.client.describeIndex(request, run.call)).index_descriptions;
  } catch (error) {
    if (absentIsNone && error instanceof MilvusError && error.status?.code === INDEX_NOT_EXIST) return [];
    throw toProviderError(error, run.errors);
  }
}

/**
 * The DescribeIndex of a search, read for the whole collection: a refusal for want of the IndexDetail privilege is
 * passed on as unreadable, so a search that names no metric and no parameter still runs.
 */
async function readIndex(run: Run, collection: string): Promise<IndexReading> {
  try {
    const response = await run.client.describeIndex({ collection_name: collection }, run.call);
    return { kind: "read", response };
  } catch (error) {
    if (error instanceof MilvusError && error.category === "permission-denied") return { kind: "unreadable" };
    if (error instanceof MilvusError && error.status?.code === INDEX_NOT_EXIST) {
      return { kind: "read", response: { status: null, index_descriptions: [] } };
    }
    throw toProviderError(error, run.errors);
  }
}

/** A query, a count or a search: one call, its answer shaped by results.ts. */
async function runEntity(run: Run, operation: EntityOperation): Promise<QueryResult> {
  const options = () => ({ executionTime: run.elapsed() });
  switch (operation.kind) {
    case "query":
      return queryResult(
        await send(run, (call) => run.client.query(operation.request, call)),
        operation.shape,
        options(),
      );
    case "count":
      return countResult(await send(run, (call) => run.client.query(operation.request, call)), options());
    case "search":
      return searchResult(
        await send(run, (call) => run.client.search(operation.request, call)),
        operation.shape,
        options(),
      );
    case "hybridSearch":
      return searchResult(
        await send(run, (call) => run.client.hybridSearch(operation.request, call)),
        operation.shape,
        options(),
      );
  }
}

const text = (name: string) => ({ name, typeText: "VarChar" });
const int64 = (name: string) => ({ name, typeText: "Int64" });
const bool = (name: string) => ({ name, typeText: "Bool" });

/** A list Milvus filters by the user's privileges says so in its column's type. */
const visible = (name: string) => ({ name, typeText: "VarChar, visible to this user" });

const DESCRIBE_COLUMNS = [
  text("fieldName"),
  text("dataType"),
  bool("isPrimary"),
  bool("nullable"),
  bool("isPartitionKey"),
  text("indexName"),
  text("indexType"),
  text("metricType"),
  text("load"),
];

const INDEX_COLUMNS = [
  text("indexName"),
  text("fieldName"),
  text("indexType"),
  text("metricType"),
  text("indexState"),
  int64("indexedRows"),
  int64("totalRows"),
  int64("pendingRows"),
  text("failReason"),
  { name: "params", typeText: "JSON" },
];

function properties(pairs: readonly WireKeyValuePair[]): Record<string, string> {
  return Object.fromEntries(pairs.map((pair) => [pair.key, pair.value]));
}

function indexRow(index: WireIndexDescription, secretForms: readonly string[]): readonly unknown[] {
  const rest = index.params.filter((pair) => pair.key !== "index_type" && pair.key !== "metric_type");
  const failed = index.index_state_fail_reason;
  return [
    index.index_name,
    index.field_name,
    indexParam(index, "index_type") ?? null,
    indexParam(index, "metric_type") ?? null,
    index.state,
    index.indexed_rows,
    index.total_rows,
    index.pending_index_rows,
    failed === "" ? null : serverText(failed, secretForms),
    properties(rest),
  ];
}

/** A metadata route: its reads, one after another, and its answer as named, typed columns. */
async function runMetadata(run: Run, operation: MetadataOperation): Promise<QueryResult> {
  const { client } = run;
  const options = () => ({ executionTime: run.elapsed() });
  switch (operation.kind) {
    case "listDatabases": {
      const answer = await send(run, (call) => client.listDatabases(call));
      return tableResult(
        [visible("dbName")],
        answer.db_names.map((name) => [name]),
        options(),
      );
    }
    case "describeDatabase": {
      const answer = await send(run, (call) => client.describeDatabase(operation.request, call));
      return tableResult(
        [text("dbName"), int64("dbID"), { name: "properties", typeText: "JSON" }],
        [[answer.db_name, answer.dbID, properties(answer.properties)]],
        options(),
      );
    }
    case "showCollections": {
      const answer = await send(run, (call) => client.showCollections(call));
      return tableResult(
        [visible("collectionName")],
        answer.collection_names.map((name) => [name]),
        options(),
      );
    }
    case "describeCollection": {
      // Fields, indexes and the load state, all of which answer on an unloaded collection: nothing here loads one.
      const named = { collection_name: operation.request.collection_name };
      const schema = describedSchema(await send(run, (call) => client.describeCollection(operation.request, call)));
      const indexes = await indexDescriptions(run, named, true);
      const load = await send(run, (call) => client.getLoadState(named, call));
      const rows = schema.fields.map((field) => {
        const index = indexes.find((candidate) => candidate.field_name === field.name);
        return [
          field.name,
          fieldTypeText(field, schema.functions),
          field.is_primary_key,
          field.nullable || field.is_dynamic,
          field.is_partition_key,
          index?.index_name ?? null,
          (index && indexParam(index, "index_type")) ?? null,
          (index && indexParam(index, "metric_type")) ?? null,
          load.state,
        ];
      });
      return tableResult(DESCRIBE_COLUMNS, rows, options());
    }
    case "getCollectionStatistics": {
      const answer = await send(run, (call) => client.getCollectionStatistics(operation.request, call));
      const rowCount = statisticsRowCount(answer.stats);
      if (rowCount === undefined) {
        throw new QueryError(
          `Milvus answered the statistics of collection ${operation.request.collection_name} with no row_count.`,
          PROVIDER,
        );
      }
      // Flushed segments only, deletes not subtracted: an estimate, and typed as one.
      return tableResult([{ name: "rowCount", typeText: countLabel("estimate") }], [[rowCount]], options());
    }
    case "getLoadState": {
      const state = await send(run, (call) => client.getLoadState(operation.request, call));
      // Milvus answers a progress only where a load exists; asked of an unloaded collection it refuses.
      const loading = state.state === "LoadStateLoading" || state.state === "LoadStateLoaded";
      const progress = loading
        ? (await send(run, (call) => client.getLoadingProgress(operation.request, call))).progress
        : null;
      return tableResult([text("loadState"), int64("loadProgress")], [[state.state, progress]], options());
    }
    case "showPartitions": {
      const answer = await send(run, (call) => client.showPartitions(operation.request, call));
      const listed = answer.partition_names.slice(0, MILVUS_PARTITIONS_LISTED);
      const result = tableResult(
        [text("partitionName")],
        listed.map((name) => [name]),
        options(),
      );
      if (listed.length === answer.partition_names.length) return result;
      return {
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          {
            message: `Studio lists the first ${listed.length.toLocaleString("en-US")} of ${answer.partition_names.length.toLocaleString("en-US")} partitions.`,
          },
        ],
        pagination: {
          limit: listed.length,
          offset: 0,
          hasMore: false,
          totalReturned: result.rowCount,
          wasLimited: true,
        },
      };
    }
    case "describeIndex": {
      // A listing of a collection with no index is no row; a named index that is not there is the server's refusal.
      const indexes = await indexDescriptions(run, operation.request, operation.request.index_name === undefined);
      return tableResult(
        INDEX_COLUMNS,
        indexes.map((index) => indexRow(index, run.secretForms)),
        options(),
      );
    }
    case "listAliases": {
      const answer = await send(run, (call) => client.listAliases(operation.request, call));
      return tableResult(
        [text("aliasName")],
        answer.aliases.map((alias) => [alias]),
        options(),
      );
    }
    case "describeAlias": {
      const answer = await send(run, (call) => client.describeAlias(operation.request, call));
      return tableResult(
        [text("aliasName"), text("collectionName"), text("dbName")],
        [[answer.alias, answer.collection, answer.db_name]],
        options(),
      );
    }
  }
}

function isEntity(operation: MilvusOperation): operation is EntityOperation {
  return (
    operation.kind === "query" ||
    operation.kind === "count" ||
    operation.kind === "search" ||
    operation.kind === "hybridSearch"
  );
}

/** The request's metadata reads, its schema rules and its one execution call, under the permit it already holds. */
async function runRequest(run: Run, request: MilvusPhase0): Promise<QueryResult> {
  const reads = milvusMetadataReads(request);
  const collection = entityCollection(request);
  const described =
    reads.describeCollection && collection !== undefined
      ? await send(run, (call) => run.client.describeCollection({ collection_name: collection }, call))
      : undefined;
  const index = reads.describeIndex && collection !== undefined ? await readIndex(run, collection) : NOT_READ;
  const operation = milvusPhase1(request, { ...(described === undefined ? {} : { collection: described }), index });
  return isEntity(operation) ? runEntity(run, operation) : runMetadata(run, operation);
}

/**
 * Runs one console text. `queryId` is the caller's name for the run: an id already running or waiting is refused, and
 * `context.runs.cancel(queryId)` stops the run whether it is waiting for its permit or in a call.
 */
export async function executeMilvusConsole(
  client: MilvusExecuteClient,
  text: string,
  queryId: string | undefined,
  context: MilvusExecuteContext,
): Promise<QueryResult> {
  // Everything that reads the text alone, the server's version among it: no call, no permit, no run.
  const request = milvusPhase0(parseMilvusRequest(text), { database: context.database });
  milvusVersionGates(request, (gate) => versionGateRefusal(gate, context.version));

  const started = context.now();
  const collection = entityCollection(request) ?? ("collection" in request ? request.collection : undefined);
  const deadlineMs = Math.min(
    entityCollection(request) === undefined ? MILVUS_METADATA_DEADLINE_MS : MILVUS_ENTITIES_DEADLINE_MS,
    context.queryTimeoutMs,
  );
  const errors: MilvusErrorContext = {
    operation: `${request.op} request`,
    write: false,
    database: request.db,
    ...(collection === undefined ? {} : { collection }),
    connection: { ...context.errors, timeoutMs: deadlineMs },
    secretForms: context.secretForms,
  };
  const handle = context.runs.begin(queryId, AbortSignal.any([AbortSignal.timeout(deadlineMs), context.lifetime]));
  try {
    let ticket: LimiterTicket;
    try {
      ticket = await context.limiter.acquire(handle.signal);
    } catch (error) {
      if (error instanceof LimiterFullError) throw error;
      // The wait ended at the deadline, at a cancel or at the connection's close: nothing was sent.
      throw toProviderError(toMilvusError(error, handle.signal), errors);
    }
    try {
      return await runRequest(
        {
          client,
          call: { db: request.db, signal: handle.signal },
          errors,
          secretForms: context.secretForms,
          elapsed: () => context.now() - started,
        },
        request,
      );
    } finally {
      ticket.release();
    }
  } finally {
    handle.end();
  }
}
