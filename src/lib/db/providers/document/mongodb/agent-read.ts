/**
 * The agent read-only execution profile's read on MongoDB (issue #1614): one admitted command, read under the budget
 * the run grants it. The boundary it runs inside is proven at open (`agent-boundary.ts`); this is what keeps one read
 * bounded once it is sent.
 *
 * - **One builder.** `openBoundedRead` is the only place a read's command is built, for execute and for the estimating
 *   plan alike, so the plan the model reads is the plan of the command that runs. A `count` is the `$match` and
 *   `$group` pipeline the driver's `countDocuments` sends, executed and explained as that.
 * - **A server-side row bound.** A `find`'s limit is one past the row budget, or the command's own when it is smaller;
 *   an `aggregate` carries a trailing `$limit` of one past it. The extra row is the refusal's signal.
 * - **A streamed read, counted in BSON bytes.** A cursor is read one raw document at a time: the crossing row is the
 *   row budget's refusal, and each document's own BSON size is added to the byte budget before it is decoded (the
 *   measure issue #1614 settled on), so the document that crosses it is never decoded. An admitted document is
 *   decoded as the driver decodes one and kept only as its served row, so memory holds the budget's rows and one
 *   batch, not the result.
 *   A `distinct` answers one reply, which the server holds to 16 MiB, and the driver decodes it whole before either
 *   budget is read, because it decodes a command's reply even when asked for it raw: near that cap, a reply of many
 *   small values costs about ten times its size in memory (the measurement is in `docs/providers/mongodb.md`, under
 *   the byte budget). It is then refused past the row budget before any row is built and past the byte budget on the
 *   crossing row.
 * - **An owned deadline.** Every call carries `maxTimeMS`, the server's own deadline, and runs in a session this
 *   module owns; when the server does not end it, `runUnderAgentDeadline` kills the session and closes the cursor.
 *   A transport failure the driver reports is a connection failure rather than a fault in the statement, but the
 *   driver reports a server cut mid-read only after its own 30 s server selection (it retries a read's first command,
 *   and a failed `getMore` first sends `killCursors` to the lost server), so a read under a shorter deadline ends as
 *   the client giving up instead (measured on 9.0.4; `docs/BACKLOG.md` D371).
 * - **The bound database.** A run reads the database its connection is bound to; a command naming another is refused
 *   before anything is sent, as issue #1614 settled.
 *
 * What matches the editor's `query()` for the same text, and what differs on purpose: the envelope, the rules its
 * Extended JSON values are read by, and the serialization of every value are the editor's; the reader is the agent's
 * own (`readMongoCommand`), stricter than the editor's parse, and the bounds are the run's own. The editor answers a
 * `find` with no limit with 100 documents and an `aggregate` with every document; the run answers at most its row
 * budget, and REFUSES a read past it rather than truncating one, so a model is never shown part of an answer as the
 * whole.
 */
import {
  type AggregationCursor,
  type ClientSession,
  type Collection,
  type Document,
  type FindCursor,
  type MongoClient,
} from "mongodb";
// The BSON parser, reached through a namespace import for the reason `index.ts` gives: bun does not see `BSON` as a
// named export of the driver's CommonJS entry.
import * as mongodbDriver from "mongodb";
import { ConnectionError, QueryError, mapDatabaseError } from "../../../errors";
import {
  assertReadOnlyBudget,
  byteBudgetSentence,
  MAX_STATEMENT_TIMEOUT_MS,
  rowBudgetSentence,
} from "../../sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "../../../types";
import { unionFields, uniquelyKeyedRows } from "../../../utils/result-fields";
import type { RevivedMongoReadEnvelope } from "./extended-json";
import { serializeMongoDocument } from "./values";

/**
 * The comment a statement-sending run's own commands carry (its checks at open, each read and plan, its catalog read
 * and the kill of a read's session; the connect's `ping` carries none), and the application name of every execution-profile client (`index.ts`), so
 * the server's own records of a run (the profiler, the slow-query log, `$currentOp`, an audited authorization failure)
 * can be told from every other client's.
 */
