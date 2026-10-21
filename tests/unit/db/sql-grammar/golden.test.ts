/**
 * Golden snapshots of what every engine's SQL grammar produces today, through the public
 * functions that read it. `UPDATE_GOLDEN=1 bun tests/run-tests.ts tests/unit/db/sql-grammar/golden.test.ts`
 * rewrites the files; a run without it compares against them.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactStatement } from "@/lib/query-events/redact";
import type { DatabaseType } from "@/lib/types";
import { GOLDEN_KEYS, REDACTION_STATEMENTS, renderGolden } from "./fixtures";

const GOLDEN_DIR = join(import.meta.dir, "golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

describe("sql grammar golden output", () => {
  for (const key of GOLDEN_KEYS) {
    test(key, () => {
      const file = join(GOLDEN_DIR, `${key}.txt`);
      const actual = renderGolden(key);
      if (UPDATE) {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(file, actual);
        throw new Error("golden files written, commit them");
      }
      expect(existsSync(file)).toBe(true);
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }
});

describe("engines whose statement text is not redacted SQL", () => {
  for (const id of ["couchbase", "druid", "libredb"] as const satisfies readonly DatabaseType[]) {
    test(`${id} redacts every statement to ?`, () => {
      for (const statement of REDACTION_STATEMENTS) {
        expect(redactStatement(statement, id).statement).toBe("?");
      }
    });
  }
});
