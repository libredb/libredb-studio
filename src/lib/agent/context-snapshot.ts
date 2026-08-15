/**
 * The run's context snapshot, and the packing that puts part of it in a prompt
 * (#329 T8, epic #325).
 *
 * A run reasons about a schema it has to be told about, and the two obvious ways to
 * tell it are both wrong: asking the provider directly bypasses the M1 enforcement
 * layer, and serialising the whole inventory into every prompt spends the context
 * window on tables the task is not about. This module does neither.
 *
 *  - **Every read goes through the T6 catalog tool.** `captureContextSnapshot`
 *    calls `readCatalogForGrounding`, which composes the statement server-side and
 *    drives it through `executeAuditedOperation` under the read-only profile. So
 *    a snapshot costs statements out of the run's budget, is audited line by line,
 *    and is refused by the same policy as any other read. There is no faster path
 *    and deliberately no seam for one.
 *  - **The rows come back out of the run's artifact store**, keyed by the
 *    correlation id the tool returned — the same store a later claim cites. A
 *    result that has been released or has expired yields no snapshot rather than a
 *    reconstruction from the model-facing text.
 *  - **The inventory is all-or-nothing.** One refused read loses the whole
 *    snapshot, because an inventory missing its keys while claiming to be whole is
 *    worse than no inventory: the model would reason about relations that are
 *    simply absent from what it was shown. The run then continues WITHOUT a
 *    snapshot and is told to use `inspect_schema` itself, narrowed.
 *
 * The fingerprint is a function of the inventory and nothing else — not of the
 * reading time, not of the connection — so two identical builds agree and a changed
 * schema does not.
 *
 * A captured inventory is also HELD for its connection, in this process, and that is
 * one of the three places a planning run's grounding can come from (#384). It was the
 * ONLY one until 2026-08-15, which is what made plan mode blind after a restart and
 * on a second replica; a plan run now captures its own inventory when neither its
 * ledger nor this hold has one, and fills the hold in turn. The model stays toolless
 * on every one of those paths. See `holdSnapshotForConnection`.
 *
 * That is what makes the REFRESH free. A capture is recorded in the run's ledger
 * with the inventory attached, so a later drive — including one that resumed after
 * the process died — calls `reusableSnapshot` and re-derives its whole schema
 * context from the record it has already read, performing no database operation at
 * all. The fingerprint is the key: the recorded entry is trusted only when the
 * identity it advertises is the one its own inventory produces.
 *
 * SQLite and PostgreSQL answer differently and the asymmetry is structural, not
 * cosmetic: PostgreSQL has three flat catalog projections, while SQLite has no
 * structured catalog on this path at all (the guard refuses every `pragma_*`
 * function) and its columns, keys and relations are read out of the DDL text the
 * engine stored — see `sqlite-ddl.ts`.
 */

import { createHash } from "node:crypto";
import type { AgentCatalogKind } from "./composed-sql";
import { parseSqliteIndexDdl, parseSqliteTableDdl } from "./sqlite-ddl";
import { type AgentToolContext, readCatalogForGrounding } from "./tools";
import type { AgentContextSnapshot, AgentRunEvent } from "./types";
import { fenceUntrustedContent } from "./untrusted-content";
import type {
  ColumnSchema,
  DatabaseConnection,
  DatabaseType,
  ForeignKeySchema,
  IndexSchema,
  TableSchema,
} from "@/lib/types";

/** Why a run has no snapshot. Both are states the run continues from, not failures. */
export type AgentContextUnavailableCode =
  /** A catalog read did not complete: refused, denied, out of budget, or unserved. */
  | "CATALOG_READ_REFUSED"
  /** The read completed but its rows are no longer in the run's artifact store. */
  | "CATALOG_RESULT_UNAVAILABLE";

export type AgentContextCapture =
  | { readonly kind: "captured"; readonly snapshot: AgentContextSnapshot }
  | {
      readonly kind: "unavailable";
      readonly reasonCode: AgentContextUnavailableCode;
      /** What the model is told, so it inspects the schema itself instead. */
      readonly modelText: string;
    };

const FALLBACK_ADVICE =
  "No schema inventory was captured for this run, so nothing about the schema has been established for you. Use inspect_schema — with a schema or table selector on a large database — before drafting a statement.";

interface MutableTable {
  readonly name: string;
  readonly columns: ColumnSchema[];
  readonly indexes: IndexSchema[];
  readonly foreignKeys: ForeignKeySchema[];
}

