/**
 * The OPC UA provider's labels (#1677).
 *
 * Pure, and shipped to the browser: `getLabels()` answers before any connection. Every sentence
 * that names something the panel cannot do says why in the same breath, because a disabled control
 * with no reason reads as a defect.
 */
import type { ProviderLabels } from "@/lib/db/types";

/**
 * What a statement is on this engine, in the words plan mode drafts by: the console's read request. Plan mode drafts
 * for the editor, so it names the console's two shapes; the browse is agent mode's own and is never drafted. The
 * withheld nodes are named so a plan never drafts a read of them.
 */
const OPCUA_STATEMENT_LANGUAGE =
  'one OPC UA read request this editor runs, a JSON object: {"read": ["ns=3;s=SlowUInt1", ...]} for the current value of each node, or {"history": "ns=3;s=HistorianInt32", "start": "2026-10-31T00:00:00Z", "end": "2026-10-31T01:00:00Z", "limit": 100} for one node\'s raw history (start, end and limit optional); a node id is written with its namespace index (ns=3;s=...) or in namespace 0 with no prefix (i=2256); there is no write and no method call, and Server.ServerConfiguration (i=12637), RoleSet (i=15606), the session diagnostics (i=3706, i=3707, i=3708) and the PubSub security groups and key push targets (i=15443, i=25440) are never drafted, since agent mode withholds them';

/** A server has nodes, and a Variable node is the row. There is no table and no schema to name. */
export const OPCUA_LABELS: ProviderLabels = Object.freeze({
  statementLanguage: OPCUA_STATEMENT_LANGUAGE,
  entityName: "Node",
  entityNamePlural: "Nodes",
  rowName: "Value",
  rowNamePlural: "Values",
  selectAction: "Read",
  generateAction: "Not available",
  analyzeAction: "Not available",
  vacuumAction: "Not available",
  searchPlaceholder: "Filter nodes",
  analyzeGlobalLabel: "Not available",
  analyzeGlobalTitle: "An OPC UA server publishes no statistics to collect",
  analyzeGlobalDesc:
    "A server's address space is a node tree, not a catalogue with statistics. What this connection " +
    "knows is what a Browse and a Read answered, and nothing more.",
  vacuumGlobalLabel: "Not available",
  vacuumGlobalTitle: "This connection writes nothing",
  vacuumGlobalDesc:
    "Maintenance would be a write, and this provider has no code that can write to a server: its " +
    "client exposes GetEndpoints, CreateSession, ActivateSession, Browse, BrowseNext, Read, " +
    "HistoryRead and CloseSession, and nothing else.",
  /*
   * WHY THE TWO MONITORING PANELS ARE EMPTY, in this engine's own terms (#518). Both default to a
   * sentence written for a SQL server, and a browser pass found what that means here: the Queries
   * panel told an OPC UA reader to install `pg_stat_statements`, a PostgreSQL extension, and the
   * Sessions panel said "No active sessions found." against a server that was holding this very
   * session. Ten other providers set these two keys; this one had skipped them.
   */
  slowQueriesEmptyState:
    "An OPC UA server answers services rather than queries, so it keeps no query log and has no slow " +
    "queries to report.",
  sessionsEmptyState:
    "An OPC UA server publishes a session COUNT (`CurrentSessionCount`) rather than a session list, and " +
    "not every server answers even that, so no session table can be read from it.",
});

/**
 * Why the Tables, Indexes and Storage panels have nothing to draw, in this engine's own terms.
 *
 * Those three have no label of their own to fall back on, so the provider REJECTS their reads and
 * this sentence travels as the rejection: `base-provider.ts` settles each panel separately and the
 * dashboard draws a refused one with the engine's words. An empty array there was drawn as a
 * measurement instead - "0 tables, 0 rows, 0 B" and "No tables found." against a server whose own
 * tree lists nine root folders, found by looking at the panel in a browser.
 */
export const OPCUA_NO_TABLE_STATISTICS =
  "An OPC UA server holds an address space of nodes rather than tables, and publishes no table, index " +
  "or size statistics: there is nothing here to measure. The nodes themselves are in the Keys panel.";

/**
 * The sentence the Objects tree shows instead of listing nodes.
 *
 * The Keys panel lists them, one level at a time, because the address space is deeper than the
 * object tree's container levels: measured at depth 7 on the documented fixture and larger again on
 * more on another.
 */
export const OPCUA_NODES_LISTED_ELSEWHERE =
  "Nodes are listed in the Keys panel, one level at a time, which is the only surface that browses them.";

/**
 * What a Method node's SOURCE DOCUMENT says, which is where a reader meets it.
 *
 * METHODS ARE LISTED AND NEVER CALLED (O-S1), and the node says so rather than leaving a reader to
 * wonder. On the first fixture 448 of 460 method nodes reported UserExecutable true to an anonymous
 * session, among them ResetToServerDefaults; on a plant floor a call is an actuation.
 *
 * It was called a ROW note and it is not one: the Keys panel draws a row from a key and its type,
 * and there is nowhere on that row for a sentence. The note is in the document the row OPENS, which
 * is the only surface this provider writes prose to, and the name says so now.
 */
/*
 * A METHOD HAS NO VALUE ATTRIBUTE EITHER, and this sentence used to leave that out: the document
 * said what a Method is, and then showed `BadAttributeIdInvalid` with nothing explaining it, which
 * is the exact thing `opcuaNoValueNote` exists to stop. Measured in a browser on
 * `Server/GetMonitoredItems`, one row below an Object that DID get the explanation.
 */
export const OPCUA_METHOD_NOTE =
  "A method: never called by this provider, and with no Value attribute, so BadAttributeIdInvalid is expected.";

/**
 * What a node with NO VALUE ATTRIBUTE says in its Source document, and why it needs saying.
 *
 * AN OBJECT HAS NO VALUE ATTRIBUTE AT ALL (Part 3 5.5.1), so a Read of one answers
 * `BadAttributeIdInvalid` - and that status, shown with no explanation, reads as a failed read of a
 * node that does have a value. Measured on the documented fixture: the Keys panel's FIRST page
 * holds `Locations` and `NetworkSet`, both Objects with no children, and clicking either answered a
 * document whose `statusCode` was `BadAttributeIdInvalid` and nothing else.
 *
 * The row stays a key, because the alternative is worse: drawn as a folder it would open empty, and
 * drawn as neither it would vanish from the tree. So it opens, and says what it is.
 */
export function opcuaNoValueNote(nodeClass: string): string {
  /*
   * ONE SHORT TRUE SENTENCE, and the first version of it was neither.
   *
   * IT WAS CUT OFF. The document is JSON in an editor that does not wrap, so a 205-character note
   * ran off the right edge at about 110 characters - measured in a browser on `Locations` - and the
   * reader never reached the half that explained the status.
   *
   * AND ITS LAST CLAUSE WAS FALSE. It ended "what this node has is its children, listed in the Keys
   * panel", on the two nodes this rule was measured against: `Locations` and `NetworkSet` are drawn
   * with no twisty and list NOTHING under them. A node's children are on screen in the panel when it
   * has any, so the sentence said nothing true and nothing needed.
   *
   * The class leads it in the server's own spelling, which keeps it true for every class and keeps
   * the article out of it: "Object has no Value attribute".
   */
  return `${nodeClass} has no Value attribute, so the BadAttributeIdInvalid below is expected, not a failed read.`;
}
