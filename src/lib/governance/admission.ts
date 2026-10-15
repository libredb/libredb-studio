/**
 * Row admission under governance (spec 7.7): which rows of the governance source's `connections_v1` become
 * connections Studio serves.
 *
 * A control plane publishes each connection as a row of non-secret columns and sealed credentials. Studio checks every
 * row, in order, and leaves out with a skip code each row it cannot serve as written, instead of failing the whole
 * snapshot over one bad row:
 *
 * 1. `connection_id` has the published format, and no other row has the same id. Every row of a repeated id is
 *    skipped, because Studio cannot tell which one the control plane meant.
 * 2. The engine is a Studio type id that opens no file on Studio's host (`OPENS_LOCAL_FILE`), and
 *    `GOVERNANCE_ALLOWED_ENGINES` names it.
 * 3. An engine whose provider reaches the whole server without a database (`OPENS_SERVER_LEVEL_WITHOUT_DATABASE`) has
 *    one, because a server-level connection opens a session to every database its credential reaches.
 * 4. The definition holds only keys of the contract's allowlist, each with a value in its domain: `DEFINITION_ALLOWLIST`,
 *    which the manifest publishes, so a control plane that builds its connection form from it never writes a row
 *    Studio skips. A credential in the definition is told apart from any other key, because it belongs in an envelope.
 * 5. The read envelope opens, and the record merged from the row and its credentials (spec 8.3) passes
 *    `SeedConnectionSchema.strict()`, Studio's own validation of a configured connection.
 * 6. A write envelope, when the row has one, opens and merges the same way; when it does not, the row is kept with read
 *    access only.
 *
 * A skip names the row, the credential level and the field it is about, and never a value. An item at the write level
 * keeps its row with read access only; every other item means the row was skipped. An admitted record carries the
 * server-only marker `literal: true`, so a `${NAME}` or Vault reference in a value the control plane set stays text and
 * is never resolved against Studio's environment or Vault.
 *
 * Nothing here reads the environment or a keyring: the caller passes the engines `GOVERNANCE_ALLOWED_ENGINES` names and
 * the function that opens an envelope, which is `openGovernedSecret` in the snapshot loader.
 */
import type { z } from "zod";
import {
  MCP_EXPOSABLE,
  OPENS_LOCAL_FILE,
  OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  SHIPPED_DATABASE_TYPES,
} from "@/lib/db/compatibility";
import { filterByRoles } from "@/lib/seed/connection-filter";
import { type ManagedConnection, SeedConnectionSchema } from "@/lib/seed/types";
import type { DatabaseType } from "@/lib/types";
import { DEFINITION_ALLOWLIST, PLAINTEXT_KEYS, type SkippedItemSchema, type SNAPSHOT_READS } from "./contract";
import type { EnvelopeCode } from "./hpke";
import { type OpenedSecret, SealedSecretError, type SecretBinding } from "./lsb1";

/** The columns the snapshot reads from `connections_v1` (spec 7.4). */
type ConnectionColumn = Extract<
  (typeof SNAPSHOT_READS)[number],
  { readonly object: "connections_v1" }
>["columns"][number];

/** A row of `connections_v1` as the governance source returned it: every column the snapshot reads, none trusted yet. */
export type ConnectionRow = Readonly<Record<ConnectionColumn, unknown>>;

/** One item of the heartbeat's `skipped` column, in the shape the manifest publishes. */
export type SkippedItem = z.infer<typeof SkippedItemSchema>;

type SkipCode = SkippedItem["code"];
type Level = SecretBinding["level"];

export interface AdmissionOptions {
  /** The connection type ids `GOVERNANCE_ALLOWED_ENGINES` names. */
  readonly allowedEngines: readonly string[];
  /**
   * Opens an envelope for its binding and returns the credential set it carries: `openGovernedSecret` in the loader.
   * A SealedSecretError leaves that level unopenable. Any other error is no row's fault, such as a keyring that does
   * not load, so admission throws it and the load fails instead of skipping every row.
   */
  readonly openSecret: (envelope: string, binding: SecretBinding) => OpenedSecret;
}

