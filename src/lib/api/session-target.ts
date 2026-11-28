/**
 * What a caller facade of the provider host core runs its calls on: a session target (`SessionTarget`), the session,
 * the environment every call of it is given, its statement timeout and the run marks of the cache entry it lives in.
 *
 * Every builder of a legacy provider's session target lives here, the object tree's (`providerTreeTarget`), the object
 * source's (`providerSourceTarget`), the monitoring and health reads' (`providerMonitoringTarget`) and the maintenance
 * calls' (`providerMaintenanceTarget`), so this is the one module of the caller facades that builds a bridged session
 * for them (`bridgedConsole` and `bridgedMaintenance` in src/lib/provider-host/legacy-bridge.ts), and every builder of
 * a target from a cache entry of the provider factory, by the entry's form, so no facade and no route forks on who
 * serves an engine. This module value-imports no provider factory module (src/lib/db/factory.ts), so the VS Code
 * backend, which is handed the factory's functions and imports none of them, builds its targets here too; the builders
 * that open through the factory live in src/lib/api/editor-provider.ts and call these.
 *
 * A target's marks count a call on its cache entry while the call runs, so the factory's idle sweep keeps the entry: a
 * provider package's session is marked from `started` until the call answered, or until the call a stop answered has
 * settled; a legacy provider's target marks nothing, since its provider reports its own runs in flight
 * (`hasRunsInFlight`), as it did before targets.
 */
import { type EngineMaintenance, type EnvReader, envReader } from "@libredb/provider-sdk/calls";
import type { Calls, MaintenanceSpec } from "@libredb/provider-sdk/manifest";
import { statementTimeout } from "@/lib/api/editor-query";
import type { CachedSession } from "@/lib/db/factory";
import type { EngineConnection } from "@/lib/db/server-catalog";
import {
  DEFAULT_QUERY_TIMEOUT,
  type DatabaseProvider,
  type MaintenanceDeclaration,
  type MaintenanceOperation,
  type MaintenanceOperationSpec,
  type ObjectReadOptions,
  type ProviderCapabilities,
} from "@/lib/db/types";
import type { StoppedRecord } from "@/lib/provider-host/core/console";
import type { MaintenanceSession } from "@/lib/provider-host/core/maintenance";
import type { HealthSession, MonitoringSession } from "@/lib/provider-host/core/monitoring";
import type { ObjectsSession } from "@/lib/provider-host/core/objects";
import { bridgedConsole, bridgedMaintenance } from "@/lib/provider-host/legacy-bridge";
import type { DatabaseType } from "@/lib/types";

/** How a call on a target ended, as its marks read it: undefined for a call that threw, which has settled. */
export type CallEnd = { readonly kind: "answered" | "refused" } | Pick<StoppedRecord, "kind" | "settled"> | undefined;

/** A session a caller facade runs its calls on, and what each call of it is given. */
export interface SessionTarget<Session> {
  readonly session: Session;
  /** The environment every call's context carries: none for a legacy provider, the declared one for a package's. */
  readonly env: EnvReader;
  /**
   * The statement timeout a call's deadline is taken from, the connection's own or Studio's default, read when a call
   * takes its deadline from it; a facade whose caller holds a deadline of its own reads none.
   */
  timeout(): number;
  /** Marks a call as running on the target's cache entry, before the call. */
  started(): void;
  /** Ends the mark `started` set, once the call ended as `record` and, for a stopped call, once it has settled. */
  ended(record: CallEnd): void;
}

/** A session target of the object tree's reads (src/lib/api/object-tree.ts). */
export interface TreeTarget extends SessionTarget<ObjectsSession> {
  /**
   * The legacy type of a connection that reaches every database on its server, whose provider declares catalog
   * sessions, which a walk over every container must not read (`assertNotWholeServer` in src/lib/db/catalog-scope.ts);
   * null for every other connection, a provider package's among them, whose record offers no catalog session. Read
   * when asked, so only a walk over every container reads a provider's capabilities for it.
   */
  wholeServer(): DatabaseType | null;
}

/** The maintenance a session's server accepts, in the form Studio's maintenance checks and its clients read. */
export type AcceptedMaintenance = Pick<
  ProviderCapabilities,
  "supportsMaintenance" | "maintenanceOperations" | "maintenanceOperationSpecs"
>;

