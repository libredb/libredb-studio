/**
 * The S3 preview's one gzip layer. Server-only (`node:zlib`). `gunzipSync` throws on a
 * truncated prefix and `maxOutputLength` throws instead of truncating, so the layer is a stream with Z_SYNC_FLUSH,
 * measured to decode a prefix and to stop a 64 MiB bomb within one 64 KiB chunk of the cap on Node and Bun.
 */
import { constants, createGunzip } from "node:zlib";

export type GunzipResult =
  | { readonly bad: false; readonly bytes: Uint8Array; readonly ended: boolean }
  | { readonly bad: true };

function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

/**
 * Decodes the gzip prefix `stored` to at most `cap` bytes. `whole` says `stored` is the entire object; `ended` is true
 * only when the stream ended by itself before reaching the cap on a whole object. An error keeps the output pushed
 * before the failing native call as a cut with `ended` false; that call's own output, under one 64 KiB chunk, is lost,
 * so a damaged object whose good part fits in one chunk reads as `bad`.
 */
export function gunzipPrefix(stored: Uint8Array, cap: number, whole: boolean): Promise<GunzipResult> {
  return new Promise((resolve) => {
    const gunzip = createGunzip({ finishFlush: constants.Z_SYNC_FLUSH, chunkSize: 65_536 });
    const chunks: Uint8Array[] = [];
    let produced = 0;
    let settled = false;
    const finish = (result: GunzipResult): void => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      resolve(result);
    };
    const collected = (ended: boolean): GunzipResult => ({
      bad: false,
      bytes: join(chunks, produced).subarray(0, Math.min(cap, produced)),
      ended,
    });
    gunzip.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk);
      produced += chunk.length;
      if (produced >= cap) finish(collected(false));
    });
    gunzip.on("end", () => finish(collected(whole)));
    gunzip.on("error", () => finish(produced === 0 ? { bad: true } : collected(false)));
    gunzip.end(stored);
  });
}
