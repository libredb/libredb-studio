/**
 * Pure mappings from Neo4j's monitoring answers to the monitoring types (Neo4j provider spec 7; revision SR11).
 *
 * It receives answers monitoring-reads.ts has already read and validated, and never a client. A figure Neo4j
 * does not publish over Bolt is left out or said to be unknown rather than filled: no uptime, no store size,
 * no cache ratio and no connection count, so `activeConnections` is absent, which is a different fact from
 * zero, and `maxConnections` is 0, "no limit published".
 *
 * A count arrives as the transport writes a 64-bit integer: a number, or its decimal string beyond 2^53.
 * The overview's text keeps every digit; a numeric field takes the nearest number, as it must.
 */
import type { ActiveSessionDetails, DatabaseOverview, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import { formatDuration } from "@/lib/db/utils/pool-manager";

/** The release series this provider is verified against; any other server connects and is marked untested. */
export const NEO4J_TESTED_SERIES = "5.26.";

/** What Neo4j does not report, in the words the monitoring panels already render. */
const NOT_REPORTED = "N/A";

/** A listing the catalog's row bound cut, phrased to follow "counted from" (`DatabaseOverview.tableCountSampledFrom`). */
const CATALOG_CUT_SAMPLE = "one catalog read that stopped at its row bound";

/** The kernel's version and edition, as `dbms.components()` answers them. */
export interface Neo4jServerVersion {
  readonly version: string;
  readonly edition: string;
}

/** A 64-bit count as the transport writes it. */
export type Neo4jCount = number | string;

/**
 * The overview's version text: "5.26.31 community", "<version> <edition> (untested)" outside 5.26, and
 * "unknown" when the read at connect failed. `DatabaseOverview` has no notice field, so the version carries it.
 */
export function versionText(server: Neo4jServerVersion | undefined): string {
  if (server === undefined) return "unknown";
  const text = `${server.version} ${server.edition}`;
  return server.version.startsWith(NEO4J_TESTED_SERIES) ? text : `${text} (untested)`;
}

/** Health after a successful verify and `db.ping()`: nothing more is published over Bolt. */
export function toHealthInfo(): HealthInfo {
  return { databaseSize: NOT_REPORTED, cacheHitRatio: NOT_REPORTED, slowQueries: [], activeSessions: [] };
}

/** What the overview is built from; an absent count is one the server refused to read. */
export interface Neo4jOverviewInput {
  readonly server: Neo4jServerVersion | undefined;
  readonly nodes: Neo4jCount | undefined;
  readonly relationships: Neo4jCount | undefined;
  readonly labels: number;
  readonly labelsCut: boolean;
  readonly relationshipTypes: number;
  readonly relationshipTypesCut: boolean;
  readonly indexes: number;
}

function counted(count: Neo4jCount | undefined, noun: string, singular: string): string {
  return count === undefined ? `${singular} count not readable` : `${count} ${noun}`;
}

/**
 * Labels are the tables (`tableCount`, a floor when the listing was cut), the created indexes are
 * `indexCount`, and the graph's size is said in nodes and relationships, since Bolt reports no store size.
 */
export function toOverview(input: Neo4jOverviewInput): DatabaseOverview {
  const types = `${input.relationshipTypesCut ? "at least " : ""}${input.relationshipTypes} relationship types`;
  return {
    version: versionText(input.server),
    uptime: NOT_REPORTED,
    maxConnections: 0,
    databaseSize: `${counted(input.nodes, "nodes", "node")} and ${counted(input.relationships, "relationships", "relationship")} of ${types}`,
    tableCount: input.labels,
    ...(input.labelsCut ? { tableCountSampledFrom: CATALOG_CUT_SAMPLE } : {}),
    indexCount: input.indexes,
  };
}

/** Days, hours, minutes and seconds: the form Neo4j writes a transaction's elapsed time in. */
const ELAPSED = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** An ISO 8601 duration of days and time to milliseconds; undefined for any other text, or one naming nothing. */
export function isoDurationMs(text: string): number | undefined {
  const match = ELAPSED.exec(text);
  if (match === null || text.endsWith("P") || text.endsWith("T")) return undefined;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

/** One running transaction, its fields as `SHOW TRANSACTIONS` yields them, the elapsed time read. */
export interface Neo4jTransaction {
  readonly database: string;
  readonly transactionId: string;
  readonly username: string;
  readonly currentQuery: string;
  readonly startTime: string;
  readonly status: string;
  readonly durationMs: number;
}

/** One session per transaction, its transaction id as the pid. */
export function toActiveSessions(transactions: readonly Neo4jTransaction[]): ActiveSessionDetails[] {
  return transactions.map((transaction) => ({
    pid: transaction.transactionId,
    user: transaction.username,
    database: transaction.database,
    state: transaction.status,
    query: transaction.currentQuery,
    queryStart: new Date(transaction.startTime),
    duration: formatDuration(transaction.durationMs),
    durationMs: transaction.durationMs,
  }));
}

/** One label's node count. */
export interface Neo4jLabelCount {
  readonly label: string;
  readonly count: Neo4jCount;
}

/**
 * One row per label with its node count from the count store. No read reports a label's bytes, so
 * `totalSize` reads "N/A" beside the 0 the required `totalSizeBytes` carries, the shape the Tables and
 * Storage tabs read as unknown.
 */
export function toTableStats(database: string, counts: readonly Neo4jLabelCount[]): TableStats[] {
  return counts.map((entry) => ({
    schemaName: database,
    tableName: entry.label,
    rowCount: Number(entry.count),
    totalSize: NOT_REPORTED,
    totalSizeBytes: 0,
  }));
}

/** One created index's usage, as `SHOW INDEXES` yields it, with its uniqueness from the catalog. */
export interface Neo4jIndexUsage {
  readonly name: string;
  readonly type: string;
  readonly labelsOrTypes: readonly string[];
  readonly properties: readonly string[];
  readonly state: string;
  readonly readCount: Neo4jCount;
  readonly populationPercent: number;
  readonly unique: boolean;
}

/**
 * Reads since tracking started are the scans. `IndexStats` has no state field, so an index that is not
 * ONLINE names its state and population beside its type; Neo4j has no primary index and reports no size.
 */
export function toIndexStats(database: string, usage: readonly Neo4jIndexUsage[]): IndexStats[] {
  return usage.map((index) => ({
    schemaName: database,
    tableName: index.labelsOrTypes.join(", "),
    indexName: index.name,
    indexType:
      index.state === "ONLINE" ? index.type : `${index.type} (${index.state}, ${index.populationPercent}% populated)`,
    columns: [...index.properties],
    isUnique: index.unique,
    isPrimary: false,
    indexSize: NOT_REPORTED,
    scans: Number(index.readCount),
  }));
}