/** A connection Studio serves, with a record for each credential level admission could build. */
export interface AdmittedConnection {
  /** The row's `connection_id`. Its records carry it as `seed:<id>`, the namespace every connection route resolves. */
  readonly id: string;
  /** The record with the read credential. */
  readonly read: ManagedConnection;
  /** The record with the write credential, when the row has a write envelope that opened and merged. */
  readonly write?: ManagedConnection;
  /**
   * The envelope each record was opened from, as the governance source returned it. A reload that reads another one
   * for a level knows that the control plane sealed that credential again (spec 7.4), as it must when the credential
   * or the definition changes (spec 8.4), and tears down the providers opened with the old one (`grant-diff.ts`).
   * Sealed, so it reveals nothing, and like the records it is never logged or reported.
   */
  readonly envelopes: { readonly read: string; readonly write?: string };
}

/** A row, or a row's write level, that admission left out. */
export interface AdmissionSkip {
  /** What the heartbeat and Studio's admin status report: ids, level, path and code, never a value. */
  readonly item: SkippedItem;
  /**
   * The code the envelope failed with, for READ_SECRET_UNOPENABLE and WRITE_SECRET_UNOPENABLE. The heartbeat item has no
   * field for it, so Studio's admin status and log line carry it instead.
   */
  readonly envelopeCode?: EnvelopeCode;
}

export interface AdmissionResult {
  /** The admitted connections, in row order. */
  readonly admitted: readonly AdmittedConnection[];
  /** The skips, in row order, at most one for each row. */
  readonly skipped: readonly AdmissionSkip[];
}

/** The format of `connection_id`, the rule the contract publishes for the column (spec 7.2). */
const CONNECTION_ID = /^[a-z0-9-]{1,64}$/;

const KNOWN_ENGINES: ReadonlySet<string> = new Set(SHIPPED_DATABASE_TYPES);

const isDatabaseType = (engine: string): engine is DatabaseType => KNOWN_ENGINES.has(engine);

/**
 * A definition path by its segments, as a lookup key. A key that holds a dot is one segment, so a top-level key named
 * `ssl.mode` never passes for the `mode` of the `ssl` object.
 */
const pathKey = (segments: readonly string[]): string => JSON.stringify(segments);

type DefinitionDomain = (typeof DEFINITION_ALLOWLIST)[number]["domain"];

/** Each allowlisted definition path with the domain of its values. */
const DOMAINS: ReadonlyMap<string, DefinitionDomain> = new Map(
  DEFINITION_ALLOWLIST.map(({ path, domain }) => [pathKey(path.split(".")), domain]),
);

/** The objects an allowlisted path reaches into, such as `ssl` for `ssl.mode`. */
const NESTED: ReadonlySet<string> = new Set(
  DEFINITION_ALLOWLIST.flatMap(({ path }) => {
    const segments = path.split(".");
    return segments.slice(1).map((_, index) => pathKey(segments.slice(0, index + 1)));
  }),
);

/**
 * The definition paths that hold a credential: the plaintext keys of spec 8.3, the agent's credential pair, an SSH
 * tunnel and a TLS client key. A credential belongs in an envelope, so one in a definition is DEFINITION_HAS_SECRET,
 * which tells the operator more than an unknown key would.
 */
const SECRET_PATHS: ReadonlySet<string> = new Set(
  [...PLAINTEXT_KEYS, "agentUser", "agentPassword", "sshTunnel", "ssl.clientKey"].map((path) =>
    pathKey(path.split(".")),
  ),
);

/** A merged record must be exactly a configured connection: an undeclared key is refused rather than stripped. */
const STRICT_SEED_CONNECTION = SeedConnectionSchema.strict();

const UNOPENABLE: Readonly<Record<Level, SkipCode>> = {
  read: "READ_SECRET_UNOPENABLE",
  write: "WRITE_SECRET_UNOPENABLE",
};

/** A JSON object as `JSON.parse` builds it, which is how the driver hands over a `jsonb` object. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function inDomain(domain: DefinitionDomain, value: unknown): boolean {
  switch (domain.type) {
    case "string":
      return typeof value === "string" && (domain.enum === undefined || domain.enum.includes(value));
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && value >= domain.minimum && value <= domain.maximum;
    case "boolean":
      return typeof value === "boolean";
  }
}

interface Leaf {
  readonly segments: readonly string[];
  readonly value: unknown;
}

/**
 * The leaves of a definition, keys in code unit order so that the first fault does not depend on the order the
 * governance source stored them in. An object an allowlisted path reaches into is descended into; anything else is a
 * leaf, so `ssl` holding a string is a leaf that no domain admits.
 */
