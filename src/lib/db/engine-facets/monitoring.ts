import type {
  ActiveSessionDetails,
  DatabaseOverview,
  IndexStats,
  MonitoringPanelAnswer,
  MonitoringPanelRequest,
  PerformanceMetrics,
  SlowQueryStats,
  StorageStats,
  TableStats,
} from "@libredb/provider-sdk/calls";
import type { MonitoringData, MonitoringOptions } from "@/lib/db/types";
import { MONITORING_PANELS, type MonitoringPanel, type MonitoringPanelOffer } from "./types";

/**
 * The seven monitoring reads of a provider, one per panel, each answering the SDK's form of its panel, so a provider's
 * mutable lists and a contract session's readonly ones both fit.
 */
export interface PanelReads {
  getOverview(): Promise<DatabaseOverview>;
  getPerformanceMetrics(): Promise<PerformanceMetrics>;
  getSlowQueries(options: { limit: number }): Promise<readonly SlowQueryStats[]>;
  getActiveSessions(options: { limit: number }): Promise<readonly ActiveSessionDetails[]>;
  getTableStats(options: { schema: string | undefined }): Promise<readonly TableStats[]>;
  getIndexStats(options: { schema: string | undefined }): Promise<readonly IndexStats[]>;
  getStorageStats(): Promise<readonly StorageStats[]>;
}

/**
 * The panel answer of `request` read from `reads`: the panel's own member called with today's argument, `{ limit }`
 * for the slow queries and the active sessions, `{ schema }` for the tables and the indexes with the key present even
 * when the request names no schema, and nothing for the other four, its answer laid by reference under the panel's
 * key. A member's rejection passes by reference, and a synchronous throw is thrown as raised.
 */
export function readPanel(reads: PanelReads, request: MonitoringPanelRequest): Promise<MonitoringPanelAnswer> {
  switch (request.panel) {
    case "overview":
      return reads.getOverview().then((overview) => ({ overview }));
    case "performance":
      return reads.getPerformanceMetrics().then((performance) => ({ performance }));
    case "slowQueries":
      return reads.getSlowQueries({ limit: request.limit }).then((slowQueries) => ({ slowQueries }));
    case "activeSessions":
      return reads.getActiveSessions({ limit: request.limit }).then((activeSessions) => ({ activeSessions }));
    case "tables":
      return reads.getTableStats({ schema: request.schema }).then((tables) => ({ tables }));
    case "indexes":
      return reads.getIndexStats({ schema: request.schema }).then((indexes) => ({ indexes }));
    case "storage":
      return reads.getStorageStats().then((storage) => ({ storage }));
  }
}

/** The request that reads `panel`: the limits as resolved, and a schema only when the caller named one. */
function requestOf(
  panel: MonitoringPanel,
  slowQueryLimit: number,
  sessionLimit: number,
  schemaFilter: string | undefined,
): MonitoringPanelRequest {
  switch (panel) {
    case "slowQueries":
      return { panel, limit: slowQueryLimit };
    case "activeSessions":
      return { panel, limit: sessionLimit };
    case "tables":
    case "indexes":
      return schemaFilter === undefined ? { panel } : { panel, schema: schemaFilter };
    default:
      return { panel };
  }
}

/**
 * What `answer` holds for the panel `request` names: its one own key, the panel's, read as a data property by its
 * descriptor.
 *
 * @throws {Error} When the answer's own keys are not exactly the panel's, or the panel's key is an accessor, naming the
 * panel and never a value of the answer.
 */
function memberOf(request: MonitoringPanelRequest, answer: MonitoringPanelAnswer): unknown {
  const { panel } = request;
  const keys = typeof answer === "object" && answer !== null ? Reflect.ownKeys(answer) : [];
  const descriptor =
    keys.length === 1 && keys[0] === panel ? Object.getOwnPropertyDescriptor(answer, panel) : undefined;
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    throw new Error(
      `The ${panel} panel read answered a form other than the ${panel} panel's, which is a defect of the session that answered it.`,
    );
  }
  return descriptor.value;
}

