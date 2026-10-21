import type { ExecutionUiSpec } from "@/lib/db/execution-ui/types";

/** `redis`: the rolled-back notice names `EXEC`, and the consent card has no deadline chip or sentence. */
export const REDIS_EXECUTION_UI: ExecutionUiSpec = {
  // A redis open transaction is a `MULTI`, and its keyword is `EXEC`. D74 gave the single-statement route the
  // same `finally` as the script route, and `redis` implements the surface, so the rolled-back notice reaches a
  // reader whose open transaction is a `MULTI`. Naming `COMMIT` tells them to type a command their engine does
  // not have.
  commitKeyword: "EXEC",
  consentDeadline: null,
};
