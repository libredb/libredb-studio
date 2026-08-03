// db/utils, not the Druid provider directory: an explain strategy that imported from
// a provider would tie the registry to it (the rule clickhouse-json.ts records).
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * Does this statement lead to a SELECT, so that `EXPLAIN PLAN FOR` can wrap it?
 *
 * Broader than the bare `/^\s*SELECT\b/` the other strategies still use, because two
 * ordinary things a user types are genuinely explainable on Druid and were being
 * refused - which left the Explain button dead rather than merely narrow:
 *
 * - a CTE: `EXPLAIN PLAN FOR WITH t AS (...) SELECT * FROM t` is live-verified as
 *   accepted, and the shared `analyzeQuery` already classifies `WITH ... SELECT` as a
 *   SELECT (it injects a LIMIT into one), so refusing it here contradicted the rest of
 *   the pipeline;
 * - a leading comment: `-- note`, or a `/* ... *\/` licence header, before the SELECT.
 *   Live-verified as accepted too, both as a prefix and combined with a CTE.
 *
 * The SHAPE of this pattern matters as much as what it accepts, and it is deliberately
 * not the obvious `^\s*(--...|\/*...*\/|\s)*` spelling:
 *
 * Every one of the three alternatives had to be made unambiguous, because each is
 * inside a `*` quantifier and any way of matching the same text twice is a way for a
 * non-matching input to backtrack. All three were measured, with a tail that never
 * reaches SELECT:
 *
 * - there is no leading `\s*`, because whitespace is already one alternative below.
 *   Having both gives two ways to match the same run of spaces: quadratic, 958ms on
 *   20k leading spaces.
 * - the line comment must end at a newline OR at end-of-input. Without that tail,
 *   `[^\n]*` can give characters back and let a later iteration match `--` again, so a
 *   run of bare dashes partitions exponentially - 634ms on a FORTY-NINE character
 *   input, which is by far the cheapest of the three to trigger. Requiring the tail
 *   forces the branch to run to the newline or to the end, so there is nothing to give
 *   back. Found by CodeQL after the first two were fixed.
 * - the block-comment body is TEMPERED (`[^*]|\*(?!\/)`) rather than a lazy
 *   `[\s\S]*?\*\/`, which inside a `*` quantifier can extend past the first `*\/` and
 *   let one iteration swallow several comments: 852ms on a 4 KB run of `/**\/`.
 *
 * All three now answer in well under a millisecond.
 *
 * Both forms accept and reject exactly the same statements - the difference is only
 * how much backtracking a non-matching input costs. `buildSql` runs on whatever is in
 * the editor when a query is executed, so a buffer that opens with a large commented
 * block and then a non-SELECT is a reachable input, and this file follows the same
 * anti-backtracking care that made `query-limiter.ts` hand-write its semicolon strip
 * "without regex to avoid ReDoS".
 */
const SELECT_ONLY = /^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*(?:SELECT|WITH)\b/i;

/**
 * Druid's EXPLAIN is a statement prefix, not a modifier with options, and it never
 * executes the statement. A trailing semicolon survives untouched:
 * `EXPLAIN PLAN FOR SELECT 1 AS c1;` is live-verified as accepted.
 */
const EXPLAIN_PREFIX = "EXPLAIN PLAN FOR ";

/**
 * The single result row carries three columns and every one of them is JSON *text*,
 * not JSON: the envelope parse leaves three escaped blobs behind and each needs a
 * second parse. Names are upper case on the wire.
 */
const EXPLAIN_COLUMNS = { plan: "PLAN", resources: "RESOURCES", attributes: "ATTRIBUTES" } as const;

/**
 * How many wrapper layers toPlanEntries peels before giving up. The deepest
 * legitimate chain is three hops - stored JSON text, the { plan } member, then the
 * entry array - so the extra layer only keeps a pathological chain from looping.
 */
const MAX_UNWRAP_DEPTH = 4;

/**
 * How deep the query -> dataSource -> query recursion may go. The deepest live plan
 * is three dataSource hops (a join whose right leg is a subquery over a table), so
 * this is far past anything real and fires only on a shape that nests without end.
 */
const MAX_PLAN_DEPTH = 32;

