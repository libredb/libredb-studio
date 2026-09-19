import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFocusedTests, isScannedFile, runOnlyCheck } from "../../scripts/only-check.mjs";

/**
 * The guard's own guard.
 *
 * A check that refuses a committed `.only` is only worth having if it can fail, so
 * every case here either produces a finding or pins the absence of one. The
 * fixtures are written into a throwaway repository under the OS temp directory
 * rather than committed beside this file: a fixture carrying a real focus that lived
 * in this tree would red the very gate it tests, so generating it at run time keeps
 * the tree clean.
 *
 * The guard reads this file like every other one, and nothing here needs a carve-out
 * to allow that. The focus is assembled from a sentinel instead of being written out,
 * and each fixture names the tail of its own call after that sentinel, so no line here
 * carries the member and an opening parenthesis next to each other - the one spelling
 * that would make the gate report the file that tests it.
 */

const SENTINEL = "__FOCUSED_SENTINEL__";

/**
 * The member a focused call hangs off `test` or `describe`, kept apart from its own
 * parenthesis for the reason above: this file is scanned by the guard it tests.
 */
const ONLY: string = `${".only"}`;

function focused(script: string): string {
  return script.split(SENTINEL).join(ONLY);
}

/** A git repository holding the given files, with a commit so `git ls-files` answers. */
function fixtureRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "only-check-"));
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

  git(["init", "-q", "--initial-branch=main"]);
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  // `git add -A` rather than `git add -- tests e2e`: a fixture repo need not have
  // both roots, and naming a directory a repo does not have is a fatal pathspec.
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=only-check",
    "-c",
    "user.email=only-check@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  return root;
}

const roots: string[] = [];

function repo(files: Record<string, string>): string {
  const root = fixtureRepo(files);
  roots.push(root);
  return root;
}

const CLEAN_SOURCE = `import { describe, expect, test } from "bun:test";

describe("a clean file", () => {
  test("runs", () => {
    expect(1).toBe(1);
  });
  test.skip("is skipped on purpose", () => {});
});
`;

const FOCUSED_SOURCE = focused(`import { describe, expect, test } from "bun:test";

describe("a focused file", () => {
  test${SENTINEL}("runs, and its siblings are hidden", () => {
    expect(1).toBe(1);
  });
  test("this one is registered and never run", () => {
    expect(2).toBe(2);
  });
});
`);

/**
 * The chained form, carrying a member between the focus and the call. bun honours it
 * as it honours a plain focus - the file reports the rows it ran and exits 0 while the
 * sibling that must fail never runs - so the guard has to refuse this too.
 */
const FOCUSED_EACH_SOURCE = focused(`import { describe, expect, test } from "bun:test";

test${SENTINEL}.each([1, 2])("runs one row, and its siblings are hidden", (row) => {
  expect(row).toBeGreaterThan(0);
});
test("this one is registered and never run", () => {
  expect(2).toBe(2);
});
`);

/** The same chain on a suite, which bun honours the same way. */
const FOCUSED_EACH_SUITE_SOURCE = focused(`import { describe, test } from "bun:test";

describe${SENTINEL}.each([["a"]])("a suite", () => {
  test("runs alone", () => {});
});
`);

