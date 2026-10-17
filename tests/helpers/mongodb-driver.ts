/**
 * A stand-in for the `mongodb` driver, for a test file that replaces the driver with
 * `mock.module("mongodb", () => mongoDriverModule())` before it imports the provider.
 *
 * It answers what a test configures on `mongoDriver` and records what the provider sends, so an assertion can be
 * about the provider's own commands rather than about the stand-in's answers: every cursor a `find` or an `aggregate`
 * opens with its filter or pipeline, its options and its builder calls; every command document, with the database it
 * was sent to; every session; and the client's URI and options. A cursor honours its `limit` and a trailing `$limit`
 * stage, as a server does, so a row bound the provider sets is a row bound the test observes. A pipeline that is one
 * `$group` over the whole collection is evaluated, so the counts the agent's collection profile composes are the
 * counts of the documents a test configured.
 *
 * The BSON values are the REAL driver's (`BSON`, taken before the module is replaced): a `raw` cursor yields each
 * document's real BSON bytes, and the provider decodes them with the real parser. `ObjectId`, `Binary` and
 * `Decimal128` are this file's own classes, which the editor's serialization tests construct with any string; a value
 * the real parser decodes is the real class, so an agent read's rows here hold plain values.
 *
 * The defaults are a genuine MongoDB 9.0.4 (its measured `buildInfo`), a principal holding only the `read` role on the
 * database a command is sent to, and a server that refuses the profile's probe with code 13. `resetMongoDriver()`
 * restores them.
 */
import * as realMongoDriver from "mongodb";
import buildInfo904 from "../unit/db/mongodb/fixtures/buildinfo-9.0.4.json";

type Doc = Record<string, unknown>;

export interface MockCollectionInfo {
  name: string;
  type: string;
  options?: Record<string, unknown>;
}

/** What one cursor was opened with, and what was done to it. */
export interface MockCursorRecord {
  readonly kind: "find" | "aggregate";
  /** `<database>.<collection>` */
  readonly namespace: string;
  readonly filter?: Doc;
  readonly pipeline?: Doc[];
  /** The options object the cursor was opened with, as the provider passed it. */
  readonly options: Doc;
  /** The builder calls made on the cursor (`limit`, `maxTimeMS`, `sort`, `project`, `skip`, `batchSize`). */
  readonly builders: Doc;
  /** How many documents the provider pulled from it. */
  pulled: number;
  closes: number;
  /** The argument `explain` was called with, when it was. */
  explained?: unknown;
}

/** One command document, the database it was sent to, and the options it was sent with. */
export interface MockCommandRecord {
  readonly database: string;
  readonly command: Doc;
  readonly options?: Doc;
}

export interface MockSessionRecord {
  readonly id: { readonly id: string };
  ended: boolean;
}

/** A server error reply as the driver delivers it: named `MongoServerError`, with its code. */
export function mongoServerError(code: number, message: string): Error {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  error.name = "MongoServerError";
  return error;
}

/** A transport failure as the driver delivers it: `MongoNetworkError`, `MongoServerSelectionError` and their kind. */
export function mongoTransportError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** What the read role holds on `database`, as `connectionStatus` answers it for a user holding only that role. */
export function readRoleStatus(database: string, user = "libredb_agent"): Doc {
  const actions = [
    "changeStream",
    "collStats",
    "dbHash",
    "dbStats",
    "find",
    "killCursors",
    "listCollections",
    "listIndexes",
    "listSearchIndexes",
    "planCacheRead",
    "performRawDataOperations",
  ];
  return {
    authInfo: {
      authenticatedUsers: [{ user, db: database }],
      authenticatedUserRoles: [{ role: "read", db: database }],
      authenticatedUserPrivileges: [
        { resource: { db: database, collection: "" }, actions },
        { resource: { db: database, collection: "system.js" }, actions },
      ],
    },
    ok: 1,
  };
}

/**
 * The server's own answer for a command that is not supported on a view: code 166,
 * `CommandNotSupportedOnView`. Reproduced here because it is what one view in a
 * database used to do to the WHOLE schema read - `estimatedDocumentCount()` and
 * `indexes()` were unguarded, so the first view aborted every collection after it.
 */
function commandNotSupportedOnView(command: string, name: string): Error {
  const error = new Error(`Namespace testdb.${name} is a view, not a collection`) as Error & { code: number };
  error.code = 166;
  error.name = `MongoServerError(${command})`;
  return error;
}

