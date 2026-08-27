/**
 * The run's context snapshot, and the packing that puts part of it in a prompt
 * (#329 T8, epic #325).
 *
 * A run reasons about a schema it has to be told about, and the two obvious ways to
 * tell it are both wrong: reaching a provider BESIDE the M1 enforcement layer, and
 * serialising the whole inventory into every prompt, which spends the context window
 * on tables the task is not about. This module does neither.
 *
 *  - **Every read goes through the audited pipeline, and there are now TWO of them**
 *    (#414). On a dialect `CATALOG_PLANS` serves, `captureContextSnapshot` calls
 *    `readCatalogForGrounding`, which composes the statement server-side and drives
 *    it through `executeAuditedOperation` under the read-only profile. On every other
 *    dialect it calls `readProviderSchemaForGrounding`, which asks the provider for
 *    its own schema inspection — the reading the sidebar already performs — under the
 *    operations profile.
 *
 *    The second path is not the objection above returning under a new name, and the
 *    difference is mechanical rather than a matter of degree. What "asking the
 *    provider directly" meant was a call with no operation descriptor naming it, no
 *    policy able to deny it, no budget charged for it and no audit line recording it.
 *    This one has all four: `db.schema.read` is a canonical R0 descriptor, the call
 *    is admitted by the run deadline, costs a statement out of `maxStatementsPerRun`,
 *    is denied or allowed by the same policy as every other reach, and lands on the
 *    audit stream under its own operation id — which an operator can deny on its own
 *    without denying any other agent read. So a snapshot still costs the run
 *    something, is still refusable, and there is still no seam for a faster path.
 *
 *    The two paths are a real asymmetry rather than a transitional state, and
 *    PostgreSQL and SQLite deliberately do NOT converge on the provider one. Three
 *    reasons, all of them properties the composed path has and this one cannot:
 *    the composed reads are audited STATEMENT BY STATEMENT rather than as one opaque
 *    call; they carry foreign keys, which the provider path cannot on any engine that
 *    does not declare them; and SQLite's inventory is parsed out of the DDL text the
 *    engine stored, which its provider does not expose in the same shape.
 *  - **The catalog path's rows come back out of the run's artifact store**, keyed by
 *    the correlation id the tool returned — the same store a later claim cites. A
 *    result that has been released or has expired yields no snapshot rather than a
 *    reconstruction from the model-facing text. The provider path does not round-trip
 *    through the store, because it never turned its inventory into text: it returns
 *    the tables themselves and puts a projection of them in the artifact so the call
 *    is still citable. See `readProviderSchemaForGrounding`.
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
import { type AgentInventoryNoun, TABLE_INVENTORY_NOUN } from "./inventory-noun";
import { parseSqliteIndexDdl, parseSqliteTableDdl } from "./sqlite-ddl";
import {
  type AgentProviderSchemaRead,
  type AgentToolContext,
  readCatalogForGrounding,
  readProviderSchemaForGrounding,
} from "./tools";
import type { AgentContextSnapshot, AgentRunEvent } from "./types";
import { fenceUntrustedContent, quoteIdentifierForPrompt } from "./untrusted-content";
import { DatabaseError, ExecutionProfileError } from "@/lib/db/errors";
import type {
  ColumnSchema,
  DatabaseConnection,
  DatabaseType,
  ForeignKeySchema,
  IndexSchema,
  TableSchema,
} from "@/lib/types";

/**
 * How much of a catalog a refused capture asked for, against how much it may have.
 *
 * Its own named shape rather than two loose numbers, because it travels: the capture
 * carries it, the `context-unavailable` ledger entry records it, and a reader that had
 * to guess which of two bare integers was the bound is a reader that will guess wrong.
 */
export interface AgentContextRowBudget {
  /** Rows the read produced, or would have. */
  readonly projected: number;
  /** Rows this run's policy allows one read to carry. */
  readonly allowed: number;
}

