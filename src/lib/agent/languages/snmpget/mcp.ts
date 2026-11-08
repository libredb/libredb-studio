/**
 * The snmpget command language's MCP facet: `run_snmp_read`, one of the SNMP console's four commands, read and admitted
 * by the agent's own SNMP reader.
 *
 * The MCP module runs it through the provider's `queryReadOnly` under the agent read-only profile, so a call reads what
 * an agent read reads: one Get, GetNext or GetBulk exchange of the agent's client, behind the valve that refuses every
 * other PDU, answered with the device's values as the console renders them. Every withheld subtree is decided on the
 * answer, by the prefix of every identifier the agent sent back, as an agent read decides it: an identifier inside one
 * is never sent, a next that lands inside one is answered withheld, and a walk or table steps over every one its
 * subtree contains. The answer carries the provider's warnings as its notes, since each is Studio's own sentence naming
 * a withheld subtree and why, and a walk that stepped over one would otherwise read as the device's whole subtree.
 *
 * A v2c community is no principal: an SNMP seed takes no agent credential, and what the community reaches is the
 * agent's own view (VACM), which the client cannot read, since the access control tables are among the withheld
 * subtrees. So the boundary is the agent's view and Studio's withheld set together.
 *
 * No `database` key: one connection is one agent, and SNMP declares no `catalogSessions`. A conceptual table and a group
 * of scalars are relation kinds, so the facet holds tables, and inspect_schema lists the bundled catalog's tables and
 * scalar groups, which sends nothing, without the ones inside a withheld subtree.
 */
import { z } from "zod";
import type { AgentLanguageMcpFacet } from "../mcp";

export const SNMPGET_MCP_FACET = Object.freeze({
  tool: "run_snmp_read",
  title: "Run a read-only SNMP read",
  statementInput: z.string().min(1, "statement cannot be empty"),
  takesDatabase: false,
  strictInput: true,
  paging: "none",
  fence: "language-admission",
  holdsNoTables: false,
  answersWarnings: true,
  describe: ({ engines, limits }) =>
    `Run one read-only SNMP read on a connection: one console command on one line, get OID [OID ...], next OID [OID ...], walk SUBTREE or table ENTRY (table ifEntry), each OID numeric (1.3.6.1.2.1.1.1.0) or a name the bundled MIB modules define (sysDescr.0, ifDescr). It answers the device's values as the console renders them. Withheld are the SNMP security, target and transport security modules (1.3.6.1.6.3.12 to .16 and .18, 1.3.6.1.2.1.189, .190 and .198, 1.3.6.1.3.101), Net-SNMP's access control extension (1.3.6.1.4.1.8072.1.9), the running processes (hrSWRun, 1.3.6.1.2.1.25.4), the commands the agent runs and what they print (1.3.6.1.4.1.8072.1.3, 1.3.6.1.4.1.2021.8 and 1.3.6.1.4.1.2021.2.1.103) and Cisco's copy tables (1.3.6.1.4.1.9.9.96 and 1.3.6.1.4.1.9.9.10.1.2.1): an object inside one is answered as a row typed withheld with no value and never asked for, a walk steps over every one it covers, a walk inside one is refused, and the answer's notes name each and why. A set, a trap, Net-SNMP's tool syntax and every other command are refused before the agent is reached. The community is no principal: the agent's own view decides what it reaches, and Studio withholds the subtrees listed here whatever that view grants. inspect_schema lists the bundled MIB modules' tables and scalar groups, none inside a withheld subtree. Runs on ${engines}; other engines refuse it. ${limits}; this tool takes no offset, so walk a narrower subtree, or name the instances with get.`,
  words: {
    fewerFields: "Walk one column, or name the instances with get,",
    readPast: (shown: number, cut: "max_rows" | "result_bytes") =>
      `read past the ${shown} row${shown === 1 ? "" : "s"} returned, ${cut === "max_rows" ? "raise max_rows (at most 500), or " : ""}walk a narrower subtree, since an SNMP read is never paged.`,
    rowOverCap:
      "One row of this result is larger than the 32 KiB result limit. Name that instance alone with get, and run it again.",
    reached: "the agent",
  },
} as const satisfies AgentLanguageMcpFacet);
