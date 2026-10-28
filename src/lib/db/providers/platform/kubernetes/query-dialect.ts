import type { DialectSpec } from "@/lib/db/query-dialects";
import { CREDENTIAL_FLAGS } from "./console/commands";

/**
 * The kubectl dialect's record in `QUERY_DIALECTS`: one statement of a read-only kubectl subset. Its grids are the API
 * server's own columns, so no profile, model or count statement of its grammar applies, and neither SQL export format
 * applies.
 *
 * A line pasted from a shell may carry kubectl's credential flags or a Secret's values, which the console refuses;
 * query history keeps none of their values. The flags are the console's own list, so the two cannot drift.
 */
export const KUBECTL_QUERY_DIALECT: DialectSpec = Object.freeze({
  tabType: "kubectl",
  offersColumnProfiling: false,
  offersCodeGeneration: false,
  offersCountQuery: false,
  offersSqlExport: false,
  historyMask: Object.freeze({ credentialFlags: CREDENTIAL_FLAGS }),
});