/** Why a run has no snapshot. All are states the run continues from, not failures. */
export type AgentContextUnavailableCode =
  /**
   * A schema read did not complete: refused, denied, out of budget, rejected by the
   * engine — or, on the provider path, never reached, because the connection could not
   * be opened or the execution profile could not be granted.
   *
   * It kept the `CATALOG_` name when the second path arrived, because the code is
   * written into ledgers this server still reads and renaming it would silently
   * reclassify every run recorded before #414. The name is narrower than the set, and
   * the DETAIL is what a reader is shown: each of those causes carries its own sentence.
   */
  | "CATALOG_READ_REFUSED"
  /** The read completed but its rows are no longer in the run's artifact store. */
  | "CATALOG_RESULT_UNAVAILABLE"
  /**
   * The provider's own schema inspection did not answer within the time this call
   * was granted (#414). Its own code and not `CATALOG_READ_REFUSED`, because the two
   * ask an operator for different things: a refusal is a decision somebody made about
   * this run, while this one says the engine is slower to describe itself than a run
   * of this workflow has to spend — which is a fact about the database, and on a large
   * MongoDB or MySQL schema an ordinary one.
   */
  | "PROVIDER_INVENTORY_TIMED_OUT";

/**
 * What a capture SPENT, taken from the tracker's own accounting (B13).
 *
 * The capture's reads reach `executeAuditedOperation` through
 * `readCatalogForGrounding` and `readProviderSchemaForGrounding` rather than through
 * the run loop's `runStep`, and `runStep` is the only writer of `tool-completed`. So
 * two or three catalog statements were charged against exactly the ceilings the rail
 * displays and left no entry the rail could fold: an agent-mode drive with no
 * reusable snapshot read "0 of 20 statements" with three already spent, before the
 * model's first turn.
 *
 * MEASURED rather than counted here, and the difference is the whole reason this is a
 * delta of `tracker.usage` around the reading instead of `plan.kinds.length`: what the
 * budget enforces is what the tracker holds, and a read the pipeline denied before
 * `beginExecution` charges nothing while an acquisition failure charges a statement
 * for a call that never ran. A figure composed from the plan would state the reads
 * this module INTENDED; this one states the reads the run paid for.
 *
 * `elapsedMs` is the span the tracker charged the whole capture, which is what
 * `maxTotalRunMs` is measured against — not the engine's own elapsed time, which is
 * the narrower figure a `tool-completed` entry carries.
 */
export interface AgentContextCharge {
  /** Statements the tracker charged this run while the capture was reading. */
  readonly statements: number;
  /** The span it charged them, in milliseconds. */
  readonly elapsedMs: number;
}

