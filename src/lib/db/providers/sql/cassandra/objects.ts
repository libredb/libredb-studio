/**
 * Apache Cassandra object surface (issue #789)
 *
 * One container level, the KEYSPACE, and seven kinds read out of the ordinary
 * queryable `system_schema` keyspace through the same `CassandraTransport` seam every
 * other read in this directory uses, so this file names no driver class.
 *
 * Everything below was measured on 2026-09-11 against a live Apache Cassandra 5.0.9
 * (`system.local.release_version`) holding the fixture in
 * `docker/cassandra-init/01-object-fixture.cql`. That fixture is committed and the
 * recipe that applies it is in `docs/providers/cassandra.md`, so every claim here can
 * be re-measured rather than trusted.
 *
 * Seven measurements shape this file, and each one produces a wrong tree if forgotten:
 *
 * 1. A SYSTEM KEYSPACE IS EXCLUDED BY EXACT NAME, never by a `system%` prefix.
 *    Measured: `CREATE KEYSPACE system_reports` SUCCEEDS, so a prefix rule hides a
 *    keyspace a person created - the invisible absence standing ruling 5a exists for.
 *    The fixture creates `system_reports` precisely so the prefix spelling stays
 *    refuted rather than merely unattractive.
 * 2. AN INDEX NAME IS UNIQUE PER KEYSPACE, so an index is a CONTAINER-level object.
 *    Measured: with `customers_by_city` on `probe.customers`, `CREATE INDEX
 *    customers_by_city ON probe.events (payload)` answers "Index 'customers_by_city'
 *    already exists", and `DROP INDEX probe.customers_by_city` names no table. That is
 *    the catalog modelling an index as a first-class named object, which is why
 *    Cassandra is one of the three engines that declares the kind at all.
 * 3. A TRIGGER NAME IS NOT UNIQUE PER KEYSPACE. Measured: with `probe_audit` on
 *    `probe.customers`, `CREATE TRIGGER probe_audit ON probe.orders` SUCCEEDS. So a
 *    trigger is addressed `[keyspace, table, trigger]` and declares
 *    `attachedTo: "table"`, and an index is addressed `[keyspace, index]`. The two
 *    kinds look alike in the catalog and are addressed differently because the ENGINE
 *    treats their names differently.
 * 4. A ROUTINE IS OVERLOADED BY ARGUMENT TYPES, so the name alone cannot address one.
 *    `system_schema.functions` is keyed `((keyspace_name), function_name,
 *    argument_types)` and the fixture holds `render(['int'])` and `render(['text'])`
 *    as two rows. The last path segment therefore carries the argument-type list, the
 *    same form PostgreSQL uses, and `name` stays the bare routine name for display.
 *    `answer()` takes none, so the empty list is a live case rather than an inference.
 *    `system_schema.aggregates` is keyed identically and gets the same treatment.
 * 5. A MATERIALIZED VIEW IS NOT IN `system_schema.tables`. Measured: the fixture's
 *    three tables are the three rows, and `customers_by_city` appears only in
 *    `system_schema.views`. So the two kinds read two catalogs and neither
 *    double-counts the other.
 * 6. NOTHING BRANCHES ON `system_schema.indexes.kind`. The fixture holds COMPOSITES
 *    and CUSTOM (a `sai` Storage Attached Index) in one keyspace, and a vocabulary
 *    derived from whichever kinds a fixture happens to hold would lose every other
 *    one. Every row of the catalog is an index, so every row is listed.
 * 7. CQL HAS NO UNION AND NO JOIN, so the count cannot be one statement over a
 *    kind-tagged subquery the way ClickHouse's is. Standing ruling 5f is held a
 *    different way instead: `countObjects` and `listObjects` issue the SAME statement
 *    text, from the same builder, and the count is the LENGTH of the rows the listing
 *    returns. There is no second WHERE clause for the two to drift apart in, which is
 *    what Oracle, MySQL and ClickHouse each got wrong on a first pass.
 *
 * Two absences are declarations rather than gaps, and one presence is.
 *
 * There is no `view` kind, because CQL has no `CREATE VIEW`: the only view it has is
 * the materialized one, and a declared kind draws a folder a zero badge then makes
 * look like a fact (standing ruling 4). There is no `procedure` kind for the same
 * reason - CQL has no stored procedure at all.
 *
 * There IS a `trigger` kind, and that decision was measured rather than argued. A
 * trigger's body is a Java class, which this product cannot show, and the obvious
 * reading is that the concept is therefore not really here. It is: `CREATE TRIGGER` is
 * in the grammar, `system_schema.triggers` holds a real row per trigger with its base
 * table and its class, and the fixture's own recipe creates one and reads it back. The
 * one thing that is true is that creating it needs a class already loadable on the
 * node - the class is compiled with a JDK, copied into every node's trigger directory
 * and picked up by `nodetool reloadtriggers`, and without that step `CREATE TRIGGER`
 * answers "Trigger class 'probe.NoopTrigger' couldn't be loaded" (all measured). None
 * of that makes a trigger a thing the engine does not have; it makes it a thing an
 * operator installs. Withholding the folder would hide an object a person created,
 * which is the absence this epic keeps finding. `trigger` is the one kind here that
 * declares no `hasSource`, and Phase 2 measured which absence it is: `DescribeStatement`
 * has no TRIGGER target at all (`DESCRIBE TRIGGER` answers code 8192, "no viable
 * alternative at input", measured on 5.0.9), and a trigger's body is a Java class on the
 * node's filesystem rather than anything the database holds. The other six kinds DO
 * declare `hasSource`; see `CASSANDRA_OBJECT_KINDS` below, which is the list.
 *
 * Only `table` declares `acceptsRowWrites`. A materialized view refuses every write
 * ("Cannot directly modify a materialized view", measured), and the other five kinds
 * have no rows at all. The provider's engine-wide `supportsInlineRowEdit: false` is a
 * SEPARATE fact about the grid's guessed WHERE clause and is deliberately not
 * conjoined with this one.
 */

import { QueryError } from "@/lib/db/errors";
import {
  applySourceBound,
  callerBoundTruncationReason,
  containerDepth,
  declaredKinds,
  findKind,
  requireSourceKind,
} from "@/lib/db/object-kinds";
import { comparePaths } from "@/lib/db/object-path";
import type {
  ColumnSchema,
  Container,
  ContainerLevelSpec,
  ContainerLevels,
  DatabaseObject,
  IndexSchema,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
  ProviderCapabilities,
} from "@/lib/db/types";
import { quoteLiteral } from "@/lib/sql/values";
import { cassandraTableColumns } from "./introspect";
import { CassandraTransportError, type CassandraRow, type CassandraTransport } from "./transport";

const PROVIDER = "cassandra" as const;

// ============================================================================
// Declaration
// ============================================================================

/**
 * One level, and there is no second one to add: CQL has no container above a keyspace
 * and none below it. The structural `id` is `schema` because that is what
 * `ContainerLevelSpec` calls the innermost level on every engine; the LABEL is the
 * engine's own word, which is Keyspace.
 */
export const CASSANDRA_CONTAINER_LEVELS: ContainerLevels = Object.freeze([
  { id: "schema", label: "Keyspace", labelPlural: "Keyspaces" },
] as const);

/**
 * The Monaco id every readable kind here renders under, and the reason it is a compromise.
 *
 * `cql` IS NOT A MONACO LANGUAGE ID. Measured against the installed monaco-editor 0.56.0
 * bundle in this epic: it registers 89 ids and `cql` is not one of them, and an unregistered
 * id degrades to plain text with no throw and nothing observable. `sql` is the closest
 * registered dialect, so a `CREATE TABLE` renders correctly and CQL-only spellings
 * (`PRIMARY KEY ((a), b)`, `frozen<address>`, a `$$ ... $$` function body) are highlighted as
 * whatever the SQL tokenizer makes of them. `docs/providers/cassandra.md` says so as a
 * limitation rather than implying the text is highlighted as CQL.
 */