/**
 * What `serverStatus` answers by default. The state holds a function rather than a literal: the metric paths have to be
 * driven on a server that publishes NO `wiredTiger` section (mongos, the in-memory storage engine, an API-compatible
 * service) and on one where the command fails outright, and both used to reach the panel as a cache hit ratio of 99%.
 */
const defaultServerStatus = (): Doc => ({
  connections: { current: 5, available: 95 },
  uptime: 86400,
  wiredTiger: {
    cache: {
      "pages read into cache": 10,
      "pages requested from the cache": 1000,
      "bytes currently in the cache": 5000000,
      "maximum bytes configured": 10000000,
    },
  },
  opcounters: { query: 100, insert: 50, update: 30, delete: 20 },
});

/**
 * What `db.stats()` answers by default, a function for the same reason: `databaseSizeBytes` is optional, so the byte
 * figure has to be driven on a database that measures 0 bytes AND on a deployment that answers without `dataSize` at
 * all, and both used to reach the Storage tab as a measured 0.
 */
const defaultDbStats = (): Doc => ({
  dataSize: 2048,
  indexSize: 512,
  storageSize: 4096,
  collections: 2,
  objects: 100,
});

function initialState() {
  return {
    /** The documents of every namespace `documentsByNs` does not name. */
    collectionData: [] as Doc[],
    /** `listCollections` of every database `collectionsByDb` does not name. */
    collections: [
      { name: "users", type: "collection" },
      { name: "orders", type: "collection" },
    ] as MockCollectionInfo[],
    currentOps: [] as Doc[],
    /** Every `killOp` command the admin database received (#1424). */
    killOpCommands: [] as Doc[],
    /** What `listDatabases` answers. */
    databaseList: [] as { name: string }[],
    /**
     * One `listCollections` per database name. The object surface reads across DATABASES, so the stand-in honours
     * the name `MongoClient.db(name)` is given instead of answering one fixed database: that is what makes a wrong
     * container bind visible, because a provider reading the connected database instead of the one the container
     * names gets a different collection list here rather than the same one (#789).
     */
    collectionsByDb: {} as Record<string, MockCollectionInfo[]>,
    /** A database whose `listCollections` is refused, by name, with the server's own error. */
    listCollectionsErrors: {} as Record<string, Error>,
    /** The documents per `<database>.<collection>`; absent falls back to `collectionData`. */
    documentsByNs: {} as Record<string, Doc[]>,
    /** Every database name `MongoClient.db()` was opened with, in order, so a test sees which database was read. */
    openedDatabases: [] as string[],
    /**
     * Every pipeline of the bulk sample chain (`describeObjects`), in order. The bulk column read's claim is that a
     * folder costs ONE aggregate per chunk rather than one read per object, and nothing about the RESULT can tell the
     * two apart, so the pipelines themselves are captured and a test asserts how many there were and which
     * collections each one named (#789).
     */
    samplePipelines: [] as Doc[][],
    /** Every `<database>.<collection>` whose indexes were read, in order. */
    indexReads: [] as string[],
    /** Every `<database>.<collection>` a `find()` cursor was opened on, in order. */
    foundCollections: [] as string[],
    /** A server refusal per `<database>.<collection>`, raised when a cursor on it is read. */
    findErrors: {} as Record<string, Error>,
    /**
     * The arguments each collection method received, by method name, last call wins. The query is read as Extended
     * JSON, and what that changes is visible only in what the driver is HANDED: `{"$oid": ...}` has to arrive as an
     * ObjectId and `{"$date": ...}` as a Date, and a stand-in that ignored its arguments would answer the same rows
     * either way.
     */
    args: {} as Record<string, unknown[]>,
    lastListDatabasesCommand: {} as Doc,
    listDatabasesCommands: [] as Doc[],
    /**
     * Decides whether one `listDatabases` command is refused, and with what; `undefined` answers every one, as MongoDB
     * does.
     */
    listDatabasesRefusal: undefined as ((command: Doc) => Error | undefined) | undefined,
    /**
     * The URI the last client was constructed with, as `buildConnectionString()` composed it. The only place the query
     * string is observable: `MongoClient` is where it goes.
     */
    lastUri: "",
    /**
     * The options object the last client was constructed with. TLS is observable nowhere else: the `MongoClient`
     * constructor is the only place it is stated.
     */
    lastOptions: {} as Doc,
    // #1573, the connect deadline. The client behaves like the driver on the two paths the deadline opens: it RELAYS
    // the heartbeat failure the way `Topology` relays `serverHeartbeatFailed` to the client, and its `close()` is
    // countable, because "no client outlives a timed-out connect" is the issue's second acceptance criterion.
    /**
     * How the next `connect()` behaves. `undefined` connects at once; a function returns its promise, which the
     * deadline tests leave pending the way a server-selection loop retries a refused port until its own 30 s bound.
     */
    connectBehavior: undefined as (() => Promise<void>) | undefined,
    /** The failure the monitoring delivered, handed to every `serverHeartbeatFailed` listener, as the driver does. */
    heartbeatFailure: undefined as Error | undefined,
    /** Every `close()` the clients received, per client, in order. */
    clientCloses: [] as number[],
    /** The provider's heartbeat listeners on the current client, as `on()` registered them. */
    heartbeatListeners: [] as ((event: { failure: Error }) => void)[],
    /** A per-collection `validate` / `compact` refusal, by collection name (#1408). */
    maintenanceRefusals: {} as Record<string, Error>,
    serverStatus: defaultServerStatus as () => Doc,
    dbStats: defaultDbStats as () => Doc,
    /**
     * Per-collection `collStats` answers, for a test that drives the ROW BYTES rather than the shared answer: a
     * collection the map does not name answers `{ size: 1024, totalIndexSize: 512, count: 42 }`.
     */
    collStatsByCollection: {} as Record<string, { size: number; totalIndexSize: number; count: number }>,
    /** What `buildInfo` answers on a database; the default is the measured MongoDB 9.0.4 document. */
    buildInfo: buildInfo904.reply as Doc,
    buildInfoError: null as Error | null,
    /** What `connectionStatus` answers; `undefined` answers the read role on the database it is sent to. */
    connectionStatus: undefined as Doc | undefined,
    /** How the profile's probe is answered: refused with code 13, accepted, or an error of the test's own. */
    probe: "refused" as "refused" | "accepted" | Error,
    /** What an `explain` answers; `undefined` answers a COLLSCAN plan carrying the server's own fields. */
    explainReply: undefined as Doc | undefined,
    /** How long a cursor's first read stays in flight, in ms; `null` answers at once. */
    readDelayMs: null as number | null,
    /** Every command document, with the database it was sent to, in order. */
    commands: [] as MockCommandRecord[],
    /** Every cursor opened by `find` or `aggregate`, in order. */
    cursors: [] as MockCursorRecord[],
    /** Every `listCollections` call, with its filter and options. */
    listCollectionsCalls: [] as { database: string; filter: Doc; options: Doc }[],
    /** Every `listIndexes` call, with its namespace and options. */
    listIndexesCalls: [] as { namespace: string; options: Doc }[],
    sessions: [] as MockSessionRecord[],
  };
}

