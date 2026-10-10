/**
 * Request targets for each S3 operation. Path style only: every object request
 * targets `/<bucket>/<key>`. The path is PR 1's `rfc3986Path` of the bucket and the key's "/"-separated segments,
 * which is also SigV4's canonical URI unchanged; "." and ".." key segments are sent as given, because Garage stores
 * and serves them, while the bucket segment never is: `objectPath` refuses a bucket failing
 * `S3_BUCKET_PATTERN`, whoever the caller. The query is sorted by encoded name
 * then encoded value, the same order the signer sorts `SigningInput.query` into.
 *
 * Not browser-safe: it imports endpoint.ts, which imports `node:net`.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { rfc3986Encode, rfc3986Path } from "@/lib/db/http/endpoint";
import { S3_TYPE } from "./constants";
import { bucketAddressRefusal, sourceAddressSentence } from "./names";

/** Plain code-unit order on the encoded name, then the encoded value; the strings are ASCII, so this is byte order. */
export function compareEncodedPairs(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/**
 * "/" + bucket, or "/" + bucket + "/" + the key's "/"-separated segments, each rfc3986Encode-d.
 * Throws DatabaseConfigError tagged "s3" with sourceAddressSentence("bucket-pattern", ...) when bucketAddressRefusal(bucket)
 * answers "bucket-pattern" (the bucket fails S3_BUCKET_PATTERN), before any request, so no caller can send a bucket segment such as "..";
 * E0a passes it through unchanged.
 */
export function objectPath(bucket: string, key?: string): string {
  if (bucketAddressRefusal(bucket) !== undefined)
    throw new DatabaseConfigError(sourceAddressSentence("bucket-pattern", { bucket, key: key ?? "" }), S3_TYPE);
  return rfc3986Path(key === undefined ? [bucket] : [bucket, ...key.split("/")]);
}

/** The pairs, each side rfc3986Encode-d, sorted by encoded name then encoded value, joined by "&"; the signer sorts again on its own. */
export function s3Query(pairs: readonly (readonly [string, string])[]): string {
  return pairs
    .map(([name, value]): [string, string] => [rfc3986Encode(name), rfc3986Encode(value)])
    .sort(compareEncodedPairs)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}
