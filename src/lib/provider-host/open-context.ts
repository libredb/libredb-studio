/**
 * The open context of an admitted provider package's engine (docs/providers/CONTRACT.md, clause C-109): what core hands
 * a package's `open`, built here from a connection, the server catalog's record of its engine and the caller's
 * execution context, and from nothing else.
 *
 * `packageOpenContext` answers:
 * - `engine` and `connectionId`: the engine's id and the connection's id. No `seedId`: a seed of a package's engine is
 *   refused before it resolves (clause C-107), so no package connection is a seed.
 * - `connection`: for each field the engine's declaration names (`connection.fields`), the connection's own value where
 *   it sets one, and nothing else, so a secret reaches a package only under a field name its declaration states. No SSH
 *   tunnel, no agent credential and no field the declaration does not name is handed on. A value outside the
 *   contract's value forms (a text, a finite number, a boolean, a list of texts) is refused by its field, never by its
 *   value.
 * - `tls`: a copy of the connection's `ssl` when it sets one whose mode the declaration lists (`connection.tls.modes`),
 *   refused by name otherwise.
 * - `egress`: core's egress decision (src/lib/db/egress-decision.ts). `trust`: core's trust material
 *   (src/lib/db/trust-material.ts) when the declaration reads it, an empty list otherwise, so the file
 *   `NODE_EXTRA_CA_CERTS` names is read only for such an engine.
 * - `policy`: no read-only statement session (the editor's and Test Connection's sessions are not one, clause C-78), the
 *   caller's file-access posture as a definite boolean, no write refusal (a read-only connection never reaches the open,
 *   since no package's engine keeps that mode), the operator's grant (`managed`) and the literal seed file marker.
 * - `pool`: core's defaults for a session every caller shares, or the owner's share for an owned one
 *   (docs/GOVERNANCE.md#per-user-providers), or the smaller pool the open asks for, the metadata session's, shared or
 *   owned alike (`PackageOpenRequest.pool`; docs/providers/CONTRACT.md, clause C-66).
 * - `deadline` and `signal`: the caller's, the deadline being the open's start plus the engine's connect budget
 *   (`packageConnectBudget`).
 * - `env`: the package's declared environment (`packageEnvironment`), which every later call of the session gets too.
 * No `admittedFile`, `admittedHostPaths`, `tunnelFarEnd`, `tunnelRoute` or `timezone`: the one ordered open check
 * refuses every connection that would need one (`assertOpenable` in src/lib/db/open-check.ts, which `openEngine` in
 * ./open-engine runs before it builds this context).
 */
import {
  type ConnectionFieldValue,
  type ConnectionFieldValues,
  DEFAULT_CONNECT_BUDGET_MS,
  type EnvReader,
  envReader,
  type OpenContext,
  type TlsSettings,
} from "@libredb/provider-sdk/calls";
import type { ProviderManifest } from "@libredb/provider-sdk/manifest";
import { egressDecision } from "@/lib/db/egress-decision";
import { DatabaseConfigError, markNotSent } from "@/lib/db/errors";
import { type EngineConnection, type EngineRecord, servedPackage } from "@/lib/db/server-catalog";
import { trustMaterial } from "@/lib/db/trust-material";
import { DEFAULT_POOL_CONFIG, type EditorExecutionContext } from "@/lib/db/types";
import { LITERAL_SEED_FILE, type WithLiteralSeedFile } from "@/lib/types";

/** What `packageOpenContext` builds an open context from. */
export interface PackageOpenRequest {
  readonly connection: EngineConnection & WithLiteralSeedFile;
  readonly engine: EngineRecord;
  /** The caller's file-access posture and, under governance, the owner and the owner's pool size. */
  readonly execution: EditorExecutionContext;
  /** When the open must have answered: its start plus `packageConnectBudget(engine)`. */
  readonly deadline: number;
  readonly signal: AbortSignal;
  /**
   * The pool core chose for this session, when it chose one: the metadata session's, which opens none until a read asks
   * and holds at most `max`, shared or owned (clause C-66). Absent, the pool is core's defaults or the owner's share.
   */
  readonly pool?: { readonly min: 0; readonly max: number };
}

/** How long the host waits for an open of `engine`: the budget its declaration states, or the host's default. */
export function packageConnectBudget(engine: EngineRecord): number {
  return engine.catalog.connectBudgetMs ?? DEFAULT_CONNECT_BUDGET_MS;
}

/**
 * The package's declared environment: a reader that answers a name its manifest declares in `runtime.env` with what
 * Studio's process reads for it, and refuses any other name by name without reading it (clause M-22).
 */
export function packageEnvironment(manifest: ProviderManifest): EnvReader {
  return envReader(manifest.runtime.env, (name) => process.env[name]);
}

