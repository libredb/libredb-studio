/**
 * Canonical database-operation descriptor model (#328, epic #325).
 *
 * Risk classes R0-R6 grade operations by blast radius; Phase 1 gives only two
 * of them a registrable meaning — R0 (bounded metadata read) and R1 (bounded
 * data read, individually verified against a database-native boundary).
 * Classes 2-6 deliberately have NO registrable representation, not even a
 * disabled slot: `RegistrableOperationDescriptor` structurally cannot express
 * them, and the registry refuses them at runtime for callers that bypass the
 * types. Database-native enforcement (PostgreSQL read-only transaction, SQLite
 * query_only) is the security boundary — nothing in this model trusts a parser.
 */

import type { z } from "zod";
import type { ProviderCapabilities } from "@/lib/db/types";

/** Full R0-R6 risk scale. Only 0 and 1 are registrable — see module doc. */
export type RiskClass = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Registrable access levels. Write/admin levels intentionally do not exist. */
type OperationAccessLevel = "metadata-read" | "data-read";

/** Coarse cost tier consumed by execution budgets (statement/row/concurrency). */
type OperationResourceCost = "light" | "moderate" | "heavy";

/**
 * ProviderCapabilities keys usable as required-capability gates: the boolean
 * affordance flags only. Capabilities stay a UI-affordance contract and a fast
 * deny signal — never the security boundary.
 */
type BooleanProviderCapability = {
  [K in keyof ProviderCapabilities]-?: ProviderCapabilities[K] extends boolean | undefined ? K : never;
}[keyof ProviderCapabilities];

/**
 * Explicit per-descriptor verification marker required to register any
 * risk-class-1 descriptor: who reviewed it and which database-native boundary
 * bounds it. An R1 descriptor without a substantive marker is refused exactly
 * like a class-2+ one.
 */
export interface RiskVerification {
  readonly reviewedBy: string;
  /** The database-native mechanism that bounds the operation (never a parser). */
  readonly boundary: string;
  /** ISO date (YYYY-MM-DD) the verification was recorded. */
  readonly verifiedOn: string;
}

interface OperationDescriptorBase {
  /** Canonical id: two or more lowercase dot-separated segments, e.g. "sql.query.read". */
  readonly id: string;
  readonly accessLevel: OperationAccessLevel;
  readonly requiredCapabilities: readonly BooleanProviderCapability[];
  readonly resourceCost: OperationResourceCost;
  readonly supportsDryRun: boolean;
  /**
   * true = default-denied: the decision pipeline may answer require-approval
   * for this operation, never a plain allow.
   */
  readonly requiresApproval: boolean;
  /** Input contract enforced before any policy evaluation (fail closed). */
  readonly inputSchema: z.ZodType<unknown>;
}

/**
 * The only descriptor shapes that can exist in a registry. R1 requires the
 * verification marker structurally; classes 2-6 are inexpressible.
 */
export type RegistrableOperationDescriptor =
  | (OperationDescriptorBase & { readonly riskClass: 0; readonly verification?: never })
  | (OperationDescriptorBase & { readonly riskClass: 1; readonly verification: RiskVerification });
