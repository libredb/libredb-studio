/**
 * The InfluxQL language's MCP facet: `run_influxql_read`, one InfluxQL statement read and admitted by the agent's own
 * InfluxQL adapter and run through the provider's `queryReadOnly`.
 *
 * The boundary is the agent's: the principal is proved read-only by the server before every statement, and an answer
 * in the shape of SHOW QUERIES or SHOW CONTINUOUS QUERIES is refused from its columns alone, so other principals'
 * statement text never reaches the client even if a spelling got past the reader.
 *
 * No `database` key: an InfluxDB connection reads the database it is bound to and declares no `catalogSessions`, so
 * `providerInDatabase` would refuse every call that named one; a statement names another database it may read as
 * `"db".."measurement"`, as the agent's own InfluxQL tool does.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const INFLUXQL_MCP_FACET = Object.freeze({
  tool: "run_influxql_read",
  title: "Run a read-only InfluxQL statement",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only InfluxQL statement against a connection's database: a SELECT, a SHOW of the catalog (DATABASES, RETENTION POLICIES, MEASUREMENTS, SERIES, TAG KEYS, TAG VALUES, FIELD KEYS, or one of their CARDINALITY forms) or an EXPLAIN of a SELECT, such as "SELECT mean(temp) FROM home WHERE time > now() - 1h GROUP BY time(10m)". One statement, with no comment. Double-quote a name and single-quote a string; name a measurement of another database the connection may read as "db".."home". INTO, every write, SHOW QUERIES, SHOW CONTINUOUS QUERIES, SHOW USERS and the server's other administration reads are refused before the database is reached, and an answer in the shape of SHOW QUERIES or SHOW CONTINUOUS QUERIES is refused whatever was sent. Before every statement the server must refuse the connection's principal an administrator's read and a no-op write on every database it lists, so an administrator, a principal that writes and a server with authentication off are refused. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so bound every SELECT by time and page inside the statement with LIMIT and OFFSET, which count per series.`,
  words: {
    fewerFields: "Select fewer fields",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, add OFFSET ${shown} to the statement, or narrow its time range, since LIMIT and OFFSET count per series.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Select fewer or narrower fields, and run it again.",
    reached: "the database",
  },
} as const satisfies AgentLanguageMcpFacet);
