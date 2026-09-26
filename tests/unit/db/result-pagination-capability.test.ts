import { describe, test, expect } from "bun:test";
import { createDatabaseProvider } from "@/lib/db/factory";
import { CENSUS_CONNECTION } from "../../helpers/census-connection";
import { generateTableQuery } from "@/lib/query-generators";
import type { DatabaseType } from "@/lib/types";
import type { PreparedQuery } from "@/lib/db/types";

/**
 * `supportsResultPagination` against what each provider's own `prepareQuery` does (#816).
 *
 * The per-provider triad tests assert the declared VALUE, which cannot fail for the reason
 * that matters: a provider declaring `true` whose `prepareQuery` never applies the offset
 * would pass every one of them while the grid offers a Load More that re-runs page one.
 * That is acceptance criterion 3, and it is a claim about behaviour, so this file measures
 * the behaviour and compares the declaration to it.
 *
 * Nothing here connects. `createDatabaseProvider` is a switch over dynamic imports and a
 * constructor, and `prepareQuery` is pure string work above the wire, so the whole census
 * runs against `CENSUS_CONNECTION`'s unconnected configurations.
 */

const PAGE_SIZE = 50;
const STATEMENT = "SELECT * FROM t";

/**
 * The declaration every provider must carry, measured 2026-09-20 by calling each
 * provider's own `prepareQuery(STATEMENT, { limit: 50, offset: 50 })`:
 *
 * - `false` for `cassandra` and `elasticsearch`, which THROW a `QueryError` rather than
 *   answer a page request they cannot serve.
 * - `false` for `mongodb` and `redis`, which pin `offset` to 0 and return the statement
 *   untouched, and for `prometheus` (#1085), declared the same way before its provider
 *   existed: an instant query has no row offset, and the provider bounds series itself.
 * - `false` for `kafka` (#1088), which inherits `BaseDatabaseProvider.prepareQuery` as `libredb`
 *   does below: a read request carries its own limit and no offset can page it.
 * - `false` for `libredb`, the quiet one: it inherits `BaseDatabaseProvider.prepareQuery`,
 *   which echoes `offset: 50` back while applying nothing, so a `true` here would render a
 *   control whose every click re-fetches page one.
 * - `true` for the other twelve, each of which emits a real offset clause; the shapes
 *   differ per dialect and the invariant below does not care which, only that the
 *   statement CHANGED and the provider says it applied the bound.
 *
 * A Record so a new member of `DatabaseType` is a compile error here rather than an
 * engine this census silently skips.
 */
const EXPECTED: Readonly<Record<DatabaseType, boolean>> = Object.freeze({
  postgres: true,
  mysql: true,
  sqlite: true,
  libsql: true,
  duckdb: true,
  oracle: true,
  mssql: true,
  clickhouse: true,
  druid: true,
  trino: true,
  couchbase: true,
  opensearch: true,
  cassandra: false,
  elasticsearch: false,
  mongodb: false,
  redis: false,
  libredb: false,
  prometheus: false,
  kafka: false,
});

const TYPES = Object.keys(EXPECTED) as DatabaseType[];

function prepare(
  provider: { prepareQuery: (q: string, o: object) => PreparedQuery },
  offset: number,
  sql: string = STATEMENT,
) {
  try {
    return { prepared: provider.prepareQuery(sql, { limit: PAGE_SIZE, offset }), threw: false as const };
  } catch (error) {
    return { error, threw: true as const };
  }
}