function leavesOf(object: Readonly<Record<string, unknown>>, parent: readonly string[]): Leaf[] {
  return Object.keys(object)
    .sort()
    .flatMap((key) => {
      const segments = [...parent, key];
      const value = object[key];
      return NESTED.has(pathKey(segments)) && isPlainObject(value) ? leavesOf(value, segments) : [{ segments, value }];
    });
}

interface Fault {
  readonly path?: string;
  readonly code: SkipCode;
}

/** The first fault of a definition: a credential before any key outside the allowlist or value outside its domain. */
function definitionFault(definition: Readonly<Record<string, unknown>>): Fault | undefined {
  const leaves = leavesOf(definition, []);
  const secret = leaves.find((leaf) => SECRET_PATHS.has(pathKey(leaf.segments)));
  if (secret !== undefined) return { path: secret.segments.join("."), code: "DEFINITION_HAS_SECRET" };
  const invalid = leaves.find((leaf) => {
    const domain = DOMAINS.get(pathKey(leaf.segments));
    return domain === undefined || !inDomain(domain, leaf.value);
  });
  return invalid === undefined ? undefined : { path: invalid.segments.join("."), code: "DEFINITION_INVALID" };
}

/** What admission knows of a row once its id, engine and definition are admitted. */
interface RowContext {
  readonly row: ConnectionRow;
  readonly id: string;
  readonly engine: DatabaseType;
  readonly definition: Readonly<Record<string, unknown>>;
}

/** A column's value under `key`, or nothing for NULL, which the seed schema refuses in an optional field. */
const present = (key: string, value: unknown): Readonly<Record<string, unknown>> =>
  value === null || value === undefined ? {} : { [key]: value };

/**
 * The record spec 8.3 merges from a row and one credential set: the row's columns, the definition and the credential,
 * whose TLS client key and certificate join the definition's `ssl` object.
 */
function mergedRecord({ row, id, engine, definition }: RowContext, secret: OpenedSecret): Record<string, unknown> {
  const { sslClientKey, sslClientCert, ...credential } = secret;
  const clientTls = { ...present("clientKey", sslClientKey), ...present("clientCert", sslClientCert) };
  const tls = definition.ssl as Readonly<Record<string, unknown>> | undefined;
  return {
    id,
    name: row.name,
    type: engine,
    ...present("environment", row.environment),
    ...present("group", row.group_name),
    ...present("color", row.color),
    managed: true,
    roles: ["*"],
    // Only where the product offers the engine to MCP clients (#246): elsewhere the seed schema refuses the opt-in.
    ...(MCP_EXPOSABLE[engine] ? { mcp: row.mcp_enabled } : {}),
    ...definition,
    ...credential,
    ...(Object.keys(clientTls).length === 0 ? {} : { ssl: { ...tls, ...clientTls } }),
  };
}

/**
 * The credential set `envelope` carries, with the envelope it opened, or the code it fails with. A column that holds no
 * text holds no envelope.
 */
function openEnvelope(
  options: AdmissionOptions,
  envelope: unknown,
  binding: SecretBinding,
): { readonly secret: OpenedSecret; readonly envelope: string } | { readonly envelopeCode: EnvelopeCode } {
  if (typeof envelope !== "string") return { envelopeCode: "FORMAT" };
  try {
    return { secret: options.openSecret(envelope, binding), envelope };
  } catch (error) {
    if (error instanceof SealedSecretError) return { envelopeCode: error.code };
    throw error;
  }
}

/** Where a validation issue is, as a skip path. Zod reports an undeclared key at its parent, so the key is added. */
function pathOf(issue: z.core.$ZodIssue): { readonly path?: string } {
  const segments = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
  const path = segments.map(String).join(".");
  return path === "" ? {} : { path };
}

/**
 * The record of one credential level, marked literal, with the envelope it was opened from, or the skip of that level.
 * The envelope is opened for this row's own binding, with the definition exactly as the governance source returned it,
 * so an envelope moved from another row or sealed for a changed definition fails AUTH_FAILED.
 */
