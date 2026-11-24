/**
 * Couchbase's SQL++ generator forms, each bound by Studio's SQL generator function table (`SQL_GENERATOR_FUNCTIONS` in
 * `src/lib/db/query-generators/index.ts`) at the slot its name gives. Browser-safe: it imports nothing at run time.
 *
 * Names are quoted unconditionally: reserved words (`bucket`, `scope`, ...) are a syntax error unquoted, and a
 * schemaless document may name a field anything at all, so there is no safe unquoted subset worth detecting.
 *
 * Both statements are about the PROJECTION: the document key is not a column, so the grid has nothing to show
 * without the alias. Every field is reached through the keyspace alias, and the document key comes from META()
 * rather than from the document body.
 *
 * Generate Query ends in a literal `;`, which SQL++ accepts, rather than the declaration's terminator.
 */
import type { SqlEngineGenerators } from "@/lib/db/query-generators/types";

/**
 * Alias every generated Couchbase statement binds its keyspace to. SQL++ needs a
 * name to hang `META()` and field references off, and the generator has only the
 * collection name to work from, so the alias is fixed rather than derived: `d`
 * for document. It never collides with a field, because fields are only ever
 * referenced through it.
 */
const COUCHBASE_ALIAS = "d";

/**
 * Column carrying the document key. Kept in step with
 * `COUCHBASE_DOCUMENT_KEY_COLUMN` in the provider's introspection: the schema tree
 * and the generated projection must name the key identically, or the grid shows a
 * column the query never produces.
 */
const COUCHBASE_DOCUMENT_KEY_COLUMN = "__id";

/** Backtick-quote a SQL++ identifier, doubling any backtick it contains. */
function couchbaseQuote(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/**
 * The document key projection. `SELECT *` nests whole documents under the
 * keyspace name and never yields the key at all (issue #262, decision 5), so
 * every generated statement projects it explicitly through the alias.
 */
const COUCHBASE_KEY_PROJECTION = `META(${COUCHBASE_ALIAS}).id AS ${COUCHBASE_DOCUMENT_KEY_COLUMN}`;

export const COUCHBASE_GENERATOR_QUOTE: SqlEngineGenerators["quote"] = (name) => couchbaseQuote(name);

export const COUCHBASE_GENERATOR_TABLE: NonNullable<SqlEngineGenerators["table"]> = (table, { terminator }) =>
  `SELECT ${COUCHBASE_KEY_PROJECTION}, ${COUCHBASE_ALIAS}.* FROM ${table} AS ${COUCHBASE_ALIAS}${terminator}`;

export const COUCHBASE_GENERATOR_SELECT: NonNullable<SqlEngineGenerators["select"]> = (table, columns, { quote }) => {
  const fields = columns.filter((c) => c.name !== COUCHBASE_DOCUMENT_KEY_COLUMN);
  const projected =
    fields.length > 0 ? fields.map((c) => `  ${COUCHBASE_ALIAS}.${quote(c.name)}`) : [`  ${COUCHBASE_ALIAS}.*`];
  const projection = [`  ${COUCHBASE_KEY_PROJECTION}`, ...projected].join(",\n");
  return `SELECT\n${projection}\nFROM ${table} AS ${COUCHBASE_ALIAS}\nWHERE 1=1\nLIMIT 100;`;
};