const CASSANDRA_SOURCE_LANGUAGE = "sql" as const;

export const CASSANDRA_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "table",
    role: "relation",
    label: "Table",
    labelPlural: "Tables",
    acceptsRowWrites: true,
    hasSource: true,
    sourceLanguage: CASSANDRA_SOURCE_LANGUAGE,
  },
  {
    id: "materialized_view",
    role: "relation",
    label: "Materialized View",
    labelPlural: "Materialized Views",
    hasSource: true,
    sourceLanguage: CASSANDRA_SOURCE_LANGUAGE,
  },
  {
    id: "index",
    role: "config",
    label: "Index",
    labelPlural: "Indexes",
    hasSource: true,
    sourceLanguage: CASSANDRA_SOURCE_LANGUAGE,
  },
  {
    id: "type",
    role: "config",
    label: "Type",
    labelPlural: "Types",
    hasSource: true,
    sourceLanguage: CASSANDRA_SOURCE_LANGUAGE,
  },
  {
    id: "function",
    role: "routine",
    label: "Function",
    labelPlural: "Functions",
    hasSource: true,
    sourceLanguage: CASSANDRA_SOURCE_LANGUAGE,
  },
  {
    id: "aggregate",
    role: "routine",
    label: "Aggregate",
    labelPlural: "Aggregates",
    hasSource: true,
    sourceLanguage: CASSANDRA_SOURCE_LANGUAGE,
  },
  // NO `hasSource`, and it is a RESULT rather than a gap. `DescribeStatement` has no `TRIGGER`
  // target at all - measured on 5.0.9, `DESCRIBE TRIGGER probe.probe_audit` is
  // "line 1:17 no viable alternative at input 'probe'" - and `system_schema.triggers` carries
  // only the trigger's name, its base table and the CLASS an operator installed. That class is
  // a compiled Java file in every node's trigger directory, so the definition is not in the
  // database in ANY form and there is nothing this product declines to reach.
  { id: "trigger", role: "attached", label: "Trigger", labelPlural: "Triggers", attachedTo: "table" },
] as const);

/**
 * The keyspaces this server owns, by exact NAME.
 *
 * Five of them are `SchemaConstants`' own local and replicated system keyspaces in
 * Cassandra 5.0 (`system`, `system_schema`, `system_auth`, `system_distributed`,
 * `system_traces`) and all five were measured in `system_schema.keyspaces` on 5.0.9.
 * The two VIRTUAL ones are listed here as well and have never been seen in that
 * catalog - measured, `system_schema.keyspaces` answers seven rows on the fixture node
 * and neither is among them - because they are published in
 * `system_virtual_schema.keyspaces` instead. They cost nothing to carry and a build
 * that did publish them would otherwise draw two folders of virtual tables.
 *
 * An exact list rather than a prefix, and that is refuted rather than preferred: see
 * point 1 of this file's docblock.
 */
const CASSANDRA_SYSTEM_KEYSPACES: readonly string[] = Object.freeze([
  "system",
  "system_schema",
  "system_auth",
  "system_distributed",
  "system_traces",
  "system_views",
  "system_virtual_schema",
]);

// ============================================================================
// Statements
// ============================================================================

/**
 * A keyspace or object name as a CQL string literal, through the shared quoter, so the
 * dialect's escape rule is the one recorded in `lib/sql/values.ts`: CQL doubles the
 * quote and reads a backslash as data, both measured.
 */
function literal(value: string): string {
  return quoteLiteral(value, PROVIDER);
}

/**
 * A keyspace or object name as a QUOTED CQL identifier (#789).
 *
 * Quoting is NOT optional and the measurement says why: `system_schema` stores a name as it
 * was written, and an unquoted identifier is lowercased by the parser, so
 * `DESCRIBE TABLE t14scratch.MixedCase` against a table created as `"MixedCase"` answers
 * "Table 'mixedcase' not found in keyspace 't14scratch'" (measured on 5.0.9). Every name that
 * reaches here came out of a catalog row, so every one of them is already in its stored
 * spelling and every one of them is quoted.
 *
 * DOUBLING THE QUOTE IS THE WHOLE ESCAPE, and this is the one place the ClickHouse hazard
 * (probe 11 of this epic, where a backslash inside a quoted identifier IS an escape and
 * swallows the closing quote) is measurably ABSENT. Measured on 5.0.9 with a function named
 * `back\slash`: `DESCRIBE FUNCTION t14scratch."back\slash"` RESOLVES it, and the
 * backslash-doubled `"back\\slash"` is "User defined function 'back\\slash' not found",
 * so CQL reads a backslash inside a quoted identifier as DATA. A name holding a `"` is
 * reachable too: `qu"ote` was created as a function name and
 * `DESCRIBE FUNCTION t14scratch."qu""ote"` resolves it.
 *
 * Not `SQLBaseProvider.escapeIdentifier`: that is a protected method on the class which
 * branches on `this.type`, and this module is the free-function half of the provider. The rule
 * it would apply for a non-mysql, non-mssql dialect is the same one written here.
 */
function identifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Every keyspace the connected role can see, system ones included.
 *
 * The exclusion is applied in TypeScript rather than in the statement, because
 * `keyspace_name` is the partition key and CQL has no `NOT IN` over one: filtering it
 * server-side would need `ALLOW FILTERING` on a catalog read. The catalog is a handful
 * of rows, so reading them all and dropping seven names costs nothing.
 */
export const CASSANDRA_KEYSPACE_LIST_CQL = "SELECT keyspace_name FROM system_schema.keyspaces";

/**
 * Which catalog answers for one kind, and how a row in it is read.
 *
 * `projection` is written out per kind rather than derived, because the statement text
 * is what the count and the listing SHARE (point 7 of this file's docblock) and a
 * projection that differed between them would put the 5f seam straight back.
 *
 * `parentColumn` is the nesting segment and only a trigger has one, which is the
 * measured difference between an index name and a trigger name rather than a style
 * choice. `overloaded` says the identity carries the argument-type list.
 */
interface ObjectCatalogSpec {
  readonly table: string;
  readonly nameColumn: string;
  readonly projection: readonly string[];
  readonly parentColumn?: string;
  readonly overloaded?: true;
  /**
   * The catalog's FIRST clustering column, which is the only column CQL will order by.
   *
   * Measured on 5.0.9, and it refutes the obvious spelling: `ORDER BY index_name` on
   * `system_schema.indexes` is server error 2200, "Order by currently only supports the
   * ordering of columns following their declared order in the PRIMARY KEY", because that
   * catalog clusters on `(table_name, index_name)`. So this is NOT the name column for
   * every kind, and on `indexes` and `triggers` it is the base table instead.
   *
   * It appears only in a BOUNDED read. An unbounded read takes every row and is re-sorted
   * by path here, so it needs no order from the server at all - and leaving the unbounded
   * statement untouched is what keeps the bulk read's target byte-identical to the
   * listing statement the count and the folder already share.
   */
  readonly orderColumn: string;
  /**
   * The `DESCRIBE` target keywords for this kind, or undefined where the statement has none.
   *
   * `DESCRIBE` is a REAL SERVER-SIDE STATEMENT here, unlike every SQL engine in #789 that
   * SELECTs a definition out of a catalog table: the server executes it and answers the
   * columns `keyspace_name, type, name, create_statement` (measured on 5.0.9). So the target
   * is part of the statement's GRAMMAR and there is no column list to project.
   *
   * `trigger` has no entry, and that is the grammar rather than an omission: measured,
   * `DESCRIBE TRIGGER probe.probe_audit` is "line 1:17 no viable alternative at input 'probe'".
   */
  readonly describeTarget?: string;
  /**
   * The value the reply's own `type` column carries for a row of this kind.
   *
   * It exists because `DESCRIBE TABLE` DOES NOT ANSWER ONE ROW. Measured on 5.0.9,
   * `DESCRIBE TABLE probe.customers` answers FOUR: the table, its two indexes and the
   * materialized view over it, each typed by this column. Every one of those is its own
   * addressable object in this tree with its own Source, so the read selects the row the
   * CALLER asked for and the others are reached under their own paths.
   */
  readonly describeType?: string;
}

