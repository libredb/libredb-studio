import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * No MCP code reads the write reach, recorded or granted.
 *
 * Whether a machine client may read an engine is the grant of `mcp.exposable` and `mcp.statementRead`, held by the
 * agent's read-only profiles on every engine whatever Studio can write there: an engine Studio writes freely is
 * MCP-readable, and one with no write path may not be. So the two answers are independent, and an MCP gate that
 * read the write reach, Studio's grant of it, `GRANTED_WRITE_REACH`, or an engine record's `readOnlyEnforced`, derived
 * from that grant, would tie them. Studio's review of the write reach is the grant register's, which only the grant reader loads
 * (tests/unit/db/claim-record-readers.test.ts).
 */
const REPO = join(import.meta.dir, "../../..");
const MCP = join(REPO, "src", "lib", "mcp");

const SOURCES = readdirSync(MCP, { recursive: true, encoding: "utf8" })
  // readdirSync answers with the platform separator; the assertion names files with "/".
  .map((name) => name.replaceAll("\\", "/"))
  .filter((name) => /\.(c|m)?(t|j)sx?$/.test(name));

/**
 * A static import, a dynamic import() or a require() of the write-reach module, a name it exports, or the name of
 * Studio's grant of the write reach or the read-only answer derived from the grant.
 */
const READS_WRITE_REACH = [
  /(from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*write-reach["']/,
  /\bGRANTED_WRITE_REACH\b/,
  /\breadOnlyEnforced\b/,
  /\bsummarizeWriteReach\b/,
];

const readsWriteReach = (text: string): boolean => READS_WRITE_REACH.some((pattern) => pattern.test(text));

describe("the MCP layer and the write-reach record", () => {
  test.each([
    ["a static import", 'import { summarize } from "@/lib/db/write-reach";'],
    ["a dynamic import", 'const reach = await import("@/lib/db/write-reach");'],
    ["a require", 'const reach = require("../db/write-reach");'],
    ["the summary's name", "summarizeWriteReach(engine);"],
    ["the granted write reach's name", 'import { GRANTED_WRITE_REACH } from "@/lib/db/claim-grants";'],
    ["the read-only answer's name", "const enforced = engine.grants.readOnlyEnforced;"],
  ])("the scan catches %s", (_, text) => {
    expect(readsWriteReach(text)).toBe(true);
  });

  test("the scan passes a file that names neither", () => {
    expect(readsWriteReach('import { GRANTED_MCP_EXPOSABLE } from "@/lib/db/claim-grants";')).toBe(false);
  });

  test("the scan reads the MCP sources", () => {
    expect(SOURCES).toContain("server.ts");
  });

  test("no file under src/lib/mcp names the write reach, recorded or granted, or imports write-reach", () => {
    const readers = SOURCES.filter((name) => readsWriteReach(readFileSync(join(MCP, name), "utf8")));
    expect(readers).toEqual([]);
  });
});
