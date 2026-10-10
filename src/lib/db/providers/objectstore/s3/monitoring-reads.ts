/**
 * Test Connection's probe, health and the overview of an S3 connection.
 *
 * The probe proves the endpoint speaks S3: with a pin, one
 * ListObjectsV2 on the pinned bucket with `max-keys=1`, `delimiter=/` and `encoding-type=url`, whose answer must parse
 * as `ListBucketResult`; without a pin, one ListBuckets, whose answer must parse as `ListAllMyBucketsResult`. A HEAD
 * that any HTTP server answers 200 never proved that, and the provider shows the bodies of GET answers. Health and
 * the overview run the same probe, so a dead server fails the panel instead of drawing a quiet one.
 * Nothing is measured, so every figure is "N/A" or 0, and no connection count is claimed.
 */
import type { DatabaseOverview, HealthInfo } from "@/lib/db/types";
import type { S3CallOptions, S3Operation, S3Surface } from "./client";
import type { S3ConnectionOptions } from "./connection-options";

export const S3_NO_BUCKETS_WARNING =
  "This key lists no bucket. A key limited to one bucket may list none: put that bucket under Bucket.";

/** The probe's own operation, so a refusal names `s3:ListBucket` or `s3:ListAllMyBuckets`. */
export function probeOperation(options: Pick<S3ConnectionOptions, "pinnedBucket">): S3Operation {
  return options.pinnedBucket === undefined ? "ListBuckets" : "ListObjectsV2";
}

/** The probe; how many buckets an unpinned probe listed, null on a pinned connection. Failures are the caller's to word. */
export async function probeS3(
  surface: S3Surface,
  call: S3CallOptions,
): Promise<{ readonly listedBuckets: number | null }> {
  const pin = surface.options.pinnedBucket;
  if (pin !== undefined) {
    await surface.client.listObjectsV2({ bucket: pin, prefix: "", delimiter: "/", maxKeys: 1 }, call);
    return { listedBuckets: null };
  }
  const listing = await surface.client.listBuckets(call);
  return { listedBuckets: listing.buckets.length };
}

export async function s3Health(surface: S3Surface, call: S3CallOptions): Promise<HealthInfo> {
  await probeS3(surface, call);
  return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}

export async function s3Overview(surface: S3Surface, call: S3CallOptions): Promise<DatabaseOverview> {
  await probeS3(surface, call);
  return { version: "N/A", uptime: "N/A", maxConnections: 0, databaseSize: "N/A", tableCount: 0, indexCount: 0 };
}