const CASSANDRA_OBJECT_CATALOGS: Readonly<Record<string, ObjectCatalogSpec>> = Object.freeze({
  table: {
    table: "tables",
    nameColumn: "table_name",
    projection: ["table_name"],
    orderColumn: "table_name",
    describeTarget: "TABLE",
    describeType: "table",
  },
  materialized_view: {
    table: "views",
    nameColumn: "view_name",
    projection: ["view_name"],
    orderColumn: "view_name",
    describeTarget: "MATERIALIZED VIEW",
    describeType: "materialized_view",
  },
  index: {
    table: "indexes",
    nameColumn: "index_name",
    // `options` carries `target`, the indexed column expression, which is what
    // `describeObject` reports for the kind. It is projected by the LISTING statement
    // so both reads are one statement rather than two that could disagree.
    projection: ["index_name", "table_name", "options"],
    // NOT `index_name`: this catalog clusters on `(table_name, index_name)` and ordering
    // by the second clustering column alone is a server error (measured).
    orderColumn: "table_name",
    describeTarget: "INDEX",
    describeType: "index",
  },
  type: {
    table: "types",
    nameColumn: "type_name",
    projection: ["type_name"],
    orderColumn: "type_name",
    describeTarget: "TYPE",
    describeType: "type",
  },
  function: {
    table: "functions",
    nameColumn: "function_name",
    projection: ["function_name", "argument_types"],
    overloaded: true,
    orderColumn: "function_name",
    describeTarget: "FUNCTION",
    describeType: "function",
  },
  aggregate: {
    table: "aggregates",
    nameColumn: "aggregate_name",
    projection: ["aggregate_name", "argument_types"],
    overloaded: true,
    orderColumn: "aggregate_name",
    describeTarget: "AGGREGATE",
    describeType: "aggregate",
  },
  trigger: {
    table: "triggers",
    nameColumn: "trigger_name",
    projection: ["trigger_name", "table_name"],
    parentColumn: "table_name",
    orderColumn: "table_name",
  },
});

/**
 * The catalog spec for a kind, or undefined for a kind that has none.
 *
 * `Object.hasOwn` and not a bare index: a plain object answers
 * `CASSANDRA_OBJECT_CATALOGS["toString"]` with `Function.prototype.toString`, so a
 * declared kind of that name would pass a `!== undefined` guard carrying a function
 * where a catalog spec belongs.
 */
function objectCatalog(kind: string): ObjectCatalogSpec | undefined {
  return Object.hasOwn(CASSANDRA_OBJECT_CATALOGS, kind) ? CASSANDRA_OBJECT_CATALOGS[kind] : undefined;
}

/**
 * The ONE statement that answers for a kind in a keyspace. Undefined for a kind this
 * engine has no catalog for, which is a caller mistake rather than an empty answer.
 *
 * ONE builder for the count, the listing and the bulk read's target, so the three answers
 * are joined on an address all of them derived the same way rather than on spellings that
 * happen to agree today. Without `limit` the text is unchanged, which is what keeps the
 * bulk read's unbounded target byte-identical to the statement the folder already shares.
 *
 * `limit` is INTERPOLATED rather than bound, and that is not a shortcut: this provider
 * REFUSES to bind a parameter into a catalog read at all (`index.ts` sends catalog CQL
 * one-shot with `prepare: false`). It is safe by construction rather than by inspection -
 * `describeObjects` refuses a limit that is not a positive whole number before it reaches
 * here, so nothing but digits can arrive. Measured on 5.0.9: `LIMIT 0` is the server's own
 * error 2200, "LIMIT must be strictly positive", so a clamp would have traded a caller
 * mistake for a server refusal.
 */
export function cassandraObjectListCql(keyspace: string, kind: string, limit?: number): string | undefined {
  const spec = objectCatalog(kind);
  if (spec === undefined) return undefined;
  const base = `SELECT ${spec.projection.join(", ")} FROM system_schema.${spec.table} WHERE keyspace_name = ${literal(keyspace)}`;
  return limit === undefined ? base : `${base} ORDER BY ${spec.orderColumn} ASC LIMIT ${limit}`;
}

/**
 * The server-side `DESCRIBE` for one object of one kind, or undefined for a kind whose
 * grammar has no target (#789).
 *
 * This is the statement that makes Cassandra unlike every SQL engine in #789: the definition
 * is not in a catalog COLUMN anybody can select, it is produced by a statement the SERVER
 * executes, and the answer arrives as ordinary rows carrying a `create_statement`.
 *
 * The target takes an IDENTIFIER and no bind, which is not this provider choosing to
 * interpolate: `DESCRIBE` accepts no `?` at all, and this provider sends every catalog
 * statement one-shot with `prepare: false` anyway. Both segments go through `identifier()`,
 * which is the whole escape (see that function for the two measurements).
 *
 * A ROUTINE'S TARGET IS ITS BARE NAME AND NEVER ITS IDENTITY. Measured on 5.0.9,
 * `DESCRIBE FUNCTION probe.render(int)` is the SYNTAX error "line 1:30 mismatched input '('
 * expecting EOF", so the argument list cannot be sent, and `DESCRIBE FUNCTION probe.render`
 * answers BOTH overloads as two rows. The caller's overload is chosen from the reply, which
 * is what `describeSignature()` is for.
 */
export function cassandraDescribeCql(keyspace: string, kind: string, name: string): string | undefined {
  const spec = objectCatalog(kind);
  if (spec?.describeTarget === undefined) return undefined;
  return `DESCRIBE ${spec.describeTarget} ${identifier(keyspace)}.${identifier(name)}`;
}

/**
 * Every column of every table and every materialized view in ONE keyspace.
 *
 * The same catalog, the same projection and the same mapper the single read uses, widened
 * from one object to the keyspace by dropping the `table_name` restriction. That is one
 * partition read either way: `system_schema.columns` is partitioned on `keyspace_name`
 * alone and clustered on `(table_name, column_name)`, so restricting it to the bounded
 * target's names with an `IN` list would read the same partition and would make the
 * statement's SHAPE depend on what the target answered.
 *
 * A table and a materialized view are both keyed here by their own name (measured: the
 * fixture's view `customers_by_city` has its three rows in this catalog beside the three
 * tables' rows), so one statement serves both kinds.
 */
export function cassandraKeyspaceColumnsCql(keyspace: string): string {
  return (
    "SELECT table_name, column_name, type, kind, position, clustering_order FROM system_schema.columns " +
    `WHERE keyspace_name = ${literal(keyspace)}`
  );
}

/**
 * Every user-defined type in one keyspace WITH its fields.
 *
 * One statement for the whole folder, because `system_schema.types` carries a UDT's
 * parallel `field_names` and `field_types` lists on the very row that names it. So the
 * membership and the detail come from one read and cannot disagree.
 *
 * This is a superset projection of the `type` listing statement over the same catalog and
 * the same predicate, which is what makes it safe to take membership from: it answers
 * exactly the rows the folder lists.
 */
export function cassandraKeyspaceTypesCql(keyspace: string): string {
  return `SELECT type_name, field_names, field_types FROM system_schema.types WHERE keyspace_name = ${literal(keyspace)}`;
}

/**
 * One table's or one materialized view's columns.
 *
 * A view's columns live in the same `system_schema.columns` a table's do, keyed by the
 * view's own name, so one statement answers both kinds.
 */
