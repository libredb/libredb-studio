/**
 * The replay helper of the Neo4j captures: a run is answered by exactly one capture, so two files that
 * capture the same database and statement are refused instead of one silently answering for the other.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const dirs: string[] = [];

function fixtures(files: Record<string, { statement: string; database: string | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), "neo4j-captures-"));
  dirs.push(dir);
  for (const [name, { statement, database }] of Object.entries(files)) {
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({
        $captured: { image: "neo4j", digest: "sha256:0", date: "2026-10-03T00:00:00.000Z", database },
        statement,
        options: { database, maxRows: 0 },
        outcome: "pass",
        result: { fields: [], rows: [], truncated: false, queryType: "s" },
      }),
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recordedGraphClient", () => {
  test("refuses two captures of the same database and statement, naming both files", () => {
    const dir = fixtures({
      a: { statement: "EXPLAIN SHOW INDEXES", database: "neo4j" },
      b: { statement: "EXPLAIN SHOW INDEXES", database: "neo4j" },
    });
    expect(() => recordedGraphClient(dir)).toThrow(/^(a\.json and b\.json|b\.json and a\.json) both capture/);
  });

  test("keeps the same statement on two databases apart", async () => {
    const dir = fixtures({
      a: { statement: "EXPLAIN SHOW INDEXES", database: "neo4j" },
      b: { statement: "EXPLAIN SHOW INDEXES", database: "other" },
    });
    const client = recordedGraphClient(dir);
    expect(await client.run("EXPLAIN SHOW INDEXES", { database: "other", timeoutMs: 1, maxRows: 0 })).toMatchObject({
      queryType: "s",
    });
  });

  test("loads the committed 5.26.31 captures, each key once", () => {
    expect(() => recordedGraphClient()).not.toThrow();
  });
});