export const AGENT_COMMAND_COMMENT = "libredb-studio-agent";

/**
 * How long past the server's own deadline the provider's timer fires: the server's `maxTimeMS` ends a punctual read
 * first, so the two never race a correct refusal, and the timer is for a server that did not end it. MySQL's profile
 * keeps the same second (`AGENT_DEADLINE_BACKSTOP_MS` in `mysql.ts`).
 */
export const AGENT_DEADLINE_BACKSTOP_MS = 1_000;

/** How long, after the timer kills the session, the read is given to end before the client stops waiting on it. */
export const AGENT_KILL_GRACE_MS = 1_000;

/** The deadline's two waits, a parameter so a test of the timer path runs in milliseconds. */
export interface AgentDeadlineSeams {
  readonly backstopMs: number;
  readonly graceMs: number;
}

const AGENT_DEADLINE_SEAMS: AgentDeadlineSeams = Object.freeze({
  backstopMs: AGENT_DEADLINE_BACKSTOP_MS,
  graceMs: AGENT_KILL_GRACE_MS,
});

/** What a statement past `maxTimeMS` answers (measured: the executor's kill). */
const MONGO_MAX_TIME_EXPIRED_CODE = 50;

/**
 * The failures that are the server going away rather than the statement failing, by the driver's class names.
 * `mapDatabaseError` reads an error by its message, not its class: a closed or reset socket reads as a generic error,
 * and a network or server-selection timeout as a timeout, so either would let a run treat a lost server as a statement
 * to repair.
 */
const TRANSPORT_FAILURES: ReadonlySet<string> = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
]);

/** How the driver decodes a document it hands back, written out because a raw cursor hands back bytes instead. */
const DRIVER_DECODE = Object.freeze({
  promoteLongs: true,
  promoteValues: true,
  promoteBuffers: false,
  bsonRegExp: false,
  useBigInt64: false,
  validation: { utf8: true },
});

/** The most documents one batch of an agent read asks the server for. */
const MAX_BATCH_DOCUMENTS = 100;

/**
 * One read's answer, in the shape the agent pipeline takes from every other engine:
 * rows as JSON-safe records, fields as their column names, and the elapsed time.
 */
export interface MongoAgentReadResult {
  readonly rows: Record<string, unknown>[];
  readonly fields: string[];
  readonly rowCount: number;
  readonly executionTime: number;
}

/** A cursor the deadline closes when it fires. */
interface Closable {
  close(): Promise<void>;
}

/**
 * The server's own deadline on one statement, as `maxTimeMS`. The number is the budget's
 * own, so the deadline a run shows the model is the deadline the server holds.
 */
function serverDeadline(budget: ReadOnlyStatementBudget): number {
  return budget.statementTimeoutMs;
}

/** One past the row budget: the extra row is the signal, exactly as the SQL engines use it. */
function rowBound(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultRows + 1;
}

/**
 * The row-budget refusal, in the sentence the SQL profile established (`rowBudgetIn` in `context-snapshot.ts` reads it).
 *
 * `stoppedAtBound` is a cursor read, which the server ends one row past the budget: its count is that bound, not the
 * number of documents that match, and the sentence says so. Without it a live run on 2026-10-17 read "201 rows > 200
 * allowed", retried with a limit of 200 and reported that the collection held 200 orders, of 8000. The opening is
 * unchanged, so `rowBudgetIn` and MCP's limit reader still read it.
 */
export function rowBudgetRefusal(
  rows: number,
  budget: ReadOnlyStatementBudget,
  statement: string,
  stoppedAtBound = false,
): QueryError {
  const total = stoppedAtBound
    ? `; the read stops one row past the budget, so at least ${rows} documents match and the total is not known (count it with "operation": "count", or narrow the read)`
    : "";
  return new QueryError(`${rowBudgetSentence(rows, budget.maxResultRows)}${total}`, "mongodb", statement);
}