export function cassandraObjectColumnsCql(keyspace: string, name: string): string {
  return (
    "SELECT column_name, type, kind, position, clustering_order FROM system_schema.columns " +
    `WHERE keyspace_name = ${literal(keyspace)} AND table_name = ${literal(name)}`
  );
}

/**
 * One user-defined type's fields.
 *
 * `field_names` and `field_types` are PARALLEL LISTS on one row rather than a row per
 * field, so they are zipped in TypeScript: CQL has no `arrayJoin`, and the driver hands
 * a `list<text>` back as an ordinary JS array of strings (measured).
 */
export function cassandraTypeFieldsCql(keyspace: string, name: string): string {
  return `SELECT field_names, field_types FROM system_schema.types WHERE keyspace_name = ${literal(keyspace)} AND type_name = ${literal(name)}`;
}

// ============================================================================
// Derivations over the declaration
// ============================================================================

/**
 * The container levels this provider declares, sliced to the depth `containerDepth()`
 * reports.
 *
 * One reader for the whole file, so the depth and the level list can never be taken by
 * two different rules. `containerDepth()` decides, never `containerLevels.length`:
 * absent and empty are the same fact.
 */
function declaredLevels(capabilities: ProviderCapabilities): readonly ContainerLevelSpec[] {
  return (capabilities.containerLevels ?? []).slice(0, containerDepth(capabilities));
}

/**
 * The segment of `path` belonging to the declared container level `id`.
 *
 * NEVER `path[0]`, which is standing ruling 5g's general form: a container level's
 * POSITION is a property of the declaration and not a constant. Cassandra declares one
 * level, so the keyspace IS the first segment here and every literal-index spelling
 * would be behaviour-identical on this engine - which is exactly why three of them
 * shipped across earlier providers and each was found a review later than the last.
 * The suite pins this with a two-level declaration swapped in through `getCapabilities`
 * and driven to a BOUND VALUE.
 *
 * Both failure modes raise through one guard: a declaration carrying no level of this
 * `id`, and a path too short to hold it. Neither may fall through to `undefined`, which
 * would reach `literal()` as the string "undefined" and quietly read a keyspace of that
 * name.
 */
function containerSegment(
  capabilities: ProviderCapabilities,
  path: readonly string[],
  id: ContainerLevelSpec["id"],
): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === id);
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A Cassandra path needs a "${id}" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      PROVIDER,
    );
  }
  return segment;
}

/**
 * The one keyspace a container path names.
 *
 * The expected depth is read through `containerDepth()` and the segment NAMES come from
 * the declared level labels, so the check and its message are the same array and
 * nothing here can inherit a hardcoded 1. A path of another length is a caller that
 * built it from another engine's model, and it raises rather than reading a segment and
 * carrying on: an empty folder looks exactly like a keyspace holding nothing, which is
 * the worst way to report a caller mistake.
 */
function containerKeyspace(capabilities: ProviderCapabilities, container: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  if (container.length !== levels.length) {
    throw new QueryError(
      `A Cassandra container path is [${levels.map((level) => level.label.toLowerCase()).join(", ")}], ` +
        `received ${JSON.stringify(container)}`,
      PROVIDER,
    );
  }
  return containerSegment(capabilities, container, "schema");
}

/**
 * How many segments a path of one KIND has, checked against the declaration (#789).
 *
 * ONE writer for two readers: `describeObject` and `readObjectSource` ask the same question
 * about the same path, and two copies of this derivation are two chances for the detail pane
 * and the Source tab to disagree about what an object's address is.
 *
 * Derived, not counted. One segment per declared container level plus the name, and a nesting
 * segment for a kind that declares `attachedTo` - which is the ONLY thing that changes the
 * depth, so both shapes come from the declaration rather than from a kind id written out here.
 */
function assertObjectPathShape(
  capabilities: ProviderCapabilities,
  spec: ObjectKindSpec,
  path: readonly string[],
): void {
  const levels = declaredLevels(capabilities).map((level) => level.label.toLowerCase());
  const shape = spec.attachedTo === undefined ? [...levels, "name"] : [...levels, spec.attachedTo, "name"];
  if (path.length === shape.length) return;
  throw new QueryError(
    `A Cassandra "${spec.id}" path is [${shape.join(", ")}], received ${JSON.stringify(path)}`,
    PROVIDER,
  );
}

/**
 * The server's own sentence, verbatim, for ONE kind whose read was refused.
 *
 * Deliberately NOT through the provider's error mapping: that gives a THROWN error a
 * type and this product's prefix, and nothing here throws. The sentence is rendered to
 * a person as the reason a folder has no number, so prefixing it would put our words in
 * front of Cassandra's. A refused read is never 0 - measured with a least-privilege
 * role, `system_schema` is readable for every table in every keyspace, so a denial here
 * is abnormal and reporting it as an empty keyspace would hide it.
 */
function refusalReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Row readers
// ============================================================================

/** A string the server sent, or "" when it sent nothing usable. */
function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A `list<text>` as the driver hands it back: a JS array of strings (measured). */
function readTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readText) : [];
}

/**
 * The last path segment for one catalog row.
 *
 * An overloaded routine carries its argument-type list, which is what makes the segment
 * unique within the keyspace: `system_schema.functions` is keyed on
 * `(function_name, argument_types)`, so `render` alone addresses two rows and
 * `render(int)` addresses one. Parameter NAMES are deliberately not in it - they are in
 * `argument_names` and a rename would otherwise change an object's identity, while
 * overload resolution never depends on them. This is the same form PostgreSQL settled
 * on, for the same reason.
 */
function objectIdentity(spec: ObjectCatalogSpec, row: CassandraRow): string {
  const name = readText(row[spec.nameColumn]);
  if (spec.overloaded !== true) return name;
  return `${name}(${readTextList(row.argument_types).join(",")})`;
}

/**
 * Where one listed object is addressed.
 *
 * Built from the DECLARATION's `parentColumn` rather than from the kind id, so the
 * seven listing statements share one rule: a parent column adds a nesting segment and
 * nothing else does. That is what the `attachedTo: "table"` declaration states, and on
 * this engine it is measured on both sides - a trigger name repeats across tables in
 * one keyspace and an index name does not.
 */
function objectPath(container: readonly string[], spec: ObjectCatalogSpec, row: CassandraRow): string[] {
  const identity = objectIdentity(spec, row);
  if (spec.parentColumn === undefined) return [...container, identity];
  return [...container, readText(row[spec.parentColumn]), identity];
}

/**
 * One `system_schema.indexes` row as an index.
 *
 * `options.target` is the indexed column expression and it is carried VERBATIM:
 * `city` for a plain secondary index and `keys(tags)` for one over a map's keys, both
 * measured, and collapsing the second onto `tags` would name a column that is not what
 * the index covers.
 *
 * `unique` is always false, and that is the engine's answer rather than this schema's:
 * `CREATE UNIQUE INDEX` is a syntax error because the keyword is not in the CQL
 * grammar, so no index Cassandra reports enforces uniqueness.
 */
function toIndexSchema(row: CassandraRow): IndexSchema {
  const options = (row.options ?? null) as Record<string, unknown> | null;
  return { name: readText(row.index_name), columns: [readText(options?.target)], unique: false };
}

// ============================================================================
// The four methods
// ============================================================================

/**
 * The keyspaces this connection can see, minus the server's own.
 *
 * One level, so `parent` can only ever name a keyspace, and nothing nests under one
 * here - that answers `[]` rather than raising, because "this level has no children" is
 * a true statement about Cassandra and not a caller mistake. It also answers without a
 * round trip, which is the difference between a tree that opens a keyspace and one that
 * asks the server what is under it first.
 *
 * `isSessionDefault` compares against the keyspace the SESSION was opened with, which
 * is the connection's own `database` field: CQL has no `currentKeyspace()` and
 * `system.local` carries no session state, so there is no server-side answer to prefer
 * over the one the driver was handed.
 *
 * A connection pinning NO keyspace passes `""` here and every container is then answered
 * with `isSessionDefault: false`, which needs no guard of its own because no keyspace can
 * be named `""`. That connection is legal (`validate()` requires a host and a data centre,
 * not a keyspace) and it is the one a container tree exists to serve: the tree is how
 * somebody picks a keyspace when the connection names none.
 *
 * This is the one place a path is CONSTRUCTED rather than read, which is the single
 * exception standing ruling 5g allows to the no-positional-index rule.
 */
