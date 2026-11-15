/**
 * The transport options of every request to a credential endpoint (a token endpoint, a metadata server), built in one
 * place so no caller can loosen them: one socket, TLS checked against the origin's host when https, a 101 answer
 * refused, and link-local addresses refused unless the lane is a metadata endpoint, which lives at one.
 *
 * Only files of src/lib/db/auth import this module: no provider builds an auth lane, so no provider can turn the
 * link-local refusal off for an origin it chose.
 */
import type { HttpOrigin } from "@/lib/db/http/endpoint";
import type { NodeTransportOptions } from "@/lib/db/http/node-transport";

export interface AuthLaneSpec {
  readonly origin: HttpOrigin;
  /** Connection headers; none when absent. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The lower-case names a request may carry in its own headers; none when absent. */
  readonly requestHeaderNames?: readonly string[];
  /** True only for a metadata endpoint, which lives at a link-local address. Absent: link-local addresses refused. */
  readonly linkLocalEndpoint?: true;
}

/**
 * maxSockets 1; TLS checked against origin.host when https, null when http; refusesUpgrade true; refusesLinkLocal
 * true unless linkLocalEndpoint, and then the key is omitted.
 */
export function authLaneOptions(spec: AuthLaneSpec): NodeTransportOptions {
  return {
    origin: spec.origin,
    tls: spec.origin.scheme === "https" ? { rejectUnauthorized: true, identity: spec.origin.host } : null,
    maxSockets: 1,
    headers: spec.headers ?? {},
    ...(spec.requestHeaderNames === undefined ? {} : { requestHeaderNames: spec.requestHeaderNames }),
    ...(spec.linkLocalEndpoint === true ? {} : { refusesLinkLocal: true }),
    refusesUpgrade: true,
  };
}
