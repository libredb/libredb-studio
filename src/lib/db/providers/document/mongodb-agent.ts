/**
 * The agent's read-only execution profile for MongoDB (issue #1614) - the boundary, the
 * gate that proves the boundary, and the bounded read itself. Kept in a module of its
 * own beside the provider rather than inside `mongodb.ts`'s 2,700 lines, which is the
 * lesson of #1744's D348 applied before the debt exists: the provider keeps its editor
 * duties and this keeps the profile's.
 *
 * THE BOUNDARY IS THE SERVER'S, IN TWO PIECES:
 *
 * 1. **The principal is proven by a NEGATIVE WRITE PROBE, not by reading its roles.**
 *    A user created with the `read` role is a claim; the probe asks the server to refuse
 *    a write and takes only that refusal as proof. Measured on MongoDB 9.0.4: an
 *    `insertOne` into the probe collection as the `read`-only user answers
 *    `MongoServerError` code 13, "not authorized on <db> to execute command {insert: …}".
 *    Measured on a server started without `--auth`: the same write SUCCEEDS - role
 *    restrictions are not enforced at all without authentication (the shape the issue
 *    recorded on 2026-09-27 and the reason reading `connectionStatus` would prove
 *    nothing) - so the probe cleans up after its own surprise and refuses the connection
 *    with `PROFILE_PRIVILEGES_TOO_BROAD`, which is the honest verdict: no read-only
 *    boundary the profile could rest on exists on that server.
 *
 *    The probe writes into the CONNECTED database only, by the issue's own design: a
 *    principal granted `readWrite` on some other database still passes the probe on this
 *    one, and what contains it there is the fence (no write operation is ever admitted)
 *    and the server's own per-database authorization of every read the envelope may aim
 *    elsewhere. Documented rather than widened, because widening it would probe every
 *    database the connection can NAME, which the connection has no list of.
 *
 * 2. **The statement itself is bounded five ways**, each stated where it is enforced:
 *    the fence (`mongo-admission.ts`) admits the five read operations of the editor's
 *    envelope and refuses the write stages of a pipeline; the driver call carries
 *    `maxTimeMS`, the SERVER's own deadline (measured: `code 50` ended a `$where`
 *    `sleep()` past its 500 ms budget); the find and aggregate calls are capped at one
 *    row past the budget SERVER-SIDE (`limit`, a trailing `$limit`), so an unbounded
 *    cursor is never materialised in Node; the client owns a backstop timer for the case
 *    the server's deadline does not fire; and the assembled result is refused on the
 *    row budget's one-past signal and on the byte budget, which is where a `distinct` -
 *    whose reply is the whole array of values, not a cursor - is bounded.
 *
 * THE GATE IS THE SERVER'S OWN SELF-IDENTIFICATION, fail-closed. `buildInfo` answers the
 * fields a genuine MongoDB answers (`version`, `versionArray`, `allocator`,
 * `javascriptEngine`, `storageEngines` containing `wiredTiger`), and names a compat layer
 * when there is one: FerretDB, measured, answers a `ferretdb: {version, package}` field
 * of its own and no `allocator`, `javascriptEngine` or `storageEngines` at all. A server
 * that fails the positive shape, or names itself, is refused with
 * `PROFILE_UNSUPPORTED_TARGET` until its own enforcement is measured - the D347
 * precedent, which is how Percona is treated on the MySQL wire.
 *
 * What this profile does NOT overclaim: MongoDB's profiler, once switched on, writes on
 * every read; `getSlowQueries()` reads `system.profile` and the empty panel is the
 * ordinary case (see the provider's labels). The boundary is about what THIS principal
 * can do, not about what the server records.
 */
import { ExecutionProfileError, QueryError, mapDatabaseError } from "../../errors";
import { assertReadOnlyBudget, measureRowBytes } from "../sql/read-only-budget";
import type { ReadOnlyStatementBudget } from "../../types";
import type { Db, Document, MongoClient } from "mongodb";
import { serializeMongoDocument } from "./mongodb";

/** The collection the probe writes into, refused by the server when the boundary holds. */
const AGENT_PROBE_COLLECTION = "libredb_agent_probe";

/** The client's backstop: how long after the server's own deadline the owned timer fires. */
const CLIENT_BACKSTOP_SLACK_MS = 2_000;

