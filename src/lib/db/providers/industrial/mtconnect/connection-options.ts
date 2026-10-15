/**
 * The connection's address as the provider dials it (MT-S6, MT-S7): the scheme and TLS material from
 * the SSL / TLS panel, and the path prefix from the dialog's Path prefix field.
 *
 * Under an SSH tunnel the origin dialled is the local forward, while the certificate is checked
 * against the tunnel's far end, which is the agent the user named.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import { type HttpOrigin, httpOrigin } from "@/lib/db/http/endpoint";
import { type NodeTlsMaterial, nodeTlsMaterial } from "@/lib/db/http/node-transport";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { MTCONNECT_DEFAULT_PORT } from "./capabilities";

export interface MtcEndpoint {
  /** `https` exactly when the SSL / TLS panel gives TLS material. */
  readonly origin: HttpOrigin;
  readonly tls: NodeTlsMaterial | null;
  /** "" or a prefix such as "/mtc", without a trailing "/". */
  readonly pathPrefix: string;
}

const PLAIN_SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;

const PREFIX_NOT_TEXT = "The Path prefix must be text.";
const PREFIX_NO_SLASH = "The Path prefix must begin with /, for example /mtc.";
const PREFIX_NOT_PLAIN =
  "The Path prefix must be a path and nothing else: no query, no fragment, no percent-encoding and no spaces.";
const PREFIX_BAD_SEGMENT = "The Path prefix cannot hold an empty, . or .. segment.";

function prefixError(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, "mtconnect");
}

/** The prefix a reverse proxy puts in front of the agent, checked as a path only (MT-S6). */
export function readPathPrefix(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw prefixError(PREFIX_NOT_TEXT);
  if (!value.startsWith("/")) throw prefixError(PREFIX_NO_SLASH);
  if (value === "/") return "";
  const prefix = value.endsWith("/") ? value.slice(0, -1) : value;
  const segments = prefix.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw prefixError(PREFIX_BAD_SEGMENT);
  }
  if (segments.some((segment) => !PLAIN_SEGMENT.test(segment))) throw prefixError(PREFIX_NOT_PLAIN);
  return prefix;
}

export function mtconnectEndpoint(config: DatabaseConnection & WithTunnelFarEnd): MtcEndpoint {
  const pathPrefix = readPathPrefix(config.apiPath);
  const dialled = httpOrigin("http", config.host, config.port ?? MTCONNECT_DEFAULT_PORT);
  const tls = nodeTlsMaterial(config.ssl, config[TUNNEL_FAR_END]?.host ?? dialled.host);
  return { origin: { ...dialled, scheme: tls === null ? "http" : "https" }, tls, pathPrefix };
}