/** What the tree says where MAX_PLAN_DEPTH stopped it, so truncation is visible rather than silent. */
const TRUNCATED_LABEL = "plan truncated: nesting limit reached";

/** Stands in for a `type` Druid did not send at all; an unrecognised type labels itself. */
const UNKNOWN_TYPE = "unknown";

/**
 * The dataSource discriminators Druid emits. Anything absent from this list renders
 * as a leaf named by its own type rather than being dropped - Druid adds dataSource
 * types between releases, and a dropped node would make the tree quietly lie about
 * what runs.
 */
const DATA_SOURCE = {
  table: "table",
  query: "query",
  join: "join",
  union: "union",
  lookup: "lookup",
  inline: "inline",
  external: "external",
} as const;

/**
 * One entry of the PLAN array: `query` is the native query Druid will run, and
 * `signature`/`columnMappings` describe the output shape rather than the operator
 * tree, so only `query` is walked.
 */
interface DruidNativeQuery {
  queryType: string;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNativeQuery(value: unknown): value is DruidNativeQuery {
  return isRecord(value) && typeof value.queryType === "string";
}

/**
 * The plan columns are JSON TEXT inside an already-parsed body, so this is a second,
 * independent parse - and a second, independent chance to round a 64-bit integer.
 *
 * The transport's pass over the outer body cannot help here: relative to that body
 * the plan is a string literal, so its digits are correctly left alone. Without the
 * scanner a native filter on a BIGINT arrives rounded, live-verified:
 * `... "matchValue": 9007199254740993` in the raw text became `...992` in the stored
 * plan, which is what the raw-JSON tab and the AI analyzer then read.
 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(quoteUnsafeIntegers(text));
  } catch {
    return undefined;
  }
}

/**
 * Accepts what extractPlan stores ({ plan, resources, attributes }), the bare PLAN
 * array, and - because an older tab may hold the column text unparsed - JSON text of
 * either, in any nesting up to MAX_UNWRAP_DEPTH.
 */
function toPlanEntries(raw: unknown): unknown[] | null {
  let current = raw;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (Array.isArray(current)) return current.length > 0 ? current : null;
    if (typeof current === "string") {
      current = parseJsonText(current);
    } else if (isRecord(current) && "plan" in current) {
      current = current.plan;
    } else {
      return null;
    }
  }
  return null;
}

/** Each column holds JSON text; the text is kept when it will not parse so nothing is lost. */
function readColumn(row: Record<string, unknown> | undefined, column: string): unknown {
  const cell = row?.[column];
  if (typeof cell !== "string") return undefined;
  return parseJsonText(cell) ?? cell;
}

/**
 * `granularity` is `{ type: "all" }` on almost every plan, but TIME_FLOOR turns it
 * into a bare string ("DAY", "SIX_HOUR") and a period spec puts the ISO period in
 * `period` while `type` stays the uninformative "period" - so `period` wins.
 */
function readGranularity(value: unknown): string | undefined {
  if (isNonEmptyString(value)) return value;
  if (!isRecord(value)) return undefined;
  if (isNonEmptyString(value.period)) return value.period;
  return isNonEmptyString(value.type) ? value.type : undefined;
}

/**
 * A native filter is itself a tree (`and` over `equals` and `range`, live). Rendering
 * it as a second tree would compete with the operator tree for the reader's
 * attention, so one row names the filter type plus either the column it restricts or
 * how many clauses it combines.
 */
function buildFilterLabel(filter: Record<string, unknown>): string {
  const type = isNonEmptyString(filter.type) ? filter.type : UNKNOWN_TYPE;
  if (isNonEmptyString(filter.column)) return `filter: ${type} on ${filter.column}`;
  const fields = filter.fields;
  if (Array.isArray(fields)) return `filter: ${type} (${fields.length} clauses)`;
  return `filter: ${type}`;
}

/** `region AS d0`: the source column and the generated output name Druid gave it. */
function describeDimension(dimension: unknown): string | undefined {
  if (!isRecord(dimension)) return undefined;
  const source = isNonEmptyString(dimension.dimension) ? dimension.dimension : undefined;
  const output = isNonEmptyString(dimension.outputName) ? dimension.outputName : undefined;
  if (source === undefined) return output;
  return output === undefined || output === source ? source : `${source} AS ${output}`;
}

