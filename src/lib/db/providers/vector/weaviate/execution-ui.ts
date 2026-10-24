import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";
import type { ExecutionUiSpec } from "@/lib/db/execution-ui/types";

/** `weaviate`: the rolled-back notice names `COMMIT`, and the consent card has no deadline chip or sentence. */
export const WEAVIATE_EXECUTION_UI: ExecutionUiSpec = {
  commitKeyword: SQL_COMMIT_KEYWORD,
  consentDeadline: null,
};
