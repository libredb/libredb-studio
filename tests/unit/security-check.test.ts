import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  checkPosture,
  findControlTable,
  isExecuted,
  linkTargets,
  parseTables,
  PROGRAMME_CONTROL_IDS,
} from "../../scripts/security-check.mjs";

const SCRIPT = path.resolve(import.meta.dir, "../../scripts/security-check.mjs");

/**
 * The guard's own guard. Phase 2's digest-pinning check was structurally unable to fail; these
 * cases exist so this one is not. Each violation family gets a case that PRODUCES it.
 */

const COMPONENTS_RUNNER = `
run_group "Group 0b: Factory singleton" \\
  tests/isolated/factory-singleton.test.ts
`;
const PLAYWRIGHT_CONFIG = `export default defineConfig({ testDir: "./e2e", projects: [] });`;

const HEADER = "| ID | Control | Status | Enforced in | Verified by |";
const DIVIDER = "|---|---|---|---|---|";

function page(rows: string[]): string {
  return ["# Security Posture", "", HEADER, DIVIDER, ...rows, ""].join("\n");
}

function row(id: string, status: string, verified: string, enforced = "[`src/proxy.ts`](../src/proxy.ts)"): string {
  return `| ${id} | Something | ${status} | ${enforced} | ${verified} |`;
}

/** A complete, clean page: one row per programme control, all linking a file that exists and runs. */
function cleanRows(): string[] {
  return PROGRAMME_CONTROL_IDS.map((id) =>
    row(id, "Implemented", `[\`tests/security/c-${id}.test.ts\`](../tests/security/c-${id}.test.ts)`),
  );
}

const CLEAN_SECURITY_TESTS = PROGRAMME_CONTROL_IDS.map((id) => `tests/security/c-${id}.test.ts`);

function run(overrides: Record<string, unknown> = {}) {
  return checkPosture({
    posture: page(cleanRows()),
    componentsRunner: COMPONENTS_RUNNER,
    playwrightConfig: PLAYWRIGHT_CONFIG,
    exists: () => true,
    securityTestFiles: CLEAN_SECURITY_TESTS,
    ...overrides,
  });
}

describe("parseTables and findControlTable", () => {
  test("finds the control table by its header, not by a heading a translator could change", () => {
    const table = findControlTable(parseTables(page(cleanRows())));

    expect(table?.rows).toHaveLength(PROGRAMME_CONTROL_IDS.length);
  });

  test("ignores a table that is not the control table", () => {
    const other = ["| A | B |", "|---|---|", "| 1 | 2 |", ""].join("\n");

    expect(findControlTable(parseTables(other))).toBeNull();
  });

  test("a line starting with a pipe that is not a table is not mistaken for one", () => {
    expect(parseTables("| not a table\nnor this\n")).toEqual([]);
  });
});

describe("linkTargets", () => {
  test("extracts every markdown link target in a cell", () => {
    expect(linkTargets("[`a`](../a.ts), [`b`](../b.ts)")).toEqual(["a.ts", "b.ts"]);
  });

  test("returns nothing for a cell with no link", () => {
    expect(linkTargets("Implemented")).toEqual([]);
  });

  test("ignores an absolute URL, which names nothing in this repository", () => {
    expect(linkTargets("[docs](https://example.com/x)")).toEqual([]);
  });
});

describe("isExecuted", () => {
  const context = { componentsRunner: COMPONENTS_RUNNER, playwrightConfig: PLAYWRIGHT_CONFIG };

  test("a tests/security file is run by tests/run-core.sh", () => {
    expect(isExecuted("tests/security/headers.test.ts", context).executed).toBe(true);
  });

  test("a tests/unit .test.tsx file is run", () => {
    expect(isExecuted("tests/unit/a.test.tsx", context).executed).toBe(true);
  });

  test("a disabled file is NOT run even though it exists", () => {
    expect(isExecuted("tests/security/headers.test.ts.disabled", context).executed).toBe(false);
  });

  test("a tests/isolated file is run only because run-components.sh names it", () => {
    expect(isExecuted("tests/isolated/factory-singleton.test.ts", context).executed).toBe(true);
    expect(isExecuted("tests/isolated/never-listed.test.ts", context).executed).toBe(false);
  });

  test("an e2e spec is run when playwright's testDir is the e2e directory", () => {
    expect(isExecuted("e2e/security-headers.spec.ts", context).executed).toBe(true);
  });

  test("an e2e spec is NOT counted when playwright points somewhere else", () => {
    const moved = { ...context, playwrightConfig: 'export default defineConfig({ testDir: "./other" });' };

    expect(isExecuted("e2e/security-headers.spec.ts", moved).executed).toBe(false);
  });

  test("a source file is not a test and is not subject to this check", () => {
    expect(isExecuted("src/proxy.ts", context).executed).toBe(true);
  });

  test("a non-test file is rejected when the caller requires a test (the Verified by column)", () => {
    expect(isExecuted("SECURITY.md", { ...context, requireTest: true })).toEqual({
      executed: false,
      reason: "not a test",
    });
  });

  test("a real test still passes when the caller requires a test", () => {
    expect(isExecuted("tests/security/headers.test.ts", { ...context, requireTest: true }).executed).toBe(true);
  });
});