/** What a write past the boundary must answer: MongoDB's authorization refusal. */
const MONGO_UNAUTHORIZED_CODE = 13;

/** What a statement past `maxTimeMS` answers (measured: the executor's kill). */
const MONGO_MAX_TIME_EXPIRED_CODE = 50;

/** The wire's floor for the fields a genuine MongoDB answers on `buildInfo`. */
const GENUINE_MONGODB_STORAGE_ENGINE = "wiredTiger";

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

/**
 * The engine admission: this server must positively be the MongoDB the boundary was
 * measured on. The `ferretdb` field names the one compat layer that mimics a MongoDB
 * version string (measured: it answers `version: "7.0.77"` with no `allocator`,
 * `javascriptEngine` or `storageEngines` beside it), and the positive shape - a numeric
 * version triple, the storage engines list carrying `wiredTiger` - is what Amazon
 * DocumentDB and Azure Cosmos DB, which also speak the wire but answer thinner
 * `buildInfo`s, fail in the fail-closed direction.
 */
export function assertAgentEngineIsAdmissible(buildInfo: Document): void {
  if (buildInfo.ferretdb !== undefined) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile is proven on MongoDB only; this server identifies itself as FerretDB on the wire, and its own enforcement is not measured, so the connection is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  const version = buildInfo.version;
  const storageEngines = buildInfo.storageEngines;
  const admissible =
    typeof version === "string" &&
    /^\d+\.\d+\.\d+/.test(version) &&
    Array.isArray(storageEngines) &&
    (storageEngines as unknown[]).includes(GENUINE_MONGODB_STORAGE_ENGINE);
  if (!admissible) {
    throw new ExecutionProfileError(
      "The agent read-only execution profile is proven on MongoDB only; this server's own buildInfo does not answer the shape a MongoDB answers, so its enforcement is unproven and the connection is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
}

/**
 * The negative write probe, run once at the profiled connection's open.
 *
 * PASS is a refusal: the server answered the write with its authorization error, which is
 * the one proof a read-only boundary exists. A write that SUCCEEDS is the no-auth shape
 * (or an over-privileged principal), and is answered with the probe's own cleanup -
 * `deleteMany` of what it just inserted, which the same over-broad principal is allowed
 * to do - and then a refusal: the profile does not leave its probe document behind and
 * does not run as a principal that wrote. Any other error is neither proof nor
 * disproof, so it propagates as the connect's own failure rather than being read as a
 * verdict.
 */
export async function probeAgentPrincipalCannotWrite(db: Db): Promise<void> {
  let insertRefused: boolean;
  try {
    await db.collection(AGENT_PROBE_COLLECTION).insertOne({ probe: true });
    insertRefused = false;
  } catch (error) {
    if (isAuthorizationRefusal(error)) return;
    throw error;
  }
  // The write succeeded, so the boundary does not exist for this principal. What the
  // probe just wrote is removed before the refusal, so the one observable side effect of
  // discovering that is nothing.
  await db
    .collection(AGENT_PROBE_COLLECTION)
    .deleteMany({})
    .catch(() => {});
  throw new ExecutionProfileError(
    "The agent read-only execution profile requires a server that refuses this principal's writes, and this one accepted one: authentication is off, or the connection's own user holds privileges no read-only boundary can contain. Point the connection's agent credential at a least-privilege principal, or connect as one.",
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

function isAuthorizationRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === MONGO_UNAUTHORIZED_CODE;
}

/**
 * The whole of the profile's verification: the server identifies itself as the engine
 * the boundary was measured on, and the principal's inability to write is proven by the
 * server's own refusal. Run at the PROFILED connection's open, which is the #1629 shape:
 * plan mode and the operations workflow ground through their own profile and are never
 * refused here, and a statement-sending run's grounding - the first thing it does - is.
 */
export async function verifyAgentProfile(client: MongoClient, databaseName: string): Promise<void> {
  const db = client.db(databaseName);
  const buildInfo = await db.command({ buildInfo: 1 }).catch((error: unknown) => {
    throw error;
  });
  assertAgentEngineIsAdmissible(buildInfo as Document);
  await probeAgentPrincipalCannotWrite(db);
}

/**
 * The server's own deadline on one statement, as `maxTimeMS`. The number is the budget's
 * own, so the deadline a run shows the model is the deadline the server holds.
 */
function serverDeadline(budget: ReadOnlyStatementBudget): number {
  return Math.max(1, budget.statementTimeoutMs);
}

/**
 * The owned backstop: a timer this module fires when the server's own deadline did not.
 * It is granted the slack above the server's deadline so the two never race a correct
 * refusal - the backstop exists for the silent server, not the punctual one - and a
 * cursor it fires under is closed, which ends the iteration on the wire too.
 */
function withClientBackstop<T>(read: () => Promise<T>, budget: ReadOnlyStatementBudget): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new QueryError(
            `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and the server did not end it, so the client stopped waiting`,
            "mongodb",
            "",
          ),
        ),
      budget.statementTimeoutMs + CLIENT_BACKSTOP_SLACK_MS,
    );
  });
  return Promise.race([read(), backstop]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** One past the row budget: the extra row is the signal, exactly as the SQL engines use it. */
function rowBound(budget: ReadOnlyStatementBudget): number {
  return budget.maxResultRows + 1;
}

/** The row-budget refusal, in the sentence the SQL profile already established. */
function rowBudgetRefusal(rows: number, budget: ReadOnlyStatementBudget, statement: string): QueryError {
  return new QueryError(
    `Read-only execution exceeded the row budget: ${rows} rows > ${budget.maxResultRows} allowed`,
    "mongodb",
    statement,
  );
}

/** The byte-budget refusal, same sentence, measured on the assembled rows. */
function byteBudgetRefusal(bytes: number, budget: ReadOnlyStatementBudget, statement: string): QueryError {
  return new QueryError(
    `Read-only execution exceeded the byte budget: ${bytes} bytes > ${budget.maxResultBytes} allowed`,
    "mongodb",
    statement,
  );
}

/**
 * The envelope of an admitted statement, as this module reads it. The fence
 * (`mongo-admission.ts`) has already admitted the text; the provider re-parses it with
 * the SAME Extended-JSON reader the editor's `query()` uses, so the two cannot disagree
 * about what a statement means.
 */
interface AdmittedEnvelope {
  readonly collection: string;
  readonly database?: string;
  readonly operation: "find" | "findOne" | "aggregate" | "count" | "distinct";
  readonly filter?: Document;
  readonly pipeline?: Document[];
  readonly field?: string;
  readonly options?: { limit?: number; skip?: number; sort?: Document; projection?: Document };
}

/**
 * One admitted statement, read under the profile's bounds.
 *
 * The envelope is the EDITOR's own, so what the run executes is what the user's editor
 * runs for the same text, and the hand-over of an auto-executed answer needs no
 * translation. `find` and `aggregate` are capped server-side - `limit` clamped to one
 * past the budget, a trailing `$limit` appended - so the rows a cursor can deliver are
 * bounded before they cross the wire; `distinct`'s reply is the whole array, which the
 * row budget refuses after assembly; `count` answers one number.
 *
 * `mode: "estimate-plan"` wraps the envelope's own operation in the server's `explain`
 * at `queryPlanner` verbosity, which plans and does not execute - the estimate the SQL
 * engines take from an `EXPLAIN`, in this engine's own word.
 */
export async function readMongoForAgent(
  client: MongoClient,
  databaseName: string,
  envelope: AdmittedEnvelope,
  budget: ReadOnlyStatementBudget,
  mode: "execute" | "estimate-plan",
  statement: string,
): Promise<MongoAgentReadResult> {
  assertReadOnlyBudget(budget, "mongodb");
  const db = envelope.database !== undefined ? client.db(envelope.database) : client.db(databaseName);
  const startedAt = Date.now();
  let documents: Document[];
  try {
    documents = await withClientBackstop(
      () => (mode === "estimate-plan" ? explainEnvelope(db, envelope, budget) : readEnvelope(db, envelope, budget)),
      budget,
    );
  } catch (error) {
    if (isMaxTimeExpired(error)) {
      throw new QueryError(
        `Read-only execution exceeded the statement deadline of ${budget.statementTimeoutMs}ms and was killed server-side`,
        "mongodb",
        statement,
      );
    }
    throw error instanceof QueryError ? error : mapDatabaseError(error, "mongodb", statement);
  }

  // The +1 row is the budget's own signal, read here rather than refused server-side for
  // the operations whose reply is assembled rather than cursored.
  if (documents.length > budget.maxResultRows) {
    throw rowBudgetRefusal(documents.length, budget, statement);
  }
  let bytes = 0;
  for (const document of documents) {
    bytes += measureRowBytes(document);
    if (bytes > budget.maxResultBytes) {
      throw byteBudgetRefusal(bytes, budget, statement);
    }
  }

  const rows = documents.map((document) => serializeMongoDocument(document));
  const fields = [...new Set(documents.flatMap((document) => Object.keys(document)))];
  return { rows, fields, rowCount: rows.length, executionTime: Date.now() - startedAt };
}

async function readEnvelope(db: Db, envelope: AdmittedEnvelope, budget: ReadOnlyStatementBudget): Promise<Document[]> {
  const collection = db.collection(envelope.collection);
  const maxTimeMS = serverDeadline(budget);
  switch (envelope.operation) {
    case "find": {
      const cursor = collection.find(envelope.filter ?? {});
      if (envelope.options?.projection !== undefined) cursor.project(envelope.options.projection);
      if (envelope.options?.sort !== undefined) cursor.sort(envelope.options.sort);
      if (envelope.options?.skip !== undefined) cursor.skip(envelope.options.skip);
      // One past the budget, or the envelope's own limit when it is smaller: the server
      // stops the cursor there, so the rows arrive already bounded.
      cursor.limit(Math.min(envelope.options?.limit ?? Number.POSITIVE_INFINITY, rowBound(budget)));
      cursor.maxTimeMS(maxTimeMS);
      try {
        return await cursor.toArray();
      } finally {
        await cursor.close().catch(() => {});
      }
    }
    case "findOne": {
      const document = await collection.findOne(envelope.filter ?? {}, {
        projection: envelope.options?.projection,
        maxTimeMS,
      });
      return document === null ? [] : [document];
    }
    case "aggregate": {
      const pipeline = [...(envelope.pipeline ?? []), { $limit: rowBound(budget) }];
      const cursor = collection.aggregate(pipeline, { maxTimeMS });
      try {
        return await cursor.toArray();
      } finally {
        await cursor.close().catch(() => {});
      }
    }
    case "count": {
      const count = await collection.countDocuments(envelope.filter ?? {}, { maxTimeMS });
      return [{ count }];
    }
    case "distinct": {
      const values = await collection.distinct(envelope.field!, envelope.filter ?? {}, { maxTimeMS });
      return values.map((value) => ({ [envelope.field!]: value }));
    }
  }
}

/**
 * The estimating plan: the envelope's own operation, wrapped in `explain` at
 * `queryPlanner` verbosity - measured on MongoDB 9.0.4, the reply carries
 * `queryPlanner.winningPlan` and `serverInfo` and runs no pipeline. The one row is the
 * plan itself, serialized the way every other row is.
 */
async function explainEnvelope(
  db: Db,
  envelope: AdmittedEnvelope,
  budget: ReadOnlyStatementBudget,
): Promise<Document[]> {
  const command = explainCommandFor(envelope);
  const explained = await db.command({ explain: command, verbosity: "queryPlanner" });
  return [explained as Document];
}

/** The envelope's operation as the `explain` command takes it: the wire form of the same read. */
function explainCommandFor(envelope: AdmittedEnvelope): Document {
  switch (envelope.operation) {
    case "find": {
      const find: Document = { find: envelope.collection, filter: envelope.filter ?? {} };
      if (envelope.options?.sort !== undefined) find.sort = envelope.options.sort;
      if (envelope.options?.projection !== undefined) find.projection = envelope.options.projection;
      if (envelope.options?.skip !== undefined) find.skip = envelope.options.skip;
      if (envelope.options?.limit !== undefined) find.limit = envelope.options.limit;
      return find;
    }
    case "aggregate":
      return { aggregate: envelope.collection, pipeline: envelope.pipeline ?? [], cursor: {} };
    case "count":
      return { count: envelope.collection, query: envelope.filter ?? {} };
    case "distinct":
      return { distinct: envelope.collection, key: envelope.field, query: envelope.filter ?? {} };
    case "findOne":
      return { find: envelope.collection, filter: envelope.filter ?? {}, limit: 1 };
  }
}

function isMaxTimeExpired(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === MONGO_MAX_TIME_EXPIRED_CODE
  );
}