export async function listContainers(
  transport: CassandraTransport,
  sessionKeyspace: string,
  parent?: readonly string[],
): Promise<Container[]> {
  if (parent !== undefined && parent.length > 0) return [];

  const result = await transport.execute(CASSANDRA_KEYSPACE_LIST_CQL);
  const containers: Container[] = [];
  for (const row of result.rows) {
    const name = readText(row.keyspace_name);
    if (CASSANDRA_SYSTEM_KEYSPACES.includes(name)) continue;
    containers.push({ path: [name], name, level: 0, isSessionDefault: name === sessionKeyspace });
  }
  return containers.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * How many objects of each declared kind one keyspace holds.
 *
 * One statement per kind, and every one of them is the LISTING statement: the count is
 * the number of rows the listing would return, taken from the same builder and the same
 * text. CQL has no UNION, so a single kind-tagged statement is not available here, and
 * two statements per kind is exactly the seam standing ruling 5f exists for - the count
 * would be free to disagree with the folder it badges. Reading rows rather than
 * `COUNT(*)` is what closes it, and the catalogs are small enough that this costs
 * nothing worth the risk.
 *
 * Three outcomes here, and `KindCount` keeps them apart: a kind whose read answered rows
 * carries their number, a kind whose read answered none carries `{ count: 0 }`, and a
 * refused read carries the server's own sentence. The type's fourth state, a bounded
 * `{ count, sampledFrom }`, is never written by this provider: the listing is read whole,
 * so every number here is a total rather than a floor.
 *
 * `Promise.allSettled` and not `Promise.all`, because those three states are PER KIND.
 * One `catch` around `Promise.all` reported the first refusal against all seven kinds,
 * which threw away six counts that had already been measured and told the tree six
 * folders were unreadable moments after reading them. Cassandra makes this reachable
 * rather than theoretical: `GRANT SELECT` is per table on `system_schema`, so a role can
 * hold `system_schema.tables` and not `system_schema.triggers`, and each refused kind
 * then carries the sentence the server wrote about THAT table.
 *
 * There is no seeding pass, and that is stronger than one rather than a shortcut past
 * it. The requirement seeding exists for is that a declared-and-empty kind keeps its 0
 * badge instead of vanishing, and it vanishes when the record is built from the ROWS a
 * catalog returned. This record is built from the DECLARATION: the loop is over
 * `declaredKinds`, so every declared kind is written exactly once whatever the catalog
 * answered, and a kind with no statement behind it is written as unavailable rather
 * than as a zero nobody measured. `tests/helpers/object-surface-conformance.ts`'s first
 * invariant is what holds this from the caller's side.
 *
 * The container path is checked BEFORE the read and raises, because a path of the wrong
 * shape is a caller mistake and not something the engine refused.
 */
export async function countObjects(
  transport: CassandraTransport,
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const keyspace = containerKeyspace(capabilities, container);
  const declared = declaredKinds(capabilities);
  const counts: Record<string, KindCount> = {};

  const settled = await Promise.allSettled(
    declared.map(async (kind) => {
      const cql = cassandraObjectListCql(keyspace, kind.id);
      if (cql === undefined) return undefined;
      return (await transport.execute(cql)).rows.length;
    }),
  );

  declared.forEach((kind, index) => {
    // `Promise.allSettled` answers one entry per input, in order, so the index a
    // `forEach` over the same array hands back always lands on this kind's outcome.
    const outcome = settled[index]!;
    if (outcome.status === "rejected") {
      counts[kind.id] = { unavailable: refusalReason(outcome.reason) };
      return;
    }
    counts[kind.id] =
      outcome.value === undefined
        ? { unavailable: `Cassandra has no statement that lists the kind "${kind.id}"` }
        : { count: outcome.value };
  });

  return counts;
}

/**
 * The objects of one kind in one keyspace, names only.
 *
 * Two questions, asked in order, and only the DECLARATION answers the first. Deciding
 * "is this kind declared" from whether a statement exists would make the two methods
 * disagree, and would report "declares no object kind" about a kind
 * `CASSANDRA_OBJECT_KINDS` does declare.
 *
 * No `rowCount` and no `sizeBytes` on any object, and that is the same measurement the
 * schema tree already carries: `system.size_estimates` counts PARTITIONS per token
 * range from flushed SSTables only - it answered 143 for a 500-row clustered table -
 * and `system_views.disk_usage` reports whole mebibytes. A number nobody can stand
 * behind is worse than no number, so both stay undefined.
 *
 * Ordering is done here rather than relying on the server: `system_schema` returns rows
 * in clustering order within a partition, and the tree addresses by PATH, so a
 * code-point sort over the segments is one rule shared with every other provider in
 * #789.
 */
export async function listObjects(
  transport: CassandraTransport,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`Cassandra declares no object kind "${kind}"`, PROVIDER);
  }
  const spec = objectCatalog(kind);
  if (spec === undefined) {
    throw new QueryError(`Cassandra declares the kind "${kind}" but has no statement that lists it`, PROVIDER);
  }
  const keyspace = containerKeyspace(capabilities, container);

  const result = await transport.execute(cassandraObjectListCql(keyspace, kind)!);
  const objects: DatabaseObject[] = [];
  // Nothing is SKIPPED here. A row whose name column read as something other than a
  // string would surface as an object named "", which is visible; dropping it would be
  // an object that exists in the catalog and cannot be reached from the tree, and an
  // absence that passes every gate is the worst shape of defect this epic has found.
  // No measured row can do it either: every one of these name columns is part of its
  // catalog's primary key, so none of them is ever null.
  for (const row of result.rows) {
    objects.push({ path: objectPath(container, spec, row), name: readText(row[spec.nameColumn]), kind });
  }
  return objects.sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * One user-defined type's fields as columns.
 *
 * Every field is nullable and none is primary, and both are facts about the type rather
 * than defaults: a UDT declares no key and any field of a stored value may be absent.
 * CQL has no `NOT NULL` to declare on one.
 */
async function describeType(
  transport: CassandraTransport,
  path: readonly string[],
  keyspace: string,
  name: string,
): Promise<ObjectDetail> {
  const cql = cassandraTypeFieldsCql(keyspace, name);
  const rows = (await transport.execute(cql)).rows;
  const row = rows[0];
  if (row === undefined) {
    throw new QueryError(`No Cassandra type named ${name} in ${keyspace}`, PROVIDER, cql);
  }

  return typeDetail(path, row);
}

/**
 * One `system_schema.types` row as an `ObjectDetail`.
 *
 * The SHARED mapper for a UDT, serving the single read and the bulk read alike, because
 * two copies are two chances for the batch to spell a field's type differently from the
 * single read of the same type.
 */
function typeDetail(path: readonly string[], row: CassandraRow): ObjectDetail {
  const names = readTextList(row.field_names);
  const types = readTextList(row.field_types);
  const columns: ColumnSchema[] = names.map((field, index) => ({
    name: field,
    type: types[index] ?? "",
    nullable: true,
    isPrimary: false,
  }));
  return { path: [...path], columns, indexes: [], foreignKeys: [] };
}

/**
 * One `system_schema.indexes` row as an `ObjectDetail`, the shared mapper for the kind.
 *
 * An index has no columns of its own, so `columns` is empty and the index itself is what
 * `indexes` carries.
 */