/** The byte-budget refusal, same sentence, counted in BSON bytes. */
function byteBudgetRefusal(bytes: number, budget: ReadOnlyStatementBudget, statement: string): QueryError {
  return new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "mongodb", statement);
}

function killedAtDeadline(budget: ReadOnlyStatementBudget, statement: string): QueryError {
  return new QueryError(
    `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and was killed server-side`,
    "mongodb",
    statement,
  );
}

function codeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

function isTransportFailure(error: unknown): error is Error {
  return error instanceof Error && TRANSPORT_FAILURES.has(error.name);
}

function connectionLost(error: Error): ConnectionError {
  return new ConnectionError(
    `The MongoDB server could not be reached while the statement ran: ${error.message}`,
    "mongodb",
  );
}

/**
 * The refusal of a command naming a database other than the one the run's connection is bound to. `named` is how the
 * caller named it, `"database": "<name>"` for a command's key, so the sentence quotes what the model wrote.
 */
export function anotherDatabaseRefusal(boundDatabase: string, named: string, statement: string): QueryError {
  return new QueryError(
    `This run reads the database "${boundDatabase}" its connection is bound to, and ${named} names another, so nothing was sent. Drop the key or name "${boundDatabase}".`,
    "mongodb",
    statement,
  );
}

/**
 * Runs `work` under the deadline this module owns, in a session of its own.
 *
 * `work` is handed the session and the server deadline, which it passes to every call it makes, and `track`, which
 * registers a cursor for the deadline to close. A timer is armed one backstop past the server's deadline (clamped to
 * the timer's 32-bit range, `MAX_STATEMENT_TIMEOUT_MS`: the hand-over budget's "no time limit" is that ceiling, and a
 * delay past it fires after 1 ms). When it fires, the session is killed (`killSessions`, which a user holding only
 * read may send for its own session: measured on 9.0.4, 8.3.11 and 7.0.43, the read ends with code 11601 and no
 * operation is left), every tracked cursor is closed, and the read is given `graceMs` to end.
 *
 * The answer is the read's, except: the server's own deadline (code 50) and anything the read settles with after the
 * kill, a result included, is the statement deadline, killed server-side; a read that has not ended `graceMs` after
 * the kill is the client giving up on a server that did not end it; and a transport failure, of the read or of the
 * kill, is a `ConnectionError`. Every other failure is `mapDatabaseError`'s, as on the editor's path. The session is
 * ended on every path.
 */
export async function runUnderAgentDeadline<T>(
  client: MongoClient,
  budget: ReadOnlyStatementBudget,
  statement: string,
  work: (session: ClientSession, maxTimeMS: number, track: <C extends Closable>(cursor: C) => C) => Promise<T>,
  seams: AgentDeadlineSeams = AGENT_DEADLINE_SEAMS,
): Promise<T> {
  const session = client.startSession();
  const cursors: Closable[] = [];
  let killIssued = false;
  let killFailure: unknown;
  let backstop: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const track = <C extends Closable>(cursor: C): C => {
    cursors.push(cursor);
    return cursor;
  };
  const read = work(session, serverDeadline(budget), track).then(
    (value) => ({ settled: "value" as const, value }),
    (error: unknown) => ({ settled: "error" as const, error }),
  );
  const abandoned = new Promise<{ readonly settled: "abandoned" }>((resolve) => {
    backstop = setTimeout(
      () => {
        killIssued = true;
        void client
          .db("admin")
          .command({ killSessions: [session.id], comment: AGENT_COMMAND_COMMENT })
          .catch((error: unknown) => {
            killFailure = error;
          });
        // `close()` settles on its own: the driver squashes a failed killCursors itself.
        for (const cursor of cursors) void cursor.close();
        grace = setTimeout(() => resolve({ settled: "abandoned" }), seams.graceMs);
      },
      Math.min(budget.statementTimeoutMs + seams.backstopMs, MAX_STATEMENT_TIMEOUT_MS),
    );
  });
  try {
    const outcome = await Promise.race([read, abandoned]);
    if (outcome.settled === "abandoned") {
      if (isTransportFailure(killFailure)) throw connectionLost(killFailure);
      throw new QueryError(
        `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and the server did not end it, so the client stopped waiting`,
        "mongodb",
        statement,
      );
    }
    if (outcome.settled === "error") {
      const { error } = outcome;
      if (isTransportFailure(error)) throw connectionLost(error);
      if (killIssued || codeOf(error) === MONGO_MAX_TIME_EXPIRED_CODE) throw killedAtDeadline(budget, statement);
      throw error instanceof QueryError ? error : mapDatabaseError(error, "mongodb", statement);
    }
    if (killIssued) throw killedAtDeadline(budget, statement);
    return outcome.value;
  } finally {
    clearTimeout(backstop);
    clearTimeout(grace);
    await session.endSession();
  }
}

