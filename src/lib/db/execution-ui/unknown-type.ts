import { SQL_COMMIT_KEYWORD } from "./shared";
import type { ExecutionUiSpec } from "./types";

/** What a type string that names no shipped engine gets: the rolled-back notice names `COMMIT`, and no consent deadline. */
export const UNKNOWN_TYPE_EXECUTION_UI: ExecutionUiSpec = {
  commitKeyword: SQL_COMMIT_KEYWORD,
  consentDeadline: null,
};