function indexDetail(path: readonly string[], row: CassandraRow): ObjectDetail {
  return { path: [...path], columns: [], indexes: [toIndexSchema(row)], foreignKeys: [] };
}

/**
 * One table's or one materialized view's rows as an `ObjectDetail`, the shared mapper.
 *
 * `foreignKeys` is ALWAYS empty and that is the engine rather than an omission: CQL has no
 * `FOREIGN KEY` clause at all, which is the same measurement behind the provider's
 * `declaresForeignKeys: false`.
 */
function relationDetail(
  path: readonly string[],
  name: string,
  columnRows: CassandraRow[],
  indexRows: readonly CassandraRow[],
): ObjectDetail {
  return {
    path: [...path],
    columns: cassandraTableColumns(columnRows),
    indexes: indexRows.filter((row) => readText(row.table_name) === name).map(toIndexSchema),
    foreignKeys: [],
  };
}

/**
 * One index's own definition.
 *
 * An index has no columns of its own, so `columns` is empty and the index itself is
 * what `indexes` carries - which is the honest shape for a kind whose entire content is
 * one target expression. The row comes from the same LISTING statement the count and
 * the listing use, filtered by name here, because `system_schema.indexes` is clustered
 * on `(table_name, index_name)` and a name-only restriction would need the table this
 * caller does not have: an index is addressed `[keyspace, index]`, measured.
 */
async function describeIndex(
  transport: CassandraTransport,
  path: readonly string[],
  keyspace: string,
  name: string,
): Promise<ObjectDetail> {
  const cql = cassandraObjectListCql(keyspace, "index")!;
  const row = (await transport.execute(cql)).rows.find((candidate) => readText(candidate.index_name) === name);
  if (row === undefined) {
    throw new QueryError(`No Cassandra index named ${name} in ${keyspace}`, PROVIDER, cql);
  }
  return indexDetail(path, row);
}

/**
 * Columns and indexes for one object of one KIND.
 *
 * The kind decides everything and nothing here reads the name to work out what it is
 * holding. A FUNCTION, an AGGREGATE and a TRIGGER answer three empty arrays without a
 * round trip: a routine has no columns and a trigger has none either, which is a true
 * fact about the kind rather than a failed read, and
 * `tests/helpers/object-surface-conformance.ts` states the same rule from the caller's
 * side.
 *
 * `foreignKeys` is ALWAYS empty, and that is the engine: `ALTER TABLE ... ADD
 * CONSTRAINT ... FOREIGN KEY` is a syntax error because the clause does not exist in
 * CQL, and the provider declares `declaresForeignKeys: false` for the same measurement.
 *
 * A table's and a view's columns are ordered by the rule `getSchema()` already
 * measured, through the same helper: partition key, then clustering columns, then
 * everything else alphabetically. Declaration order is NOT recoverable -
 * `system_schema.columns.position` is -1 for every regular column - so an alphabetical
 * list pretending to be the DDL is the alternative.
 */
export async function describeObject(
  transport: CassandraTransport,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  const spec = findKind(capabilities, kind);
  if (spec === undefined) {
    throw new QueryError(`Cassandra declares no object kind "${kind}"`, PROVIDER);
  }

  assertObjectPathShape(capabilities, spec, path);

  const catalog = objectCatalog(kind);
  if (catalog === undefined) {
    throw new QueryError(`Cassandra declares the kind "${kind}" but has no statement that describes it`, PROVIDER);
  }

  // Neither bind is positional. The keyspace comes from the segment the DECLARATION
  // assigns to the `schema` level, and the object's own name is the LAST segment, which
  // is right at both depths this provider produces.
  const keyspace = containerSegment(capabilities, path, "schema");
  const name = path[path.length - 1];

  if (catalog.table === "types") return describeType(transport, path, keyspace, name);
  if (catalog.table === "indexes") return describeIndex(transport, path, keyspace, name);
  if (catalog.table !== "tables" && catalog.table !== "views") {
    return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
  }

  const columnsCql = cassandraObjectColumnsCql(keyspace, name);
  const columnRows = (await transport.execute(columnsCql)).rows;
  if (columnRows.length === 0) {
    // A CQL table must declare a primary key, so every table and every view has at
    // least one column and an empty answer means it is not there under that name.
    throw new QueryError(`No Cassandra ${kind} named ${name} in ${keyspace}`, PROVIDER, columnsCql);
  }

  // The same statement the `index` kind is listed with, filtered to this object. An
  // index is a first-class object here AND an attribute of the table it covers, and
  // both are true at once: the folder addresses it, the detail panel shows which
  // indexes reach this table's columns.
  const indexRows = (await transport.execute(cassandraObjectListCql(keyspace, "index")!)).rows;

  return relationDetail(path, name, columnRows, indexRows);
}

/**
 * Columns for EVERY object of one kind in one keyspace, in a CONSTANT number of round
 * trips (#789).
 *
 * The fifth method, and Cassandra is one of the two type-ids that fell out of the four
 * waves which landed it elsewhere. Nothing went red, because the shared conformance helper
 * skipped a provider that did not declare the method at all, which is the second half of
 * that finding.
 *
 * CONSTANT PER FOLDER, never one read per object, which is the whole reason the method
 * exists. It is not ONE statement here and it cannot be: CQL has no join, no subquery and
 * no union, so the composed single statement PostgreSQL and Druid use is simply not in the
 * grammar. What replaces it is a fixed statement set per kind, measured rather than
 * assumed:
 *
 * - `table` and `materialized_view`: THREE, issued together - the target listing, the
 *   keyspace's whole `system_schema.columns` partition, and the keyspace's index listing,
 *   which is what the single read joins for the same object. They are independent, so they
 *   go out in parallel and cost one round trip of latency rather than three.
 * - `index`: ONE. The listing statement already projects `options`, which is the entire
 *   content of an index detail.
 * - `type`: ONE. `system_schema.types` carries a UDT's `field_names` and `field_types` on
 *   the row that names it.
 * - `function`, `aggregate` and `trigger`: NONE. A routine has no columns and neither does
 *   a trigger, which is a true fact about the kind rather than a failed read, so the batch
 *   is `{ details: [] }` without touching the network - exactly as `describeObject`
 *   answers three empty arrays for one of them.
 *
 * The four guards, in the order the reference implementation writes them: an undeclared
 * kind THROWS naming the engine and the kind, the container is resolved through
 * `containerKeyspace()` (the same reader the listing uses, so neither the depth nor the
 * position of the keyspace segment is a constant, standing ruling 5g), a `limit` that is
 * not a positive whole number THROWS rather than being clamped, and a kind with no columns
 * answers an empty batch with no round trip.
 *
 * MEMBERSHIP IS THE TARGET READ'S, always, and never the column read's. A table the target
 * named and the column catalog holds nothing for is still in the batch with an empty column
 * list, where the SINGLE read raises instead - a deliberate difference, because a batch
 * that silently drops an object its own folder lists is the #414 absence this epic exists
 * to stop, and no CQL table can be columnless anyway (a primary key is mandatory).
 *
 * WHAT ORDERS THE CUT is the catalog's first clustering column, which is the only column
 * CQL will order by, and on `system_schema.indexes` that is the BASE TABLE rather than the
 * index name (`ORDER BY index_name` is server error 2200, measured). So on the `index` kind
 * a bounded read's MEMBERSHIP follows the base table's order while the ANSWER is sorted by
 * path. On every other kind the two agree.
 *
 * AND THE COLLATION QUESTION HAS NO EDGE HERE, measured rather than assumed. Task 26a-2
 * found that four engines cut under the UTF-8 byte order while `comparePaths` compares
 * UTF-16 code units, the two reversing for `U+E000` against `U+1F600`. Neither name can
 * exist on this engine: a CQL identifier holds alphanumeric and underscore characters only,
 * quoted or not, and `CREATE TABLE ks."<U+1F600>"` and `CREATE KEYSPACE "ks<U+1F600>"` are
 * both refused by the server. Over that alphabet the byte order and the UTF-16 order are
 * the same order, so the two sorts cannot disagree.
 *
 * A refused read RAISES here rather than answering a short batch. `countObjects` reports a
 * refusal per kind because a folder badge has a state for it; a batch has none, and
 * `{ details: [] }` already means "this keyspace holds no such object".
 */
