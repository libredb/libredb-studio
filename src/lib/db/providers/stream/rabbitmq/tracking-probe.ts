/**
 * Whether this account could take a classic or quorum queue's messages, asked without reading one: the stream
 * tracking route of the rabbitmq_stream_management plugin checks the read permission on the named queue before it
 * looks for a stream, so a 503 (no stream leader) or a 400 means the read was allowed, and a 401 means it was not.
 * Any other status is unchecked and never held. The route's body is discarded unread.
 *
 * The plugin is optional and absent from the official image; whether the broker lists its stream.js among the UI
 * extensions is read once per provider instance and held, so an evicted provider reads it again. The read in flight is
 * held too, so callers that ask together share one GET; a failed read is dropped, and the next caller asks again.
 */
import type { GetOptions, ManagementClient } from "./management/client";

export type QueueAccess = "readable" | "not-readable" | "unchecked";

export interface TrackingProbe {
  /** `/api/extensions` lists stream.js; read once per provider instance and held, a failed read not held. */
  streamManagementListed(options?: GetOptions): Promise<boolean>;
  /** 503 or 400: readable; 401: not-readable; any other status: unchecked, never cached. */
  queueReadableByAccount(vhost: string, queue: string, options?: GetOptions): Promise<QueueAccess>;
}

export function createTrackingProbe(client: ManagementClient): TrackingProbe {
  let listed: Promise<boolean> | undefined;
  return {
    streamManagementListed(options) {
      listed ??= client.get("extensions", {}, options).then(
        (answer) => answer.streamManagement,
        (error: unknown) => {
          listed = undefined;
          throw error;
        },
      );
      return listed;
    },
    async queueReadableByAccount(vhost, queue, options) {
      const status = await client.status("stream-tracking", { vhost, name: queue }, options);
      if (status === 503 || status === 400) return "readable";
      if (status === 401) return "not-readable";
      return "unchecked";
    },
  };
}