/** `longMax(qty) AS a0`; a count has no `fieldName` because it aggregates no column. */
function describeAggregation(aggregation: unknown): string | undefined {
  if (!isRecord(aggregation)) return undefined;
  const type = aggregation.type;
  if (!isNonEmptyString(type)) return undefined;
  const call = isNonEmptyString(aggregation.fieldName) ? `${type}(${aggregation.fieldName})` : type;
  return isNonEmptyString(aggregation.name) ? `${call} AS ${aggregation.name}` : call;
}

function describeAll(value: unknown, describe: (item: unknown) => string | undefined): string[] {
  return Array.isArray(value) ? value.map(describe).filter(isNonEmptyString) : [];
}

/** topN names its single grouping key `dimension`; groupBy uses the `dimensions` array. */
function readDimensions(query: DruidNativeQuery): string[] {
  return describeAll(Array.isArray(query.dimensions) ? query.dimensions : [query.dimension], describeDimension);
}

/**
 * VisualExplain's tree renderer shows the label and nothing else, so what a reader
 * needs to see has to be a label - hence child rows rather than one detail string.
 * These are attributes of the query, never metrics: Druid's planner emits no cost and
 * no row estimate anywhere in this payload.
 */
function collectAttributeRows(query: DruidNativeQuery): ExplainTreeNode[] {
  const rows: string[] = [];
  const granularity = readGranularity(query.granularity);
  if (granularity !== undefined) rows.push(`granularity: ${granularity}`);
  if (isRecord(query.filter)) rows.push(buildFilterLabel(query.filter));
  const dimensions = readDimensions(query);
  if (dimensions.length > 0) rows.push(`dimensions: ${dimensions.join(", ")}`);
  const aggregations = describeAll(query.aggregations, describeAggregation);
  if (aggregations.length > 0) rows.push(`aggregations: ${aggregations.join(", ")}`);
  return rows.map((label) => ({ label, children: [] }));
}

function buildJoinLabel(dataSource: Record<string, unknown>): string {
  const head = [DATA_SOURCE.join, dataSource.joinType].filter(isNonEmptyString).join(" ");
  return isNonEmptyString(dataSource.condition) ? `${head} on ${dataSource.condition}` : head;
}

function buildNamedLabel(type: string, name: unknown): string {
  return isNonEmptyString(name) ? `${type} ${name}` : type;
}

/**
 * "1 row" / "2 rows". The count is part of the label, which is the only thing the
 * tree renderer shows, so it has to read as English - live `SELECT 1 AS c1` plans a
 * one-row inline dataSource and reached the reader as "1 rows".
 */