type TableIndex = Map<string, MutableTable>;

/**
 * How one dialect's inventory is read: which catalog kinds to ask for, and how to
 * turn their rows into tables.
 *
 * A dialect absent from this map gets no snapshot and reaches no database.
 * `composed-sql.ts` holds the same served-dialect decision for the tool the model
 * drives; the duplication is deliberate rather than shared, because the two answer
 * different questions — one is "can a statement be composed", the other is "can its
 * rows be read back into an inventory" — and a dialect can honestly gain the first
 * before the second. A dialect that composes but is missing here yields no
 * snapshot, which is the safe direction.
 */
interface CatalogPlan {
  readonly kinds: readonly AgentCatalogKind[];
  readonly build: (rows: ReadonlyMap<AgentCatalogKind, readonly Record<string, unknown>[]>) => TableIndex;
}

const CATALOG_PLANS: Partial<Record<DatabaseType, CatalogPlan>> = {
  postgres: { kinds: ["columns", "relations", "indexes"], build: buildPostgresTables },
  // Two reads, not three: a SQLite table's foreign keys are declared inside its own
  // `CREATE TABLE` text, which the object read already returns.
  sqlite: { kinds: ["columns", "indexes"], build: buildSqliteTables },
};

// ============================================================================
// Reading rows
// ============================================================================

