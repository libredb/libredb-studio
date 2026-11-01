/**
 * The Elasticsearch agent path's index-name fence: a hidden or system index (its name starts with a dot) is refused
 * before anything is sent, in every spelling 9.1.4 answered with rows on 2026-11-01 when the superuser sent it raw,
 * and so is every catalog command but the column catalog read the agent composes. The statements it admits are the
 * reads the agent and MCP send, the composed catalog read included.
 */
import { describe, expect, test } from "bun:test";
import { QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import {
  assertAgentIndexNames,
  CATALOG_COMMAND_REFUSAL,
  DOT_INDEX_REFUSAL,
} from "@/lib/db/providers/sql/search/elasticsearch-agent-index-fence";

function thrown(run: () => void): QueryError {
  try {
    run();
  } catch (error) {
    return error as QueryError;
  }
  throw new Error("nothing was thrown");
}

describe("assertAgentIndexNames", () => {
  test.each([
    "SELECT customer FROM probe_orders",
    'SELECT customer FROM "probe_orders"',
    'SELECT COUNT(*) AS n FROM "*"',
    "SELECT p.customer FROM probe_orders p WHERE p.customer IS NOT NULL",
    'SELECT "p".customer FROM probe_orders "p"',
    "SELECT .5 AS x, 1.5 AS y",
    "SELECT customer FROM probe_orders WHERE customer = '.security' OR note LIKE '.%'",
    'SELECT COUNT(*) AS n FROM "logs-2026.11.01"',
    'SELECT note AS "total (est.)" FROM probe_orders',
    "SELECT k FROM probe_buckets ORDER BY k DESC",
    "SELECT * FROM probe_stream",
    "EXPLAIN SELECT customer FROM probe_orders",
    "SYS COLUMNS",
    'SYS COLUMNS "probe_orders"',
    'SYS COLUMNS "odd ""name"""',
    "-- SHOW TABLES\nSELECT 1",
    "/* .security */ SELECT 1",
  ])("admits %p", (sql) => {
    expect(() => assertAgentIndexNames(sql)).not.toThrow();
  });

  // Each one answered the security index's rows, or its columns, when the superuser sent it raw on 9.1.4.
  test.each([
    'SELECT COUNT(*) AS n FROM ".security"',
    'SELECT COUNT(*) AS n FROM ".security-7"',
    'SELECT COUNT(*) AS n FROM ".sec*"',
    'SELECT COUNT(*) AS n FROM "probe_orders,.security-7"',
    'SELECT COUNT(*) AS n FROM "*,.security"',
    'SELECT COUNT(*) AS n FROM "-probe_orders,.security"',
    'SELECT COUNT(*) AS n FROM "<.security-7>"',
    'SELECT COUNT(*) AS n FROM "probe_orders, .security"',
    'SELECT COUNT(*) AS n FROM /* c */ ".security"',
    'SELECT COUNT(*) AS n FROM (SELECT * FROM ".security") s',
    'SELECT COUNT(*) AS n FROM ".logs-elasticsearch.deprecation-default"',
    'SELECT COUNT(*) AS n FROM ".ds-probe_stream-2026.11.01-000001"',
    'EXPLAIN SELECT * FROM ".security"',
    'SELECT COUNT(*) AS n FROM "remote:.security"',
    "SELECT COUNT(*) AS n FROM `.security`",
    "SELECT COUNT(*) AS n FROM probe_orders,.security",
    'SYS COLUMNS ".security"',
    'SYS COLUMNS "probe_orders,.security"',
  ])("refuses %p, a name that starts with a dot", (sql) => {
    const error = thrown(() => assertAgentIndexNames(sql));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(
      "The agent names no Elasticsearch index that starts with a dot: those are the hidden and system indices, the security index among them, which a login that may read them reads through SQL; read a data stream by its own name rather than its backing index",
    );
    expect(error.message).toBe(DOT_INDEX_REFUSAL);
  });

  // A LIKE pattern is a string, and SHOW TABLES LIKE '.sec%' answered the security index's name on 9.1.4.
  test.each([
    "SHOW TABLES",
    "SHOW TABLES LIKE '.sec%'",
    "SHOW TABLES INCLUDE FROZEN LIKE '%'",
    'SHOW COLUMNS IN "probe_orders"',
    "SHOW FUNCTIONS",
    "DESCRIBE probe_orders",
    "DESC probe_orders",
    "show tables",
    "SYS TABLES",
    "SYS COLUMNS TABLE LIKE '.sec%'",
    'SYS COLUMNS "probe_orders" "probe_shapes"',
    "SYS COLUMNS probe_orders",
    "DEBUG SELECT customer FROM probe_orders",
    "EXPLAIN SHOW TABLES LIKE '.sec%'",
  ])("refuses %p, a catalog command but the agent's own", (sql) => {
    const error = thrown(() => assertAgentIndexNames(sql));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(
      "The agent sends Elasticsearch no SHOW, DESCRIBE, SYS or DEBUG command but its own column catalog read, SYS COLUMNS for every table or for one: the others take an index pattern as a string, which the agent does not read as an index name",
    );
    expect(error.message).toBe(CATALOG_COMMAND_REFUSAL);
  });

  test("names the engine and the statement on the refusal", () => {
    const error = thrown(() => assertAgentIndexNames('SELECT 1 FROM ".security"')) as RefusedBeforeSendError;
    expect([error.provider, error.query]).toEqual(["elasticsearch", 'SELECT 1 FROM ".security"']);
  });
});
