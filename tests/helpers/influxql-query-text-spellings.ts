/**
 * Every spelling of SHOW QUERIES and SHOW CONTINUOUS QUERIES an InfluxQL agent read is held to refusing before
 * anything is sent: case, whitespace, quoting, a trailing terminator, a second statement and the forms that wrap one.
 * On 1.13.1 a user granted READ on one database is answered SHOW QUERIES with every running statement on the server
 * and SHOW CONTINUOUS QUERIES with the text an administrator wrote, so each entry is replayed through the agent's
 * reader in tests/unit/db/influxdb/influxql-agent-statement.test.ts and, live, through MCP and raw to the server by
 * tests/live/influxdb-mcp-boundary.ts, which records what the server answered each.
 */
export const INFLUXQL_QUERY_TEXT_SPELLINGS: readonly string[] = [
  "SHOW QUERIES",
  "show queries",
  "Show Queries",
  "sHoW qUeRiEs",
  "SHOW  QUERIES",
  "SHOW\tQUERIES",
  "SHOW\nQUERIES",
  "  SHOW QUERIES  ",
  "\nSHOW QUERIES\n",
  "SHOW QUERIES;",
  "SHOW QUERIES ;",
  "SHOW QUERIES;;",
  'SHOW "QUERIES"',
  "SHOW QUERIES LIMIT 1",
  "SHOW QUERIES",
  "SHOW CONTINUOUS QUERIES",
  "show continuous queries",
  "Show Continuous Queries",
  "SHOW CONTINUOUS  QUERIES",
  "SHOW\tCONTINUOUS\tQUERIES",
  "SHOW\nCONTINUOUS\nQUERIES",
  "SHOW CONTINUOUS QUERIES;",
  'SHOW "CONTINUOUS" QUERIES',
  'SHOW CONTINUOUS "QUERIES"',
  "SHOW MEASUREMENTS; SHOW QUERIES",
  "SHOW MEASUREMENTS;SHOW CONTINUOUS QUERIES",
  "SHOW MEASUREMENTS\nSHOW QUERIES",
  "SELECT * FROM home; SHOW QUERIES",
  "EXPLAIN SHOW QUERIES",
  "EXPLAIN ANALYZE SHOW CONTINUOUS QUERIES",
  "SELECT * FROM (SHOW QUERIES)",
  "SHOW QUERIES\r",
  "SHOW\rQUERIES",
  "SHOW QUERIES -- c",
  "SHOW /* c */ QUERIES",
  "/* c */ SHOW CONTINUOUS QUERIES",
];
