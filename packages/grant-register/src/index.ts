/**
 * The grant register: LibreDB's reviewed rows that grant an engine's claims (docs/providers/CONTRACT.md, clauses
 * M-54 and M-84), its schema (`./register.schema.json`) and its reader.
 *
 * A row is keyed by the engine and exactly one of:
 * - `package`: a package's name, version and digest, in the forms of Studio's providers lock, so a new version or
 *   digest of a package has no row until LibreDB reviews it;
 * - `legacy`: the legacy key, `LEGACY_KEY`, `@libredb/studio`, the source name of Studio's legacy adapter, for an engine
 *   Studio still serves through that adapter. A legacy row describes Studio's own code, not a package, and is deleted as
 *   its engine moves into a package of its own.
 *
 * A row's `grants` holds one member per claim, each in its claim's vocabulary, and every member is required, so no
 * grant is left out by omission; its optional `reasons` holds LibreDB's review note for a member, by member name. The
 * rows are hand-reviewed data, written once and edited by review, never projected from a declaration.
 *
 * The reader validates the register against its schema when it reads it (src/schema-subset.ts, which compiles no code,
 * so it runs in the browser and the VS Code webview as on the server), then refuses two code rules:
 * - `duplicate-key`: two rows with one key, two legacy rows of one engine, or two package rows of one name, version,
 *   digest and engine;
 * - `legacy-engine-not-served`: a legacy row of an engine the legacy adapter does not serve. The served set is the
 *   caller's, since this package imports nothing of Studio's.
 * Every refusal of one read is reported together in one error, one line each, `<rule> at <JSON Pointer>: <sentence>`,
 * naming no value of the register beyond a key's name. The code rules are read only once the schema admits the
 * register.
 *
 * A read answers each row deep-frozen for its key, or null where the register holds none; the value read is copied,
 * never frozen in the caller's hands.
 */
import committed from "./register.json";
import schema from "./register.schema.json";
import { schemaRefusals, where } from "./schema-subset";

/** The key of a legacy row: the source name of Studio's legacy adapter. */
export const LEGACY_KEY = "@libredb/studio";

/**
 * A statement language agent mode may send an engine: the schema's `statementLanguage` enum but its null, held equal
 * to it by tests/types.test.ts.
 */
export type RegisterStatementLanguage =
  | "sql"
  | "kubectl"
  | "mongo"
  | "libredbkv"
  | "influxql"
  | "weaviateapi"
  | "qdrantapi"
  | "cypher"
  | "milvusrpc"
  | "rediscli"
  | "etcdctl"
  | "oxiacli"
  | "rabbitread"
  | "kafkaread"
  | "s3api"
  | "fsquery"
  | "snmpget"
  | "netconfrpc"
  | "modbusread"
  | "promql"
  | "opcuaread"
  | "mtconnectread"
  | "mqttread"
  | "sparkplugread";

/**
 * A curated operational reading agent mode may be offered on an engine: the schema's `agentReadings` item enum, held
 * equal to it by tests/types.test.ts.
 */
export type RegisterAgentReading = "sessions" | "slow-queries" | "table-stats" | "index-stats" | "storage" | "health";

/**
 * What a row grants: the schema's `grants`, one member per claim. tests/types.test.ts holds every member and its
 * vocabulary equal to the schema's, so a member added, removed or retyped on one side only fails the typecheck or that
 * test.
 */
export interface RegisterGrants {
  readonly writeReach: "open" | "guarded" | "none";
  readonly readsFileAccessPosture: boolean;
  readonly deniedFileAccessRefusal: string | null;
  readonly singleWriterFile: boolean;
  readonly readRootsRequired: boolean;
  readonly agentCredentialForm: "token" | "service-account-key" | "dedicated-user" | "none" | null;
  readonly maskingExemptColumns: { readonly column: string; readonly reason: string } | null;
  readonly exposable: boolean;
  readonly statementRead: boolean;
  readonly metadataReadChangesState: boolean;
  readonly agentCredentialRequired: boolean;
  readonly opensLocalFile: boolean;
  readonly hostPathFields: readonly ("clientCertificatePath" | "clientPrivateKeyPath")[];
  readonly serverLevelWithoutDatabase: boolean;
  readonly sshTunnel: string | null;
  readonly agentCredential: {
    readonly form: "pair" | "dedicated-pair" | "secret";
    readonly supersededBy: readonly string[];
  } | null;
  readonly statementLanguage: RegisterStatementLanguage | null;
  readonly agentReadings: readonly RegisterAgentReading[];
  readonly servesOneSession: string | null;
  readonly agentExecution: boolean;
  readonly ownWords: "scrubbed" | "code-only";
}

/** A package's key: its name, version and digest, in the providers lock's forms. */
export interface RegisterPackage {
  readonly name: string;
  readonly version: string;
  readonly digest: string;
}

/** The key of one row. */
export type RegisterKey =
  | { readonly legacy: typeof LEGACY_KEY; readonly engine: string }
  | { readonly package: RegisterPackage; readonly engine: string };

/** One row of the register, as the reader answers it. */
export type RegisterRow = RegisterKey & {
  readonly grants: RegisterGrants;
  readonly reasons?: Readonly<Partial<Record<keyof RegisterGrants, string>>>;
};

/** A register read and admitted. */
export interface GrantRegister {
  /** The row of `key`, deep-frozen, or null where the register holds none. */
  rowFor(key: RegisterKey): RegisterRow | null;
}

/** The text a key is indexed by: one form per key kind, so a legacy row and a package row never share one. */
function keyText(key: RegisterKey): string {
  return "legacy" in key
    ? JSON.stringify(["legacy", key.engine])
    : JSON.stringify(["package", key.package.name, key.package.version, key.package.digest, key.engine]);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Reads `value` as a grant register, with `legacyEngines` the engines Studio's legacy adapter serves.
 *
 * @throws {Error} Listing every refusal of the register, one line each, naming its rule and JSON Pointer; or listing
 * every problem of the schema itself, when it uses a keyword the reader does not read.
 */
export function parseGrantRegister(value: unknown, legacyEngines: readonly string[]): GrantRegister {
  const lines = schemaRefusals(schema, value).map(
    ({ rule, pointer, sentence }) => `${rule} at ${where(pointer)}: ${sentence}`,
  );
  const rows = lines.length === 0 ? deepFreeze(structuredClone(value) as RegisterRow[]) : [];
  const byKey = new Map<string, number>();
  rows.forEach((row, index) => {
    const text = keyText(row);
    const earlier = byKey.get(text);
    if (earlier !== undefined)
      lines.push(`duplicate-key at /${index}: the row repeats the key of the row at /${earlier}`);
    else byKey.set(text, index);
    if ("legacy" in row && !legacyEngines.includes(row.engine)) {
      lines.push(`legacy-engine-not-served at /${index}/engine: the legacy adapter serves no engine of this id`);
    }
  });
  if (lines.length > 0) throw new Error(["The grant register is refused:", ...lines].join("\n"));
  return {
    rowFor(key) {
      const index = byKey.get(keyText(key));
      return index === undefined ? null : (rows[index] as RegisterRow);
    },
  };
}

/** Reads the committed register, `./register.json`, through `parseGrantRegister`. */
export function readGrantRegister(legacyEngines: readonly string[]): GrantRegister {
  return parseGrantRegister(committed, legacyEngines);
}