export const mongoDriver = initialState();

/** Restores every answer and recording to its default. */
export function resetMongoDriver(): void {
  Object.assign(mongoDriver, initialState());
  pendingReads.clear();
}

/** The reads in flight per session id, so `killSessions` can interrupt them. */
const pendingReads = new Map<string, Set<(error: Error) => void>>();

function documentsOf(namespace: string): Doc[] {
  return mongoDriver.documentsByNs[namespace] ?? mongoDriver.collectionData;
}

function collectionInfosOf(database: string): MockCollectionInfo[] {
  return mongoDriver.collectionsByDb[database] ?? mongoDriver.collections;
}

const isView = (name: string, database: string): boolean =>
  collectionInfosOf(database).some((info) => info.name === name && info.type === "view");

/** Delivers the configured heartbeat failure the way the driver relays it. */
function emitHeartbeatFailure(): void {
  if (mongoDriver.heartbeatFailure === undefined) return;
  // The event shape `ServerHeartbeatFailedEvent` carries: the refusal is on `.failure`.
  const event = { failure: mongoDriver.heartbeatFailure };
  for (const listener of mongoDriver.heartbeatListeners) listener(event);
}

/**
 * Waits out `readDelayMs` for a read on `session`, unless `killSessions` names the session first, which rejects it
 * with the code the server interrupts a killed operation with (11601).
 */