/** The options every agent read is opened with: its session and server deadline, its comment, and how it is read. */
export interface BoundedReadOptions {
  readonly session: ClientSession;
  readonly maxTimeMS: number;
  readonly comment: string;
  /** Execute reads raw BSON bytes, counted before they are decoded; the estimating plan reads a decoded reply. */
  readonly raw: boolean;
  readonly batchSize: number;
}

/** A read as the builder opens it: a cursor and what its documents answer, or a `distinct`'s command document. */
export type BoundedRead =
  | {
      readonly kind: "cursor";
      readonly cursor: FindCursor<Document> | AggregationCursor<Document>;
      readonly answers: "documents" | "count";
    }
  | { readonly kind: "command"; readonly command: Document };

/** A `distinct`'s command document, the one shape the read runs and the plan explains. */
export function distinctCommand(envelope: RevivedMongoReadEnvelope & { readonly operation: "distinct" }): Document {
  return { distinct: envelope.collection, key: envelope.field, query: envelope.filter ?? {} };
}

/**
 * The one builder of an agent read, for execute and for the estimating plan alike: a cursor opened with the bounds
 * above and `options`, or a `distinct`'s command document, which the caller sends.
 */
export function openBoundedRead(
  collection: Collection,
  envelope: RevivedMongoReadEnvelope,
  budget: ReadOnlyStatementBudget,
  options: BoundedReadOptions,
): BoundedRead {
  switch (envelope.operation) {
    case "find": {
      const { limit, ...shape } = envelope.options ?? {};
      return {
        kind: "cursor",
        cursor: collection.find(envelope.filter ?? {}, {
          ...shape,
          limit: Math.min(limit ?? Number.POSITIVE_INFINITY, rowBound(budget)),
          ...options,
        }),
        answers: "documents",
      };
    }
    case "findOne":
      return {
        kind: "cursor",
        cursor: collection.find(envelope.filter ?? {}, { ...envelope.options, limit: 1, ...options }),
        answers: "documents",
      };
    case "aggregate":
      return {
        kind: "cursor",
        cursor: collection.aggregate([...envelope.pipeline, { $limit: rowBound(budget) }], options),
        answers: "documents",
      };
    case "count":
      return {
        kind: "cursor",
        cursor: collection.aggregate(
          [{ $match: envelope.filter ?? {} }, { $group: { _id: 1, n: { $sum: 1 } } }],
          options,
        ),
        answers: "count",
      };
    case "distinct":
      return { kind: "command", command: distinctCommand(envelope) };
  }
}