function countLabel(value: unknown, noun: string): string {
  const count = Array.isArray(value) ? value.length : 0;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function toDataSourceNodes(value: unknown, depth: number): ExplainTreeNode[] {
  const node = toDataSourceNode(value, depth);
  return node === null ? [] : [node];
}

/**
 * The recursion that IS the operator tree: a query's `dataSource` is either a leaf
 * (table, lookup, inline, external) or another layer of queries (query, join, union).
 */
function toDataSourceNode(value: unknown, depth: number): ExplainTreeNode | null {
  if (!isRecord(value)) return null;
  if (depth >= MAX_PLAN_DEPTH) return { label: TRUNCATED_LABEL, children: [] };
  const type = isNonEmptyString(value.type) ? value.type : UNKNOWN_TYPE;
  switch (type) {
    case DATA_SOURCE.table:
      return { label: buildNamedLabel(DATA_SOURCE.table, value.name), children: [] };
    case DATA_SOURCE.query:
      return {
        label: DATA_SOURCE.query,
        children: isNativeQuery(value.query) ? [toQueryNode(value.query, depth + 1)] : [],
      };
    case DATA_SOURCE.join: {
      // rightPrefix is what disambiguates the right leg's columns inside the join
      // condition ("j0." live), so it belongs beside the condition, not instead of it.
      const node: ExplainTreeNode = {
        label: buildJoinLabel(value),
        children: [...toDataSourceNodes(value.left, depth + 1), ...toDataSourceNodes(value.right, depth + 1)],
      };
      if (isNonEmptyString(value.rightPrefix)) node.detail = `rightPrefix: ${value.rightPrefix}`;
      return node;
    }
    case DATA_SOURCE.union: {
      const sources = Array.isArray(value.dataSources) ? value.dataSources : [];
      return {
        label: `${DATA_SOURCE.union} (${countLabel(sources, "source")})`,
        children: sources.flatMap((source) => toDataSourceNodes(source, depth + 1)),
      };
    }
    case DATA_SOURCE.lookup:
      return { label: buildNamedLabel(DATA_SOURCE.lookup, value.lookup), children: [] };
    case DATA_SOURCE.inline: {
      const node: ExplainTreeNode = {
        label: `${DATA_SOURCE.inline} (${countLabel(value.rows, "row")})`,
        children: [],
      };
      const columns = Array.isArray(value.columnNames) ? value.columnNames.filter(isNonEmptyString) : [];
      if (columns.length > 0) node.detail = `columns: ${columns.join(", ")}`;
      return node;
    }
    case DATA_SOURCE.external: {
      // The native engine rejects EXTERN outright ("Cannot use [EXTERN] with SQL
      // engine [native]"), so this only arrives from the MSQ task engine. Naming the
      // input source is what makes the node readable when it does.
      const inputSource = value.inputSource;
      const name = isRecord(inputSource) ? inputSource.type : undefined;
      return { label: buildNamedLabel(DATA_SOURCE.external, name), children: [] };
    }
    default:
      return { label: type, children: [] };
  }
}

/**
 * The dataSource subtree comes first and the attribute rows after, so following first
 * children down the tree follows the data - the same ordering ClickHouse uses for its
 * plan children ahead of its index rows.
 */
function toQueryNode(query: DruidNativeQuery, depth: number): ExplainTreeNode {
  return {
    label: query.queryType,
    children: [...toDataSourceNodes(query.dataSource, depth), ...collectAttributeRows(query)],
  };
}

function readEntryQuery(entry: unknown): unknown {
  return isRecord(entry) ? entry.query : undefined;
}

export const druidNativeStrategy: ExplainStrategy = {
  format: "druid-native",
  // Druid's EXPLAIN never executes the statement, so there is nothing different to
  // build for analyze. Declining that mode would disable the feature instead of
  // narrowing it - the direct Explain action always builds with mode "analyze"
  // (use-query-execution.ts:165) and refuses the run when the strategy returns null -
  // so both modes return the same plan, as the SQLite and Couchbase strategies do.
  buildSql(sql) {
    if (!SELECT_ONLY.test(sql.trim())) return null;
    return `${EXPLAIN_PREFIX}${sql}`;
  },
  // Parsing all three columns here rather than at render time is what gives the raw
  // JSON tab and the AI tab a structure to read instead of three escaped blobs.
  extractPlan(result) {
    const row = result.rows?.[0];
    const plan = readColumn(row, EXPLAIN_COLUMNS.plan);
    const resources = readColumn(row, EXPLAIN_COLUMNS.resources);
    const attributes = readColumn(row, EXPLAIN_COLUMNS.attributes);
    // Nothing recognisable: hand the rows through so the raw tab still shows what the
    // server sent rather than an object of three undefineds.
    if (plan === undefined && resources === undefined && attributes === undefined) return result.rows;
    return { plan, resources, attributes };
  },
  toRenderModel(raw) {
    const entries = toPlanEntries(raw);
    if (entries === null) return null;
    const queries = entries.map(readEntryQuery).filter(isNativeQuery);
    if (queries.length === 0) return null;
    const roots = queries.map((query) => toQueryNode(query, 0));
    // PLAN is an array and it is not always length 1: two aggregating branches of a
    // UNION ALL come back as two independent native queries (live-verified). A
    // synthetic root is the only way to show both without pretending one is the
    // parent of the other; a single query is its own root.
    const root = roots.length === 1 ? roots[0] : { label: `${roots.length} native queries`, children: roots };
    return { kind: "tree", root, raw };
  },
};