describe("supportsResultPagination (#816)", () => {
  test.each(TYPES)("%s declares the flag explicitly", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    // `typeof` rather than a truthiness check: the UI gates on `=== true`, so an ABSENT
    // flag and a declared `false` render the same and only this assertion can tell them
    // apart. The spec is emphatic that every provider in this repo declares a value.
    expect(typeof provider.getCapabilities().supportsResultPagination).toBe("boolean");
  });

  test.each(TYPES)("%s declares the value its own prepareQuery earns", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    expect(provider.getCapabilities().supportsResultPagination).toBe(EXPECTED[type]);
  });

  test.each(TYPES.filter((type) => EXPECTED[type]))("%s applies an offset it was offered", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const pageOne = prepare(provider, 0);
    const pageTwo = prepare(provider, PAGE_SIZE);

    expect(pageTwo.threw).toBe(false);
    if (pageTwo.threw) return;
    if (pageOne.threw) throw pageOne.error;

    // The three facts the grid depends on, in the order the route reads them: the bound is
    // OURS (`wasLimited`, which `hasMore` now requires), the offset the caller asked for is
    // the one reported back, and the statement that goes to the engine is not page one's.
    expect(pageTwo.prepared.wasLimited).toBe(true);
    expect(pageTwo.prepared.offset).toBe(PAGE_SIZE);
    expect(pageTwo.prepared.limit).toBe(PAGE_SIZE);
    expect(pageTwo.prepared.query).not.toBe(pageOne.prepared.query);
    expect(pageTwo.prepared.query).not.toBe(STATEMENT);
  });

  /**
   * CRITERION 1 AND REVIEW ITEM 4, as a chain rather than as three separate facts, over
   * EVERY type-id rather than only the pageable ones.
   *
   * A tree click opens `generateTableQuery`'s statement and runs it with `limit: 50`. For the
   * Load More control to appear at all, the route's `hasMore` needs `wasLimited`, which needs
   * the limiter to have rewritten THAT statement. So the generated preview and the provider
   * have to agree, and this asserts they do.
   *
   * It is the assertion the old design could not have: the generated statement carried its own
   * `LIMIT 50`, so the limiter returned it untouched with `wasLimited: false` — which is why no
   * control ever rendered, on any engine.
   *
   * It runs over every type-id because item 4 is about the engines that CANNOT page: "no engine
   * is left with a larger preview and no control". Cassandra and Elasticsearch are exactly the
   * pair whose generated `LIMIT 50` this change removed and whose flag is false, so restricting
   * the chain to `EXPECTED[type]` would have excluded the two engines the item was written
   * about. The split below is on a capability and never on a type-id: the JSON grammars
   * carry their bound inside the document the generator writes, because the limiter cannot
   * reach into one.
   */
  test.each(TYPES)("%s: the statement a tree click generates is bounded at the preview page size", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const capabilities = provider.getCapabilities();
    const generated = generateTableQuery(["app", "orders"], capabilities);
    const pageOne = prepare(provider, 0, generated);
    expect(pageOne.threw).toBe(false);
    if (pageOne.threw) return;

    if (!capabilities.supportsExternalQueryLimiting) {
      // MongoDB, Redis and LibreDB. Measured 2026-09-20: the generator writes
      // `{"collection":"orders","operation":"find",…,"options":{"limit":50}}` for MongoDB
      // and the single-key commands `TYPE orders` and `get orders` for the other two, and
      // the limiter hands all three on untouched. Their generators were not in this change
      // and their previews did not grow; the assertion is that the limiter still does not
      // rewrite them, because a rewrite is what would silently replace their own bound.
      // Prometheus (#1085) joins them with the metric selector its generator writes, which
      // its own `prepareQuery` hands on untouched as well, and Kafka (#1088) with the read
      // request its generator writes, `limit` included, which the base `prepareQuery` hands on.
      expect(pageOne.prepared.query).toBe(generated);
      return;
    }

    // Criterion 9: what the editor shows is a statement the user can copy out and run
    // elsewhere unchanged, so it carries no row bound and no terminator the engine refuses.
    expect(generated).not.toMatch(/\bLIMIT\b|\bFETCH\s+FIRST\b|\bTOP\s+\d/i);
    if (capabilities.statementTerminator === "none") expect(generated.endsWith(";")).toBe(false);

    // The bound left the text, so it has to come back from the limiter — at the preview page
    // size and not at `DEFAULT_QUERY_LIMIT`. This is the half that holds for Cassandra and
    // Elasticsearch too: they keep a 50-row preview and simply never gain a control.
    expect(pageOne.prepared.wasLimited).toBe(true);
    expect(pageOne.prepared.limit).toBe(PAGE_SIZE);
    expect(pageOne.prepared.query).not.toBe(generated);
  });

  test.each(TYPES.filter((type) => !EXPECTED[type]))("%s cannot be asked for page two", async (type) => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
    const pageTwo = prepare(provider, PAGE_SIZE);

    if (pageTwo.threw) {
      // Cassandra and Elasticsearch: a refusal is the strongest answer, and the flag is
      // false so the control that would provoke it is never rendered.
      expect(pageTwo.error).toBeInstanceOf(Error);
      return;
    }

    // MongoDB, Redis, LibreDB, Prometheus and Kafka: no refusal, so the only thing that keeps criterion 3 is the
    // flag. Pin what they really do, so a provider that starts applying the offset is a
    // failure here rather than a flag left false for an engine that outgrew it.
    expect(pageTwo.prepared.wasLimited).toBe(false);
    expect(pageTwo.prepared.query).toBe(STATEMENT);
  });
});