/** A row value as text. Engine drivers return numbers and booleans for some columns. */
function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** PostgreSQL booleans arrive as booleans from `pg`, and as `t`/`true` from elsewhere. */
function truthy(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

const qualified = (schema: unknown, table: unknown): string => `${text(schema)}.${text(table)}`;

/** Applies `change` to a known table, and drops the row when there is no such table. */
function attach(tables: TableIndex, name: string, change: (table: MutableTable) => void): void {
  const table = tables.get(name);
  if (table !== undefined) change(table);
}

function markPrimary(table: MutableTable, columnName: string): void {
  for (const column of table.columns) {
    if (column.name === columnName) column.isPrimary = true;
  }
}

function emptyTable(name: string): MutableTable {
  return { name, columns: [], indexes: [], foreignKeys: [] };
}

function buildPostgresTables(rows: ReadonlyMap<AgentCatalogKind, readonly Record<string, unknown>[]>): TableIndex {
  const tables: TableIndex = new Map();

  for (const row of rows.get("columns") ?? []) {
    const name = qualified(row.table_schema, row.table_name);
    const table = tables.get(name) ?? emptyTable(name);
    tables.set(name, table);
    table.columns.push({
      name: text(row.column_name),
      type: text(row.data_type),
      nullable: text(row.is_nullable).toUpperCase() === "YES",
      isPrimary: false,
    });
  }

  for (const row of rows.get("relations") ?? []) {
    attach(tables, qualified(row.table_schema, row.table_name), (table) => {
      table.foreignKeys.push({
        columnName: text(row.column_name),
        referencedTable: qualified(row.referenced_schema, row.referenced_table),
        referencedColumn: text(row.referenced_column),
      });
    });
  }

  // One row per indexed column, in the index's own column order, so an index is
  // assembled across rows rather than declared by one.
  for (const row of rows.get("indexes") ?? []) {
    const indexName = text(row.index_name);
    const columnName = text(row.column_name);
    attach(tables, qualified(row.table_schema, row.table_name), (table) => {
      let index = table.indexes.find((candidate) => candidate.name === indexName);
      if (index === undefined) {
        index = { name: indexName, columns: [], unique: truthy(row.is_unique) };
        table.indexes.push(index);
      }
      index.columns.push(columnName);
      if (truthy(row.is_primary)) markPrimary(table, columnName);
    });
  }

  return tables;
}

function buildSqliteTables(rows: ReadonlyMap<AgentCatalogKind, readonly Record<string, unknown>[]>): TableIndex {
  const tables: TableIndex = new Map();

  for (const row of rows.get("columns") ?? []) {
    const name = text(row.name);
    const definition = parseSqliteTableDdl(text(row.sql));
    tables.set(name, {
      name,
      columns: [...definition.columns],
      indexes: [],
      foreignKeys: [...definition.foreignKeys],
    });
  }

  for (const row of rows.get("indexes") ?? []) {
    const parsed = parseSqliteIndexDdl(text(row.sql));
    if (parsed === null) continue;
    attach(tables, text(row.tbl_name), (table) => {
      table.indexes.push({ name: text(row.name), columns: [...parsed.columns], unique: parsed.unique });
    });
  }

  return tables;
}

/** Ordered so two identical inventories serialise identically. */
function finalize(tables: TableIndex): TableSchema[] {
  return [...tables.values()]
    .sort((left, right) => (left.name === right.name ? 0 : left.name < right.name ? -1 : 1))
    .map((table) => ({
      name: table.name,
      columns: table.columns,
      indexes: [...table.indexes].sort((left, right) =>
        left.name === right.name ? 0 : left.name < right.name ? -1 : 1,
      ),
      foreignKeys: table.foreignKeys,
    }));
}

/**
 * The inventory's identity.
 *
 * Everything a reader would call "the schema" is in it and nothing else is: not the
 * time it was read, not the connection it was read from, not the order the rows
 * arrived in. So the same database fingerprints the same twice, and a resumed run
 * can tell whether it is looking at the schema its earlier claims were made about.
 */
function fingerprintTables(tables: readonly TableSchema[]): string {
  const canonical = JSON.stringify(
    tables.map((table) => [
      table.name,
      table.columns.map((column) => [column.name, column.type, column.nullable, column.isPrimary]),
      table.indexes.map((index) => [index.name, index.unique, index.columns]),
      (table.foreignKeys ?? []).map((key) => [key.columnName, key.referencedTable, key.referencedColumn]),
    ]),
  );
  return `ctx_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

// ============================================================================
// Capture
// ============================================================================

function unavailable(reasonCode: AgentContextUnavailableCode, detail: string): AgentContextCapture {
  return { kind: "unavailable", reasonCode, modelText: `${detail}\n${FALLBACK_ADVICE}` };
}

/**
 * The inventory this run already recorded, or `null` when it has to be read.
 *
 * This is the refresh, and it performs NO database operation: a run that has
 * captured its context once carries the whole inventory in its own ledger, so every
 * later drive — including one that resumed after the process died — re-derives its
 * schema context by reading the ledger it was going to read anyway.
 *
 * Keyed on the fingerprint in both directions, which is what makes the reuse safe
 * rather than merely cheap:
 *
 *  - the recorded entry is refused unless the fingerprint and table count it
 *    ADVERTISES are the ones its own inventory produces, so a ledger written by a
 *    different version, or by a writer that summarised something else, is re-read
 *    instead of trusted;
 *  - the snapshot is refused unless it describes THIS run's connection, so an
 *    inventory can never travel between databases.
 *
 * The last recorded capture wins, because a run that noticed its schema move
 * recorded the newer one. What this deliberately does NOT do is notice a schema
 * that moves while the run is live: the run reasons over the inventory its earlier
 * claims cite, and a mid-run re-read would leave those claims describing a schema
 * the report no longer shows. That is the same choice `types.ts` records for the
 * fingerprint itself.
 */
export function reusableSnapshot(events: readonly AgentRunEvent[], connectionId: string): AgentContextSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "context-captured") continue;
    const { snapshot } = event;
    // Every refusal below is a RE-READ, not a fall back to an older capture: an
    // entry the checks reject says the ledger is not one this code wrote, and
    // reaching past it would hand the run an inventory two captures out of date.
    if (snapshot === undefined || snapshot.connectionId !== connectionId) return null;
    if (snapshot.fingerprint !== event.fingerprint || snapshot.tables.length !== event.tableCount) return null;
    if (fingerprintTables(snapshot.tables) !== snapshot.fingerprint) return null;
    return snapshot;
  }
  return null;
}

/**
 * Reads the run's schema inventory through the catalog tool.
 *
 * Runs before the first model turn of a drive that has no recorded inventory to
 * reuse. It costs one statement per catalog kind out of the run's budget, which is
 * why the result is persisted rather than re-read.
 *
 * PLANNING RUNS REACH THIS TOO, since the plan-mode grounding design of 2026-08-15.
 * Until then a planning run was refused here by the mode gate in `tools.ts` and was
 * left scavenging whatever inventory this process happened to hold, which made the
 * safe mode's usefulness conditional on having already used the unsafe one. What has
 * NOT changed is the property the mode actually sells: this is a catalog read, no
 * statement of the user's is run, nothing is written, and the model is still handed
 * no tools — `readCatalogForGrounding` is the server's own call, and
 * `selectAgentTools` still yields an empty set for the mode.
 */
export async function captureContextSnapshot(context: AgentToolContext): Promise<AgentContextCapture> {
  const plan = CATALOG_PLANS[context.connection.type];
  if (plan === undefined) {
    return unavailable(
      "CATALOG_READ_REFUSED",
      `No schema inventory can be read for a ${context.connection.type} connection.`,
    );
  }

  const nowMs = context.clock?.() ?? Date.now();
  const rows = new Map<AgentCatalogKind, readonly Record<string, unknown>[]>();

  for (const kind of plan.kinds) {
    const outcome = await readCatalogForGrounding(context, { kind });
    if (outcome.kind !== "completed") return unavailable("CATALOG_READ_REFUSED", outcome.modelText);
    const artifact = context.artifacts.get(outcome.artifact.correlationId, nowMs);
    if (artifact === undefined) {
      return unavailable(
        "CATALOG_RESULT_UNAVAILABLE",
        `The ${kind} inventory was read but its rows are no longer held by this run.`,
      );
    }
    rows.set(kind, artifact.value.rows);
  }

  const tables = finalize(plan.build(rows));
  return {
    kind: "captured",
    snapshot: {
      connectionId: context.connection.id,
      fingerprint: fingerprintTables(tables),
      capturedAtMs: nowMs,
      tables,
    },
  };
}

// ============================================================================
// What this process has already read
// ============================================================================

/**
 * The inventories this PROCESS has already read, one per connection (#384).
 *
 * It exists to spare a second reading of a catalog this process has already read.
 * That was originally stated as existing FOR planning mode, which could read no
 * catalog of its own and was otherwise reduced to writing the plan it would write
 * about any database in the world — what live runs on 2026-08-15 actually produced.
 * Since the plan-mode grounding design of that date a plan run captures its own
 * inventory when this holds none, so the hold is a fast path rather than the only
 * path, and it is filled by both modes.
 *
 * Three properties are what make that safe rather than merely cheap:
 *
 *  - **Nothing here ever reads a database.** Entries arrive only from
 *    `captureContextSnapshot`, which goes through the T6 catalog tool; this module
 *    adds no second path to an engine.
 *  - **An entry is refused unless its identity is the one its own inventory
 *    produces**, exactly as `reusableSnapshot` refuses a ledger entry. A snapshot
 *    that fingerprints as something else is not held at all, so a reader never has
 *    to decide whether to trust one.
 *  - **It is keyed by connection**, which is the same boundary the run loop already
 *    enforces (`RUN_CONNECTION_MISMATCH`). Everyone who can open a run on a
 *    connection can read its catalog through that run anyway. What the key does NOT
 *    carry is the database that connection currently points at, or its dialect: a
 *    connection record re-pointed at another database while keeping its id would be
 *    served the old inventory here. That is recorded as `docs/BACKLOG.md` B45 rather
 *    than left for a reader to find, and it matters more now that a plan run both
 *    fills this and reads it.
 *
 * What it deliberately is NOT: durable. This is process memory, like the run-scoped
 * artifact store and for the same reason. Losing it on a restart no longer costs a
 * plan run its grounding — it costs one catalog read, because the run captures its
 * own — so what a miss buys is a statement, not the difference between a grounded
 * plan and a blind one.
 */
const HELD_SNAPSHOT_LIMIT = 16;

const heldSnapshots = new Map<string, AgentContextSnapshot>();

/**
 * The fields that decide WHICH database a reading came from, and whose view of it.
 *
 * The hold used to be keyed on the connection id alone (`docs/BACKLOG.md` B45). Neither
 * the key nor the snapshot carried any database identity — `AgentContextSnapshot` holds
 * an id, a fingerprint, a time and the tables — so a connection record re-pointed at
 * another database while keeping its id was served the old one's inventory until the
 * entry aged out or the process restarted. Editing a saved connection to aim at staging
 * instead of production is an ordinary thing to do, and the id does not change when you
 * do it.
 *
 * It mattered before the plan-mode grounding work and it matters more after it: what the
 * hold serves is now the ground a drafted statement is VALIDATED against, so a statement
 * checked against another database's tables comes back with no unknown names — the card
 * reports "checked" for a check performed against the wrong catalog. That is the exact
 * class of claim this whole design item exists to stop making.
 *
 * Over-keying is deliberately the safe direction. A miss costs ONE catalog read, because
 * a plan run captures its own inventory when the hold has nothing for it; a false hit
 * costs a confident answer about a database nobody looked at. So the user fields are in
 * here too — a least-privilege role sees a different catalog — while the password is
 * not: rotating a credential does not change which database this is.
 *
 * Hashed rather than concatenated because `connectionString` can carry a password, and a
 * process-lifetime map should not hold one as a key.
 */
export function connectionIdentity(connection: DatabaseConnection): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        connection.id,
        connection.type,
        connection.host ?? "",
        connection.port ?? "",
        connection.database ?? "",
        connection.connectionString ?? "",
        connection.serviceName ?? "",
        connection.instanceName ?? "",
        connection.user ?? "",
        connection.agentUser ?? "",
      ]),
    )
    .digest("hex");
}

/**
 * Holds one connection's inventory for later reuse. Bounded, newest reading kept.
 *
 * Two things happen here and they are deliberately not the same thing, because the
 * callers differ in age. A fresh CAPTURE is always the newest reading of a
 * connection there is; a resumed run's LEDGER REUSE carries whatever that run read
 * when it started, which may be hours older than what another run has since held.
 *
 *  - **Which reading is kept is decided by `capturedAtMs`**, so a resumed run cannot
 *    walk the whole process back to its own older schema and ground every later plan
 *    run on it. Nothing would observe that regression: both inventories are
 *    internally valid, and neither is a lie about the database it came from.
 *  - **Where the connection sits in the bound is decided by USE**, so re-holding it
 *    moves it to the end of the insertion order whichever reading won. A connection a
 *    resumed run is actively working on must not age out under sixteen connections
 *    read once each.
 *
 * Found by review on #384, which had one `delete`/`set` doing both jobs at once.
 */
export function holdSnapshotForConnection(snapshot: AgentContextSnapshot, identity: string): void {
  if (fingerprintTables(snapshot.tables) !== snapshot.fingerprint) return;
  const held = heldSnapshots.get(identity);
  const newest = held !== undefined && held.capturedAtMs > snapshot.capturedAtMs ? held : snapshot;
  // Deleted before it is set, so the connection's place in the eviction order below
  // is refreshed even on the path where the reading it arrived with was the older one.
  heldSnapshots.delete(identity);
  heldSnapshots.set(identity, newest);
  for (const oldest of heldSnapshots.keys()) {
    if (heldSnapshots.size <= HELD_SNAPSHOT_LIMIT) break;
    heldSnapshots.delete(oldest);
  }
}

/**
 * The inventory this process holds for a connection, or `null` when it holds none.
 *
 * Keyed on `connectionIdentity` and not on the connection id: a record re-pointed at
 * another database keeps its id, and being served the previous database's tables is a
 * miss this layer cannot detect afterwards (B45).
 */
export function heldSnapshotForConnection(identity: string): AgentContextSnapshot | null {
  return heldSnapshots.get(identity) ?? null;
}

/**
 * Empties the hold. For tests, which must be able to express the cold process —
 * the one a plan run finds after a restart, and the case a grounded run must not
 * be mistaken for.
 */
export function forgetHeldSnapshots(): void {
  heldSnapshots.clear();
}

// ============================================================================
// Packing
// ============================================================================

/**
 * The bound on one packed context, in characters.
 *
 * A character bound rather than a token one: the token count depends on the model's
 * tokeniser, which this layer does not know and must not guess at. Roughly a
 * quarter of this in tokens for schema text, which is a small fraction of any model
 * the registry serves — the point is that a 500-table database cannot push the
 * objective, the rules and the run's own progress out of the window.
 */
export const AGENT_CONTEXT_PACK_MAX_CHARS = 6_000;

/** Per table, so one wide table cannot spend the whole budget on itself. */
const MAX_COLUMNS_PER_TABLE = 12;
const MAX_INDEXES_PER_TABLE = 4;

/**
 * Words that say nothing about which table a question is about. Short tokens are
 * dropped by length, so this list only has to carry the common longer ones.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "any",
  "are",
  "been",
  "but",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "into",
  "its",
  "not",
  "our",
  "over",
  "than",
  "that",
  "the",
  "their",
  "then",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
]);

function taskTerms(objective: string): string[] {
  return (objective.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (term) => term.length >= 3 && !STOPWORDS.has(term),
  );
}

/**
 * How much this table looks like what the task is about.
 *
 * A name match outweighs a column match, because a question naming `orders` is
 * about the orders table, not about every table carrying an `orders_id`. Ties are
 * broken by name so the packing is deterministic — two runs with the same objective
 * and the same schema produce the same prompt.
 */
function relevance(table: TableSchema, terms: readonly string[]): number {
  const name = table.name.toLowerCase();
  const columns = table.columns.map((column) => column.name.toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (name.includes(term)) score += 3;
    else if (columns.some((column) => column.includes(term))) score += 1;
  }
  return score;
}

function renderColumn(table: TableSchema, column: ColumnSchema): string {
  const reference = (table.foreignKeys ?? []).find((key) => key.columnName === column.name);
  return [
    column.name,
    column.type === "" ? "" : ` ${column.type}`,
    column.nullable ? "" : " NOT NULL",
    column.isPrimary ? " PK" : "",
    reference === undefined ? "" : ` -> ${reference.referencedTable}.${reference.referencedColumn}`,
  ].join("");
}

function renderTable(table: TableSchema): string {
  const shown = table.columns.slice(0, MAX_COLUMNS_PER_TABLE).map((column) => renderColumn(table, column));
  const hidden = table.columns.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more column(s)`);

  const indexes = table.indexes
    .slice(0, MAX_INDEXES_PER_TABLE)
    .map((index) => `${index.name}${index.unique ? " unique" : ""} (${index.columns.join(", ")})`);
  const hiddenIndexes = table.indexes.length - indexes.length;
  if (hiddenIndexes > 0) indexes.push(`+${hiddenIndexes} more`);

  const columnText = shown.length === 0 ? "no columns derivable from the stored definition" : shown.join(", ");
  const indexText = indexes.length === 0 ? "" : `; indexes: ${indexes.join(", ")}`;
  return `${table.name}: ${columnText}${indexText}`;
}

