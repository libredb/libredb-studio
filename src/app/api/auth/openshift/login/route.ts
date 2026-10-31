/**
 * GET /api/auth/openshift/login: the start of openshift sign-in (NEXT_PUBLIC_AUTH_PROVIDER=openshift).
 *
 * Outside the mode it answers the 404 of an unknown path and touches nothing. In it: the loop guard first (a session
 * record that went missing twice in a row stops on Studio's page instead of the cluster's), then the configuration and
 * the client secret file (checked readable and non-empty, never read here), then the OAuth metadata, then the signed
 * state cookie and a redirect to the cluster's authorize endpoint. Every refusal lands on the login page with its code;
 * every answer is `no-store`.
 */

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { RETURN_PATH_PARAM, safeReturnPath } from "@/lib/api/session-ended";
import { clientAddress } from "@/lib/api/client-address";
import { cookieDeletion } from "@/lib/auth-cookies";
import { studioCookie } from "@/lib/studio-cookie";
import { AuthConfigError } from "@/lib/auth-errors";
import { getBasePath } from "@/lib/config/base-path";
import { authProviderSetting } from "@/lib/config/auth-provider";
import { ACCESS_REVIEW_RETRY_COOKIE, retryLoopTripped } from "@/lib/kubernetes-access/session-guard";
import { logger } from "@/lib/logger";
import {
  openShiftApiUrl,
  openShiftCallbackUrl,
  openShiftClientId,
  openShiftTokenFilePath,
} from "@/lib/openshift-auth/config";
import { tokenFileReady } from "@/lib/openshift-auth/files";
import { openShiftAuthorizationUrl } from "@/lib/openshift-auth/flow";
import { readOpenShiftMetadata } from "@/lib/openshift-auth/metadata";
import { type OpenShiftSignInCode, openShiftLoginPageLocation } from "@/lib/openshift-auth/redirect";
import { auditSignInFailure, metadataFailureCode, notFound, redirectNoStore } from "@/lib/openshift-auth/responses";
import { encryptOpenShiftState, OPENSHIFT_STATE_COOKIE, openShiftStateCookiePath } from "@/lib/openshift-auth/state";

const ROUTE = "GET /api/auth/openshift/login";
/** The state cookie lives as long as the signed state inside it. */
const STATE_MAX_AGE_SECONDS = 300;

function refuse(code: OpenShiftSignInCode, ip: string): NextResponse {
  auditSignInFailure(ROUTE, code, ip);
  return redirectNoStore(openShiftLoginPageLocation(code));
}

function configFailure(ip: string): NextResponse {
  logger.error("OpenShift sign-in is not configured correctly", undefined, { route: ROUTE });
  return refuse("openshift_config", ip);
}

/** The configuration a sign-in needs; throws OpenShiftConfigError, and false for an unusable client secret file. */
function configurationReady(): boolean {
  openShiftClientId();
  openShiftCallbackUrl();
  openShiftApiUrl();
  return tokenFileReady(openShiftTokenFilePath());
}

export async function GET(request: Request): Promise<NextResponse> {
  if (authProviderSetting() !== "openshift") return notFound();
  const ip = clientAddress(request);
  try {
    const cookieStore = await cookies();
    const marker = await studioCookie(ACCESS_REVIEW_RETRY_COOKIE, getBasePath() || "/");
    if (retryLoopTripped(cookieStore.get(marker.name)?.value)) {
      cookieStore.delete(cookieDeletion(marker));
      logger.info("OpenShift sign-in: the loop guard tripped, so the sign-in page shows instead", {
        route: ROUTE,
        loop: true,
      });
      return refuse("openshift_session_lost", ip);
    }
    if (!configurationReady()) return configFailure(ip);
    const reading = await readOpenShiftMetadata();
    if (reading.kind !== "ok") return refuse(metadataFailureCode(ROUTE, reading), ip);
    const returnTo = safeReturnPath(new URL(request.url).searchParams.get(RETURN_PATH_PARAM));
    const { url, state } = await openShiftAuthorizationUrl(reading.metadata, returnTo);
    const stateScope = await studioCookie(OPENSHIFT_STATE_COOKIE, openShiftStateCookiePath());
    cookieStore.set(stateScope.name, await encryptOpenShiftState(state), {
      httpOnly: true,
      secure: stateScope.secure,
      sameSite: "lax",
      maxAge: STATE_MAX_AGE_SECONDS,
      path: stateScope.path,
    });
    return redirectNoStore(url.href);
  } catch (error) {
    // Reduced to its class: an error object never reaches the log.
    if (error instanceof AuthConfigError) return configFailure(ip);
    logger.error("OpenShift sign-in failed", undefined, { route: ROUTE });
    return refuse("openshift_failed", ip);
  }
}
