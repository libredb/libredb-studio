import type { DatabaseProvider, MonitoringData, MonitoringOptions } from "@/lib/db/types";
import { MONITORING_PANELS, type MonitoringPanel, type MonitoringPanelOffer } from "./types";

/** The seven monitoring reads of a provider, one per panel. */
export type PanelReads = Pick<
  DatabaseProvider,
  | "getOverview"
  | "getPerformanceMetrics"
  | "getSlowQueries"
  | "getActiveSessions"
  | "getTableStats"
  | "getIndexStats"
  | "getStorageStats"
>;

/**
 * The one orchestration of the seven monitoring reads, which `BaseDatabaseProvider.getMonitoringData` hands the
 * engine's `ENGINE_FACETS` row. Each panel ends in one of four states, each distinguishable in the payload:
 *
 * - answered: the panel's field is present;
 * - failed: the field is absent and `errors` carries the read's own sentence;
 * - not requested: the field is absent with no `errors` entry and is not listed (`includeTables` and its two
 *   siblings, which default to true; the four core panels are always requested);
 * - not offered: the field is absent and listed in `notOffered`, and its read is never called. Every panel the engine
 *   does not offer is listed, in `MONITORING_PANELS` order, whether or not it was requested.
 *
 * Every offered, requested panel is read independently, so one read failing costs only its own panel: StarRocks 3.3
 * has no `information_schema.PROCESSLIST`, and its rejected session read used to discard the six panels it had
 * answered (measured 2026-08-24 on StarRocks 3.3 through the MySQL provider).
 *
 * It rejects only when at least one panel was read and every panel read rejected, which is what a dead connection
 * looks like. One distinct sentence rethrows the first rejection, in panel order, as raised: it is already a mapped
 * provider error carrying its class and API code, and re-wrapping it would classify it again from its text. Several
 * are joined with "; " in panel order and raised through `mapError`. Any panel that answered makes the payload
 * partial rather than a failure. An engine that offers no requested panel reads nothing and answers
 * `{ timestamp, notOffered }`.
 */
export async function readDeclaredPanels(
  reads: PanelReads,
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
  const read: Readonly<Record<MonitoringPanel, () => Promise<unknown>>> = {
    overview: () => reads.getOverview(),
    performance: () => reads.getPerformanceMetrics(),
    slowQueries: () => reads.getSlowQueries({ limit: slowQueryLimit }),
    activeSessions: () => reads.getActiveSessions({ limit: sessionLimit }),
    tables: () => reads.getTableStats({ schema: schemaFilter }),
    indexes: () => reads.getIndexStats({ schema: schemaFilter }),
    storage: () => reads.getStorageStats(),
  };

  const notOffered = MONITORING_PANELS.filter((panel) => offer[panel] === "not-offered");
  const toRead = MONITORING_PANELS.filter((panel) => offer[panel] === "offered" && requested[panel]);

  const result: MonitoringData = { timestamp: new Date(), notOffered };
  const settled = await Promise.allSettled(toRead.map((panel) => read[panel]()));

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
