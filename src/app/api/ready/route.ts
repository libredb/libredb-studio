import { NextResponse } from "next/server";
import { governanceEnabled } from "@/lib/governance/config";
import {
  READINESS_BY_FRESHNESS,
  READINESS_WITHOUT_GOVERNANCE,
  type ReadinessBodySchema,
  SUPPORTED_CONTRACT_VERSIONS,
} from "@/lib/governance/contract";
import { governanceFreshness } from "@/lib/governance/freshness";
import { governanceState } from "@/lib/governance/state";
import type { z } from "zod";

/** The body of every answer, the readiness body of the conformance manifest (spec 7.5, 7.10). */
export type ReadinessBody = z.infer<typeof ReadinessBodySchema>;

/** The answer is the state of this process at this moment, never one rendered at build time. */
export const dynamic = "force-dynamic";

/** A probe must always see the state of this moment, never a cached answer. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * GET /api/ready: readiness (spec 7.5, 12.1, docs/GOVERNANCE.md). Liveness stays on `/api/db/health`.
 *
 * Public, because an orchestrator's probe carries no session. It reads the in-process governance state only and
 * touches no user database. Without governance it answers 200 `ready`. Under governance it answers the freshness
 * state: 200 `ok`, 200 `degraded` for a degraded and for an unavailable snapshot so that an administrator can still
 * reach the status page, and 503 `loading`, `misconfigured` or `incompatible`, the last two with a `detail` that names
 * the object or privilege, or both version sets.
 *
 * It only reads the state and never starts a load, so an anonymous caller cannot keep loads running back to back
 * during an outage: the refresher of `startGovernance()` already retries while the snapshot is absent or old. The
 * `detail` holds Studio's own words only (the contract object with its SQLSTATE, the keyring variable, or both version
 * sets); the server's or the keyring loader's message stays in the log.
 */
export function GET() {
  if (!governanceEnabled()) {
    const body: ReadinessBody = {
      status: READINESS_WITHOUT_GOVERNANCE.status,
      contract: { supported: [...SUPPORTED_CONTRACT_VERSIONS], active: null },
    };
    return NextResponse.json(body, { status: READINESS_WITHOUT_GOVERNANCE.httpStatus, headers: NO_STORE });
  }
  const freshness = governanceFreshness();
  const { snapshot, failure } = governanceState();
  const answer = READINESS_BY_FRESHNESS[freshness];
  // A version is active only while the snapshot that negotiated it is served: never while loading, and never while
  // the governance source is misconfigured or incompatible, even with an older snapshot kept for the admin status.
  const served = answer.status === "ok" || answer.status === "degraded";
  const body: ReadinessBody = {
    status: answer.status,
    contract: {
      supported: [...SUPPORTED_CONTRACT_VERSIONS],
      active: served ? (snapshot?.contractVersion ?? null) : null,
    },
  };
  // Only these two states stop serving for a cause an operator must fix, and their failure names it.
  if (freshness === "misconfigured" || freshness === "incompatible") body.detail = failure?.publicDetail;
  return NextResponse.json(body, { status: answer.httpStatus, headers: NO_STORE });
}
