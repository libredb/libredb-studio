/**
 * The SigV4 core, measured against the AWS suite: the canonical request, the string to sign, the derived key and the
 * `Authorization` value, with no service's path normalisation. A signing policy (which headers it signs, its payload
 * hash, its service name) belongs to the caller that builds the canonical request.
 *
 * The canonical request is the method, the canonical URI, the canonical query, `name:value\n` per sorted header, the
 * signed header list and the payload hash, joined by "\n"; the string to sign is `AWS4-HMAC-SHA256`, the date, the
 * scope and the hex SHA-256 of the canonical request; the key is HMAC("AWS4" + secret, date), then region, service
 * and `aws4_request`.
 *
 * Only the keys a caller passes sign: this module reads no environment variable, no file and no instance metadata,
 * and imports nothing that could. It is the only module of the layer that imports `node:crypto`.
 */
import { createHash, createHmac } from "node:crypto";

export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALGORITHM = "AWS4-HMAC-SHA256";
const NO_EQUALS = 'The request query holds a pair with no "=", so it cannot be signed';

/** The access key pair a signature is computed with. */
export interface AwsSigningKeys {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface CanonicalRequest {
  readonly method: string;
  /** Already encoded: used verbatim as the canonical URI. */
  readonly canonicalUri: string;
  /** Already encoded and sorted: used verbatim as the canonical query. */
  readonly canonicalQuery: string;
  /** Lower-case names; values are trimmed and inner whitespace runs collapsed to one space by the core. */
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

export interface SigningScope {
  readonly region: string;
  readonly service: string;
  /** YYYYMMDDTHHMMSSZ */
  readonly amzDate: string;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** A header value as SigV4 canonicalises it: line breaks to spaces, runs of spaces and tabs to one, ends trimmed. */
function canonicalValue(value: string): string {
  return value
    .replace(/[\r\n]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/^ | $/g, "");
}

/** The Authorization header value; exported for the suite vectors. */
export function signatureV4(request: CanonicalRequest, keys: AwsSigningKeys, scope: SigningScope): string {
  // Code-unit order on purpose: SigV4's canonical header order is byte order, which a locale comparison breaks.
  const names = Object.keys(request.headers).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = [
    request.method,
    request.canonicalUri,
    request.canonicalQuery,
    names.map((name) => `${name}:${canonicalValue(request.headers[name])}\n`).join(""),
    names.join(";"),
    request.payloadHash,
  ].join("\n");
  const day = scope.amzDate.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const toSign = [ALGORITHM, scope.amzDate, credentialScope, sha256Hex(canonical)].join("\n");
  let key = hmac(`AWS4${keys.secretAccessKey}`, day);
  for (const part of [scope.region, scope.service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return `${ALGORITHM} Credential=${keys.accessKeyId}/${credentialScope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

/** YYYYMMDDTHHMMSSZ in UTC. */
export function amzDateOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Plain code-unit order on the encoded name, then the encoded value; the strings are ASCII, so this is byte order. */
export function compareEncodedPairs(a: readonly [string, string], b: readonly [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

/**
 * `SigningInput.query` is in the caller's order and is not a canonical query: its pairs, split at
 * their first "=", sorted by encoded name then encoded value, joined by "&"; "" stays "". A pair with no "=" throws an
 * Error naming the defect, which the byte transport routes to the request unchanged.
 */
export function canonicalQueryOf(query: string): string {
  if (query === "") return "";
  return query
    .split("&")
    .map((pair): [string, string] => {
      const at = pair.indexOf("=");
      if (at < 0) throw new Error(NO_EQUALS);
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
    .sort(compareEncodedPairs)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}