export async function describeObjects(
  transport: CassandraTransport,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  if (findKind(capabilities, kind) === undefined) {
    throw new QueryError(`Cassandra declares no object kind "${kind}"`, PROVIDER);
  }
  const keyspace = containerKeyspace(capabilities, container);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new QueryError(
      `A Cassandra bulk column read limit must be a positive whole number, received ${limit}`,
      PROVIDER,
    );
  }
  const spec = objectCatalog(kind);
  if (spec === undefined) {
    throw new QueryError(`Cassandra declares the kind "${kind}" but has no statement that lists it`, PROVIDER);
  }
  // A kind with no columns, answered without a round trip. Keyed on the CATALOG this kind
  // reads and never on the kind id, the same rule `describeObject` branches by.
  if (spec.table !== "tables" && spec.table !== "views" && spec.table !== "indexes" && spec.table !== "types") {
    return { details: [] };
  }

  // One row more than the bound, so the read itself says whether it stopped short.
  const bound = limit === undefined ? undefined : limit + 1;
  const details =
    spec.table === "types"
      ? await describeTypeBatch(transport, container, keyspace, bound)
      : spec.table === "indexes"
        ? await describeIndexBatch(transport, container, keyspace, bound)
        : await describeRelationBatch(transport, container, keyspace, kind, bound);

  const truncated = limit !== undefined && details.length > limit;
  const kept = (truncated ? details.slice(0, limit) : details).sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  return truncated
    ? { details: kept, truncated: { limit, reason: callerBoundTruncationReason(limit) } }
    : { details: kept };
}

/**
 * Every UDT in one keyspace, from the one statement that carries both its name and its
 * fields. In the target's order, so the caller's bound cuts what the SERVER ordered.
 */
async function describeTypeBatch(
  transport: CassandraTransport,
  container: readonly string[],
  keyspace: string,
  bound: number | undefined,
): Promise<ObjectDetail[]> {
  const cql = cassandraKeyspaceTypesCql(keyspace);
  const rows = (await transport.execute(bound === undefined ? cql : `${cql} ORDER BY type_name ASC LIMIT ${bound}`))
    .rows;
  return rows.map((row) => typeDetail([...container, readText(row.type_name)], row));
}

/** Every index in one keyspace, from the listing statement, which already carries it all. */
async function describeIndexBatch(
  transport: CassandraTransport,
  container: readonly string[],
  keyspace: string,
  bound: number | undefined,
): Promise<ObjectDetail[]> {
  const rows = (await transport.execute(cassandraObjectListCql(keyspace, "index", bound)!)).rows;
  return rows.map((row) => indexDetail([...container, readText(row.index_name)], row));
}

/**
 * Every table or every materialized view in one keyspace, with its columns and the indexes
 * that reach it.
 *
 * Three statements, issued TOGETHER. `Promise.all` and not `allSettled`: unlike
 * `countObjects`, where a refusal is a per-kind fact a folder badge can carry, there is no
 * state in `ObjectDetailBatch` for "the columns were refused", so a refusal has to raise.
 *
 * Paths are built by `objectPath()`, the same function the listing builds its paths with,
 * because every caller joins the two answers on path.
 */
async function describeRelationBatch(
  transport: CassandraTransport,
  container: readonly string[],
  keyspace: string,
  kind: string,
  bound: number | undefined,
): Promise<ObjectDetail[]> {
  const spec = objectCatalog(kind)!;
  const [targets, columns, indexes] = await Promise.all([
    transport.execute(cassandraObjectListCql(keyspace, kind, bound)!),
    transport.execute(cassandraKeyspaceColumnsCql(keyspace)),
    transport.execute(cassandraObjectListCql(keyspace, "index")!),
  ]);

  const byOwner = new Map<string, CassandraRow[]>();
  for (const row of columns.rows) {
    const owner = readText(row.table_name);
    const owned = byOwner.get(owner);
    if (owned === undefined) byOwner.set(owner, [row]);
    else owned.push(row);
  }

  return targets.rows.map((row) => {
    const name = readText(row[spec.nameColumn]);
    return relationDetail(objectPath(container, spec, row), name, byOwner.get(name) ?? [], indexes.rows);
  });
}

// ============================================================================
// The object source read (issue #789)
// ============================================================================

/** The one part id and label this engine emits: one object, one statement, one text. */
const SOURCE_PART_ID = "definition";
const SOURCE_PART_LABEL = "Definition";

/**
 * The server's own sentence when a `DESCRIBE` result is invalidated between pages.
 *
 * MEASURED on 5.0.9 and REPRODUCED rather than quoted: `DESCRIBE TABLE probe.customers` with
 * `fetchSize: 1`, a `CREATE TABLE` in another keyspace, then a fetch of the second page with
 * the first page's `pageState`, answers protocol code 8704 with exactly this text. It is the
 * server telling the client to ASK AGAIN, not a refusal about the object, so reporting it as
 * an `unavailable` part would put a transient instruction in the Source pane as if it were a
 * fact about the definition.
 *
 * THIS IS THE ONE PLACE THIS PROVIDER READS A SERVER SENTENCE TO DECIDE ANYTHING, and the
 * trade is the opposite way round from the one `transport.ts` records for the monitoring
 * degradation. There the sentence was the only discriminator for five panels and a rephrase
 * would have silently disabled all five, so the discriminator moved to a property of the
 * server. Here 8704 alone cannot be the discriminator - an absent object carries it too - and
 * a rephrase costs exactly one thing: the retry stops firing and the error propagates as a
 * raise, which is what this code does anyway when the retry does not help. A degradation to
 * the documented fallback is an acceptable dependency on a sentence; a silent disappearance
 * is not.
 */
const SCHEMA_CHANGED_MID_PAGE = "The schema has changed since the previous page of the DESCRIBE statement result.";

/** The protocol's `Invalid query` code, which both the retry and every absence arrive under. */
const CQL_INVALID_CODE = 8704;

/**
 * One `DESCRIBE`, retried ONCE if the schema moved under a paged result.
 *
 * The retry is bounded at one attempt on purpose: a cluster whose schema is changing faster
 * than a catalog read completes will not be fixed by a third try, and an unbounded retry would
 * turn a busy cluster into a hang the Source pane can never leave.
 *
 * REACHABILITY, stated rather than implied: this provider sends no `fetchSize`, so the
 * driver's own default of 5000 rows applies, and a single-object `DESCRIBE` answers one row
 * plus, for a table, one per index and materialized view over it. So the paging this error
 * needs is out of reach for every shape the fixture holds, and the arm is driven in the suite
 * rather than by a cluster. It is written because the bound is the DRIVER's default and not a
 * guarantee of the statement.
 */
async function describeRows(transport: CassandraTransport, cql: string): Promise<CassandraRow[]> {
  try {
    return (await transport.execute(cql)).rows;
  } catch (error) {
    if (!isSchemaChangedMidPage(error)) throw error;
    return (await transport.execute(cql)).rows;
  }
}

/** Whether a failure is the server asking for the DESCRIBE to be sent again. */
function isSchemaChangedMidPage(error: unknown): boolean {
  return (
    error instanceof CassandraTransportError &&
    error.code === CQL_INVALID_CODE &&
    error.message.includes(SCHEMA_CHANGED_MID_PAGE)
  );
}

