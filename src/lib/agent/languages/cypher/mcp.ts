/**
 * The Cypher language's MCP facet: `run_cypher_read`, one Cypher statement read and admitted by the agent's own reader.
 *
 * The MCP module acquires the connection under the agent read-only profile and runs the statement through the
 * provider's `queryReadOnly`, so the boundary is agent mode's: on Neo4j Enterprise Edition, the seed's own user,
 * proved read-only by the server before every statement, and the server's classification of every statement.
 *
 * No `database` key: a Neo4j connection reads one database and declares no `catalogSessions`, so `providerInDatabase`
 * would refuse every call that named one, as the agent's own Cypher tool leaves it out.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const CYPHER_MCP_FACET = Object.freeze({
  tool: "run_cypher_read",
  title: "Run a read-only Cypher statement",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  // Labels and relationship types are relations, so inspect_schema lists them.
  holdsNoTables: false,
  describe: ({ engines, limits }) =>
    `Run one read-only Cypher statement on a connection's database: a MATCH ... RETURN, the SHOW forms of indexes, constraints, procedures and functions, or a CALL of db.labels, db.relationshipTypes, db.propertyKeys, db.schema.visualization, db.schema.nodeTypeProperties, db.schema.relTypeProperties, db.ping or dbms.components, such as "MATCH (p:Person)-[:KNOWS]->(f) RETURN p.name, count(f) AS friends ORDER BY friends DESC LIMIT 20". Writes, LOAD CSV, USE, other procedures, APOC, parameters, comments and a second statement are refused before the database is reached, and so are the SHOW DATABASE forms, which the server classifies as administration. It runs only on Neo4j Enterprise Edition, as a user the server proves before every statement to read only: an administrator, a user that writes or may LOAD, a server with an extension the user can run, and Community Edition are refused. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so page inside the statement with ORDER BY, SKIP and LIMIT.`,
  words: {
    fewerFields: "Return fewer or smaller properties",
    readPast: (shown: number) =>
      `read past the ${shown} rows returned, ORDER BY a unique property and add SKIP ${shown} before the LIMIT.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Return fewer or smaller properties instead of whole nodes, and run it again.",
    reached: "the database",
  },
} as const satisfies AgentLanguageMcpFacet);