describe("checkPosture", () => {
  test("a page in sync produces no violations", () => {
    expect(run()).toEqual([]);
  });

  test("names a linked file that does not exist", () => {
    const violations = run({ exists: (p: string) => p !== "tests/security/c-1.3.test.ts" });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("tests/security/c-1.3.test.ts");
    expect(violations[0]).toContain("does not exist");
  });

  test("names a linked test that exists but never runs", () => {
    const rows = cleanRows();
    rows[0] = row("0.1", "Implemented", "[`t`](../tests/security/c-0.1.test.ts.disabled)");

    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS.filter((f) => f !== "tests/security/c-0.1.test.ts"),
    });

    expect(violations.some((v) => v.includes("is never executed"))).toBe(true);
  });

  test("names a security test that no row accounts for", () => {
    const violations = run({
      securityTestFiles: [...CLEAN_SECURITY_TESTS, "tests/security/orphan.test.ts"],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("tests/security/orphan.test.ts");
    expect(violations[0]).toContain("no control row");
  });

  test("rejects a status outside the closed vocabulary", () => {
    const rows = cleanRows();
    rows[0] = row("0.1", "Shipped", "[`t`](../tests/security/c-0.1.test.ts)");

    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS,
    });

    expect(violations.some((v) => v.includes("Shipped"))).toBe(true);
  });

  test("rejects a claim with nothing verifying it", () => {
    const rows = cleanRows();
    rows[0] = row("0.1", "Implemented", "none yet");

    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS.filter((f) => f !== "tests/security/c-0.1.test.ts"),
    });

    expect(violations.some((v) => v.includes("claims 'Implemented' but links nothing"))).toBe(true);
  });

  test("allows 'Not implemented' to link nothing, because there is nothing to verify", () => {
    const rows = cleanRows();
    rows[0] = row("0.1", "Not implemented", "-");

    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS.filter((f) => f !== "tests/security/c-0.1.test.ts"),
    });

    expect(violations).toEqual([]);
  });

  test("names a programme control the page forgot", () => {
    const violations = checkPosture({
      posture: page(cleanRows().slice(1)),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS.filter((f) => f !== "tests/security/c-0.1.test.ts"),
    });

    expect(violations.some((v) => v.includes("missing 0.1"))).toBe(true);
  });

  test("names a row the programme does not have", () => {
    const rows = [...cleanRows(), row("9.9", "Implemented", "[`t`](../tests/security/c-9.9.test.ts)")];
    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: [...CLEAN_SECURITY_TESTS, "tests/security/c-9.9.test.ts"],
    });

    expect(violations.some((v) => v.includes("not in the programme"))).toBe(true);
  });

  test("rejects a 'Verified by' link that is not a test at all", () => {
    const rows = cleanRows();
    rows[0] = row("0.1", "Implemented", "[`policy`](../SECURITY.md)");
    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS.filter((f) => f !== "tests/security/c-0.1.test.ts"),
    });

    expect(violations.some((v) => v.includes("SECURITY.md") && v.includes("not a test"))).toBe(true);
  });

  test("still allows a non-test source file in the 'Enforced in' column", () => {
    const rows = cleanRows();
    rows[0] = row(
      "0.1",
      "Implemented",
      "[`t`](../tests/security/c-0.1.test.ts)",
      "[`docs/SECURITY.md`](../docs/SECURITY.md)",
    );

    expect(
      checkPosture({
        posture: page(rows),
        componentsRunner: COMPONENTS_RUNNER,
        playwrightConfig: PLAYWRIGHT_CONFIG,
        exists: () => true,
        securityTestFiles: CLEAN_SECURITY_TESTS,
      }),
    ).toEqual([]);
  });

  test("sabotage: a duplicate control id is caught even though every id individually belongs to the programme", () => {
    const rows = [...cleanRows(), row("0.1", "Implemented", "[`t`](../tests/security/c-0.1-again.test.ts)")];
    const violations = checkPosture({
      posture: page(rows),
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: [...CLEAN_SECURITY_TESTS, "tests/security/c-0.1-again.test.ts"],
    });

    expect(violations.some((v) => v.includes("duplicate") && v.includes("0.1"))).toBe(true);
  });

  test("a page whose control table cannot be found fails loudly instead of passing vacuously", () => {
    const violations = checkPosture({
      posture: "# Security Posture\n\nno table here\n",
      componentsRunner: COMPONENTS_RUNNER,
      playwrightConfig: PLAYWRIGHT_CONFIG,
      exists: () => true,
      securityTestFiles: CLEAN_SECURITY_TESTS,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("no control table");
  });
});

describe("security-check CLI", () => {
  // This is the real verifier for control 0.4 ("The security policy states only what the code
  // does"): every other test above proves the RULES are right against synthetic fixtures, but 0.4
  // is a claim about docs/SECURITY.md itself, and only running the checker against the actual
  // repository proves that claim. Docs/SECURITY.md's own 0.4 row links this test.
  test("passes against the real docs/SECURITY.md and the real repository", () => {
    const result = Bun.spawnSync(["node", SCRIPT]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("OK");
  });
});
