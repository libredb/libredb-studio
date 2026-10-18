/**
 * What this provider declares before any connection (#1677 section 8).
 *
 * EVERY SURFACE A SERVER DOES NOT HAVE IS DECLARED ABSENT BY NAME, not left to a default. A panel
 * that drew an empty table where there is no table, or offered maintenance against a connection
 * that cannot write, would be lying by omission.
 */
import type { ProviderCapabilities } from "@/lib/db/types";
import { OPCUA_DEFAULT_PORT } from "./constants";
import { OPCUA_KEY_SCAN } from "./key-scan";
import { OPCUA_OBJECT_KIND_SPECS } from "./objects";

export const OPCUA_CAPABILITIES: ProviderCapabilities = Object.freeze({
  /**
   * Read-only, and structurally so: the client seam in `client.ts` names eight services and none of
   * them writes. The connection's read-only checkbox cannot turn writing on, because there is
   * nothing to turn on.
   *
   * On a plant floor this is not a nicety. Measured on the issue's first fixture, an anonymous
   * session wrote a variable with status Good and 448 of 460 methods reported UserExecutable true
   * to it, among them ResetToServerDefaults. The server will not stop a client; this does.
   */
  enforcesReadOnly: true,

  /** One JSON read request, the Kafka shape, in its own dialect so no connection falls through. */
  queryLanguage: "json",
  queryDialect: "opcua",

  defaultPort: OPCUA_DEFAULT_PORT,

  /**
   * No second page of a result.
   *
   * A value read answers one row per node named in the request, so the reader decides its size. A
   * history read is capped and says when the cap was reached. Neither has a cursor a panel could
   * resume, and a history continuation point is session state that cannot survive the request.
   */
  supportsResultPagination: false,

  /** A server has no transaction, no schema and no table. */
  supportsTransactions: false,
  declaresForeignKeys: false,
  supportsInlineRowEdit: false,
  supportsTestDataGeneration: false,
  supportsExplain: false,

  /** No external limit clause: a read request names the nodes, and a history read carries its cap. */
  supportsExternalQueryLimiting: false,

  /** Maintenance would be a write, and this provider has no code that can write to a server. */
  supportsMaintenance: false,
  maintenanceOperations: [],

  /** The endpoint URL is the whole address; there is no separate connection string to parse. */
  supportsConnectionString: false,

  /**
   * Nothing a read request does changes what the tree shows, so the refresh pattern matches nothing.
   *
   * `(?!)` rather than an empty string, because the base class's SQL pattern, compiled
   * case-insensitively, would match a read of a node named `drop` and reload the tree for it.
   */
  schemaRefreshPattern: "(?!)",

  /** No statement terminator: one request is one JSON document. */
  statementTerminator: "none",

  /** One connection is one server endpoint, so there is no container level to name. */
  containerLevels: [] as const,

  /** One object kind, `node`, which is what opens a value in a Source tab. */
  objectKinds: OPCUA_OBJECT_KIND_SPECS,

  /** A node is a node the server holds, not a grouping derived from a scan. */
  tablesAreDerivedGroupings: false,

  /** The address space, one level at a time. */
  keyScan: OPCUA_KEY_SCAN,
});
