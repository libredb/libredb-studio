/**
 * The OAuth server's metadata, read from the API server itself (`/.well-known/oauth-authorization-server`), never
 * through openid-client's discovery: against the API host the issuer check fails (the issuer is the OAuth route), and
 * the issuer host serves no metadata. The document is checked here and reduced to the checked fields, so the code flow
 * can use nothing unchecked: an https issuer, both endpoints on the issuer's origin (a token request carrying the code,
 * the verifier and the client secret can then go nowhere else), and S256. A 404 means the cluster signs in through
 * an external OIDC provider, where this mode cannot run.
 *
 * A checked document is cached for five minutes per API URL; a failure is never cached.
 */

import type { ServerMetadata } from "openid-client";
import { httpsUrl, openShiftApiUrl } from "@/lib/openshift-auth/config";
import { type OpenShiftCallFailureReason, openShiftApiCall } from "@/lib/openshift-auth/http";

const METADATA_PATH = "/.well-known/oauth-authorization-server";
const METADATA_MAX_BYTES = 64 * 1024;
const CACHE_MS = 5 * 60 * 1000;

/** The metadata the code flow uses: the checked fields and nothing else. */
export type OpenShiftServerMetadata = ServerMetadata & {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly code_challenge_methods_supported: string[];
};

export type MetadataReading =
  | { kind: "ok"; metadata: OpenShiftServerMetadata }
  | { kind: "external-oidc" }
  | { kind: "unreachable"; reason: OpenShiftCallFailureReason | "status"; status?: number }
  | { kind: "invalid"; check: string };

const cache = new Map<string, { readonly metadata: OpenShiftServerMetadata; readonly expiresAtMs: number }>();

/** A field that is an https URL without user info, query or fragment, or null. */
function urlField(value: unknown): URL | null {
  return typeof value === "string" ? httpsUrl(value) : null;
}

/** The checks of the document; `check` names the failed field only. */
export function checkOpenShiftMetadata(
  document: unknown,
): { kind: "ok"; metadata: OpenShiftServerMetadata } | { kind: "invalid"; check: string } {
  const fields = document as Record<string, unknown>;
  const issuer = urlField(fields.issuer);
  if (issuer === null) return { kind: "invalid", check: "issuer" };
  for (const field of ["authorization_endpoint", "token_endpoint"] as const) {
    if (urlField(fields[field])?.origin !== issuer.origin) return { kind: "invalid", check: field };
  }
  const methods = fields.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    return { kind: "invalid", check: "code_challenge_methods_supported" };
  }
  return {
    kind: "ok",
    metadata: {
      issuer: fields.issuer as string,
      authorization_endpoint: fields.authorization_endpoint as string,
      token_endpoint: fields.token_endpoint as string,
      code_challenge_methods_supported: methods.filter((method): method is string => typeof method === "string"),
    },
  };
}

/** The checked metadata of OPENSHIFT_API_URL's OAuth server. Throws OpenShiftConfigError on an invalid API URL. */
export async function readOpenShiftMetadata(nowMs = Date.now()): Promise<MetadataReading> {
  const key = openShiftApiUrl().href;
  const cached = cache.get(key);
  if (cached !== undefined && nowMs < cached.expiresAtMs) return { kind: "ok", metadata: cached.metadata };
  const result = await openShiftApiCall({ method: "GET", path: METADATA_PATH, maxBytes: METADATA_MAX_BYTES });
  if (result.kind === "failed") return { kind: "unreachable", reason: result.reason };
  if (result.status === 404) return { kind: "external-oidc" };
  if (result.status < 200 || result.status > 299)
    return { kind: "unreachable", reason: "status", status: result.status };
  let document: unknown;
  try {
    document = JSON.parse(result.body);
  } catch {
    return { kind: "invalid", check: "document" };
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { kind: "invalid", check: "document" };
  }
  const checked = checkOpenShiftMetadata(document);
  if (checked.kind === "ok") cache.set(key, { metadata: checked.metadata, expiresAtMs: nowMs + CACHE_MS });
  return checked;
}

/** Test seam: forgets every cached document. */
export function resetOpenShiftMetadataCache(): void {
  cache.clear();
}