async function inFlight(session: unknown): Promise<void> {
  const delay = mongoDriver.readDelayMs;
  if (delay === null) return;
  const id = (session as { id?: { id?: string } } | undefined)?.id?.id;
  await new Promise<void>((resolve, reject) => {
    const timer = Number.isFinite(delay) ? setTimeout(resolve, delay) : undefined;
    if (id === undefined) return;
    const interrupt = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    const set = pendingReads.get(id) ?? new Set();
    set.add(interrupt);
    pendingReads.set(id, set);
  });
}

/**
 * The bulk sample pipeline, INTERPRETED rather than ignored (standing ruling 5b, #789). `describeObjects` reads every
 * object's documents in one `$unionWith` chain, and a stand-in that answered one canned array whatever the pipeline
 * said could not see a rewrite of it: the collection names, the per-collection `$limit` and the `__ks` tag would all be
 * unasserted. So this walks the exact stage shape the provider builds and refuses anything else by name, which is what
 * makes a mutation of that construction fail here rather than only against a live server.
 */
function runSampleChain(name: string, database: string, pipeline: Doc[]): Doc[] {
  const project = pipeline[1] as { $project?: { __ks?: { $literal?: string } } } | undefined;
  const readLimit = (stage: unknown): number => {
    const limit = (stage as { $limit?: unknown } | undefined)?.$limit;
    if (typeof limit !== "number") throw new Error("the bulk sample pipeline must start each arm with $limit");
    return limit;
  };
  // The SAME fallback a `find()` takes for a namespace no test named, so the stand-in models one server for both reads:
  // an asymmetry here would show up as the bulk read and the single read disagreeing about a collection.
  const sample = (collection: string, limit: number): Doc[] =>
    documentsOf(`${database}.${collection}`)
      .slice(0, limit)
      .map((document) => ({ __ks: collection, d: document }));
  if (project?.$project?.__ks?.$literal !== name) {
    throw new Error(`the bulk sample pipeline tagged ${name} as ${String(project?.$project?.__ks?.$literal)}`);
  }
  const rows = sample(name, readLimit(pipeline[0]));
  for (const stage of pipeline.slice(2)) {
    const union = (stage as { $unionWith?: { coll?: string; pipeline?: Doc[] } }).$unionWith;
    if (union?.coll === undefined || union.pipeline === undefined) {
      throw new Error("the bulk sample pipeline may only carry $unionWith after its first two stages");
    }
    const tag = (union.pipeline[1] as { $project?: { __ks?: { $literal?: string } } })?.$project?.__ks?.$literal;
    if (tag !== union.coll) throw new Error(`a $unionWith arm on ${union.coll} tagged its rows ${String(tag)}`);
    rows.push(...sample(union.coll, readLimit(union.pipeline[0])));
  }
  return rows;
}

const isSampleChain = (pipeline: Doc[]): boolean =>
  (pipeline[1] as { $project?: { __ks?: unknown } } | undefined)?.$project?.__ks !== undefined;

/** `countDocuments`' own pipeline ends in this stage; the stand-in answers the namespace's document count. */
const isCountGroup = (stage: unknown): boolean =>
  JSON.stringify(stage) === JSON.stringify({ $group: { _id: 1, n: { $sum: 1 } } });

/** The value at a field path (`$a.b`) of `document`, or undefined where the document holds none. */
function fieldAt(document: Doc, fieldPath: string): unknown {
  let value: unknown = document;
  for (const key of fieldPath.slice(1).split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Doc)[key];
  }
  return value;
}

/** What `$type` answers for a value: the BSON type alias, `missing` where the field is absent. */
function bsonAliasOf(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? "int" : "double";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  return "object";
}

/** An expression's value read as a condition, as the server reads one: false, null, missing and 0 are false. */
const holds = (value: unknown): boolean => value !== false && value !== null && value !== undefined && value !== 0;

/**
 * One aggregation expression evaluated against one document: the operators the agent's collection profile composes
 * (`mongo-tools.ts`), and nothing else. An operator outside them is refused by name, so a change to what the
 * composition sends fails the test that drives it rather than counting nothing. `$and` stops at its first false
 * operand, as the server's does, and `$regexMatch` answers false for a null or missing input and refuses any other input
 * that is not a string, as the server's does.
 */