/**
 * The keys of an explain reply that are the plan: a find's `queryPlanner` and an aggregate's `stages`, or, for an
 * aggregate a sharded cluster splits, the keys the server's 9.0.4 source writes in their place (`appendExplainResults`:
 * `mergeType`, `mergeShardId`, `splitPipeline` and each shard's plan under `shards`). Every other key at the top level
 * is dropped: the server speaking about itself (`serverInfo` with its host and port, `serverParameters`, the `command`
 * echoed back, `ok` and the cluster time) and the `queryShapeHash` of the command's shape, which 9.0.4 and 8.3.11
 * answer.
 */
const PLAN_KEYS = [
  "explainVersion",
  "queryPlanner",
  "stages",
  "mergeType",
  "mergeShardId",
  "splitPipeline",
  "shards",
] as const;

/**
 * A shard's address where a sharded find lists its shards, under `queryPlanner.winningPlan.shards`: the manual's
 * sharded plan, written by `ClusterExplain::buildPlannerInfo`.
 */
const LISTED_SHARD_ADDRESS: ReadonlySet<string> = new Set(["connectionString", "serverInfo"]);

/**
 * A shard's address where a split pipeline answers each shard's plan under `shards`, written by
 * `mergeExplainOutputFromShards`.
 */
const SPLIT_SHARD_ADDRESS: ReadonlySet<string> = new Set(["host"]);

/**
 * The plan of an explain reply, without what the server says about itself: at the top level only `PLAN_KEYS` pass.
 * Below it the plan is kept as the server wrote it, because it echoes the command's own field names (in a filter, a
 * projection, a sort, an index's keys and bounds, an aggregate's stages and a facet's arms), and a command may name a
 * field `ok`, `command` or `serverInfo`: measured on 9.0.4, 8.3.11 and 7.0.43, an unsharded plan holds none of the
 * server's own keys below the top level. A sharded plan names its shards' addresses, and those are dropped where the
 * server's 9.0.4 source writes them: each shard a find lists loses its `connectionString` and `serverInfo`, and each
 * shard a split pipeline answers for loses its `host`, at the top level and where a `$unionWith` explains its pipeline
 * on a sharded collection (`finalizePipelineAndTargetShardsForExplain`). No sharded cluster is measured. The model
 * reads a plan, and has no use for where the server runs. A copy; the reply is not changed. Recursive: a plan is as
 * deep as its stages and the filter it echoes, which the server's own BSON nesting limit bounds.
 */
export function planOnly(reply: Document): Document {
  const plan: Document = {};
  for (const key of PLAN_KEYS) {
    if (Object.hasOwn(reply, key)) plan[key] = reply[key];
  }
  return withoutShardAddresses(plan);
}

function isPlainDocument(value: unknown): value is Document {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** An explain's plan copied as the server wrote it, without the address of each shard it names. */
function withoutShardAddresses(explain: Document): Document {
  const plan = copyPlan(explain) as Document;
  if (isPlainDocument(explain.shards)) {
    plan.shards = Object.fromEntries(
      Object.entries(explain.shards).map(([name, shard]) => [name, withoutKeys(shard, SPLIT_SHARD_ADDRESS)]),
    );
  }
  const winningPlan: unknown = isPlainDocument(explain.queryPlanner) ? explain.queryPlanner.winningPlan : undefined;
  if (isPlainDocument(winningPlan) && Array.isArray(winningPlan.shards)) {
    ((plan.queryPlanner as Document).winningPlan as Document).shards = winningPlan.shards.map((shard: unknown) =>
      withoutKeys(shard, LISTED_SHARD_ADDRESS),
    );
  }
  return plan;
}

/**
 * `value` copied as the server wrote it. A `$unionWith` whose `pipeline` is a document rather than a list of stages
 * holds the explain of a pipeline on a sharded collection, which names its shards as a split pipeline does.
 */
function copyPlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyPlan);
  if (!isPlainDocument(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === "$unionWith" && isPlainDocument(child) && isPlainDocument(child.pipeline)
        ? { ...(copyPlan(child) as Document), pipeline: withoutShardAddresses(child.pipeline) }
        : copyPlan(child),
    ]),
  );
}

