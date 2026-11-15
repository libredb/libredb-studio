/**
 * S3's signing policy over the shared SigV4 core (src/lib/db/auth/aws/sigv4.ts): the `RequestSigner` the byte
 * transport (src/lib/db/http/node-transport.ts) calls once per request, at send time.
 *
 * Every request is a GET or HEAD with no body, so the payload hash is the empty-string SHA-256, never
 * UNSIGNED-PAYLOAD, and `x-amz-content-sha256` is always sent, because Garage refuses a request without it. Every
 * `x-amz-*` header a request carries is signed, because Silo refuses an unsigned one, and so is `range`. The service
 * is "s3" and the region is the session's.
 *
 * Only typed credentials sign: this module reads no environment variable, no file and no instance metadata, and
 * imports nothing that could. No module of the provider imports `node:crypto`; the shared core holds every hash.
 */
import { amzDateOf, canonicalQueryOf, EMPTY_PAYLOAD_SHA256, signatureV4 } from "@/lib/db/auth/aws/sigv4";
import type { RequestSigner, SigningInput } from "@/lib/db/http/node-transport";
import type { S3Credentials } from "./connection-options";

/**
 * The byte transport's RequestSigner for one session: service "s3", the empty payload hash, the clock read at send
 * time.
 */
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
          // The byte transport's path grammar is SigV4's UriEncode alphabet, so the wire path is the canonical URI
          // unchanged.
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
