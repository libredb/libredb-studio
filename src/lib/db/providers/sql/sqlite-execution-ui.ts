import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";
import type { ExecutionUiSpec } from "@/lib/db/execution-ui/types";

/** `sqlite`: the rolled-back notice names `COMMIT`, and the consent card carries the killed-at-its-timeout chip and sentence. */
export const SQLITE_EXECUTION_UI: ExecutionUiSpec = {
  commitKeyword: SQL_COMMIT_KEYWORD,
  /**
   * The one sentence that is true of SQLite and of nothing else, in the words the budget meter
   * already uses for the same fact: an on-disk SQLite read that overruns its timeout is now
   * killed mid-flight, so only the in-memory database keeps the old blocking behaviour.
   */
  consentDeadline: {
    chip: "SQLite: killed at its timeout",
    sentence:
      "On SQLite a read that runs past its timeout is now killed mid-flight; the in-memory database is the exception and still blocks this application until the read finishes.",
  },
};
