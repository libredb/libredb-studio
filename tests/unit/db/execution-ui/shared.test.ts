import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL_COMMIT_KEYWORD } from "@/lib/db/execution-ui/shared";

/** The commit keyword the engine modules share, held to the answer the Task 8.1 golden pins for postgres. */
describe("execution UI shared building block", () => {
  test("SQL_COMMIT_KEYWORD is COMMIT", () => {
    expect(SQL_COMMIT_KEYWORD).toBe("COMMIT");
  });

  test("the postgres golden names it in the rolled-back notice", () => {
    const golden = readFileSync(join(import.meta.dir, "golden", "postgres.txt"), "utf8");
    expect(golden).toContain(`Add ${SQL_COMMIT_KEYWORD} to keep them.`);
  });
});