/** One shard's entry without the keys that name its address, the rest of it copied as a plan. */
function withoutKeys(shard: unknown, address: ReadonlySet<string>): unknown {
  if (!isPlainDocument(shard)) return copyPlan(shard);
  return Object.fromEntries(
    Object.entries(shard)
      .filter(([key]) => !address.has(key))
      .map(([key, child]) => [key, copyPlan(child)]),
  );
}

/**
 * The plan of the read a cursor would run, at `queryPlanner` verbosity under the server deadline. The explain is a
 * command of its own in the cursor's session (driver 7.7.0's `FindCursor.explain` and `AggregationCursor.explain`) and
 * never opens the cursor, so closing the cursor ends nothing on the server: a plan the server does not end itself is
 * ended by the deadline's kill of the session alone (tests/live/mongodb-agent-profile.ts measures it with `maxTimeMS`
 * disabled). The cursor is closed once the plan settles all the same, because the client keeps every cursor it builds
 * among its active cursors until that cursor closes (measured with driver 7.7.0 against 9.0.4: five explained cursors
 * left open stayed there until the client closed).
 */
async function explainCursor(
  cursor: FindCursor<Document> | AggregationCursor<Document>,
  maxTimeMS: number,
): Promise<Document> {
  try {
    return await cursor.explain({ verbosity: "queryPlanner", maxTimeMS });
  } finally {
    await cursor.close();
  }
}

/**
 * A raw cursor's documents, read one at a time under the budget: the row past the row budget, or the document whose
 * BSON bytes carry the total past the byte budget, is the refusal, and the crossing document is never decoded. Each
 * admitted document is decoded and kept only as its served row; the bytes are not kept, because the driver may hand
 * back a view of a pooled buffer. The cursor is closed on every path.
 */
async function collectWithinBudget(
  cursor: FindCursor<Document> | AggregationCursor<Document>,
  budget: ReadOnlyStatementBudget,
  statement: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  try {
    // oxlint-disable-next-line no-await-in-loop -- a cursor yields its documents one after another.
    for (let next = await cursor.next(); next !== null; next = await cursor.next()) {
      // Opened with `raw: true`: the document is its own BSON bytes.
      const document = next as Uint8Array;
      if (rows.length === budget.maxResultRows) throw rowBudgetRefusal(rows.length + 1, budget, statement, true);
      bytes += document.byteLength;
      if (bytes > budget.maxResultBytes) throw byteBudgetRefusal(bytes, budget, statement);
      rows.push(serializeMongoDocument(mongodbDriver.BSON.deserialize(document, DRIVER_DECODE)));
    }
  } finally {
    await cursor.close();
  }
  return rows;
}

/**
 * The documents a sample of one object reads, for inferring its fields: a raw cursor read one document at a time,
 * decoded as the driver decodes, stopping before the document whose BSON bytes would carry the total past the byte
 * budget, which is never decoded. A sample is evidence for the object's fields rather than an answer the model reads,
 * so it stops rather than refuses, and its length says how much it holds; but a first document that crosses the
 * budget alone is refused, because an empty sample would describe an object with documents as one with none. The
 * cursor is closed on every path.
 */
export async function sampleWithinBudget(
  cursor: FindCursor<Document>,
  budget: ReadOnlyStatementBudget,
  statement: string,
): Promise<Document[]> {
  const documents: Document[] = [];
  let bytes = 0;
  try {
    // oxlint-disable-next-line no-await-in-loop -- a cursor yields its documents one after another.
    for (let next = await cursor.next(); next !== null; next = await cursor.next()) {
      // Opened with `raw: true`: the document is its own BSON bytes.
      const document = next as Uint8Array;
      bytes += document.byteLength;
      if (bytes > budget.maxResultBytes) {
        if (documents.length === 0) throw byteBudgetRefusal(bytes, budget, statement);
        break;
      }
      documents.push(mongodbDriver.BSON.deserialize(document, DRIVER_DECODE));
    }
  } finally {
    await cursor.close();
  }
  return documents;
}

