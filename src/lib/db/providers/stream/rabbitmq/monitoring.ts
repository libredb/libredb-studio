/**
 * The version rule, health and the overview of a RabbitMQ connection, from the management API alone.
 *
 * `rabbitmq_version` is read only through its shape, `^(\d{1,4})\.(\d{1,4})\.(\d{1,4})` with an optional suffix, and
 * compared by its three numbers, so 4.10.0 is above 4.2.0 and 4.2.0-rc.1 is 4.2.0; a value of another shape is never
 * shown. Health is one GET of the version; the overview is that GET with the management version and the alarm check.
 * The overview counts nothing, so its table count is a floor of 0 that says why, and its size card holds the alarm
 * state: an engine's own fact drawn there, as Kubernetes draws its node count.
 */
import type { DatabaseOverview, HealthInfo } from "@/lib/db/types";
import {
  ALARM_CAUTION,
  MAINTENANCE_REFUSED,
  NO_ALARM_STATUS,
  OVERVIEW_COUNT_NOT_READ,
  queryError,
  versionTooOld,
  versionUnreadable,
} from "./errors";
import { RABBITMQ_MIN_VERSION } from "./limits";
import type { GetOptions, ManagementClient } from "./management/client";

const VERSION = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})([-+][0-9A-Za-z.+-]{0,64})?$/;

function numbers(version: string): readonly [number, number, number] | undefined {
  const match = VERSION.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The version when it has the shape and is at least the floor; refuses otherwise, naming it only after the check. */
export function supportedVersion(version: string): string {
  const found = numbers(version);
  if (found === undefined) throw versionUnreadable();
  const floor = numbers(RABBITMQ_MIN_VERSION) as readonly [number, number, number];
  for (let i = 0; i < 3; i++) {
    if (found[i] > floor[i]) return version;
    if (found[i] < floor[i]) throw versionTooOld(version);
  }
  return version;
}

/** One GET of the version; the broker answering it is the health. */
export async function readHealth(client: ManagementClient, options?: GetOptions): Promise<HealthInfo> {
  supportedVersion((await client.get("overview-version", {}, options)).version);
  // No count of connections: a management user sees only its own, which is not the broker's figure.
  return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}

export async function readOverview(client: ManagementClient): Promise<DatabaseOverview> {
  const [overview, alarms] = await Promise.all([client.get("overview-full", {}), client.get("alarms", {})]);
  const version = supportedVersion(overview.version);
  const management = overview.managementVersion;
  const shown =
    management !== null && management !== version && numbers(management) !== undefined
      ? `RabbitMQ ${version} (management ${management})`
      : `RabbitMQ ${version}`;
  return {
    version: shown,
    uptime: "N/A",
    maxConnections: 0,
    databaseSize: alarms.active ? ALARM_CAUTION : NO_ALARM_STATUS,
    tableCount: 0,
    tableCountSampledFrom: OVERVIEW_COUNT_NOT_READ,
    indexCount: 0,
  };
}

/** Unreachable behind supportsMaintenance: false; a direct call is refused. */
export function refuseMaintenance(): never {
  throw queryError(MAINTENANCE_REFUSED);
}