export type AgentContextCapture =
  | {
      readonly kind: "captured";
      readonly snapshot: AgentContextSnapshot;
      /**
       * What the reading cost, so the caller can record it (B13). Absent only where
       * a capture was composed by something other than `captureContextSnapshot` —
       * a fixture, or a test driving one of the two inner paths — and an absent
       * charge is recorded as no charge at all rather than as a zero spend.
       */
      readonly charged?: AgentContextCharge;
    }
  | {
      readonly kind: "unavailable";
      readonly reasonCode: AgentContextUnavailableCode;
      /**
       * The two numbers a row-budget refusal named, when that is what refused this
       * capture: how many rows the catalog read projected, and how many the run's
       * policy allows. Present only for that reason — see `rowBudgetIn`.
       */
      readonly rowBudget?: AgentContextRowBudget;
      /**
       * What the refused reading cost anyway (B13). A read the engine rejected was
       * admitted, charged and only then answered, so the spend is real even where the
       * inventory is not.
       */
      readonly charged?: AgentContextCharge;
      /**
       * WHY this run has no inventory, in one sentence and with no advice in it.
       *
       * Separate from `modelText` because the diagnosis and the way out belong to
       * different owners: the diagnosis is this module's — it is the only thing that
       * knows whether the dialect was unserved, the read refused or the rows already
       * released — while what to DO about it depends on which tools the caller handed
       * the run. `operations` holds no `inspect_schema`, so a caller for it composes
       * this half with advice of its own instead of forwarding `modelText`, and #411
       * found the alternative: substituting a whole sentence of the caller's own threw
       * the diagnosis away and told an operator "no inventory could be read on this
       * postgres connection" when the real cause was a denied catalog read.
       */
      readonly detail: string;
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
      // The constraint-created indexes SQLite stores no DDL for: the composed index
      // read below cannot see them, and they are what kept a UNIQUE-covered foreign
      // key reading as unindexed (docs/BACKLOG.md B25).
      indexes: [...definition.indexes],
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

/**
 * The row budget a refusal named, read out of the sentence that named it.
 *
 * A regex over a message is not the shape anybody would choose, and it is the only
 * shape available: the two numbers are formatted by the PROVIDER
 * (`postgres.ts`/`sqlite.ts` both refuse rather than truncate) into a `QueryError`
 * message, and neither the error nor the tool refusal that wraps it carries them as
 * fields. Reading them here is what turns the pair from prose the model was shown into
 * data the ledger can hold — which is the whole of B54's second half, since the reason
 * code alone says "somebody said no" where the numbers say "narrow the capture".
 *
 * Anchored on the whole phrase, so the `200` in the advice sentence the tool layer
 * appends ("add LIMIT 200") cannot be mistaken for a measurement. `statementAdvice` in
 * `tools.ts` reads the same message with the same anchor; the duplication is deliberate
 * rather than shared, because the two answer different questions — one composes advice
 * for a model, the other records a fact — and either may be given a different source.
 *
 * Absent when the refusal was about anything else, and absent is the honest answer:
 * this run met no budget, so a pair of zeros would be a measurement nobody took (#477).
 * The REASON CODE never depends on this function, so a message this cannot read still
 * produces a diagnosable entry — one that says "refused" without inventing a bound.
 *
 * EXPORTED so the loop can be closed by a test rather than by a comment. The hazard is
 * silent: reword the provider's sentence and this returns `undefined` for ever, the
 * ledger quietly loses the pair, and B54 re-opens with nothing going red. So
 * `tests/integration/db/sqlite-provider.test.ts` drives a REAL over-budget read through
 * `bun:sqlite`, catches the error the provider itself threw, and feeds its message
 * through here — and pins PostgreSQL's copy of the same sentence against its source.
 */
export function rowBudgetIn(detail: string): AgentContextRowBudget | undefined {
  const matched = /row budget: (\d+) rows > (\d+) allowed/.exec(detail);
  if (matched === null) return undefined;
  return { projected: Number(matched[1]), allowed: Number(matched[2]) };
}

function unavailable(reasonCode: AgentContextUnavailableCode, detail: string): AgentContextCapture {
  const rowBudget = rowBudgetIn(detail);
  return {
    kind: "unavailable",
    reasonCode,
    detail,
    ...(rowBudget === undefined ? {} : { rowBudget }),
    modelText: `${detail}\n${FALLBACK_ADVICE}`,
  };
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
 * Reads the run's schema inventory, through whichever of the two readings this
 * dialect has.
 *
 * Runs before the first model turn of a drive that has no recorded inventory to
 * reuse. It costs one statement per catalog kind out of the run's budget on the
 * composed path and exactly one on the provider path, which is why the result is
 * persisted rather than re-read — and what it actually cost is returned with the
 * snapshot, measured off the tracker, so the caller can record it (see
 * `AgentContextCharge`).
 *
 * PLANNING RUNS REACH THIS TOO, since the plan-mode grounding design of 2026-08-15.
 * Until then a planning run was refused here by the mode gate in `tools.ts` and was
 * left scavenging whatever inventory this process happened to hold, which made the
 * safe mode's usefulness conditional on having already used the unsafe one. What has
 * NOT changed is the property the mode actually sells: this is a schema read, no
 * statement of the user's is run, nothing is written, and the model is still handed
 * no tools — both `readCatalogForGrounding` and `readProviderSchemaForGrounding` are
 * the server's own calls, and `selectAgentTools` still yields an empty set for the
 * mode.
 */
export async function captureContextSnapshot(context: AgentToolContext): Promise<AgentContextCapture> {
  // Around the reading and not inside either path, because the two paths spend
  // differently — one statement per catalog kind against exactly one — and the
  // question the meter asks is what the capture cost, not which route it took.
  const before = context.tracker.usage(context.runId);
  const capture = await readInventory(context);
  const after = context.tracker.usage(context.runId);
  // A REFUSED capture is charged too, and that is the half of B13 the ledger's own
  // `context-unavailable` docblock deferred: a read the engine rejected, and a read
  // whose rows overran the budget, both spent a statement before saying no.
  return {
    ...capture,
    charged: {
      statements: after.executedStatements - before.executedStatements,
      elapsedMs: after.totalElapsedMs - before.totalElapsedMs,
    },
  };
}

/**
 * The reading itself, through whichever of the two paths this dialect has.
 *
 * Separate from the measurement above so the delta cannot be taken around part of a
 * capture: every `return` in here and in `captureFromProvider` is inside the span.
 */
async function readInventory(context: AgentToolContext): Promise<AgentContextCapture> {
  const plan = CATALOG_PLANS[context.connection.type];
  const nowMs = context.clock?.() ?? Date.now();
  // No composed catalog for this dialect, which used to end the capture here with
  // "no schema inventory can be read for a mongodb connection". One can: the product
  // reads it every time the sidebar lists a table. See `captureFromProvider`.
  if (plan === undefined) return captureFromProvider(context, nowMs);

  const rows = new Map<AgentCatalogKind, readonly Record<string, unknown>[]>();

  // The same catch the provider path has, and B48 is the record of it having been
  // absent here: a failure raised BEFORE the statement left — an unreachable host, a
  // wrong password, a refused execution profile — propagates out of
  // `readCatalogForGrounding` by design (`tools.ts`), so on PostgreSQL and SQLite it
  // ended the whole run `internal`, or `engine-unsupported` on the profile error,
  // where the same environment on the other nine engines lost only the grounding.
  // `environmentFailure` is shared with `captureFromProvider` so the two paths cannot
  // come to answer one environment in two voices.
  try {
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
  } catch (error) {
    const failure = environmentFailure(error, context);
    if (failure === null) throw error;
    return failure;
  }

  const tables = finalize(plan.build(rows));
  return {
    kind: "captured",
    snapshot: {
      connectionId: context.connection.id,
      fingerprint: fingerprintTables(tables),
      capturedAtMs: nowMs,
      tables,
      // Deliberately not stamped `"composed-catalog"`: absence already means that,
      // and every snapshot written before `readVia` existed came from here. Writing
      // it would change nothing a reader concludes and would make this path's output
      // differ, byte for byte, from what every ledger already holds.
    },
  };
}

/**
 * The same snapshot, read through the engine's own schema inspection (#414).
 *
 * The tables are NORMALISED before they become a snapshot: name, columns, indexes,
 * foreign keys, and nothing else. `rowCount` and `size` are what get dropped, and
 * dropping them is the point rather than tidiness. The fingerprint is over the
 * schema; a row estimate is not schema, so keeping it would make an inventory change
 * identity every time somebody inserted a row — and each provider means something
 * different by the number anyway (`estimatedDocumentCount` on MongoDB, a scanned key
 * sample on Redis, `TABLE_ROWS` on MySQL). Worse, it would arrive unlabelled through
 * a path that never announced it had one, which is exactly the kind of silent claim
 * this run is not allowed to make. Statistics have their own read and their own
 * honest "this engine holds none" answer (`schema-stats.ts`).
 *
 * `finalize` is reused rather than reimplemented, so the ordering and therefore the
 * fingerprint are produced by the same code the composed path uses: two readings of
 * the same schema have to agree whichever route reached them, or `reusableSnapshot`
 * and `holdSnapshotForConnection` would reject a run's own recorded capture.
 *
 * All-or-nothing, exactly as the composed path is. A refused read, a provider that
 * could not be reached, a schema the provider rejected the request for, and a read
 * that overran its time all lose the WHOLE snapshot: a partial inventory presented as
 * complete is the failure this module exists to avoid, and it is no less one for
 * having been read a second way.
 *
 * A failure raised BEFORE the reading left becomes an unavailable capture, rather than
 * propagating and ending the run — `environmentFailure` is where that is read, and the
 * composed path asks it too now (B48). That is a decision, and the
 * reason is what plan mode promises: it opens and answers on every engine, and it did
 * on these nine before this change, because nothing was reached at all. Letting an
 * unreachable host, a wrong password, a refused `connect()` or an `ExecutionProfileError`
 * from a half-configured `agentUser` out of here would lose a plan run to an
 * IMPROVEMENT — and on the profile error it would lose it under
 * "the agent cannot run on this database engine: it offers no read-only execution
 * profile", said about an engine where plan mode demonstrably works. The user is still
 * told: the ungrounded note carries this capture's own diagnosis, so what reaches the
 * model is that the reading did not happen and why, which is the whole of what an
 * ungrounded run is owed. Anything that is NOT one of these two classes propagates —
 * a `TypeError` here is this server's bug and must not be reported to a user as a
 * property of their database.
 *
 * The COMPOSED path answers the same environment the same way, which it did not when
 * this was written: #414 left PostgreSQL and SQLite propagating such a failure on the
 * argument that they had never reached this line, and B48 is the record of a reader
 * tripping over the asymmetry. Both paths now read it through `environmentFailure`.
 *
 * Neither sentence carries the error's own message. `detail` is spliced into the note
 * a plan run reads as the server's own voice, and a driver message is text the database
 * wrote; the fenced diagnoses arrive that way from the tool layer, and these do not go
 * through it.
 */
async function captureFromProvider(context: AgentToolContext, nowMs: number): Promise<AgentContextCapture> {
  let read: AgentProviderSchemaRead;
  try {
    read = await readProviderSchemaForGrounding(context);
  } catch (error) {
    const failure = environmentFailure(error, context);
    if (failure === null) throw error;
    return failure;
  }
  if (read.kind === "timed-out") {
    return unavailable(
      "PROVIDER_INVENTORY_TIMED_OUT",
      `This ${context.connection.type} database did not describe its own schema within the ${read.grantedMs}ms this run granted the reading.`,
    );
  }
  if (read.kind === "unavailable") return unavailable("CATALOG_READ_REFUSED", read.modelText);

  const tables = finalize(providerTables(read.tables));
  return {
    kind: "captured",
    snapshot: {
      connectionId: context.connection.id,
      fingerprint: fingerprintTables(tables),
      capturedAtMs: nowMs,
      tables,
      readVia: "provider-inventory",
    },
  };
}

/**
 * An environment failure read as an unavailable capture, or `null` when it is not one.
 *
 * BOTH grounding paths ask this, which is the whole of B48: the same unreachable host
 * lost only the grounding on the nine provider-path engines and lost the RUN on
 * PostgreSQL and SQLite, and the difference was one catch block. One reading rather
 * than two also means the sentence a plan run is shown does not depend on which route
 * its dialect takes.
 *
 * Two classes and no others. Anything else is this server's bug — a `TypeError` here is
 * not a property of the user's database and must not be reported to them as one — so it
 * is handed back for the caller to rethrow rather than swallowed.
 *
 * Neither sentence carries the error's own message: `detail` is spliced into a note the
 * run reads as the server's own voice, and a driver message is text the database wrote.
 */
function environmentFailure(error: unknown, context: AgentToolContext): AgentContextCapture | null {
  if (error instanceof ExecutionProfileError) {
    return unavailable(
      "CATALOG_READ_REFUSED",
      `This server could not open a connection to this ${context.connection.type} database under the execution profile a grounding read takes, so its schema was not read for this run.`,
    );
  }
  if (error instanceof DatabaseError) {
    return unavailable(
      "CATALOG_READ_REFUSED",
      `This run could not reach this ${context.connection.type} database to ask it for its schema, so nothing was read for this run.`,
    );
  }
  return null;
}

/**
 * The provider's tables, reduced to the four fields a snapshot carries.
 *
 * `foreignKeys` defaults to an empty list because two providers (Redis, LibreDB)
 * never set the field at all, and `finalize` has to produce the same shape on both
 * paths or two readings of one schema would fingerprint differently.
 */
function providerTables(tables: readonly TableSchema[]): TableIndex {
  const index: TableIndex = new Map();
  for (const table of tables) {
    index.set(table.name, {
      name: table.name,
      columns: [...table.columns],
      indexes: [...table.indexes],
      foreignKeys: [...(table.foreignKeys ?? [])],
    });
  }
  return index;
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
        // The database the user is looked up in. Same name, different auth database is
        // a different user record, so it can be a different catalog view - the reason
        // the role fields are in here.
        connection.authSource ?? "",
        connection.agentUser ?? "",
        // The tunnel is part of the ROUTE and not part of the credentials: `host` and
        // `port` above are resolved at the FAR END of it, so the same `db:5432` reached
        // through two different bastions is two different databases, and a connection
        // whose only edit was its bastion is re-pointed exactly as squarely as one whose
        // host changed. Its secrets are excluded on the rule the database password
        // follows - rotating one changes who may reach the database, never which it is -
        // and so is `hostKeyFingerprint`, which records what this connection TRUSTS
        // rather than where it goes.
        connection.sshTunnel === undefined
          ? ""
          : [
              connection.sshTunnel.enabled,
              connection.sshTunnel.host,
              connection.sshTunnel.port,
              connection.sshTunnel.username,
            ],
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
 *
 * `omissionAdvice` is what to do about the omitted tables, and it is a parameter for
 * the same reason as the preface plus one that is a correctness matter rather than a
 * budgeting one. This notice used to end "call inspect_schema with a table selector to
 * read any of them" unconditionally, and that sentence was already false in plan mode:
 * a plan run holds no tools at all, so on a database large enough to trigger the
 * omission it was told to call something it does not have — the #350 failure, in the
 * one mode that cannot even be answered by a refusal. The tool set belongs to the
 * caller, so the caller says what can be done about the omission and a caller with no
 * tool to name says nothing. The omission ITSELF is never optional: a model shown a
 * silently truncated list believes it has seen the schema.
 *
 * `noun` is what the rows are CALLED on this engine, and it is a parameter for the
 * same reason the preface is: this function keeps the bound, so the header it counts
 * has to be the header it writes. Defaulting to `TABLE_INVENTORY_NOUN` keeps every
 * SQL engine's prompt exactly as it was — see the type's own docblock for what a
 * wrong noun cost on Redis.
 */
export function packContextForTask(
  snapshot: AgentContextSnapshot,
  objective: string,
  options: {
    readonly maxChars?: number;
    readonly preface?: string;
    readonly omissionAdvice?: string;
    readonly noun?: AgentInventoryNoun;
  } = {},
): string {
  const lead = options.preface === undefined ? "" : `${options.preface}\n`;
  const maxChars = (options.maxChars ?? AGENT_CONTEXT_PACK_MAX_CHARS) - lead.length;
  const noun = options.noun ?? TABLE_INVENTORY_NOUN;
  const source = {
    label: "schema inventory",
    operationId: "agent/context-snapshot",
    reference: snapshot.fingerprint,
  };

  // The capture time is named because the inventory can be REUSED: a run resumed
  // hours later is shown the schema it started with, and a model told only "the
  // schema" would take it for the schema as it is now.
  const header = `Schema inventory for this run — fingerprint ${snapshot.fingerprint}, ${snapshot.tables.length} ${noun.singular}(s) read at epoch ${snapshot.capturedAtMs}ms and not re-read since, most task-relevant first.`;
  if (snapshot.tables.length === 0) {
    return `${lead}${fenceUntrustedContent(`${header}\nThis database reported no ${noun.plural}.`, source)}`;
  }

  const terms = taskTerms(objective);
  const ranked = [...snapshot.tables].sort((left, right) => {
    const difference = relevance(right, terms) - relevance(left, terms);
    return difference !== 0 ? difference : left.name < right.name ? -1 : 1;
  });

  const advice = options.omissionAdvice === undefined ? "" : ` ${options.omissionAdvice}`;
  const close = (body: string, omitted: number): string =>
    omitted === 0
      ? body
      : `${body}\n${omitted} further ${noun.singular}(s) omitted as less relevant to this task.${advice}`;

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

/**
 * The same inventory, packed for an OPERATIONS run: names and indexes, nothing else
 * (#411).
 *
 * The capture is unchanged — it is whole, all-or-nothing, held for the connection and
 * recorded in the ledger exactly as every other workflow's is, because a partial
 * capture shared through `holdSnapshotForConnection` would be handed to a later
 * investigation run as if it were complete. What varies by workflow is the
 * PRESENTATION, and this is the operations one.
 *
 * Why these two fields and not the others. An operations objective is about what the
 * engine reports about itself, and the engine's own reports are full of schema
 * identifiers: a lock is held on a relation, an index-stats row names an index, a slow
 * query names tables. Names and index names are therefore exactly what turns an opaque
 * string in a reading into a known object. Column types are not what such an objective
 * asks about, and the relations graph is the most expensive part of the packing and the
 * least useful one here — so `packRelations` is not called for this workflow at all,
 * and this renderer carries no columns.
 *
 * An index's own columns are left out for the same reason the table's are: they are the
 * table's columns, and a reading names an index by NAME. Including them would smuggle
 * the column list back in through the part of the inventory that was kept.
 *
 * Not ranked by task relevance, unlike `packContextForTask`. An operations objective
 * rarely names a table — what it will be about is whatever the engine happens to report
 * during the run — so scoring the inventory against the objective's words would order it
 * by a signal that is not there. The snapshot's own name order is what survives, which
 * is at least stable between drives of the same run.
 */
export function packOperationsInventory(
  snapshot: AgentContextSnapshot,
  options: { readonly maxChars?: number; readonly preface?: string; readonly noun?: AgentInventoryNoun } = {},
): string {
  const lead = options.preface === undefined ? "" : `${options.preface}\n`;
  const maxChars = (options.maxChars ?? AGENT_CONTEXT_PACK_MAX_CHARS) - lead.length;
  const noun = options.noun ?? TABLE_INVENTORY_NOUN;
  const source = {
    label: "schema inventory: names and indexes",
    operationId: "agent/context-snapshot",
    reference: snapshot.fingerprint,
  };

  const header = `Schema inventory for this run — fingerprint ${snapshot.fingerprint}, ${snapshot.tables.length} ${noun.singular}(s) read at epoch ${snapshot.capturedAtMs}ms and not re-read since. Names and the indexes on each; no columns and no relations are included.`;
  if (snapshot.tables.length === 0) {
    return `${lead}${fenceUntrustedContent(`${header}\nThis database reported no ${noun.plural}.`, source)}`;
  }

  // Names no tool, in either mode: an operations agent run holds no `inspect_schema`
  // and a plan run holds nothing at all, so a way out named here would be a way out
  // neither reader has (#350).
  const close = (body: string, omitted: number): string =>
    omitted === 0
      ? body
      : `${body}\n${omitted} further ${noun.singular}(s) exist in this database and are not named here.`;

  let body = header;
  let shown = 0;
  for (const table of snapshot.tables) {
    const candidate = `${body}\n${renderOperationsTable(table)}`;
    if (fenceUntrustedContent(close(candidate, snapshot.tables.length - shown - 1), source).length > maxChars) break;
    body = candidate;
    shown += 1;
  }

  return `${lead}${fenceUntrustedContent(close(body, snapshot.tables.length - shown), source)}`;
}

/**
 * One table, as an operations run is shown it: its name, and what is indexed on it.
 *
 * Both quoted, and this is the one renderer where the quoting is load-bearing rather
 * than defensive. In `renderTable` the identifiers are context for SQL the model will
 * draft, and a name that arrived mangled fails at the engine; here the identifier list
 * IS the payload, and the run is told in the same breath to match what the engine names
 * back at it against this list and to invent nothing outside it. Unquoted, a table
 * named with an embedded newline produces a second line indistinguishable from a real
 * entry, and an index named `a, b_unique` reads as two indexes — so the run would
 * recommend action on an object nobody created, cited against a real snapshot
 * fingerprint. Found by review on #411; `untrusted-content.ts` holds the rule.
 */
function renderOperationsTable(table: TableSchema): string {
  const shown = table.indexes
    .slice(0, MAX_INDEXES_PER_TABLE)
    .map((index) => `${quoteIdentifierForPrompt(index.name)}${index.unique ? " unique" : ""}`);
  const hidden = table.indexes.length - shown.length;
  if (hidden > 0) shown.push(`+${hidden} more`);
  const name = quoteIdentifierForPrompt(table.name);
  // Absence is stated rather than left blank: a table listed with nothing after it
  // reads as a table whose indexes were not captured, and an operations run asked to
  // reason about an unused index would not know which of the two it was looking at.
  return shown.length === 0 ? `${name}: no indexes` : `${name}: indexes ${shown.join(", ")}`;
}