afterAll(() => {
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("findFocusedTests", () => {
  test("reports the line and text of a focused call", () => {
    const found = findFocusedTests([{ path: "tests/unit/x.test.ts", content: FOCUSED_SOURCE }]);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);
    expect(found[0]?.text).toContain(".only");
  });

  test("reports a describe-level focus too, not only an it-level one", () => {
    const source = focused(`describe${SENTINEL}("a suite", () => {\n  test("a", () => {});\n});\n`);

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toHaveLength(1);
  });

  test("finds a call whose receiver and parenthesis a formatter split across lines", () => {
    const source = focused(`test${SENTINEL}(\n  "wrapped by a formatter",\n  () => {},\n);\n`);

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toHaveLength(1);
  });

  test("finds a chained member between the focus and the call, the row form", () => {
    const found = findFocusedTests([{ path: "tests/unit/x.test.ts", content: FOCUSED_EACH_SOURCE }]);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.text).toContain(".each");
  });

  test("finds the suite form of the same chain, which bun honours the same way", () => {
    const found = findFocusedTests([{ path: "tests/unit/x.test.ts", content: FOCUSED_EACH_SUITE_SOURCE }]);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.text).toContain("describe");
  });

  test("finds a chain the runtime reads as one expression but a line-break splits", () => {
    // `test.only` and its `.each(...)` on separate lines are the same focused call to
    // bun, and a pattern that only admitted them adjacent read this file as clean. It is
    // reported at the line the match starts on.
    const source = focused(`test${SENTINEL}\n  .each([1, 2])("runs per row", () => {});\n`);

    const found = findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }]);

    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(1);
    expect(found[0]?.text).toContain(".only");
  });

  test("does not join a focus that ends a line to a parenthesis on the next one", () => {
    // The other side of that boundary: a comment may end a line with a focus and open
    // the next one with a parenthesis, and no call is written there.
    const prose = "// never commit a .only\n(it hides the rest of the file)\n";

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: prose }])).toEqual([]);
  });

  test("counts once per call, so three focuses are three findings", () => {
    const source = focused(
      `test${SENTINEL}("a", () => {});\ntest${SENTINEL}("b", () => {});\ntest${SENTINEL}("c", () => {});\n`,
    );

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toHaveLength(3);
  });

  test("counts two calls on one line as two, which is the unit a whole-file match gives", () => {
    const source = focused(`test${SENTINEL}("a", () => {}); test${SENTINEL}("b", () => {});\n`);

    const found = findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }]);

    expect(found).toHaveLength(2);
    expect(found.map((entry) => entry.line)).toEqual([1, 1]);
  });

  test("a clean file produces nothing", () => {
    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: CLEAN_SOURCE }])).toEqual([]);
  });

  test("a chained call without a focus is not a finding", () => {
    const source = `test.each([1, 2])("runs per row", (row) => {\n  expect(row).toBeGreaterThan(0);\n});\n`;

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toEqual([]);
  });

  test("the prose this repository is full of is not a call", () => {
    // These are real shapes from the tree: the runner's own assertions say "it.The",
    // "it.Both" and "it.com" in the middle of sentences, and a looser pattern would
    // read any of them as a focused test.
    const prose = [
      "// The runner reads it.The way the report states it, not from stdout.",
      "// it.Both halves matter, and it.com is where the loader reads it.",
      'test("it.only is refused before the run", () => {});',
      "const focused = /[.]only[(]/;",
      "expect(source).toContain('it' + '.only');",
    ].join("\n");

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: prose }])).toEqual([]);
  });

  test("reads spellings rather than a program, and that is where its edge sits", () => {
    // All measured on bun 1.4.2. The first two are focused calls this cannot see: each runs
    // alone, leaves the sibling that must fail unrun and exits 0, and neither carries the
    // spelling being searched for. The third is the other direction - prose that looks like
    // a chain, reported while bun runs every test in the file.
    const bracketLookup = `import { expect, test } from "bun:test";\ntest["only"]("runs", () => {});\ntest("sibling", () => {\n  expect(1).toBe(2);\n});\n`;
    const commentInside = `import { expect, test } from "bun:test";\ntest.only /* why */ ("runs", () => {});\ntest("sibling", () => {\n  expect(1).toBe(2);\n});\n`;
    const proseThatLooksLikeAChain = "/*\n  never commit .only\n  .each(...) hides the rest of the file\n*/\n";

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: bracketLookup }])).toEqual([]);
    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: commentInside }])).toEqual([]);
    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: proseThatLooksLikeAChain }])).toHaveLength(1);
  });

  test("a path that cannot be read is named rather than skipped", () => {
    const found = findFocusedTests([{ path: "tests/unit/gone.test.ts" }], () => {
      throw new Error("ENOENT: no such file");
    });

    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe("tests/unit/gone.test.ts");
    expect(found[0]?.text).toContain("unreadable");
  });
});

