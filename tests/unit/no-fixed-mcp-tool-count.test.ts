/**
 * No doc, comment or test states how many MCP tools there are, lists their names by hand, joins the engines a tool
 * serves into one sentence, or pins a tool to its neighbour's position.
 *
 * The number and the list of tools live in the registry alone: `AGENT_LANGUAGE_MCP_FACETS` declares each statement
 * tool and `MCP_TOOL_INPUT_SCHEMAS` the order they are listed in. A tool that starts serving then edits its own facet,
 * its own `docs/MCP.md` section and its own rows, and no shared line that a second tool landing at the same time
 * would edit too. Tests compute what they expect from the registry and pin it against a hand-written doc, the wire
 * answer, or a second record. The matchers and their reach are described in tests/helpers/fixed-tool-count.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { getDBConfig } from "@/lib/db-ui-config";
import { countFindings, inCountScope } from "../helpers/fixed-tool-count";
import { trackedFiles } from "../helpers/repo-text-scope";

const ROOT = resolve(import.meta.dir, "../..");
const LABELS = SHIPPED_DATABASE_TYPES.map((type) => getDBConfig(type).label);
/** The matchers' own fixture test plants every form this guard refuses, on purpose. */
const FIXTURES = "tests/unit/fixed-tool-count-matcher.test.ts";

describe("no fixed MCP tool count", () => {
  test("no tracked file states a tool count, lists tool names by hand, or pins a tool's neighbour", () => {
    const found = trackedFiles(ROOT)
      .filter((path) => inCountScope(path) && path !== FIXTURES)
      .flatMap((path) => countFindings(path, readFileSync(resolve(ROOT, path), "utf8"), LABELS))
      .map((finding) => `${finding.path}:${finding.line} ${finding.text}`);
    expect(found, "derive the count or list from the registry instead").toEqual([]);
  }, 120_000);
});