function evaluate(expression: unknown, document: Doc): unknown {
  if (typeof expression === "string" && expression.startsWith("$")) return fieldAt(document, expression);
  if (typeof expression !== "object" || expression === null) return expression;
  if (Array.isArray(expression)) return expression.map((entry) => evaluate(entry, document));
  const [operator, ...others] = Object.keys(expression);
  if (operator === undefined || others.length > 0) throw new Error("an expression is one operator");
  const argument = (expression as Doc)[operator];
  const operands = Array.isArray(argument) ? argument : [argument];
  switch (operator) {
    case "$type":
      return bsonAliasOf(evaluate(argument, document));
    case "$eq":
      return evaluate(operands[0], document) === evaluate(operands[1], document);
    case "$in":
      return (operands[1] as unknown[]).includes(evaluate(operands[0], document));
    case "$and":
      return operands.every((operand) => holds(evaluate(operand, document)));
    case "$cond":
      return holds(evaluate(operands[0], document)) ? evaluate(operands[1], document) : evaluate(operands[2], document);
    case "$regexMatch": {
      const { input, regex, options } = argument as { input: unknown; regex: string; options?: string };
      const text = evaluate(input, document);
      if (text === null || text === undefined) return false;
      if (typeof text !== "string") throw mongoServerError(51104, "$regexMatch needs 'input' to be of type string");
      return new RegExp(regex, options).test(text);
    }
    default:
      throw new Error(`the stand-in does not evaluate ${operator}`);
  }
}

/**
 * A `$group` over the whole collection (`_id: null`), interpreted rather than ignored: each accumulator is a `$sum`
 * of its expression over every document, and the group answers no row at all over no document, as the server's
 * does. Any accumulator other than `$sum` is refused by name.
 */
function wholeCollectionGroup(group: Doc, documents: readonly Doc[]): Doc[] {
  if (documents.length === 0) return [];
  const row: Doc = { _id: null };
  for (const [alias, accumulator] of Object.entries(group)) {
    if (alias === "_id") continue;
    const sum = (accumulator as { $sum?: unknown } | null)?.$sum;
    if (sum === undefined) throw new Error(`the stand-in groups with $sum only, and ${alias} is not one`);
    row[alias] = documents.reduce((total, document) => {
      const value = evaluate(sum, document);
      return total + (typeof value === "number" ? value : 0);
    }, 0);
  }
  return [row];
}

/** The `$group` of a pipeline that is one whole-collection group, a trailing `$limit` aside; otherwise undefined. */
function wholeCollectionGroupOf(pipeline: readonly Doc[]): Doc | undefined {
  const stages = typeof pipeline.at(-1)?.$limit === "number" ? pipeline.slice(0, -1) : pipeline;
  const group = stages.length === 1 ? (stages[0].$group as Doc | undefined) : undefined;
  return group !== undefined && group._id === null ? group : undefined;
}

/**
 * The documents an aggregate answers: the sample chain interpreted, a count counted, a whole-collection `$group`
 * evaluated, a trailing `$limit` honoured.
 */
function aggregateDocuments(name: string, database: string, pipeline: Doc[]): Doc[] {
  if (isSampleChain(pipeline)) return runSampleChain(name, database, pipeline);
  const documents = documentsOf(`${database}.${name}`);
  const last = pipeline.at(-1);
  if (isCountGroup(last)) return documents.length === 0 ? [] : [{ _id: 1, n: documents.length }];
  const group = wholeCollectionGroupOf(pipeline);
  const answered = group === undefined ? documents : wholeCollectionGroup(group, documents);
  const limit = (last as { $limit?: unknown } | undefined)?.$limit;
  return typeof limit === "number" ? answered.slice(0, limit) : answered;
}

/** The plan an explain answers by default: a COLLSCAN, with the fields a server adds beside it. */
function defaultExplainReply(namespace: string, command: unknown): Doc {
  return {
    explainVersion: "1",
    queryPlanner: { namespace, winningPlan: { stage: "COLLSCAN" }, rejectedPlans: [] },
    command,
    serverInfo: { host: "mock-host", port: 27017, version: "9.0.4" },
    serverParameters: { internalQueryFacetBufferSizeBytes: 104857600 },
    ok: 1,
    $clusterTime: { clusterTime: 1 },
    operationTime: 1,
  };
}

class MockCursor {
  readonly record: MockCursorRecord;
  private readonly answer: () => Doc[];
  private served: Doc[] | null = null;

  constructor(record: MockCursorRecord, answer: () => Doc[]) {
    this.record = record;
    this.answer = answer;
    mongoDriver.cursors.push(record);
  }

  private builder(name: string, value: unknown): this {
    (this.record.builders as Doc)[name] = value;
    return this;
  }

