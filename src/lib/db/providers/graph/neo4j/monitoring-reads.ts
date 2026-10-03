/**
 * The Neo4j monitoring reads (Neo4j provider spec 7; revisions SR9, SR11).
 *
 * Each read is one fixed statement, exported for the tests and the evidence harness, run through the client
 * in a READ session on the connection's database and bounded by `DEFAULT_QUERY_LIMIT` rows; the label and
 * index listings are the catalog's own reads. monitoring.ts shapes every answer. A row of the wrong shape is a
 * `QueryError` naming the statement, as the catalog's are.
 *
 * Every statement here passes the read policy but one: `SHOW TRANSACTIONS` is refused to a user (SR9),
 * because its `YIELD *` returns other sessions' query text and parameters, and this read keeps its fixed
 * column list, which names no `parameters` (E10). The per-label counts are built with `quoteCypherName` and
 * checked by the policy before they run (SR11).
 *
 * A read the server refuses (a permission, an unknown procedure, a statement its version does not parse)
 * yields the panel's empty answer, never a throw; a server that cannot be reached, a timeout or a cancel is
 * thrown, since an empty panel would claim a measurement nobody made.
 */
import { ConnectionError, QueryError } from "@/lib/db/errors";
import {
  type GraphClient,
  GraphClientError,
  type GraphClientErrorCategory,
  type GraphRunResult,
} from "@/lib/db/graph/bolt/client";
import { CypherNameError, quoteCypherName } from "@/lib/db/graph/cypher/quote";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import type { ActiveSessionDetails, DatabaseOverview, IndexStats, TableStats } from "@/lib/db/types";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { neo4jCatalog } from "./catalog";
import { PROVIDER } from "./errors";
import {
  isoDurationMs,
  type Neo4jCount,
  type Neo4jLabelCount,
  type Neo4jServerVersion,
  toActiveSessions,
  toIndexStats,
  toOverview,
  toTableStats,
} from "./monitoring";
import { NEO4J_POLICY_PROFILE } from "./profile";

/** Every fixed statement the monitoring reads run; a label's count is `labelCountStatement`. */
export const NEO4J_MONITORING_STATEMENTS = {
  components: "CALL dbms.components() YIELD name, versions, edition",
  ping: "CALL db.ping()",
  transactions:
    "SHOW TRANSACTIONS YIELD database, transactionId, username, currentQuery, startTime, status, elapsedTime",
  nodeCount: "MATCH (n) RETURN count(n) AS nodes",
  relationshipCount: "MATCH ()-[r]->() RETURN count(r) AS relationships",
  indexUsage:
    "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, readCount, lastRead, populationPercent",
} as const;

/** The table stats count the first this many labels by name (spec 7). */
export const TABLE_STATS_LABEL_BOUND = 50;

/** The Bolt transaction timeout of one monitoring read. */
const MONITORING_TIMEOUT_MS = 30_000;

/** The categories of a server that answered and refused the read. */
const REFUSED: ReadonlySet<GraphClientErrorCategory> = new Set(["access-mode", "query", "syntax"]);

type Runner = Pick<GraphClient, "run">;
type Row = Readonly<Record<string, unknown>>;

/** Whether a failure is the server refusing the read, which a panel answers with its empty form. */
export function isRefusal(error: unknown): boolean {
  return error instanceof GraphClientError && REFUSED.has(error.category);
}

async function orEmpty<T>(read: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isRefusal(error)) return empty;
    throw error;
  }
}

function run(client: Runner, statement: string, database: string): Promise<GraphRunResult> {
  return client.run(statement, { database, timeoutMs: MONITORING_TIMEOUT_MS, maxRows: DEFAULT_QUERY_LIMIT });
}

function wrong(statement: string, field: string, shape: string): QueryError {
  return new QueryError(
    `The monitoring answer of ${JSON.stringify(statement)} holds a ${field} that is not ${shape}`,
    PROVIDER,
    statement,
  );
}