/**
 * The part of the inventory this task is about, fenced for a prompt.
 *
 * Bounded by construction rather than by trimming afterwards: lines are added while
 * the FENCED result still fits, so the envelope, the omission notice and the
 * marker-neutralising expansion are all inside the bound rather than added to it.
 * What does not fit is named as omitted — a model told that 34 tables exist and are
 * not shown asks for the one it needs; a model shown a silently truncated list
 * believes it has seen the schema.
 *
 * Table and column names are DATABASE CONTENT and are therefore fenced as untrusted
 * input, exactly like rows: a column comment or a table name is writable by whoever
 * can write to the database.
 *
 * A `preface` is the SERVER's own sentence, placed ahead of the fence — a caller that
 * needs to say something about the inventory (how to cite it, say) cannot say it
 * inside a region the model is told to treat as data. It is a parameter rather than
 * something a caller concatenates because the bound is this function's to keep:
 * anything prepended outside would overrun it silently, by exactly its own length.
 */
export function packContextForTask(
  snapshot: AgentContextSnapshot,
  objective: string,
  options: { readonly maxChars?: number; readonly preface?: string } = {},
): string {
  const lead = options.preface === undefined ? "" : `${options.preface}\n`;
  const maxChars = (options.maxChars ?? AGENT_CONTEXT_PACK_MAX_CHARS) - lead.length;
  const source = {
    label: "schema inventory",
    operationId: "agent/context-snapshot",
    reference: snapshot.fingerprint,
  };

  // The capture time is named because the inventory can be REUSED: a run resumed
  // hours later is shown the schema it started with, and a model told only "the
  // schema" would take it for the schema as it is now.
  const header = `Schema inventory for this run — fingerprint ${snapshot.fingerprint}, ${snapshot.tables.length} table(s) read at epoch ${snapshot.capturedAtMs}ms and not re-read since, most task-relevant first.`;
  if (snapshot.tables.length === 0) {
    return `${lead}${fenceUntrustedContent(`${header}\nThis database reported no tables.`, source)}`;
  }

  const terms = taskTerms(objective);
  const ranked = [...snapshot.tables].sort((left, right) => {
    const difference = relevance(right, terms) - relevance(left, terms);
    return difference !== 0 ? difference : left.name < right.name ? -1 : 1;
  });

  const close = (body: string, omitted: number): string =>
    omitted === 0
      ? body
      : `${body}\n${omitted} further table(s) omitted as less relevant to this task; call inspect_schema with a table selector to read any of them.`;

  let body = header;
  let shown = 0;
  for (const table of ranked) {
    const candidate = `${body}\n${renderTable(table)}`;
    if (fenceUntrustedContent(close(candidate, ranked.length - shown - 1), source).length > maxChars) break;
    body = candidate;
    shown += 1;
  }

  return `${lead}${fenceUntrustedContent(close(body, ranked.length - shown), source)}`;
}
