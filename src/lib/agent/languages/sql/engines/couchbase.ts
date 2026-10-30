/**
 * Couchbase's server overlay: the dialect-bound members of the SQL server facet, as agent mode composes them on
 * Couchbase, and the grounding a plan run on it is told. Server tier, read only through `engineServerDialect` and
 * `runServerPack` in `languages/engines/server.ts`.
 *
 * A Couchbase collection declares no columns, so the column inventory is read from its documents: a SELECT of at most
 * 100 documents of one collection, each top-level field's name and JSON type (`TYPE()`) once, which describes that
 * sample rather than a declared shape, as the schema explorer's INFER does. A user holding only query_select reads it
 * (measured on 8.0.2, `tests/fixtures/couchbase/8.0.2/agent-boundary/` capture 07). A collection is named by its
 * scope and its own name inside the connection's bucket, so the read names both, and a selector without them is
 * refused. SQL++ has no foreign key, an index list a user holding only query_select is shown none of
 * (`system:indexes` filters every row out, capture 02), and no row count it can vouch for, so those three kinds are
 * refused. The provider sends only a SELECT to the server, so no estimating plan (`EXPLAIN`) is composed, and a table
 * profile, the statistics reading and the grounding capture have no composition measured here.
 */
import { quoteLiteral } from "@/lib/sql/values";
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  assertSelector,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay, AgentLanguageGrounding, SqlServerDialect } from "../../pack";

/**
 * A name as SQL++ quotes one: in backticks, a backtick inside doubled (`sql-grammar.ts` beside the provider). A
 * double-quoted run is a string literal in SQL++, not a name, so the standard identifier quote cannot name a
 * collection here.
 */
const backticked = (name: string): string => `\`${name.replaceAll("`", "``")}\``;

/** Documents the column inventory samples from one collection, as many as the schema explorer's INFER reads. */
const COLUMN_SAMPLE_SIZE = 100;

/** The field names and JSON types of a sample of one collection's documents, each pair once. */
function composeCouchbaseColumns(selector: AgentCatalogSelector): string {
  if (selector.schema === undefined || selector.table === undefined) {
    throw new AgentComposedSqlError(
      "Couchbase's collections declare no columns, so the fields are read from one collection's documents at a time: name its scope as the schema and the collection as the table",
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  const scope = assertSelector(selector.schema, "schema");
  const collection = assertSelector(selector.table, "table");
  return (
    `SELECT DISTINCT ${quoteLiteral(scope, "couchbase")} AS table_schema, ` +
    `${quoteLiteral(collection, "couchbase")} AS table_name, p.name AS column_name, TYPE(p.val) AS data_type ` +
    `FROM (SELECT RAW d FROM ${backticked(scope)}.${backticked(collection)} AS d ` +
    `LIMIT ${COLUMN_SAMPLE_SIZE}) AS doc UNNEST OBJECT_PAIRS(doc) AS p ORDER BY column_name, data_type`
  );
}

/** A kind the engine has nothing to answer: refused, naming what it lacks. */
function refusing(lacks: string): (selector: AgentCatalogSelector) => string {
  return () => {
    throw new AgentComposedSqlError(
      `Couchbase keeps no ${lacks}, so there is no such inventory to read`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  };
}

/** Couchbase's catalog read: the column kind alone composed. */
const COUCHBASE_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeCouchbaseColumns,
    relations: refusing("foreign key"),
    indexes: refusing("index list a user holding only query_select is shown"),
    statistics: refusing("row count it can vouch for"),
  }),
});

/**
 * What a plan run on Couchbase is told on top of the SQL contract: how SQL++ names what it reads, and what the agent
 * path sends, each measured on 8.0.2.
 */
const SQLPP_PLANNING_RULES: readonly string[] = Object.freeze([
  "Name a collection as scope.collection with each part in backticks (`_default`.`_default` for the bucket's default collection): the query context is the connection's bucket, and a bare name reads as a collection of the _default scope.",
  "Documents are JSON: reach a nested field with a dot (d.address.city) and an array element with brackets, and alias the collection (FROM `s`.`c` AS d) so META(d).id names the document key.",
  "Send one SELECT, a WITH before it allowed; UPDATE STATISTICS, INFER, EXPLAIN, ADVISE, PREPARE and EXECUTE are refused before they are sent.",
]);

/** The SQL grounding with SQL++'s naming added, and no relation inventory, since SQL++ has no foreign key. */
const couchbaseGrounding = (base: AgentLanguageGrounding): AgentLanguageGrounding =>
  Object.freeze({ ...base, relations: false, planningRules: SQLPP_PLANNING_RULES });

export const COUCHBASE_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: COUCHBASE_CATALOG_READ,
    planEstimate: "unsupported",
    profileComposition: "unsupported",
    statistics: "unsupported",
    catalogCapture: "unsupported",
  } satisfies SqlServerDialect),
  grounding: couchbaseGrounding,
} as const satisfies AgentEngineServerOverlay<"sql">;
