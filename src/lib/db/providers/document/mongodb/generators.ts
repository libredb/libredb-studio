/**
 * The JSON language's generators: MongoDB's command documents, collected as the `json` row of `LANGUAGE_GENERATORS` in
 * `src/lib/db/query-generators/index.ts`. Browser-safe: it reads only the declared levels and the shared pieces.
 *
 * Every engine that declares a query dialect of its own also declares `queryLanguage: "json"`, and its dialect row is
 * read first, so these documents are written only for a declaration with no dialect, which is MongoDB's. The row's
 * quoting is the whole language's, dialects included: a JSON command names an object as it is, never SQL-quoted.
 */
import { declaredLevels } from "@/lib/db/object-kinds";
import { objectSegment } from "@/lib/db/query-generators/shared";
import type { LanguageGenerators } from "@/lib/db/query-generators/types";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";

/**
 * The address a JSON command carries: the collection's own segment, and the database that
 * holds it as a key of its own (#843). `db.collection("sample_shop.users")` would name a
 * collection literally called that, so the database cannot ride inside `collection`.
 *
 * The database is the segment the declaration assigns to its `schema` level, never
 * `path[0]` (standing ruling 5g), and it is emitted unconditionally, including for the
 * connected database, for the reason `quoteObjectPath` qualifies unconditionally. A path
 * whose length does not match the declared levels is refused: a collection that lost its
 * database would otherwise read the connected database's same-named collection, which is
 * the wrong answer #843 was.
 *
 * The one reader for every statement the product writes for MongoDB: the three generators
 * below, the profiler route and the test data generator, which reads it as the row's `address`.
 */
export function jsonCommandAddress(
  path: readonly string[],
  capabilities: ProviderCapabilities,
): { database?: string; collection: string } {
  const levels = declaredLevels(capabilities);
  if (path.length !== levels.length + 1) {
    const shape = [...levels.map((level) => level.id), "name"].join(", ");
    throw new Error(`Cannot generate a query: the object path is [${shape}], received ${JSON.stringify(path)}.`);
  }
  const collection = objectSegment(path);
  if (levels.length === 0) return { collection };
  const index = levels.findIndex((level) => level.id === "schema");
  if (index < 0) {
    throw new Error(
      `Cannot generate a query: a JSON command needs a "schema" container level for its database; ` +
        `the declaration is [${levels.map((level) => level.id).join(", ")}].`,
    );
  }
  return { database: path[index], collection };
}

/**
 * The field paths a MongoDB projection may name together: every path whose ancestor is also
 * listed is dropped, since projecting the subdocument already returns it.
 *
 * Inferred columns name a subdocument and its dotted children side by side (`address`,
 * `address.city`, `address.geo.lat`; docs/providers/mongodb.md section 3.3), and MongoDB
 * refuses a projection or `$project` that names a path beside one of its sub-paths:
 * `Path collision at address.city remaining portion city` (measured on mongo:8.2.12). An
 * ancestor is a whole segment, so `addressBook` survives `address`. Order is kept and
 * duplicates collapse.
 */
export function outermostFieldPaths(names: readonly string[]): string[] {
  const listed = new Set(names);
  return [...listed].filter((name) => {
    const segments = name.split(".");
    return !segments.some((_, i) => i > 0 && listed.has(segments.slice(0, i).join(".")));
  });
}

/** Generate Query's find document: the outermost column paths as its projection, or none, under `limit: 100`. */
function selectDocument(
  path: readonly string[],
  columns: readonly ColumnSchema[],
  capabilities: ProviderCapabilities,
): string {
  const projection: Record<string, number> = {};
  outermostFieldPaths(columns.map((c) => c.name)).forEach((name) => {
    projection[name] = 1;
  });
  return JSON.stringify(
    {
      ...jsonCommandAddress(path, capabilities),
      operation: "find",
      filter: {},
      options: {
        projection: Object.keys(projection).length > 0 ? projection : undefined,
        limit: 100,
      },
    },
    null,
    2,
  );
}

/**
 * A tree click's find keeps its own bound, `limit: 50`: MongoDB cannot be asked for page two at all
 * (`supportsResultPagination: false`, measured), so the bound in the document is the only one there is. Generate Query
 * keeps `limit: 100`, written into the editor and run only if the user presses Run, and Generate Count Query writes
 * a `count` with an empty filter.
 */
export const MONGODB_JSON_GENERATORS: LanguageGenerators = Object.freeze<LanguageGenerators>({
  table: (path, _columns, capabilities) =>
    JSON.stringify(
      { ...jsonCommandAddress(path, capabilities), operation: "find", filter: {}, options: { limit: 50 } },
      null,
      2,
    ),
  select: selectDocument,
  count: (path, capabilities) =>
    JSON.stringify({ ...jsonCommandAddress(path, capabilities), operation: "count", filter: {} }, null, 2),
  address: jsonCommandAddress,
  quote: (name) => name,
  quotePath: (path) => path.join("."),
});