/** A session target of the monitoring and health reads (src/lib/api/provider-monitoring.ts). */
export interface MonitoringTarget extends SessionTarget<MonitoringSession & HealthSession> {
  /**
   * The maintenance the session's server accepts, read when asked: the monitoring route answers it beside the
   * dashboard's panels, since the connection metadata route never connects and answers only the declaration.
   */
  accepted(): AcceptedMaintenance;
}

/** A session target of the maintenance calls (src/lib/api/provider-maintenance.ts). */
export interface MaintenanceTarget extends SessionTarget<Omit<MaintenanceSession, "maintenance">> {
  /**
   * The session's maintenance, read when a call is made: a legacy provider's is its declaration narrowed by what the
   * connected provider accepts (`bridgedMaintenance`), which the SDK refuses as `CallRefusalError` for a narrowing its
   * declaration cannot have, so a run answers that refusal as not sent, after the route admitted it.
   */
  maintenance(): EngineMaintenance;
}

/** A legacy provider reads no declared environment, so its calls get a reader of none. */
const NO_ENVIRONMENT = envReader([], () => undefined);

/** The marks of a target that counts nothing: a legacy provider's. */
const NO_MARKS = Object.freeze({ started: () => undefined, ended: () => undefined });

/**
 * The marks of a call on `entry`: `running` counts the call from its start until it ended, or, when a stop ended it,
 * until the call it stopped waiting for has settled, so the idle sweep never closes a session under a call in flight;
 * `lastUsed` is the time the call ended.
 */
function entryMarks(entry: CachedSession): Pick<SessionTarget<unknown>, "started" | "ended"> {
  return {
    started: () => {
      entry.running += 1;
    },
    ended: (record) => {
      entry.lastUsed = Date.now();
      if (record?.kind === "stopped") {
        void record.settled.then(() => {
          entry.running -= 1;
        });
      } else {
        entry.running -= 1;
      }
    },
  };
}

/**
 * The target of `provider`: one bridged session of it, built when this is called, which reads the provider's
 * capabilities once for its object model, before any host core is read; no environment, no marks, and, when asked,
 * the provider's statement timeout. `objectReads` is handed to the bridge as it is.
 */
function providerTarget(provider: DatabaseProvider, objectReads: ObjectReadOptions): SessionTarget<ObjectsSession> {
  return { session: bridgedConsole(provider, {}, objectReads).session, ...providerFields(provider) };
}

/**
 * The tree target of `provider`: its target (`providerTarget`) and, when asked, the provider's type as `wholeServer`
 * where its capabilities declare catalog sessions.
 * `objectReads` is handed to the bridge as it is: the agent's billed-read allowance, where the walk has one.
 */
export function providerTreeTarget(provider: DatabaseProvider, objectReads: ObjectReadOptions = {}): TreeTarget {
  return {
    ...providerTarget(provider, objectReads),
    wholeServer: () => (provider.getCapabilities().catalogSessions === true ? provider.type : null),
  };
}

/**
 * What every target of `provider` holds beside its session: no environment, the provider's statement timeout read when
 * asked, and no marks.
 */
function providerFields(provider: DatabaseProvider): Omit<SessionTarget<unknown>, "session"> {
  return { env: NO_ENVIRONMENT, timeout: () => statementTimeout(provider), ...NO_MARKS };
}

/**
 * The monitoring target of `provider`: one bridged session of it, built when this is called, whose panels are its
 * engine's and whose health is the provider's; no environment, no marks, and, when asked, the provider's statement
 * timeout and its capabilities as the maintenance it accepts.
 */
export function providerMonitoringTarget(provider: DatabaseProvider): MonitoringTarget {
  return {
    session: bridgedConsole(provider, {}).session,
    accepted: () => provider.getCapabilities(),
    ...providerFields(provider),
  };
}

/**
 * The maintenance target of `provider`: one bridged session of it, built when this is called, as
 * `providerMonitoringTarget` builds it, and its maintenance read when a call reads it, `declared`, the provider's
 * maintenance before it connected, narrowed by what the connected provider accepts at that call (`bridgedMaintenance`).
 */
export function providerMaintenanceTarget(
  provider: DatabaseProvider,
  declared: MaintenanceDeclaration,
): MaintenanceTarget {
  return {
    session: bridgedConsole(provider, {}).session,
    maintenance: () => bridgedMaintenance(provider, declared),
    ...providerFields(provider),
  };
}

