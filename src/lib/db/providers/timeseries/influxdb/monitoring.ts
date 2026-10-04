/**
 * Pure mappings from what an InfluxDB server reports to the monitoring types (InfluxDB spec 7, I22, R24). A figure no
 * route of either table reports reads "N/A" or 0, never a guess: there is no uptime, no size and no connection limit
 * in `/ping` or `/health`, and `/metrics` is never read (I25).
 *
 * The overview's version text comes from the version bodies (R2) and names the line through `GENERATION_TRAITS`
 * only where it reports no build or no version. `tableCount` is the objects of the visible databases (measurements)
 * or of the session database (tables), each listing capped at `INFLUX_LIST_CAP`; the floor field is set only when a
 * cap cut one, so a database count never stands in for it.
 *
 * Pure: the providers make the reads and hand the counts in.
 */
import type { DatabaseOverview, HealthInfo } from "@/lib/db/types";
import { INFLUX_LIST_CAP } from "./connection-options";
import { GENERATION_TRAITS, type InfluxServerVersion } from "./versions";

/** What InfluxDB's routes do not report, in the words the panels already render. */
const NOT_REPORTED = "N/A";

/** Reachability only: `/ping` answering is no evidence of what the credential may read. */
export function toInfluxHealth(): HealthInfo {
  return { databaseSize: NOT_REPORTED, cacheHitRatio: NOT_REPORTED, slowQueries: [], activeSessions: [] };
}

export interface InfluxOverviewInput {
  readonly version: InfluxServerVersion;
  /** influxdb3 only: named after the version text, since no container node names it (R16). */
  readonly sessionDatabase?: string;
  /** The measurements or tables counted (R24). */
  readonly objectCount: number;
  /** A listing cap cut a listing, so `objectCount` is a floor. */
  readonly objectCountCut: boolean;
  readonly objects: "measurements" | "tables";
}

/** A whole number with its thousands grouped by commas, the same in every locale. */
function grouped(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** What the floor sentence says was counted, phrased to follow "counted from". */
const FLOOR: Readonly<Record<InfluxOverviewInput["objects"], string>> = {
  measurements: `the first ${grouped(INFLUX_LIST_CAP)} measurements SHOW MEASUREMENTS returned for each database`,
  tables: `the first ${grouped(INFLUX_LIST_CAP)} tables the session database's table listing returned`,
};

/** "InfluxDB 1.13.1", "InfluxDB 2.9.1", "InfluxDB 3 Core 3.12.0"; the line's label when no version is reported. */
function versionText(version: InfluxServerVersion): string {
  const label = GENERATION_TRAITS[version.generation].label;
  if (version.reported === null) return `${label}, version not reported`;
  const number = version.reported.replace(/^v/, "");
  return version.build === null ? `InfluxDB ${number}` : `${label} ${version.build} ${number}`;
}

/** The overview: the version, the counted objects and the floor sentence when cut; every size and timing "N/A". */
export function toInfluxOverview(input: InfluxOverviewInput): DatabaseOverview {
  const database = input.sessionDatabase === undefined ? "" : `, database ${input.sessionDatabase}`;
  return {
    version: `${versionText(input.version)}${database}`,
    uptime: NOT_REPORTED,
    maxConnections: 0,
    databaseSize: NOT_REPORTED,
    tableCount: input.objectCount,
    ...(input.objectCountCut ? { tableCountSampledFrom: FLOOR[input.objects] } : {}),
    indexCount: 0,
  };
}