function levelRecord(
  context: RowContext,
  level: Level,
  envelope: unknown,
  options: AdmissionOptions,
): { readonly record: ManagedConnection; readonly envelope: string } | { readonly skip: AdmissionSkip } {
  const { id, engine, definition } = context;
  const opening = openEnvelope(options, envelope, { connectionId: id, level, engine, definition });
  if ("envelopeCode" in opening) {
    const item: SkippedItem = { kind: "connection", id, level, code: UNOPENABLE[level] };
    return { skip: { item, envelopeCode: opening.envelopeCode } };
  }
  const parsed = STRICT_SEED_CONNECTION.safeParse(mergedRecord(context, opening.secret));
  if (!parsed.success) {
    return {
      skip: { item: { kind: "connection", id, level, ...pathOf(parsed.error.issues[0]), code: "DEFINITION_INVALID" } },
    };
  }
  const [record] = filterByRoles([parsed.data], ["*"]);
  return { record: Object.assign(record, { literal: true as const }), envelope: opening.envelope };
}

/** How a skip names a row whose id is malformed: as written, or by its JSON text when that is not a non-empty string. */
function rowName(id: unknown): string {
  if (typeof id === "string" && id !== "") return id;
  return JSON.stringify(id) ?? String(id);
}

interface RowOutcome {
  readonly connection?: AdmittedConnection;
  readonly skip?: AdmissionSkip;
}

const skipOf = (id: string, fault: Fault): RowOutcome => ({ skip: { item: { kind: "connection", id, ...fault } } });

function admitRow(row: ConnectionRow, repeated: ReadonlySet<unknown>, options: AdmissionOptions): RowOutcome {
  const id = row.connection_id;
  if (typeof id !== "string" || !CONNECTION_ID.test(id) || repeated.has(id)) {
    return skipOf(rowName(id), { path: "connection_id", code: "DEFINITION_INVALID" });
  }
  const engine = row.engine;
  if (typeof engine !== "string" || !isDatabaseType(engine) || OPENS_LOCAL_FILE[engine]) {
    return skipOf(id, { code: "ENGINE_UNSUPPORTED" });
  }
  if (!options.allowedEngines.includes(engine)) return skipOf(id, { code: "ENGINE_NOT_ALLOWED" });
  const definition = row.definition;
  if (!isPlainObject(definition)) return skipOf(id, { path: "definition", code: "DEFINITION_INVALID" });
  // The provider's own rule (`serverLevel` in providers/sql/postgres.ts): an empty or absent database is the server.
  if (OPENS_SERVER_LEVEL_WITHOUT_DATABASE[engine] && !definition.database) {
    return skipOf(id, { path: "database", code: "SERVER_LEVEL_NOT_ALLOWED" });
  }
  const fault = definitionFault(definition);
  if (fault !== undefined) return skipOf(id, fault);

  const context: RowContext = { row, id, engine, definition };
  const read = levelRecord(context, "read", row.read_secret, options);
  if ("skip" in read) return read;
  const readOnly: AdmittedConnection = { id, read: read.record, envelopes: { read: read.envelope } };
  if (row.write_secret === null || row.write_secret === undefined) return { connection: readOnly };
  const write = levelRecord(context, "write", row.write_secret, options);
  if ("skip" in write) return { connection: readOnly, skip: write.skip };
  const envelopes = { read: read.envelope, write: write.envelope };
  return { connection: { id, read: read.record, write: write.record, envelopes } };
}

/**
 * Admits the rows of `connections_v1` by spec 7.7, in order, and returns the connections Studio serves together with
 * a skip for every row, or write level of a row, it left out.
 *
 * It throws only what `options.openSecret` throws other than a SealedSecretError: a fault of the process, not of a row.
 */
export function admitConnectionRows(rows: readonly ConnectionRow[], options: AdmissionOptions): AdmissionResult {
  const seen = new Set<unknown>();
  const repeated = new Set<unknown>();
  for (const { connection_id: id } of rows) (seen.has(id) ? repeated : seen).add(id);

  const admitted: AdmittedConnection[] = [];
  const skipped: AdmissionSkip[] = [];
  for (const row of rows) {
    const { connection, skip } = admitRow(row, repeated, options);
    if (connection !== undefined) admitted.push(connection);
    if (skip !== undefined) skipped.push(skip);
  }
  return { admitted, skipped };
}
