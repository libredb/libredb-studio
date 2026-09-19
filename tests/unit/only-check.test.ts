import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXCLUDED, findFocusedTests, isScannedFile, runOnlyCheck } from "../../scripts/only-check.mjs";

/**
 * The guard's own guard.
 *
 * A check that refuses a committed `.only` is only worth having if it can fail, so
 * every case here either produces a finding or pins the absence of one. The
 * fixtures are written into a throwaway repository under the OS temp directory
 * rather than committed beside this file: a fixture carrying a real `.only` that
 * lived in this tree would red the very gate it tests, so generating it at run time
 * keeps the tree clean without a path carve-out for a committed fixture.
 *
 * The focused call is composed through a sentinel rather than written out at each
 * use, so the fixture below still reads as the plain test file it is meant to be.
 * It does not hide the string from the guard, and nothing here pretends otherwise:
 * line 25 spells it out, which is exactly why this file is on `EXCLUDED`.
 */

const SENTINEL = "__FOCUSED_SENTINEL__";
const FOCUSED_CALL: string = SENTINEL.replace("__FOCUSED_SENTINEL__", ".only(");

function focused(script: string): string {
  return script.split(SENTINEL).join(FOCUSED_CALL);
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
  test${SENTINEL}"runs, and its siblings are hidden", () => {
    expect(1).toBe(1);
  });
  test("this one is registered and never run", () => {
    expect(2).toBe(2);
  });
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
    const source = focused(`describe${SENTINEL}"a suite", () => {\n  test("a", () => {});\n});\n`);

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toHaveLength(1);
  });

  test("finds a call whose receiver and parenthesis a formatter split across lines", () => {
    const source = focused(`test${SENTINEL}\n  "wrapped by a formatter",\n  () => {},\n);\n`);

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toHaveLength(1);
  });

  test("counts once per call, so three focuses are three findings", () => {
    const source = focused(
      `test${SENTINEL}"a", () => {});\ntest${SENTINEL}"b", () => {});\ntest${SENTINEL}"c", () => {});\n`,
    );

    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: source }])).toHaveLength(3);
  });

  test("a clean file produces nothing", () => {
    expect(findFocusedTests([{ path: "tests/unit/x.test.ts", content: CLEAN_SOURCE }])).toEqual([]);
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

  test("skips its own test, which has to hold the string it searches for", () => {
    // Not an oversight: this file cannot be scanned by the gate it tests, because
    // the fixture that proves the gate can fail is itself a match. See EXCLUDED.
    expect(EXCLUDED).toEqual(["tests/unit/only-check.test.ts"]);
    expect(isScannedFile("tests/unit/only-check.test.ts")).toBe(false);
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

  test("the gate refuses a focus in an e2e spec as well as a unit test", () => {
    const root = repo({
      "e2e/login.spec.ts": focused(
        `import { test } from "@playwright/test";\ntest${SENTINEL}"logs in", async () => {});\n`,
      ),
    });

    expect(runOnlyCheck(root).code).toBe(1);
  });
});