  project(value: unknown) {
    return this.builder("project", value);
  }
  sort(value: unknown) {
    return this.builder("sort", value);
  }
  skip(value: unknown) {
    return this.builder("skip", value);
  }
  limit(value: unknown) {
    return this.builder("limit", value);
  }
  maxTimeMS(value: unknown) {
    return this.builder("maxTimeMS", value);
  }
  batchSize(value: unknown) {
    return this.builder("batchSize", value);
  }

  /** What the cursor serves: its namespace's refusal, or its documents cut at the limit it was given. */
  private async documents(): Promise<Doc[]> {
    if (this.served !== null) return this.served;
    await inFlight(this.record.options.session);
    const refusal = mongoDriver.findErrors[this.record.namespace];
    if (refusal !== undefined) throw refusal;
    const limit = this.record.builders.limit ?? this.record.options.limit;
    const all = this.answer();
    this.served = typeof limit === "number" && limit > 0 ? all.slice(0, limit) : all;
    return this.served;
  }

  async toArray(): Promise<Doc[]> {
    const documents = await this.documents();
    this.record.pulled += documents.length;
    return documents;
  }

  async next(): Promise<unknown> {
    const documents = await this.documents();
    const document = documents[this.record.pulled];
    if (document === undefined) return null;
    this.record.pulled += 1;
    return this.record.options.raw === true ? Buffer.from(realMongoDriver.BSON.serialize(document)) : document;
  }

  async close(): Promise<void> {
    this.record.closes += 1;
  }

  async explain(verbosity?: unknown): Promise<Doc> {
    this.record.explained = verbosity;
    await inFlight(this.record.options.session);
    const refusal = mongoDriver.findErrors[this.record.namespace];
    if (refusal !== undefined) throw refusal;
    return mongoDriver.explainReply ?? defaultExplainReply(this.record.namespace, { record: this.record.kind });
  }
}