/** A not-sent configuration error with `sentence`: the open was never called. */
function refused(sentence: string): DatabaseConfigError {
  const error = new DatabaseConfigError(sentence);
  markNotSent(error);
  return error;
}

/** Whether `value` is one of the contract's connection field value forms. */
function isFieldValue(value: unknown): value is ConnectionFieldValue {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * The values of the fields `engine` declares that `connection` sets, and no other.
 *
 * @throws {DatabaseConfigError} Not-sent, naming the field, for a value outside the contract's value forms.
 */
function declaredValues(connection: EngineConnection, engine: EngineRecord): ConnectionFieldValues {
  const values: Record<string, ConnectionFieldValue> = {};
  const record = connection as unknown as Readonly<Record<string, unknown>>;
  for (const field of engine.connection.fields) {
    const value = Object.hasOwn(record, field) ? record[field] : undefined;
    if (value === undefined || value === null) continue;
    if (!isFieldValue(value)) {
      throw refused(
        `The connection's ${field} is not a value Studio hands a provider package: it takes a text, a finite number, true or false, or a list of texts.`,
      );
    }
    values[field] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(values);
}

/** The members of a connection's `ssl` a package is handed, each with the type it must have. */
const TLS_MEMBERS = Object.freeze({
  caCert: "string",
  clientCert: "string",
  clientKey: "string",
  rejectUnauthorized: "boolean",
} as const);

/**
 * A copy of the connection's `ssl` for a mode `engine` declares, or undefined when it sets none.
 *
 * @throws {DatabaseConfigError} Not-sent, for an `ssl` whose mode the declaration does not list or whose member is not
 * of its type.
 */
function tlsOf(connection: EngineConnection, engine: EngineRecord): TlsSettings | undefined {
  const ssl: unknown = connection.ssl;
  if (ssl === undefined || ssl === null) return undefined;
  const settings = ssl as Readonly<Record<string, unknown>>;
  const modes: readonly unknown[] = engine.connection.tlsModes;
  if (typeof ssl !== "object" || !modes.includes(settings.mode)) {
    throw refused(
      "The connection's TLS mode is not one its provider package declares for the engine, so Studio does not open it.",
    );
  }
  const copy: Record<string, unknown> = { mode: settings.mode };
  for (const [member, type] of Object.entries(TLS_MEMBERS)) {
    const value = settings[member];
    if (value === undefined) continue;
    if (typeof value !== type) {
      throw refused(`The connection's TLS ${member} is not a ${type === "string" ? "text" : "boolean"}.`);
    }
    copy[member] = value;
  }
  return Object.freeze(copy) as unknown as TlsSettings;
}

/**
 * The pool of the open: the one the open asks for over core's defaults, else core's defaults for a session every caller
 * shares, else the owner's share.
 */
function poolOf(
  asked: PackageOpenRequest["pool"],
  owner: string | undefined,
  execution: EditorExecutionContext,
): OpenContext["pool"] {
  if (asked !== undefined) return { ...DEFAULT_POOL_CONFIG, min: asked.min, max: asked.max };
  if (owner === undefined) return { ...DEFAULT_POOL_CONFIG };
  return { ...DEFAULT_POOL_CONFIG, min: 0, max: execution.ownerPoolMax as number };
}

/**
 * The open context core hands `request.engine`'s package for `request.connection`; see the module's docblock.
 *
 * @throws {DatabaseConfigError} Not-sent: for a field value outside the contract's value forms, for a TLS setting the
 * declaration does not take, for an invalid `DB_HTTP_BLOCK_PRIVATE_HOSTS`, and, for an engine that reads trust
 * material, for an invalid file `NODE_EXTRA_CA_CERTS` names.
 */
export function packageOpenContext(request: PackageOpenRequest): OpenContext {
  const { connection, engine, execution } = request;
  const owner = execution.owner;
  const tls = tlsOf(connection, engine);
  return {
    engine: engine.id,
    connectionId: connection.id,
    connection: declaredValues(connection, engine),
    ...(tls !== undefined && { tls }),
    egress: egressDecision(),
    trust: engine.connection.readsTrustMaterial ? trustMaterial() : { certificates: [] },
    policy: {
      readOnly: false,
      sendsStatements: false,
      allowExternalFileAccess: execution.allowExternalFileAccess === true,
      refuseWrites: false,
      managed: connection.managed === true,
      literalSeedFile: connection[LITERAL_SEED_FILE] === true,
    },
    pool: poolOf(request.pool, owner, execution),
    deadline: request.deadline,
    signal: request.signal,
    env: packageEnvironment(servedPackage(engine).manifest),
  };
}
