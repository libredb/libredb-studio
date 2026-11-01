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
  CARRIAGE_RETURN_REFUSAL,
  CATALOG_COMMAND_REFUSAL,
  DOT_INDEX_REFUSAL,
  EMPTY_NAME_REFUSAL,
  UNREADABLE_REFUSAL,
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
    // A backslash is an ordinary character in both quotes, as the engine reads it, so each closes where it ends.
    "SELECT customer FROM probe_orders WHERE customer = 'x\\'",
    'SELECT "a\\" FROM probe_orders',
    'SELECT COUNT(*) AS n FROM "remote:probe_orders"',
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
    'SELECT COUNT(*) AS n FROM "*,.security*"',
    'SELECT COUNT(*) AS n FROM ".SECURITY"',
    'SELECT COUNT(*) AS n FROM ".Security-7"',
    'SELECT COUNT(*) AS n FROM "%2Esecurity"',
    'SELECT COUNT(*) AS n FROM "%2esecurity"',
    'SELECT COUNT(*) AS n FROM "\\u002Esecurity"',
    'SELECT COUNT(*) AS n FROM "docker-cluster":".security"',
    'SELECT COUNT(*) AS n FROM "x" . ".security"',
    // The engine builds the name of an empty quoted name, a `.` and a bare one as a name that starts with a dot.
    'SELECT COUNT(*) AS n FROM "".security',
    'SELECT COUNT(*) AS n FROM "" . /* c */ security',
    // A dot-led part after a qualifier: the joined name holds `..`, and the quoted part itself starts with a dot.
    'SELECT COUNT(*) AS n FROM "x".".security"',
    'SELECT COUNT(*) AS n FROM probe_orders.".security"',
    "SELECT COUNT(*) AS n FROM probe_orders..security",
    "SELECT COUNT(*) AS n FROM `x`.`.security`",
    "SELECT COUNT(*) AS n FROM probe_orders.`.security`",
    'SELECT COUNT(*) AS n FROM "x"."%2Esecurity"',
    'SELECT COUNT(*) AS n FROM "docker-cluster".".security"',
    // An empty part between two qualifiers joins to `..`.
    'SELECT COUNT(*) AS n FROM "x"."".security',
    "SELECT COUNT(*) AS n FROM ``.security",
    // A backslash closes nothing early here: the string ends at its second quote, and the dot-led name is code.
    "SELECT 'a\\' AS x FROM \".security\"",
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

  // `""` reads every open index on 9.1.4, and an empty name before a `.` would make the name after it dot-led.
  test.each(['SELECT COUNT(*) AS n FROM ""', 'SELECT 1 AS ""'])("refuses %p, an empty quoted name", (sql) => {
    const error = thrown(() => assertAgentIndexNames(sql));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(
      "The agent names nothing in Elasticsearch with an empty quoted name: the engine reads an empty index name as every open index, and an empty name before a `.` would start the name after it with a dot",
    );
    expect(error.message).toBe(EMPTY_NAME_REFUSAL);
  });

  test.each([
    'SELECT COUNT(*) AS n FROM ".security',
    "SELECT COUNT(*) AS n FROM probe_orders WHERE customer = '.security",
    'SELECT 1 /* FROM ".security"',
    'SELECT [x FROM ".security"',
  ])("refuses %p, whose quote or comment never closes", (sql) => {
    const error = thrown(() => assertAgentIndexNames(sql));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(
      "The agent sends Elasticsearch no statement whose quote or comment never closes, since where its names end cannot be read",
    );
    expect(error.message).toBe(UNREADABLE_REFUSAL);
  });

  // 9.1.4 ends a `--` comment at a lone carriage return, so the text after it is code the engine reads.
  test.each([
    'SELECT * FROM -- x\r".security-7"',
    "SELECT 1 AS a -- x\r, 2 AS b",
    'SELECT * FROM probe_orders -- x\r\t".security"',
  ])("refuses %p, a carriage return inside a -- comment with more text after it", (sql) => {
    const error = thrown(() => assertAgentIndexNames(sql));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(
      "The agent sends Elasticsearch no statement with a carriage return inside a -- comment and more text after it: the engine ends the comment there, so the text after it is code; end a comment with a line feed",
    );
    expect(error.message).toBe(CARRIAGE_RETURN_REFUSAL);
  });

  test.each(["-- x\r\nSELECT 1", "SELECT 1 -- x\r", "SELECT 1 /* x\r */ AS a", "SELECT 'x\r' AS a"])(
    "admits %p, whose carriage return ends no comment early",
    (sql) => {
      expect(() => assertAgentIndexNames(sql)).not.toThrow();
    },
  );

  test("names the engine and the statement on the refusal", () => {
    const error = thrown(() => assertAgentIndexNames('SELECT 1 FROM ".security"')) as RefusedBeforeSendError;
    expect([error.provider, error.query]).toEqual(["elasticsearch", 'SELECT 1 FROM ".security"']);
  });
});