function stringOf(statement: string, row: Row | undefined, field: string): string {
  const value = row?.[field];
  if (typeof value !== "string") throw wrong(statement, field, "a string");
  return value;
}

function stringsOf(statement: string, row: Row, field: string): string[] {
  const value = row[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw wrong(statement, field, "a list of strings");
  }
  return value;
}

/** A 64-bit count: an integer, or the decimal string the transport writes beyond 2^53. */
function countOf(statement: string, row: Row | undefined, field: string): Neo4jCount {
  const value = row?.[field];
  if (Number.isInteger(value) || (typeof value === "string" && /^-?\d+$/.test(value))) return value as Neo4jCount;
  throw wrong(statement, field, "a count");
}

/** The one count a `RETURN count(...)` statement answers. */
async function readCount(client: Runner, statement: string, database: string, field: string): Promise<Neo4jCount> {
  const { rows } = await run(client, statement, database);
  return countOf(statement, rows.length === 1 ? rows[0] : undefined, field);
}

/**
 * `MATCH (n:<quoted label>) RETURN count(n) AS c`, checked by the read policy (SR11); undefined for a label
 * `quoteCypherName` refuses, which is then left out of the table stats.
 */
export function labelCountStatement(label: string): string | undefined {
  let quoted: string;
  try {
    quoted = quoteCypherName(label);
  } catch (error) {
    if (!(error instanceof CypherNameError)) throw error;
    return undefined;
  }
  const statement = `MATCH (n:${quoted}) RETURN count(n) AS c`;
  return checkCypherRead(statement, NEO4J_POLICY_PROFILE).allowed ? statement : undefined;
}

/** The kernel's version and edition from `dbms.components()`. */
export async function readServerVersion(client: Runner, database: string): Promise<Neo4jServerVersion> {
  const statement = NEO4J_MONITORING_STATEMENTS.components;
  const { rows } = await run(client, statement, database);
  const kernel = rows.find((row) => row.name === "Neo4j Kernel");
  if (kernel === undefined) throw new QueryError("Neo4j reported no kernel component", PROVIDER, statement);
  const [version] = stringsOf(statement, kernel, "versions");
  if (version === undefined) throw wrong(statement, "versions", "a list naming a version");
  return { version, edition: stringOf(statement, kernel, "edition") };
}

/** `CALL db.ping()`, which must answer one success; anything else is a connection fault. */
export async function readPing(client: Runner, database: string): Promise<void> {
  const { rows } = await run(client, NEO4J_MONITORING_STATEMENTS.ping, database);
  if (rows.length !== 1 || rows[0]?.success !== true) {
    throw new ConnectionError("Neo4j did not answer db.ping() with success", PROVIDER);
  }
}

/**
 * The overview: node and relationship counts, the label, type and created-index listings, and the version
 * read at connect. Each of the five reads is answered on its own, so a refused one (an Enterprise reader
 * without the index privilege, say) leaves its figure unreadable and the others standing (spec 7).
 */
export async function readOverview(
  client: Runner,
  database: string,
  server: Neo4jServerVersion | undefined,
): Promise<DatabaseOverview> {
  const { nodeCount, relationshipCount } = NEO4J_MONITORING_STATEMENTS;
  const listing = (kind: "label" | "relationship_type" | "index") =>
    orEmpty<{ entries: readonly unknown[]; truncated: boolean } | undefined>(
      () => neo4jCatalog.listKind(client, database, kind),
      undefined,
    );
  const [nodes, relationships, labels, types, indexes] = await Promise.all([
    orEmpty<Neo4jCount | undefined>(() => readCount(client, nodeCount, database, "nodes"), undefined),
    orEmpty<Neo4jCount | undefined>(() => readCount(client, relationshipCount, database, "relationships"), undefined),
    listing("label"),
    listing("relationship_type"),
    listing("index"),
  ]);
  return toOverview({
    server,
    nodes,
    relationships,
    labels: labels?.entries.length,
    labelsCut: labels?.truncated === true,
    relationshipTypes: types?.entries.length,
    relationshipTypesCut: types?.truncated === true,
    indexes: indexes?.entries.length,
  });
}

