/**
 * The BACKLOG entries the Firestore provider files (spec 13), each under its own heading, and the B entry cited from
 * docs/AGENT.md beside the other engines that have no agent execution, which is the owner's two-way invariant. The
 * section index's ranges and counts are held by tests/unit/backlog-structure.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const BACKLOG = readFileSync(path.join(ROOT, "docs/BACKLOG.md"), "utf8");
const AGENT = readFileSync(path.join(ROOT, "docs/AGENT.md"), "utf8");
const DOC = readFileSync(path.join(ROOT, "docs/providers/firestore.md"), "utf8");

const ENTRIES = [
  "### D293. Firestore connections cannot write",
  "### D294. The Google credential and token code exists twice",
  "### D295. Firestore Pipelines are not offered",
  "### D296. A Firestore database in Datastore mode is refused",
  "### D297. Firestore's MongoDB-compatible API is reached only through the `mongodb` type, unmeasured",
  "### D298. Firestore has no Firebase Auth user sign-in",
  "### D299. Firestore has no service-account impersonation",
  "### D300. Firestore regional endpoints are not offered",
  "### D301. The Firestore console has no `limitToLast`",
  "### D302. Firestore has no point-in-time reads",
  "### D303. The Firestore console has no bytes literal",
  "### D304. Firestore's Enterprise BSON types are shown but not typed for editing or filtering",
  "### D305. No CI job runs the Firestore emulator",
  "### D306. A BigQuery connection sends its access token to the BigQuery emulator host",
  "### U115. A billed engine has no read budget meter",
  "### U116. The grid shows an absent field and a stored null alike",
  "### U117. The Keys panel counts a key and its folder as two entries",
  "### DOC22. docs/ADDING_A_PROVIDER.md names none of six guards a new provider meets",
  "### B107. Firestore has no agent execution and no MCP surface",
];

describe("the Firestore BACKLOG entries (spec 13, and spec 14's two filings)", () => {
  test.each(ENTRIES)("%s", (heading) => {
    const lines = BACKLOG.split("\n");
    const at = lines.indexOf(heading);
    expect(at).toBeGreaterThan(-1);
    const body = lines.slice(
      at + 1,
      lines.findIndex((line, index) => index > at && line.startsWith("### ")),
    );
    expect(body.some((line) => line.startsWith("**Done when:**"))).toBe(true);
  });

  test("the B entry is cited from docs/AGENT.md and from the provider doc", () => {
    expect(AGENT).toContain("- **B107**: Firestore is served by plan mode only");
    expect(DOC).toContain("B107");
  });

  test("no entry uses a blame word", () => {
    const firestore = BACKLOG.split("\n### ").filter((block) =>
      ENTRIES.some((heading) => heading.startsWith(`### ${block.split(".")[0]}.`)),
    );
    expect(firestore).toHaveLength(ENTRIES.length);
    for (const block of firestore) expect(block).not.toMatch(/\b(bug|defect|broken|wrong)\b/i);
  });
});
