/**
 * The one open function (issue #2537): every engine the server serves, legacy or package alike, opens here through its
 * record (`EngineRecord` in src/lib/db/server-catalog.ts). `openEngine` runs the one ordered open check
 * (`assertOpenable` in src/lib/db/open-check.ts) on the connection and the execution context it opens with, then the
 * record's open: a record no package serves opens through the legacy adapter (`openLegacyEngine` in
 * ./legacy-adapter/open), and a package's record through its package's own `open` (`openContractSession` in
 * ./core/contract-session.ts) with the context core builds (`packageOpenContext` in ./open-context).
 *
 * What it answers is `OpenedEngine`, read through `openedProvider` and `openedSession`, each of which refuses the other
 * form as a host defect, so a caller reads the form it was answered and never who serves the engine:
 * - `"provider"`: a legacy provider, built and not connected, whose caller connects it under its own deadline;
 * - `"session"`: a package's connected session, with the package's declared environment every later call is given.
 * A legacy open reads the caller's `options` and is bounded by nothing, since it connects nothing; a package's open
 * reads `within`, its deadline and the signal that stops it, and refuses an open without one as a host defect, before
 * the package's `open` is called.
 *
 * Nothing here wraps an error: the provider factory (src/lib/db/factory.ts) runs it inside `buildPhase` for a build and
 * for Test Connection's one open (`openEngineOnce`), and inside `connectPhase` for the editor's cached open that
 * connects (`getOrCreateEditorSession`), which mark its errors not-sent.
 */
import type { EnvReader } from "@libredb/provider-sdk/calls";
import { errorCode, errorKind } from "@/lib/db/error-record";
import { assertOpenable, type OpenPurpose } from "@/lib/db/open-check";
import { type EngineConnection, type EngineRecord, servedPackage } from "@/lib/db/server-catalog";
import type { DatabaseProvider, ProviderExecutionContext, ProviderOptions } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import { HostDefectError } from "./access";
import { type ContractSession, openContractSession } from "./core/contract-session";
import { openLegacyEngine } from "./legacy-adapter/open";
import { type PackageOpenRequest, packageEnvironment, packageOpenContext } from "./open-context";

/** What `openEngine` opens an engine with. */
export interface EngineOpen {
  readonly connection: EngineConnection;
  /** The caller's execution context, which the open check reads and the record's open is handed. */
  readonly execution: ProviderExecutionContext;
  /** `"connect"` for an open that may connect, `"declarations"` for a legacy provider read only for its declarations. */
  readonly purpose: OpenPurpose;
  /** A legacy provider's options (its pool and query timeout); a provider package's open reads none. */
  readonly options: ProviderOptions;
  /**
   * The open's deadline and the signal that stops it: a provider package's open needs both; a legacy open connects
   * nothing, so neither bounds it.
   */
  readonly within?: { readonly deadline: number; readonly signal: AbortSignal };
  /**
   * The pool core chose for a provider package's session, when it chose one (`PackageOpenRequest.pool` in
   * ./open-context): the metadata session's. A legacy open reads its pool from `options` instead.
   */
  readonly pool?: PackageOpenRequest["pool"];
}

/**
 * An opened session of a package's engine, the package's declared environment its calls are given, and the engine user
 * its open answered.
 */
export interface OpenedPackageSession {
  readonly session: ContractSession;
  readonly env: EnvReader;
  /**
   * The engine principal the package's open answered, a user name, never any part of a secret, read once at open
   * (docs/providers/CONTRACT.md, clause C-67); absent where the open answered none. The maintenance audit names it.
   */
  readonly engineUser?: string;
}

/** What `openEngine` answers: a legacy provider, not connected, or a package's connected session. */
export type OpenedEngine =
  | { readonly form: "provider"; readonly provider: DatabaseProvider }
  | ({ readonly form: "session" } & OpenedPackageSession);

