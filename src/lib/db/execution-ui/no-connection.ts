import { SQL_COMMIT_KEYWORD } from "./shared";
import type { ExecutionUiSpec } from "./types";

/** What a reader gets with no connection: the rolled-back notice names `COMMIT`, and no consent deadline. */
export const NO_CONNECTION_EXECUTION_UI: ExecutionUiSpec = {
  commitKeyword: SQL_COMMIT_KEYWORD,
  consentDeadline: null,
};