/**
 * The one orchestration of the seven monitoring reads, which `BaseDatabaseProvider.getMonitoringData` hands the
 * engine's `ENGINE_FACETS` row and its own members through `readPanel`, and the host's monitoring facade the host
 * core's panel call. Each panel ends in one of four states, each distinguishable in the payload:
 *
 * - answered: the panel's field is present;
 * - failed: the field is absent and `errors` carries the read's own sentence;
 * - not requested: the field is absent with no `errors` entry and is not listed (`includeTables` and its two
 *   siblings, which default to true; the four core panels are always requested);
 * - not offered: the field is absent and listed in `notOffered`, and its read is never called. Every panel the engine
 *   does not offer is listed, in `MONITORING_PANELS` order, whether or not it was requested.
 *
 * Every offered, requested panel is read through `read` with one request of its own, a fresh object, all started in
 * one turn: `{ panel, limit }` for the slow queries (`slowQueryLimit`, default 10) and the active sessions
 * (`sessionLimit`, default 50), `{ panel, schema }` for the tables and the indexes only when `schemaFilter` is present
 * and `{ panel }` otherwise. Each answer is held to its request: an answer whose own keys are not exactly the
 * requested panel's, or whose panel key is an accessor, fails that panel with a sentence naming it, a defect of the
 * session that answered it, and its member is laid in the payload by reference otherwise.
 *
 * Every panel is read independently, so one read failing costs only its own panel: StarRocks 3.3 has no
 * `information_schema.PROCESSLIST`, and its rejected session read used to discard the six panels it had answered
 * (measured 2026-08-24 on StarRocks 3.3 through the MySQL provider).
 *
 * It rejects only when at least one panel was read and every panel read rejected, which is what a dead connection
 * looks like. One distinct sentence rethrows the first rejection, in panel order, as raised: it is already a mapped
 * provider error carrying its class and API code, and re-wrapping it would classify it again from its text. Several
 * are joined with "; " in panel order and raised through `mapError`. Any panel that answered makes the payload
 * partial rather than a failure. An engine that offers no requested panel reads nothing and answers
 * `{ timestamp, notOffered }`.
 */
export async function readDeclaredPanels(
  read: (request: MonitoringPanelRequest) => Promise<MonitoringPanelAnswer>,
  offer: MonitoringPanelOffer,
  options: MonitoringOptions,
  mapError: (error: Error) => Error,
): Promise<MonitoringData> {
  const {
    includeTables = true,
    includeIndexes = true,
    includeStorage = true,
    slowQueryLimit = 10,
    sessionLimit = 50,
    schemaFilter, // undefined = all user schemas
  } = options;

  const requested: Readonly<Record<MonitoringPanel, boolean>> = {
    overview: true,
    performance: true,
    slowQueries: true,
    activeSessions: true,
    tables: includeTables,
    indexes: includeIndexes,
    storage: includeStorage,
  };

  const notOffered = MONITORING_PANELS.filter((panel) => offer[panel] === "not-offered");
  const toRead = MONITORING_PANELS.filter((panel) => offer[panel] === "offered" && requested[panel]);

  const result: MonitoringData = { timestamp: new Date(), notOffered };
  const settled = await Promise.allSettled(
    toRead.map((panel) => {
      const request = requestOf(panel, slowQueryLimit, sessionLimit, schemaFilter);
      return read(request).then((answer) => memberOf(request, answer));
    }),
  );

  const errors: NonNullable<MonitoringData["errors"]> = {};
  const rejections: unknown[] = [];
  const sentences: string[] = [];
  settled.forEach((outcome, at) => {
    const panel = toRead[at];
    if (outcome.status === "fulfilled") {
      Object.assign(result, { [panel]: outcome.value });
      return;
    }
    const sentence = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    errors[panel] = sentence;
    rejections.push(outcome.reason);
    if (!sentences.includes(sentence)) sentences.push(sentence);
  });

  if (toRead.length > 0 && rejections.length === toRead.length) {
    if (sentences.length === 1) throw rejections[0];
    throw mapError(new Error(sentences.join("; ")));
  }

  if (rejections.length > 0) result.errors = errors;
  return result;
}