/** The running transactions, by the fixed column list (SR9, E10). */
export function readActiveSessions(client: Runner, database: string): Promise<ActiveSessionDetails[]> {
  const statement = NEO4J_MONITORING_STATEMENTS.transactions;
  return orEmpty(async () => {
    const { rows } = await run(client, statement, database);
    return toActiveSessions(
      rows.map((row) => {
        const durationMs = isoDurationMs(stringOf(statement, row, "elapsedTime"));
        if (durationMs === undefined) throw wrong(statement, "elapsedTime", "a duration of days and time");
        return {
          database: stringOf(statement, row, "database"),
          transactionId: stringOf(statement, row, "transactionId"),
          username: stringOf(statement, row, "username"),
          currentQuery: stringOf(statement, row, "currentQuery"),
          startTime: stringOf(statement, row, "startTime"),
          status: stringOf(statement, row, "status"),
          durationMs,
        };
      }),
    );
  }, []);
}

/**
 * Node counts of the first `TABLE_STATS_LABEL_BOUND` labels by name (SR11). The counts run one after another,
 * each in its own READ session, so a monitoring refresh holds one session at a time rather than fifty; each
 * is an O(1) read of the count store. The panel is all or nothing: one refused count, like a refused label
 * listing, empties it, since a partial list would read as the whole graph.
 */
export function readTableStats(client: Runner, database: string): Promise<TableStats[]> {
  return orEmpty(async () => {
    const { entries } = await neo4jCatalog.listKind(client, database, "label");
    const labels = entries
      .map((entry) => entry.name)
      .sort()
      .slice(0, TABLE_STATS_LABEL_BOUND);
    const counts: Neo4jLabelCount[] = [];
    for (const label of labels) {
      const statement = labelCountStatement(label);
      // oxlint-disable-next-line no-await-in-loop -- one session at a time, as the docblock says.
      if (statement !== undefined) counts.push({ label, count: await readCount(client, statement, database, "c") });
    }
    return toTableStats(database, counts);
  }, []);
}

/**
 * The created indexes' usage. The default `LOOKUP` indexes are left out, as the tree leaves them out, and
 * uniqueness comes from the catalog's index rows, since this read's column list names no owning constraint.
 * A `readCount` of null is an index with no tracked read, which has made no scan. The statement yields
 * `lastRead`, as spec 7 lists it, but nothing reads it: `IndexStats` has no field for it. It stays in the
 * column list because the recorded captures are keyed by the statement's text.
 */
export function readIndexStats(client: Runner, database: string): Promise<IndexStats[]> {
  const statement = NEO4J_MONITORING_STATEMENTS.indexUsage;
  return orEmpty(async () => {
    const [usage, created] = await Promise.all([
      run(client, statement, database),
      neo4jCatalog.indexRows(client, database),
    ]);
    const unique = new Set(created.rows.filter((row) => row.unique).map((row) => row.name));
    return toIndexStats(
      database,
      usage.rows
        .filter((row) => row.type !== "LOOKUP")
        .map((row) => {
          const name = stringOf(statement, row, "name");
          const populationPercent = row.populationPercent;
          if (typeof populationPercent !== "number") throw wrong(statement, "populationPercent", "a number");
          return {
            name,
            type: stringOf(statement, row, "type"),
            labelsOrTypes: stringsOf(statement, row, "labelsOrTypes"),
            properties: stringsOf(statement, row, "properties"),
            state: stringOf(statement, row, "state"),
            readCount: row.readCount === null ? 0 : countOf(statement, row, "readCount"),
            populationPercent,
            unique: unique.has(name),
          };
        }),
    );
  }, []);
}
