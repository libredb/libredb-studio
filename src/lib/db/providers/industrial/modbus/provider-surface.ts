/**
 * What this provider declares about itself.
 *
 * WHY THE TYPES HERE ARE LOCAL ALIASES. The real declarations live in shared files that one
 * provider's change may not widen on its own: the `DatabaseType` union, the seven exhaustive
 * records of `compatibility.ts`, the dialect registries and the connection form. 28 records in 18
 * files are compiler forced across the repository, and the order in which providers touch them is
 * not this provider's to choose. So the shape is declared here, with local aliases, and the shared
 * records take their line when the order says so. Nothing in this file imports from `@/lib`.
 *
 * Each `false` below is a claim, not a default, and the ones that matter carry their reason.
 */

export type LocalObjectRole = "relation" | "routine" | "group" | "attached" | "config";

export interface LocalContainerLevel {
  readonly id: string;
  readonly label: string;
  readonly labelPlural: string;
}

export interface SurfaceDeclaration {
  readonly typeId: "modbus";
  readonly defaultPort: number;
  readonly securePort: number;
  readonly queryLanguage: "json";
  readonly queryDialect: "modbus";
  readonly containerLevels: readonly LocalContainerLevel[];
  readonly pointRole: LocalObjectRole;
  readonly enforcesReadOnly: true;
  readonly mcpExposable: false;
  readonly agentExecute: false;
  readonly supportsExplain: false;
  readonly supportsCreateTable: false;
  readonly supportsInlineRowEdit: false;
  readonly supportsTransactions: false;
  readonly supportsResultPagination: false;
  readonly supportsMaintenance: false;
  readonly supportsConnectionString: false;
  readonly keyScan: false;
  readonly numberMaxOfClientTransaction: 1;
}

export const MODBUS_SURFACE: SurfaceDeclaration = Object.freeze({
  typeId: "modbus",
  defaultPort: 502,
  securePort: 802,
  queryLanguage: "json",
  queryDialect: "modbus",
  /** One level, and it is not discovered: the units are the ones the map names. */
  containerLevels: Object.freeze([{ id: "schema", label: "Unit", labelPlural: "Units" }]),
  /**
   * A point is read and a read returns rows, so `relation`. `config` was the other candidate and
   * describes an object defined by text or JSON; the map defines a point in JSON, but what the user
   * does with it in the tree is read it. `attached` is the near miss, rejected because a point's
   * owner is a unit id, a number on the wire, not an object in the tree.
   */
  pointRole: "relation",
  /** The guarantee is this provider's own encoder and valve. The device enforces nothing. */
  enforcesReadOnly: true,
  mcpExposable: false,
  agentExecute: false,
  supportsExplain: false,
  supportsCreateTable: false,
  supportsInlineRowEdit: false,
  supportsTransactions: false,
  supportsResultPagination: false,
  supportsMaintenance: false,
  /** There is no connection string form for Modbus TCP, and inventing one would be ours not theirs. */
  supportsConnectionString: false,
  /** No kind is enumerated by the Keys panel, so there is no key scan to declare. */
  keyScan: false,
  /** TCP 4.4.1.2 requires a client to publish this. Ours is one, and the documentation says so. */
  numberMaxOfClientTransaction: 1,
});

/** What the form says under the read only hint, which a documentation test pins to this constant. */
export const READ_ONLY_HINT =
  "Studio cannot write to a Modbus device: it builds four read requests and the identification request, and nothing else. The device enforces nothing of its own, so anything else that reaches its port can write to it. Protection is mbaps or a network path you control.";

export const NO_REVOCATION_SENTENCE =
  "Over MODBUS/TCP Security, Studio checks the device's certificate chain and host name but does not check revocation. Measured on 13 October 2026: a stapled OCSP response saying revoked still completes the connection under Node, and under Bun it never reaches the application.";
