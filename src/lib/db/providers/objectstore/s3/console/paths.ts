/**
 * An `s3://bucket/key` path as the AWS CLI's ListCommand reads it.
 *
 * Pure, and shipped to the browser. A leading lower-case `s3://` is stripped and a scheme-less path reads as if it
 * had one. What remains is refused when it begins with `arn:` (access points and Outposts, which v1 does not address) or with another
 * scheme; a `://` later in the key is part of the key, because S3 allows any text in a key and a check on the whole
 * remainder would make such an object unreachable. The rest splits at its first `/`.
 */

export type S3PathReading =
  | { readonly ok: true; readonly bucket: string; readonly key: string }
  | { readonly ok: false; readonly code: "arn-path" | "other-scheme" | "no-bucket"; readonly message: string };

export const S3_PATH_SENTENCES = Object.freeze({
  arn: "Studio does not read access points or Outposts, so it refuses a path that begins with arn:: write s3://bucket/prefix.",
  otherScheme: "The path is not an s3:// path: write s3://bucket/prefix.",
  noBucket: "The path names no bucket: write s3://bucket/prefix.",
});

const S3_SCHEME = "s3://";
/** A URI scheme and its `://` at the start of the text (RFC 3986 section 3.1). */
const SCHEME_AT_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** The bucket and key a path names; bucket "" (and key "") is the bucket listing. */
export function readS3Path(text: string): S3PathReading {
  const rest = text.startsWith(S3_SCHEME) ? text.slice(S3_SCHEME.length) : text;
  if (rest.startsWith("arn:")) return { ok: false, code: "arn-path", message: S3_PATH_SENTENCES.arn };
  if (SCHEME_AT_START.test(rest)) return { ok: false, code: "other-scheme", message: S3_PATH_SENTENCES.otherScheme };
  const slash = rest.indexOf("/");
  const bucket = slash < 0 ? rest : rest.slice(0, slash);
  const key = slash < 0 ? "" : rest.slice(slash + 1);
  if (bucket === "" && key !== "") return { ok: false, code: "no-bucket", message: S3_PATH_SENTENCES.noBucket };
  return { ok: true, bucket, key };
}
