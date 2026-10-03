/**
 * The Milvus provider's monitoring reads, each through the client slice it needs: CheckHealth for health, and
 * for the Tables and index panels one ShowCollections, then one GetCollectionStatistics or one DescribeIndex for each
 * of the first 200 collections at concurrency 4, each under its own permit, about 60 ms for 200 collections.
 * monitoring.ts shapes every answer; errors.ts's table raises every failure.
 *
 * A collection refused for want of a privilege is left out of its panel, and a panel whose every collection is refused
 * raises that refusal, so the panel reports the engine's sentence and never an empty list; an RPC the server does not
 * implement is the panel's "not supported by this server version". Each panel tolerates its own failure through
 * the base provider's `getMonitoringData`. No panel reads GetMetrics: in v1 only the Load preview does.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseOverview, DatabaseType, HealthInfo, IndexStats, TableStats } from "@/lib/db/types";
import type { MilvusClient } from "./client";
import {
  statisticsRowCount,
  toMilvusHealth,
  toMilvusIndexStats,
  toMilvusOverview,
  toMilvusTableStats,
} from "./monitoring";
import {
  inBoundedFlight,
  listMilvusCollectionNames,
  MILVUS_FAN_OUT,
  type MilvusSurfaceContext,
  readCollectionIndexes,
  refusedForPrivilege,
  surfaceCall,
} from "./objects";
import type { MilvusVersion } from "./versions";

const PROVIDER: DatabaseType = "milvus";

/** The collections the Tables and index panels read, the bound `tableStatsCaption` states. */
export const MILVUS_PANEL_BOUND = 200;

/** CheckHealth, the read Test Connection makes after a good connect; a failure there is a degraded success. */
export async function readMilvusHealth(
  client: Pick<MilvusClient, "checkHealth">,
  context: MilvusSurfaceContext,
): Promise<HealthInfo> {
  const answer = await surfaceCall(context, "health check", { database: context.database }, (options) =>
    client.checkHealth(options),
  );
  return toMilvusHealth(answer, context.secretForms);
}

async function panelNames(
  client: Pick<MilvusClient, "showCollections">,
  context: MilvusSurfaceContext,
  database: string,
): Promise<string[]> {
  return (await listMilvusCollectionNames(client, context, database)).slice(0, MILVUS_PANEL_BOUND);
}

/**
 * `read` for each collection, at most 4 in flight; a collection refused for want of a privilege is left out, and when
 * every one is refused the first refusal is raised.
 */
async function eachReadable<R>(names: readonly string[], read: (collection: string) => Promise<R>): Promise<R[]> {
  const refused: Error[] = [];
  const answers = await inBoundedFlight(names, MILVUS_FAN_OUT, async (collection) => {
    try {
      return { value: await read(collection) };
    } catch (error) {
      if (!refusedForPrivilege(error)) throw error;
      refused.push(error as Error);
      return undefined;
    }
  });
  if (names.length > 0 && refused.length === names.length) throw refused[0];
  return answers.flatMap((answer) => (answer === undefined ? [] : [answer.value]));
}

/** The Tables panel: the GetCollectionStatistics estimate of each of the first 200 collections. */
export async function readMilvusTableStats(
  client: Pick<MilvusClient, "showCollections" | "getCollectionStatistics">,
  context: MilvusSurfaceContext,
  database: string,
): Promise<TableStats[]> {
  const names = await panelNames(client, context, database);
  const rows = await eachReadable(names, async (collection) => {
    const answer = await surfaceCall(
      context,
      `statistics read of collection ${collection}`,
      { database, collection },
      (options) => client.getCollectionStatistics({ collection_name: collection }, options),
    );
    const rowCount = statisticsRowCount(answer.stats);
    if (rowCount === undefined) {
      throw new QueryError(`Milvus answered the statistics of collection ${collection} with no row_count.`, PROVIDER);
    }
    return { collection, rowCount };
  });
  return toMilvusTableStats(database, rows);
}

async function indexRows(
  client: Pick<MilvusClient, "describeIndex">,
  context: MilvusSurfaceContext,
  database: string,
  names: readonly string[],
): Promise<IndexStats[]> {
  const perCollection = await eachReadable(names, async (collection) =>
    toMilvusIndexStats(database, collection, await readCollectionIndexes(client, context, database, collection)),
  );
  return perCollection.flat();
}

/** The index statistics the agent's `index-stats` reading takes: one row per index of the first 200 collections. */
export async function readMilvusIndexStats(
  client: Pick<MilvusClient, "showCollections" | "describeIndex">,
  context: MilvusSurfaceContext,
  database: string,
): Promise<IndexStats[]> {
  return indexRows(client, context, database, await panelNames(client, context, database));
}

/** The overview: the version GetVersion answered at connect, the database's collections and the bound's index rows. */
export async function readMilvusOverview(
  client: Pick<MilvusClient, "showCollections" | "describeIndex">,
  context: MilvusSurfaceContext,
  database: string,
  version: MilvusVersion,
): Promise<DatabaseOverview> {
  const names = await listMilvusCollectionNames(client, context, database);
  const indexes = await indexRows(client, context, database, names.slice(0, MILVUS_PANEL_BOUND));
  return toMilvusOverview({ version: version.reported, database, collections: names.length, indexes: indexes.length });
}