/**
 * Opens a session of `engine`'s package for `connection` through the package's `open`, with the context core builds
 * and the pool core chose for it, if any; see `packageOpenContext`. A stop answers the signal's reason. An open the
 * host refused is a `HostDefectError` carrying the refusals, the class the accessor builds for a refusal no row of it reads (./access.ts): a refinement the open
 * answered is refused by rules whose author is the package, so every route answers it as the package's defect, naming
 * each rule (`packageFailureAnswer` in src/lib/api/package-errors.ts), and a refusal of the call's start, its deadline
 * passed or its signal aborted before `open` was called, by rules whose author is Studio. A failure the package
 * answers after the caller stopped waiting is logged by the connection, its kind and its code, never its text.
 */
async function openPackageEngine(
  engine: EngineRecord,
  connection: EngineConnection,
  execution: ProviderExecutionContext,
  within: { readonly deadline: number; readonly signal: AbortSignal },
  pool: PackageOpenRequest["pool"],
): Promise<OpenedPackageSession> {
  const served = servedPackage(engine);
  const env = packageEnvironment(served.manifest);
  const ctx = packageOpenContext({
    connection,
    engine,
    execution,
    deadline: within.deadline,
    signal: within.signal,
    ...(pool !== undefined && { pool }),
  });
  const late = (error: unknown): void => {
    logger.warn("[DB] A provider package's open Studio stopped waiting for failed afterwards.", {
      connectionId: connection.id,
      kind: errorKind(error),
      code: errorCode(error),
    });
  };
  const record = await openContractSession(served.record.impl, ctx, served.session, late);
  if (record.kind === "stopped") throw record.reason;
  if (record.kind === "refused") throw new HostDefectError(record.refusals);
  return {
    session: record.session,
    env,
    ...(record.engineUser !== undefined && { engineUser: record.engineUser }),
  };
}

/**
 * Opens `engine` for `open.connection`: the one ordered open check, then the record's open; see the module's docblock.
 *
 * @throws {DatabaseConfigError} Not-sent, when the open check refuses the connection; or a refusal of the record's
 * open.
 * @throws {HostDefectError} When the host refused a package's open, carrying the refusals (`openPackageEngine`).
 * @throws {Error} A host defect: a package's open without `within`, raised before the package's `open` is called.
 * @throws A provider constructor's or the package's error, by reference.
 */
export async function openEngine(engine: EngineRecord, open: EngineOpen): Promise<OpenedEngine> {
  assertOpenable(engine, open.connection, open.execution, open.purpose);
  if (engine.source.package === null) {
    return {
      form: "provider",
      provider: await openLegacyEngine(engine, open.connection, open.execution, open.options),
    };
  }
  if (open.within === undefined) {
    throw new Error(
      "A provider package's engine was opened without a deadline and a signal: its open connects, so a caller that gives neither is a host defect.",
    );
  }
  return {
    form: "session",
    ...(await openPackageEngine(engine, open.connection, open.execution, open.within, open.pool)),
  };
}

/**
 * The legacy provider `opened` holds.
 *
 * @throws {Error} A host defect, when `opened` is a package's session: a caller that reads a provider of it.
 */
export function openedProvider(opened: OpenedEngine): DatabaseProvider {
  if (opened.form !== "provider") {
    throw new Error(
      "The engine opened to a provider package's session, and this caller reads a legacy provider of it: a host defect.",
    );
  }
  return opened.provider;
}

/**
 * The package's session `opened` holds, with its declared environment and the engine user its open answered.
 *
 * @throws {Error} A host defect, when `opened` is a legacy provider: a caller that reads a package's session of it.
 */
export function openedSession(opened: OpenedEngine): OpenedPackageSession {
  if (opened.form !== "session") {
    throw new Error(
      "The engine opened to a legacy provider, and this caller reads a provider package's session of it: a host defect.",
    );
  }
  return {
    session: opened.session,
    env: opened.env,
    ...(opened.engineUser !== undefined && { engineUser: opened.engineUser }),
  };
}