function createMockCollection(name = "users", database = "testdb") {
  const namespace = `${database}.${name}`;
  return {
    find: (...args: unknown[]) => {
      mongoDriver.args.find = args;
      mongoDriver.foundCollections.push(namespace);
      const [filter, options] = args as [Doc | undefined, Doc | undefined];
      return new MockCursor(
        { kind: "find", namespace, filter, options: options ?? {}, builders: {}, pulled: 0, closes: 0 },
        () => documentsOf(namespace),
      );
    },
    findOne: async (...args: unknown[]) => {
      mongoDriver.args.findOne = args;
      return mongoDriver.collectionData[0] || null;
    },
    aggregate: (pipeline: Doc[] = [], options?: Doc) => {
      mongoDriver.args.aggregate = [pipeline, options];
      if (isSampleChain(pipeline)) mongoDriver.samplePipelines.push(pipeline);
      return new MockCursor(
        { kind: "aggregate", namespace, pipeline, options: options ?? {}, builders: {}, pulled: 0, closes: 0 },
        () => aggregateDocuments(name, database, pipeline),
      );
    },
    countDocuments: async (...args: unknown[]) => {
      mongoDriver.args.countDocuments = args;
      return mongoDriver.collectionData.length;
    },
    distinct: async (field: string, ...rest: unknown[]) => {
      mongoDriver.args.distinct = [field, ...rest];
      // The driver answers the DISTINCT values; the stand-in dedupes for the same reason.
      return [...new Set(mongoDriver.collectionData.map((document) => document[field]))];
    },
    insertOne: async (...args: unknown[]) => {
      mongoDriver.args.insertOne = args;
      // Echoes a statement's own `_id`, as the driver does, so a typed one reaches the result.
      return { insertedId: (args[0] as { _id?: unknown })._id ?? "new-id-123", acknowledged: true };
    },
    insertMany: async (documents: Doc[]) => {
      mongoDriver.args.insertMany = [documents];
      return { insertedCount: documents.length, insertedIds: documents.map((doc, i) => doc._id ?? `id-${i}`) };
    },
    updateOne: async (...args: unknown[]) => {
      mongoDriver.args.updateOne = args;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    updateMany: async (...args: unknown[]) => {
      mongoDriver.args.updateMany = args;
      return { matchedCount: 2, modifiedCount: 2 };
    },
    deleteOne: async (...args: unknown[]) => {
      mongoDriver.args.deleteOne = args;
      return { deletedCount: 1 };
    },
    deleteMany: async (...args: unknown[]) => {
      mongoDriver.args.deleteMany = args;
      return { deletedCount: 3 };
    },
    estimatedDocumentCount: async () => {
      if (isView(name, database)) throw commandNotSupportedOnView("count", name);
      return 42;
    },
    indexes: async () => {
      mongoDriver.indexReads.push(namespace);
      if (isView(name, database)) throw commandNotSupportedOnView("listIndexes", name);
      return [
        { name: "_id_", key: { _id: 1 }, unique: true },
        { name: "email_1", key: { email: 1 }, unique: false },
      ];
    },
    listIndexes: (options: Doc = {}) => {
      mongoDriver.listIndexesCalls.push({ namespace, options });
      return {
        toArray: async () => {
          mongoDriver.indexReads.push(namespace);
          if (isView(name, database)) throw commandNotSupportedOnView("listIndexes", name);
          return [
            { v: 2, key: { _id: 1 }, name: "_id_" },
            { v: 2, key: { email: 1 }, name: "email_1" },
          ];
        },
        close: async () => {},
      };
    },
  };
}

/** One command, answered as a server would answer it under the configured state. */
async function answerCommand(database: string, command: Doc, options?: Doc): Promise<unknown> {
  mongoDriver.commands.push({ database, command, ...(options === undefined ? {} : { options }) });
  if (command.ping) return { ok: 1 };
  if (command.buildInfo) {
    if (mongoDriver.buildInfoError !== null) throw mongoDriver.buildInfoError;
    return mongoDriver.buildInfo;
  }
  if (command.connectionStatus) return mongoDriver.connectionStatus ?? readRoleStatus(database);
  if (command.delete !== undefined) {
    if (mongoDriver.probe === "accepted") return { n: 0, ok: 1 };
    if (mongoDriver.probe === "refused") {
      throw mongoServerError(
        13,
        `not authorized on ${database} to execute command { delete: "${String(command.delete)}" }`,
      );
    }
    throw mongoDriver.probe;
  }
  if (command.killSessions !== undefined) {
    for (const lsid of command.killSessions as { id?: string }[]) {
      const interrupts = pendingReads.get(String(lsid.id));
      for (const interrupt of interrupts ?? []) interrupt(mongoServerError(11601, "operation was interrupted"));
      pendingReads.delete(String(lsid.id));
    }
    return { ok: 1 };
  }
  if (command.explain !== undefined) {
    await inFlight(options?.session);
    return (
      mongoDriver.explainReply ??
      defaultExplainReply(`${database}.${String((command.explain as Doc).distinct ?? "")}`, command.explain)
    );
  }
  if (command.distinct !== undefined) {
    await inFlight(options?.session);
    const namespace = `${database}.${String(command.distinct)}`;
    const refusal = mongoDriver.findErrors[namespace];
    if (refusal !== undefined) throw refusal;
    const key = String(command.key);
    return { values: [...new Set(documentsOf(namespace).map((document) => document[key]))], ok: 1 };
  }
  if (command.collStats) {
    const name = String(command.collStats);
    if (isView(name, database)) throw commandNotSupportedOnView("collStats", name);
    return mongoDriver.collStatsByCollection[name] ?? { size: 1024, totalIndexSize: 512, count: 42 };
  }
  if (command.validate || command.compact) {
    const name = String(command.validate ?? command.compact);
    // The server refuses both on a view, code 166 with these sentences (measured on
    // 7.0.43, 8.0.32 and 8.2.12, #1408).
    if (isView(name, database)) {
      throw mongoServerError(166, command.validate ? "Cannot validate a view" : "can't compact a view");
    }
    const refusal = mongoDriver.maintenanceRefusals[name];
    if (refusal !== undefined) throw refusal;
    return command.validate ? { ok: 1, valid: true } : { ok: 1 };
  }
  return {};
}

function createMockDb(database = "testdb") {
  return {
    command: (command: Doc, options?: Doc) => answerCommand(database, command, options),
    listCollections: (filter: Doc = {}, options: Doc = {}) => {
      mongoDriver.listCollectionsCalls.push({ database, filter, options });
      return {
        toArray: async () => {
          const refusal = mongoDriver.listCollectionsErrors[database];
          if (refusal !== undefined) throw refusal;
          const infos = collectionInfosOf(database);
          return typeof filter.name === "string" ? infos.filter((info) => info.name === filter.name) : infos;
        },
        close: async () => {},
      };
    },
    collection: (name?: string) => createMockCollection(name, database),
    stats: async () => mongoDriver.dbStats(),
    admin: () => ({
      serverStatus: async () => mongoDriver.serverStatus(),
      command: async (command: Doc) => {
        mongoDriver.commands.push({ database: "admin", command });
        if (command.currentOp) return { inprog: mongoDriver.currentOps };
        if (command.killOp) {
          mongoDriver.killOpCommands.push(command);
          return { info: "attempting to kill op", ok: 1 };
        }
        if (command.buildInfo) return { version: "7.0.0" };
        if (command.listDatabases) {
          mongoDriver.lastListDatabasesCommand = command;
          mongoDriver.listDatabasesCommands.push(command);
          const refusal = mongoDriver.listDatabasesRefusal?.(command);
          if (refusal !== undefined) throw refusal;
          return { databases: mongoDriver.databaseList, ok: 1 };
        }
        return {};
      },
    }),
  };
}

export class MockObjectId {
  private _str: string;
  constructor(str?: string) {
    this._str = str || "mock-object-id-123456789012";
  }
  toString() {
    return this._str;
  }
}

export class MockBinary {
  private _data: Buffer;
  constructor(data?: Buffer | string) {
    this._data = Buffer.from(data || "binary-data");
  }
  length() {
    return this._data.length;
  }
}

export class MockDecimal128 {
  private _val: string;
  constructor(val?: string) {
    this._val = val || "123.456";
  }
  toString() {
    return this._val;
  }
}

/** The hosts a URI names, as the driver's `MongoClient.options` carries them: `hosts`, and `srvHost` for SRV. */
function hostOptions(uri: string): { hosts: { host: string; port: number }[]; srvHost?: string } {
  const match = /^(mongodb(?:\+srv)?):\/\/(?:[^@/]*@)?([^/?]*)/.exec(uri);
  if (match === null) return { hosts: [] };
  if (match[1] === "mongodb+srv") return { hosts: [{ host: match[2], port: 27017 }], srvHost: match[2] };
  return {
    hosts: match[2].split(",").map((entry) => {
      const [host, port] = entry.split(":");
      return { host, port: Number(port ?? 27017) };
    }),
  };
}

let sessionCounter = 0;

class MockMongoClient {
  private closes = 0;
  readonly options: { hosts: { host: string; port: number }[]; srvHost?: string };

  constructor(uri: string, options?: unknown) {
    mongoDriver.lastUri = uri;
    mongoDriver.lastOptions = (options ?? {}) as Doc;
    mongoDriver.clientCloses.push(0);
    this.options = hostOptions(uri);
  }

  // The driver's client is an event emitter and `Topology` relays the monitor's
  // `serverHeartbeatFailed` to it (`constants.js` SERVER_RELAY_EVENTS), which is where the
  // provider reads the refusal the deadline reports (#1573).
  on(event: string, listener: (...args: never[]) => void) {
    if (event === "serverHeartbeatFailed") {
      mongoDriver.heartbeatListeners.push(listener as (event: { failure: Error }) => void);
    }
    return this;
  }

  async connect() {
    // The heartbeat failure lands while the connect is still selecting, as it does on a closed
    // port: the monitor's connect attempt fails at once and the selection loop keeps retrying
    // (#1458). Deferred to a microtask: the provider registers its `serverHeartbeatFailed`
    // listener between the constructor and this call, and the monitor of a real client fires
    // only once the topology starts connecting.
    queueMicrotask(() => emitHeartbeatFailure());
    return mongoDriver.connectBehavior?.();
  }

  async close() {
    this.closes += 1;
    mongoDriver.clientCloses[mongoDriver.clientCloses.length - 1] = this.closes;
  }

  db(name?: string) {
    mongoDriver.openedDatabases.push(name ?? "");
    return createMockDb(name);
  }

  startSession() {
    sessionCounter += 1;
    const record: MockSessionRecord = { id: { id: `session-${sessionCounter}` }, ended: false };
    mongoDriver.sessions.push(record);
    return {
      id: record.id,
      endSession: async () => {
        record.ended = true;
      },
    };
  }
}

/** The module `mock.module("mongodb", ...)` answers with. */
export function mongoDriverModule(): Record<string, unknown> {
  return {
    MongoClient: MockMongoClient,
    ObjectId: MockObjectId,
    Binary: MockBinary,
    Decimal128: MockDecimal128,
    BSON: realMongoDriver.BSON,
  };
}
