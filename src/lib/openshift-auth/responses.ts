/**
 * The answers the two openshift sign-in routes share: the 404 of a route outside the mode, a no-store redirect, the
 * audit line of a refused sign-in, and the reason code of a metadata reading.
 *
 * Redirects are built by hand, because a refusal may land on a path (openShiftLoginPageLocation when the public URL
 * does not read), which `NextResponse.redirect` refuses. An audit sink that throws never changes the redirect.
 */

import { NextResponse } from "next/server";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import type { MetadataReading } from "@/lib/openshift-auth/metadata";
import type { OpenShiftSignInCode } from "@/lib/openshift-auth/redirect";

/** The same body and status any unknown path gets, so a disabled mode does not advertise itself. */
export function notFound(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** A 307 to `location`, never cached. */
export function redirectNoStore(location: string): NextResponse {
  return new NextResponse(null, { status: 307, headers: { location, "cache-control": "no-store" } });
}

/** The `login_failure` audit line of a refused sign-in; the user is `anonymous` until users/~ answered. */
export function auditSignInFailure(route: string, reason: OpenShiftSignInCode, ip: string, user = "anonymous"): void {
  try {
    emitAuditEvent({ type: "login_failure", action: "login", target: route, user, result: "failure", reason, ip });
  } catch {
    logger.error("Failed to record an OpenShift sign-in login_failure audit event", undefined, { route });
  }
}

/** The `login_success` audit line; a broken sink never turns a session that exists into a failure. */
export function auditSignInSuccess(route: string, user: string, ip: string): void {
  try {
    emitAuditEvent({ type: "login_success", action: "login", target: route, user, result: "success", ip });
  } catch {
    logger.error("Failed to record an OpenShift sign-in login_success audit event", undefined, { route });
  }
}

/** The code of a metadata reading that is not `ok`, logged with its fields only. */
export function metadataFailureCode(
  route: string,
  reading: Exclude<MetadataReading, { kind: "ok" }>,
): OpenShiftSignInCode {
  if (reading.kind === "external-oidc") {
    logger.warn("OpenShift sign-in: the cluster serves no OAuth metadata, so it signs in through external OIDC", {
      route,
      step: "metadata",
    });
    return "openshift_external_oidc";
  }
  if (reading.kind === "unreachable") {
    logger.warn("OpenShift sign-in: the API server did not answer the OAuth metadata request", {
      route,
      step: "metadata",
      reason: reading.reason,
      status: reading.status,
    });
    return "openshift_unreachable";
  }
  logger.error("OpenShift sign-in: the OAuth metadata failed a check", undefined, {
    route,
    step: "metadata",
    check: reading.check,
  });
  return "openshift_config";
}