/**
 * A `distinct`'s values as rows, one per value under the field's name: refused past the row budget before any row is
 * built, then on the row whose BSON size carries the total past the byte budget. The reply arrives decoded whole, so
 * these refusals bound what is served, not what the read held: the driver decodes a command's reply even when asked
 * for it raw, which keeps only embedded documents as bytes and still decodes the `values` list.
 */
function distinctWithinBudget(
  reply: Document,
  field: string,
  budget: ReadOnlyStatementBudget,
  statement: string,
): Record<string, unknown>[] {
  const values: unknown = reply.values;
  if (!Array.isArray(values)) {
    throw new QueryError("The server answered the distinct with no list of values", "mongodb", statement);
  }
  if (values.length > budget.maxResultRows) throw rowBudgetRefusal(values.length, budget, statement);
  const rows: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const value of values) {
    const document = { [field]: value };
    bytes += mongodbDriver.BSON.calculateObjectSize(document);
    if (bytes > budget.maxResultBytes) throw byteBudgetRefusal(bytes, budget, statement);
    rows.push(serializeMongoDocument(document));
  }
  return rows;
}

/**
 * One admitted command, read under the profile's bounds, in the database the run's connection is bound to.
 *
 * `mode: "estimate-plan"` explains the command the builder opens, at `queryPlanner` verbosity and under the same
 * deadline, which `maxTimeMS` at the top of the explain command holds (measured: 8.3.11 and 7.0.43 ignore the one
 * inside the explained command, and planned past it; 9.0.4 honours both). The server plans the command and, when
 * several candidate plans fit, runs each for a bounded trial to choose; it returns no result rows. The one row is the
 * plan, through `planOnly`.
 */
export async function readMongoForAgent(
  client: MongoClient,
  boundDatabase: string,
  envelope: RevivedMongoReadEnvelope,
  budget: ReadOnlyStatementBudget,
  mode: "execute" | "estimate-plan",
  statement: string,
  seams: AgentDeadlineSeams = AGENT_DEADLINE_SEAMS,
): Promise<MongoAgentReadResult> {
  assertReadOnlyBudget(budget, "mongodb");
  if (envelope.database !== undefined && envelope.database !== boundDatabase) {
    throw anotherDatabaseRefusal(boundDatabase, `"database": "${envelope.database}"`, statement);
  }
  const db = client.db(boundDatabase);
  const startedAt = Date.now();
  const rows = await runUnderAgentDeadline(
    client,
    budget,
    statement,
    async (session, maxTimeMS, track) => {
      const read = openBoundedRead(db.collection(envelope.collection), envelope, budget, {
        session,
        maxTimeMS,
        comment: AGENT_COMMAND_COMMENT,
        raw: mode === "execute",
        batchSize: Math.min(rowBound(budget), MAX_BATCH_DOCUMENTS),
      });
      if (mode === "estimate-plan") {
        const plan =
          read.kind === "cursor"
            ? await explainCursor(read.cursor, maxTimeMS)
            : await db.command(
                { explain: read.command, verbosity: "queryPlanner", maxTimeMS, comment: AGENT_COMMAND_COMMENT },
                { session },
              );
        return [serializeMongoDocument(planOnly(plan))];
      }
      if (read.kind === "command") {
        const reply = await db.command({ ...read.command, maxTimeMS, comment: AGENT_COMMAND_COMMENT }, { session });
        return distinctWithinBudget(reply, String(read.command.key), budget, statement);
      }
      const documents = await collectWithinBudget(track(read.cursor), budget, statement);
      return read.answers === "count" ? [{ count: documents[0]?.n ?? 0 }] : documents;
    },
    seams,
  );
  return {
    ...uniquelyKeyedRows(unionFields(rows), rows),
    rowCount: rows.length,
    executionTime: Date.now() - startedAt,
  };
}
