/**
 * The replay helper of the Neo4j captures: a run is answered by exactly one capture, so two files that
 * capture the same database and statement are refused instead of one silently answering for the other.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordedGraphClient } from "../../../helpers/neo4j-fixtures";
import path from "node:path";

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

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const CAPTURES_README = read("tests/fixtures/neo4j/5.26.31/README.md");
const COMPOSE = read("database-compose.yml");

describe("the capture README, the compose image and the committed MCP run", () => {
  test("the cancellation measurement is the capture README's, and the R02 wording is the client's docblock", () => {
    const rejected = /rejected the run (\S+ ms) later/.exec(CAPTURES_README)?.[1];
    const left = /left `SHOW TRANSACTIONS` (\S+ ms) after the abort/.exec(CAPTURES_README)?.[1];
    expect(rejected).toBeDefined();
    expect(left).toBeDefined();
    const wording =
      "`session.close()` returns in 1 to 3 ms and the transaction leaves `SHOW TRANSACTIONS` within 1.5 s";
    expect(read("src/lib/db/graph/bolt/bolt-client.ts").replaceAll("\n * ", " ")).toContain(wording);
  });

  test("the compose file pins the image by digest, and the capture README records that digest", () => {
    const image = /image: (neo4j:[^@\s]+)@(sha256:[0-9a-f]{64})/.exec(COMPOSE);
    expect(image).not.toBeNull();
    const [, , digest] = image as RegExpExecArray;
    expect(CAPTURES_README).toContain(digest);
  });

  test("the fixture README gives the seed's size", () => {
    expect(read("docker/neo4j/README.md")).toContain("30 nodes and 40 relationships");
  });

  test("the MCP timeout and cancel measurements are the committed capture's", () => {
    const RUN = read("tests/fixtures/neo4j/5.26.31/mcp-boundary/run.txt");
    const timeout = /answered in (\d+) ms, and the server ended the statement (\d+) ms later/.exec(RUN);
    const close = /a client close: answered in (\d+) ms, and the statement ran on the server (\d+) ms more/.exec(RUN);
    expect(timeout).not.toBeNull();
    expect(close).not.toBeNull();
  });
});