/**
 * `call`, one host core call on `target`'s session, counted on the target's entry from its start until it ended
 * (`started`, `ended`), `undefined` for a call that threw; its record, or its error as the same object.
 */
export async function markedCall<Record extends CallEnd>(
  target: Pick<SessionTarget<unknown>, "started" | "ended">,
  call: () => Promise<Record>,
): Promise<Record> {
  target.started();
  let record: Record | undefined;
  try {
    record = await call();
    return record;
  } finally {
    target.ended(record);
  }
}

/**
 * The source target of `provider` (src/lib/api/object-source.ts): its target (`providerTarget`), whose session offers
 * `objects.source` exactly where the provider defines `readObjectSource`.
 */
export function providerSourceTarget(provider: DatabaseProvider): SessionTarget<ObjectsSession> {
  return providerTarget(provider, {});
}

/**
 * The tree target of `entry`, an entry of the provider factory's caches for `connection`, by its form: a legacy
 * provider's through `providerTreeTarget`; a provider package's session with its declared environment, the
 * connection's own statement timeout or Studio's default, no whole server, and the marks of each read on the entry.
 */
export function entryTreeTarget(entry: CachedSession, connection: EngineConnection): TreeTarget {
  const { opened } = entry;
  if (opened.form === "provider") return providerTreeTarget(opened.provider);
  return {
    session: opened.session,
    env: opened.env,
    timeout: () => connection.queryTimeout ?? DEFAULT_QUERY_TIMEOUT,
    wholeServer: () => null,
    ...entryMarks(entry),
  };
}

/**
 * `spec`, one spec of a session's maintenance in the SDK's form, in Studio's form: the card fields `title`,
 * `description`, `confirmation` and `kinds` present only where the spec states them, and `preview` only where it is
 * true, the inverse of the bridge's `declaredSpec` (src/lib/provider-host/legacy-bridge.ts).
 */
function studioSpec(spec: MaintenanceSpec): MaintenanceOperationSpec {
  return {
    label: spec.label,
    perEntity: spec.perEntity,
    global: spec.global,
    ...(spec.title === null ? {} : { title: spec.title }),
    ...(spec.description === null ? {} : { description: spec.description }),
    ...(spec.confirmation === null ? {} : { confirmation: spec.confirmation }),
    ...(spec.preview ? { preview: true as const } : {}),
    ...(spec.kinds === null ? {} : { kinds: [...spec.kinds] }),
  };
}

/**
 * The maintenance `session`, a provider package's, accepts, in Studio's form: its narrowed maintenance where it offers
 * `maintenance.run`, and none where it does not, since no control may be offered for a run its session cannot make.
 */
function acceptedOf(session: { readonly calls: Calls; readonly maintenance: EngineMaintenance }): AcceptedMaintenance {
  if (session.calls.maintenance.run !== "offered") {
    return Object.freeze({ supportsMaintenance: false, maintenanceOperations: [], maintenanceOperationSpecs: {} });
  }
  const { maintenance, maintenanceSpecs } = session.maintenance;
  const specs: Partial<Record<MaintenanceOperation, MaintenanceOperationSpec>> = {};
  for (const spec of maintenanceSpecs) specs[spec.operation] = studioSpec(spec);
  return Object.freeze({
    supportsMaintenance: maintenance.length > 0,
    maintenanceOperations: [...maintenance],
    maintenanceOperationSpecs: specs,
  });
}

/**
 * The monitoring target of `entry`, an entry of the provider factory's caches for `connection`, by its form: a legacy
 * provider's through `providerMonitoringTarget`; a provider package's session with its declared environment, the
 * connection's own statement timeout or Studio's default, the marks of each read on the entry, and the session's
 * narrowed maintenance as the maintenance it accepts (`acceptedOf`).
 */
export function entryMonitoringTarget(entry: CachedSession, connection: EngineConnection): MonitoringTarget {
  const { opened } = entry;
  if (opened.form === "provider") return providerMonitoringTarget(opened.provider);
  const { session } = opened;
  return {
    session,
    env: opened.env,
    timeout: () => connection.queryTimeout ?? DEFAULT_QUERY_TIMEOUT,
    accepted: () => acceptedOf(session),
    ...entryMarks(entry),
  };
}
