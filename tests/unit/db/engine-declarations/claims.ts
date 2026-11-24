/**
 * The claims of an engine declaration outside its `policy` and `mcp` segments, as dotted members: the members of the
 * connection, facets, agent and SQL text segments docs/providers/CONTRACT.md, clause M-53, names as claims.
 *
 * Every member of the schema's `policyClaims` and `mcpClaims` is a claim too, and is read from the schema where it is
 * needed. The census (tests/unit/db/engine-declarations.test.ts) holds this list equal to the members its
 * `SEGMENT_CLAIM_RECORDS` reads back, so a claim the census gains or loses moves this list with it, and the closed
 * list of declaration readers (tests/unit/db/engine-declaration-readers.test.ts) refuses a reader of any of them.
 */
export const SEGMENT_CLAIMS: readonly string[] = Object.freeze([
  "connection.opensLocalFile",
  "connection.hostPathFields",
  "connection.serverLevelWithoutDatabase",
  "connection.sshTunnel",
  "connection.agentCredential",
  "agent.statementLanguage",
  "facets.agentReadings",
  "sqlText.redaction",
  "agent.overlay.dialect.catalogRead.commandShaped",
]);
