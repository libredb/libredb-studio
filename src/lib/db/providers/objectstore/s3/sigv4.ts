/**
 * SigV4 for S3: the signer measured against the AWS suite, in TypeScript, without its non-S3 path normalisation,
 * and the `RequestSigner` PR 1's byte transport calls once per request, at send time.
 *
 * The canonical request is the method, the canonical URI, the canonical query, `name:value\n` per sorted header, the
 * signed header list and the payload hash, joined by "\n"; the string to sign is `AWS4-HMAC-SHA256`, the date, the
 * scope and the hex SHA-256 of the canonical request; the key is HMAC("AWS4" + secret, date), then region, service
 * and `aws4_request`. Every request is a GET or HEAD with no body, so the payload hash is the empty-string SHA-256,
 * never UNSIGNED-PAYLOAD, and `x-amz-content-sha256` is always sent, because Garage refuses a request
 * without it. Every `x-amz-*` header a request carries is signed, because Silo refuses an unsigned one.
 *
 * Only typed credentials sign: this module reads no environment variable, no file and no instance metadata, and
 * imports nothing that could. It is the only module of the provider that imports `node:crypto`.
 */
import { createHash, createHmac } from "node:crypto";
import type { RequestSigner, SigningInput } from "@/lib/db/http/node-transport";
import type { S3Credentials } from "./connection-options";
import { compareEncodedPairs } from "./encoding";

export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALGORITHM = "AWS4-HMAC-SHA256";
const NO_EQUALS = 'The request query holds a pair with no "=", so it cannot be signed';

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
export function signatureV4(request: CanonicalRequest, credentials: S3Credentials, scope: SigningScope): string {
  const names = Object.keys(request.headers).sort();
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
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [scope.region, scope.service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

/** YYYYMMDDTHHMMSSZ in UTC. */
export function amzDateOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * `SigningInput.query` is in the caller's order and is not a canonical query: its pairs, split at
 * their first "=", sorted by encoded name then encoded value, joined by "&"; "" stays "". A pair with no "=" throws an
 * Error naming the defect, which PR 1 routes to the request unchanged.
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

/** PR 1's RequestSigner for one session: service "s3", the empty payload hash, the clock read at send time. */
export function s3Signer(credentials: S3Credentials, region: string, clock: () => Date): RequestSigner {
  return {
    headerNames: ["authorization", "x-amz-date", "x-amz-content-sha256"],
    sign(input: SigningInput) {
      // Read when the request leaves the queue, so a queued request is never signed with a stale date.
      const amzDate = amzDateOf(clock());
      const signed: Record<string, string> = { host: input.host };
      for (const [name, value] of Object.entries(input.headers)) {
        if (name === "range" || name.startsWith("x-amz-")) signed[name] = value;
      }
      signed["x-amz-date"] = amzDate;
      signed["x-amz-content-sha256"] = EMPTY_PAYLOAD_SHA256;
      const authorization = signatureV4(
        {
          method: input.method,
          // PR 1's path grammar is SigV4's UriEncode alphabet, so the wire path is the canonical URI unchanged.
          canonicalUri: input.path,
          canonicalQuery: canonicalQueryOf(input.query),
          headers: signed,
          payloadHash: EMPTY_PAYLOAD_SHA256,
        },
        credentials,
        { region, service: "s3", amzDate },
      );
      return { authorization, "x-amz-date": amzDate, "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 };
    },
  };
}