describe("isScannedFile", () => {
  test("reads the two directories the runner and Playwright read", () => {
    expect(isScannedFile("tests/unit/x.test.ts")).toBe(true);
    expect(isScannedFile("tests/runner/report.ts")).toBe(true);
    expect(isScannedFile("e2e/login.spec.ts")).toBe(true);
    expect(isScannedFile("tests/helpers/posix-tools.ts")).toBe(true);
    expect(isScannedFile("tests/unit/x.mjs")).toBe(true);
  });

  test("leaves the application, the scripts and type declarations alone", () => {
    expect(isScannedFile("src/app/page.tsx")).toBe(false);
    expect(isScannedFile("scripts/only-check.mjs")).toBe(false);
    expect(isScannedFile("tests/types.d.ts")).toBe(false);
    expect(isScannedFile("docs/AGENT.md")).toBe(false);
  });

  test("reads its own test, which needs no carve-out to be scanned", () => {
    // This file holds the fixtures the gate is tested with and is read like every other
    // one: the focus is assembled from pieces, so no line here matches the pattern the
    // gate searches for.
    expect(isScannedFile("tests/unit/only-check.test.ts")).toBe(true);
  });
});

describe("runOnlyCheck", () => {
  test("a file carrying a focused test fails a required check and names it", () => {
    const root = repo({ "tests/unit/only.test.ts": FOCUSED_SOURCE });

    const { code, lines } = runOnlyCheck(root);

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("tests/unit/only.test.ts");
    expect(lines.join("\n")).toContain("FAIL");
  });

  test("the control fixture passes, so a red run is about the `.only` and nothing else", () => {
    const root = repo({ "tests/unit/clean.test.ts": CLEAN_SOURCE });

    const { code, lines } = runOnlyCheck(root);

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("OK");
  });

  test("naming the line, not just the file, is what makes the failure diagnosable", () => {
    const root = repo({ "tests/unit/only.test.ts": FOCUSED_SOURCE });

    const line = runOnlyCheck(root).lines.find((entry) => entry.includes("only.test.ts"));

    expect(line).toMatch(/only\.test\.ts:4:/);
  });

  test("an untracked draft is not read, because CI cannot see one (#980)", () => {
    const root = repo({ "tests/unit/clean.test.ts": CLEAN_SOURCE });
    fs.writeFileSync(path.join(root, "tests/unit/draft.test.ts"), FOCUSED_SOURCE, "utf8");

    expect(runOnlyCheck(root).code).toBe(0);
  });

  test("an empty enumeration fails loudly instead of passing vacuously", () => {
    const root = repo({ "src/page.tsx": "export default 1;\n" });

    const { code, lines } = runOnlyCheck(root);

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("nothing was checked");
  });

  test("a missing git binary is reported rather than swallowed", () => {
    const { code, lines } = runOnlyCheck(process.cwd(), {
      trackedFiles: () => {
        throw new Error("spawn git ENOENT");
      },
    });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("ENOENT");
  });

  test("a chained focus fails the gate end to end, named with its line", () => {
    const root = repo({ "tests/unit/only-each.test.ts": FOCUSED_EACH_SOURCE });

    const { code, lines } = runOnlyCheck(root);

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("tests/unit/only-each.test.ts:3");
  });

  test("the gate refuses a focus in an e2e spec as well as a unit test", () => {
    const root = repo({
      "e2e/login.spec.ts": focused(
        `import { test } from "@playwright/test";\ntest${SENTINEL}("logs in", async () => {});\n`,
      ),
    });

    expect(runOnlyCheck(root).code).toBe(1);
  });
});