/**
 * A routine signature with every space removed, which is what makes two spellings of one
 * signature comparable.
 *
 * MEASURED on 5.0.9, and it is why an equality against the reply's `name` column would never
 * match: the server writes `sum_state(int, int)` with a SPACE after the comma while this
 * provider's identity segment is `sum_state(int,int)`, and a `map` argument is
 * `map<text, text>` in `system_schema.functions.argument_types` itself. Stripping whitespace
 * makes both spellings one value and changes nothing else: a CQL type name holds no
 * significant space.
 */
function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, "");
}

/**
 * The argument list the reply's `name` column carries, without the routine's own name.
 *
 * NOT a comparison against the whole `name`, and the measurement is the reason. The reply's
 * `name` is not a usable identity: for a quoted table it is `"MixedCase"` WITH the quotes, and
 * for a function named `Fn(x` - which the server ACCEPTS, unlike a table name, measured - it
 * is the unusable `"Fn"(x(int)`. What IS reliable in every one of those is the trailing
 * parenthesized argument list, because a CQL type name is built from angle brackets and holds
 * no parenthesis, so the LAST `(` opens the signature.
 */
function describeSignature(name: string): string | undefined {
  const open = name.lastIndexOf("(");
  if (open < 0 || !name.endsWith(")")) return undefined;
  return normalizeSignature(name.slice(open + 1, -1));
}

/**
 * The catalog row an OVERLOADED kind's path segment addresses, or undefined for none.
 *
 * The identity is resolved through `objectIdentity()`, THE SAME FUNCTION that built the
 * segment in `listObjects`, so the resolution can never drift from the listing: a change to
 * how a routine is addressed moves both sides at once. Nothing here re-parses the segment,
 * which is the alternative and is wrong on this engine - a function name may itself contain a
 * `(` (measured: `Fn(x` was created and sits in `system_schema.functions`).
 *
 * It is the same statement `countObjects` and `listObjects` send, which is the pattern
 * `describeIndex` above already follows for the same reason.
 */
async function resolveOverloadedRow(
  transport: CassandraTransport,
  keyspace: string,
  kind: string,
  spec: ObjectCatalogSpec,
  segment: string,
): Promise<CassandraRow | undefined> {
  const rows = (await transport.execute(cassandraObjectListCql(keyspace, kind)!)).rows;
  return rows.find((row) => objectIdentity(spec, row) === segment);
}

/**
 * One object's definition, as the server regenerates it (#789).
 *
 * `form: "complete"` and `origin: "regenerated"`, both measured rather than assumed. The text
 * is a whole `CREATE` statement ending in a semicolon, and it is a RECONSTRUCTION and not the
 * author's bytes: the fixture writes `CREATE TABLE probe.customers (id, name, city, home,
 * tags)` and the server answers the partition key first and then the other columns
 * alphabetically, with all twenty table options spelled out. Nothing in this product stores
 * the original.
 *
 * A FUNCTION'S BODY IS NOT CQL and the part does not pretend otherwise. `DESCRIBE FUNCTION`
 * answers a CQL envelope wrapping a body verbatim in `$$ ... $$`, whose language comes from
 * the catalog (`java` on 5.0). The part's `language` is the kind's declared `sql` because the
 * part IS the envelope, and `docs/providers/cassandra.md` says that plainly rather than
 * implying the body is highlighted correctly.
 *
 * ABSENCE RAISES AND IT IS THE SERVER'S OWN SENTENCE. Measured on 5.0.9, `DESCRIBE` NAMES THE
 * KIND IT LOOKED FOR in every one of them - "Table 'no_such_table' not found in keyspace
 * 'probe'", "Materialized view 'x' not found in 'probe'", "User defined function 'x' not found
 * in 'probe'" - so a WRONG-KIND ask is the same fact as a missing object and is told apart by
 * the sentence rather than by a code: `DESCRIBE TABLE probe.customers_by_city` against the
 * fixture's materialized view answers "Table 'customers_by_city' not found in keyspace
 * 'probe'". Both are absences and both raise, which is what the non-empty `parts` tuple
 * requires: there is no empty document for an absence to be confused with.
 *
 * THERE IS NO PRIVILEGE-DRIVEN REFUSAL ON THIS ENGINE, measured rather than assumed, and it is
 * the same shape probe 1 of this epic found for PostgreSQL's `pg_get_*` family. On a 5.0.9
 * node running `PasswordAuthenticator` with `CassandraAuthorizer`, a role created with a login
 * and NO GRANT OF ANY KIND read the complete `DESCRIBE TABLE` and `DESCRIBE FUNCTION` text for
 * the fixture's objects, in the same session where `SELECT` on `system_schema.tables` returned
 * nothing. So the `unavailable` arm below has exactly ONE producer: a `create_statement` that
 * is empty or whitespace only, which no build in this epic's measurements has ever answered
 * and which is refused anyway, because an empty definition is not a definition and an empty
 * editor over one is the failure this whole phase exists to stop.
 */
export async function readObjectSource(
  transport: CassandraTransport,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const spec = requireSourceKind(capabilities, kind, { displayName: "Cassandra", type: PROVIDER });
  assertObjectPathShape(capabilities, spec, path);
  const catalog = objectCatalog(kind);
  if (catalog?.describeTarget === undefined || catalog.describeType === undefined) {
    throw new QueryError(
      `Cassandra declares readable source for the kind "${kind}" but DESCRIBE has no target for it`,
      PROVIDER,
    );
  }

  // Neither read is positional. The keyspace comes from the segment the DECLARATION assigns to
  // the `schema` level, and the object's own name is the LAST segment, which is right at both
  // depths this provider produces.
  const keyspace = containerSegment(capabilities, path, "schema");
  const segment = path[path.length - 1];

  let name = segment;
  let signature: string | undefined;
  if (catalog.overloaded === true) {
    const row = await resolveOverloadedRow(transport, keyspace, kind, catalog, segment);
    if (row === undefined) {
      throw new QueryError(`No Cassandra ${kind} named ${segment} in ${keyspace}`, PROVIDER);
    }
    name = readText(row[catalog.nameColumn]);
    signature = normalizeSignature(readTextList(row.argument_types).join(","));
  }

  const cql = cassandraDescribeCql(keyspace, kind, name)!;
  const rows = await describeRows(transport, cql);
  const row = rows.find(
    (candidate) =>
      readText(candidate.type) === catalog.describeType &&
      (signature === undefined || describeSignature(readText(candidate.name)) === signature),
  );
  if (row === undefined) {
    // Defensive rather than observed: for every kind the server raises instead of answering a
    // reply with no row of the target's own type, and an overload the catalog did not hold was
    // already refused above. A short answer is still an absence and never a refusal part.
    throw new QueryError(`No Cassandra ${kind} named ${segment} in ${keyspace}`, PROVIDER, cql);
  }

  // An array LITERAL, which is what satisfies the non-empty tuple. `rows.map(...)` does not,
  // and casting past it would defeat the invariant the tuple exists for.
  const parts: [ObjectSourcePart] = [sourcePart(readText(row.create_statement), spec.sourceLanguage, limit)];
  return { path: [...path], kind, parts };
}

/**
 * One `create_statement` as a part, or the refusal an empty one is.
 *
 * The refusal sentence is OURS and says so, which is a declared deviation from "the engine's
 * own sentence, unprefixed": there is no engine sentence to carry, because the read SUCCEEDED
 * and the server simply put nothing in the column. `docs/providers/cassandra.md` records both
 * halves - that this is our wording, and that no measured build has produced it.
 */
function sourcePart(text: string, language: string, limit: number | undefined): ObjectSourcePart {
  if (text.trim() === "") {
    return {
      id: SOURCE_PART_ID,
      label: SOURCE_PART_LABEL,
      unavailable: "Cassandra answered this DESCRIBE with an empty create_statement.",
    };
  }
  const bounded = applySourceBound(text, limit);
  return {
    id: SOURCE_PART_ID,
    label: SOURCE_PART_LABEL,
    text: bounded.text,
    language,
    form: "complete",
    origin: "regenerated",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}
