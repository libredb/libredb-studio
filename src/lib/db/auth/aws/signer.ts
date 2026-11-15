/**
 * The signing policy for AWS JSON and Query API requests sent through the text transport
 * (src/lib/db/http/node-transport.ts), over the SigV4 core: the transport calls `sign` once per request, at send
 * time, with the method, Host, path, query, headers and body it is about to write.
 *
 * Signed: host, content-type, every x-amz-* header the request carries, x-amz-date, and x-amz-security-token whenever
 * the credentials hold a session token; the payload hash is the SHA-256 of the exact body. Nothing else a transport
 * sets is signed, since accept-encoding and content-length are the transport's own and Connection is appended by the
 * runtime after the signer runs. Only the path "/" is signed: both protocols post to it, and for every service but one
 * SigV4 encodes any other canonical URI a second time, which this signer does not implement. The query is signed as it
 * is sent, so every name and value must already be RFC 3986-encoded as rfc3986Query builds it: only A-Z a-z 0-9 - . _ ~
 * and upper-case %XX. A form-encoded query, such as endpointUrl builds from URLSearchParams (~ as %7E, a space as +,
 * a bare *), is refused rather than rewritten, since its canonical form is not the one AWS computes.
 *
 * The service name is the caller's; this module names none. Only the credentials the getter returns sign.
 */
import type { RequestSigner, SigningInput } from "@/lib/db/http/node-transport";
import { DatabaseConfigError } from "@/lib/db/errors";
import { AWS_SIGNING_REGION, checkAwsServiceName } from "./endpoints";
import { type AwsCredentials, canonicalQueryOf, payloadSha256, sigV4Headers } from "./sigv4";

export interface AwsSignerOptions {
  /**
   * Read when the transport sends each request. Over typed keys it returns the same object every time; a getter keeps
   * this signature unchanged when a refreshing source arrives, so the caller that adopts one changes no other.
   */
  readonly credentials: () => AwsCredentials;
  /** The scope region, checked against AWS_SIGNING_REGION when the signer is built. */
  readonly region: string;
  /** The signing name, passed by the caller and checked against ^[a-z][a-z0-9-]{1,62}$; this module names none. */
  readonly service: string;
  /** Read when the transport sends each request, so a queued request is never signed with a stale date. */
  readonly clock: () => Date;
}

const REGION_REFUSED = "The AWS signing region must be 1 to 64 letters, digits, hyphens or underscores";
const PATH_REFUSED =
  'The AWS request signer signs only the path "/": the JSON and Query protocols post to it, and any other path would need a second encoding this signer does not implement';
const QUERY_REFUSED =
  "The AWS request signer signs only a query whose every name and value is RFC 3986-encoded, as rfc3986Query builds it: A-Z a-z 0-9 - . _ ~ and upper-case %XX";
/** One name or name=value pair in its canonical form; a pair with no "=" is left to the core, which refuses it. */
const ENCODED_PAIR = /^(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*(?:=(?:[A-Za-z0-9._~-]|%[0-9A-F]{2})*)?$/;
const ROOT = "/";
const CONTENT_TYPE = "content-type";
const AMZ_PREFIX = "x-amz-";

/**
 * headerNames: authorization, x-amz-date, x-amz-security-token. Building refuses, with DatabaseConfigError quoting
 * nothing, a region outside AWS_SIGNING_REGION and a malformed service name, and reads neither the credentials nor the
 * clock. `sign` refuses a path other than "/" and a query that is not RFC 3986-encoded with an Error before it reads
 * either, which the transport hands to the caller unchanged with nothing sent; a query pair with no "=" is refused by
 * the core the same way.
 */
export function createAwsSigner(options: AwsSignerOptions): RequestSigner {
  const { region, service, credentials, clock } = options;
  if (!AWS_SIGNING_REGION.test(region)) throw new DatabaseConfigError(REGION_REFUSED);
  checkAwsServiceName(service);
  return {
    headerNames: ["authorization", "x-amz-date", "x-amz-security-token"],
    sign(input: SigningInput) {
      if (input.path !== ROOT) throw new Error(PATH_REFUSED);
      if (input.query !== "" && !input.query.split("&").every((pair) => ENCODED_PAIR.test(pair))) {
        throw new Error(QUERY_REFUSED);
      }
      const signed: Record<string, string> = {};
      for (const [name, value] of Object.entries(input.headers)) {
        if (name === CONTENT_TYPE || name.startsWith(AMZ_PREFIX)) signed[name] = value;
      }
      return sigV4Headers(
        {
          method: input.method,
          host: input.host,
          canonicalUri: ROOT,
          canonicalQuery: canonicalQueryOf(input.query),
          signed,
          payloadHash: payloadSha256(input.body),
        },
        credentials(),
        { region, service },
        clock(),
      );
    },
  };
}
