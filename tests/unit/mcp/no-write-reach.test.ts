import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No MCP code reads the write-reach record.
 *
 * Whether a machine client may read an engine is `MCP_EXPOSABLE` and `MCP_STATEMENT_READ`'s answer, held by the
 * agent's read-only profiles on every engine whatever Studio can write there: an engine Studio writes freely is
 * MCP-readable, and one with no write path may not be. So the two answers are independent, and an MCP gate that
 * read `WRITE_REACH` would tie them.
 */
const REPO = join(import.meta.dir, "../../..");
const MCP = join(REPO, "src", "lib", "mcp");

const SOURCES = readdirSync(MCP, { recursive: true, encoding: "utf8" })
  // readdirSync answers with the platform separator; the assertion names files with "/".
  .map((name) => name.replaceAll("\\", "/"))
  .filter((name) => /\.(c|m)?(t|j)sx?$/.test(name));

describe("the MCP layer and the write-reach record", () => {
  test("the scan reads the MCP sources", () => {
    expect(SOURCES).toContain("server.ts");
  });

  test("no file under src/lib/mcp names WRITE_REACH or imports write-reach", () => {
    const readers = SOURCES.filter((name) => {
      const text = readFileSync(join(MCP, name), "utf8");
      return text.includes("WRITE_REACH") || /from\s+["'][^"']*write-reach["']/.test(text);
    });
    expect(readers).toEqual([]);
  });
});
