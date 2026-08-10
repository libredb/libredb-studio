#!/usr/bin/env node
/**
 * Posture-page drift guard for docs/SECURITY.md.
 *
 * The programme design specified "assert that each linked file exists". That is not enough, and
 * Phase 2 is the evidence: its digest-pinning guard - protecting the one scanner allowed to block a
 * merge - inspected a single physical line and stayed green against the exact downgrade it existed
 * to catch. docs/BACKLOG.md H10 records the same shape on the route-guard allowlist. A check that
 * cannot fail is worse than no check, because it is believed.
 *
 * Seven checks, each of which a deliberate sabotage turns red:
 *
 *   1. RESOLVE  every markdown link in "Enforced in" and "Verified by" points at a real file
 *   2. RUN      every linked path under tests/ or e2e/ is actually executed by a runner
 *   3. PROVE    every "Verified by" link is itself a test - a source file or a policy document
 *               does not count, no matter how real it is (0.4 and 0.5 shipped this exact gap)
 *   4. ACCOUNT  every tests/security/*.test.ts(x) file is named by at least one row
 *   5. CLAIM    Status is from a closed set, and a claim of Implemented/Partial links a verifier
 *   6. COVER    the row IDs are exactly the programme's controls (a zero-row parse fails here)
 *   7. UNIQUE   no row ID repeats (all-16-plus-a-second-0.1 is neither missing nor extra)
 *
 * NOT checked, deliberately and stated on the page itself: whether a linked test actually
 * exercises the control it is linked from. No script can decide that honestly.
 *
 * Pure functions below are unit tested in tests/unit/security-check.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POSTURE = "docs/SECURITY.md";
const COMPONENTS_RUNNER = "tests/run-components.sh";
const PLAYWRIGHT_CONFIG = "playwright.config.ts";
const SECURITY_TEST_DIR = "tests/security";

/** The header that identifies the control table, matched structurally rather than by heading text. */
const CONTROL_HEADER = ["ID", "Control", "Status", "Enforced in", "Verified by"];

/**
 * The programme's control set, written here as a SECOND witness. The page is one statement of what
 * exists; this list is another, and the check is that they agree. Adding a control means editing
 * both - deliberate friction, which is what an inventory is for.
 */
export const PROGRAMME_CONTROL_IDS = [
  "0.1",
  "0.2",
  "0.3",
  "0.4",
  "0.5",
  "1.1",
  "1.2",
  "1.3",
  "1.4",
  "1.5",
  "2.1",
  "2.2",
  "2.3",
  "3.1",
  "3.2",
  "3.3",
];

export const STATUSES = new Set(["Implemented", "Partial", "Not implemented"]);

/** Directories tests/run-core.sh enumerates with `find ... -name '*.test.ts' -o -name '*.test.tsx'`. */
const CORE_TEST_DIRS = ["tests/unit/", "tests/api/", "tests/integration/", "tests/hooks/", "tests/security/"];

/** Splits a markdown row into trimmed cells, dropping the leading and trailing empties. */
function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Returns every markdown table as { header, rows }. A table is a run of consecutive pipe lines
 * whose second line is the delimiter row; anything else starting with a pipe is skipped. Same
 * shape as scripts/readme-check.mjs, deliberately - one markdown parser idiom in this repository.
 */
export function parseTables(markdown) {
  const tables = [];
  const lines = markdown.split("\n");
  let block = [];
  const flush = () => {
    if (block.length >= 3 && /^[\s|:-]+$/.test(block[1]) && block[1].includes("-")) {
      tables.push({ header: cells(block[0]), rows: block.slice(2).map(cells) });
    }
    block = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith("|")) block.push(line);
    else flush();
  }
  flush();
  return tables;
}

/** The control table is the one whose header is exactly the five expected columns. */
export function findControlTable(tables) {
  return (
    tables.find(
      (t) => t.header.length === CONTROL_HEADER.length && t.header.every((c, i) => c === CONTROL_HEADER[i]),
    ) ?? null
  );
}

/**
 * Repository-relative targets of every markdown link in a cell. Page links are written relative to
 * docs/, so a leading "../" is stripped; an absolute URL names nothing in this repository and is
 * skipped rather than reported as a missing file.
 */
export function linkTargets(cell) {
  const targets = [];
  for (const match of cell.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    targets.push(target.replace(/^\.\.\//, ""));
  }
  return targets;
}

/**
 * Whether a linked path is actually executed by one of this repository's three runners.
 *
 * This is the check existence cannot make. A file renamed to *.disabled exists. A test moved from
 * tests/security/ to tests/components/ exists. Neither runs, and a posture page that links one is
 * claiming a verification nobody performs.
 *
 * A path that is not a test at all (a source file in the "Enforced in" column) is not subject to
 * this and reports executed: true - existence is the only claim being made about it. `requireTest`
 * flips that for the "Verified by" column: a control naming the checker script or the policy
 * document itself as its own verifier (0.4, 0.5) is not linking a test, and existence is not the
 * claim a "Verified by" cell makes.
 */
export function isExecuted(target, { componentsRunner, playwrightConfig, requireTest = false }) {
  if (!target.startsWith("tests/") && !target.startsWith("e2e/")) {
    return requireTest ? { executed: false, reason: "not a test" } : { executed: true, reason: "not a test path" };
  }
  if (target.startsWith("e2e/")) {
    const inTestDir = /testDir:\s*["']\.\/e2e["']/.test(playwrightConfig);
    if (inTestDir && target.endsWith(".spec.ts")) return { executed: true, reason: "playwright testDir" };
    return { executed: false, reason: "not collected by playwright.config.ts" };
  }
  const isCoreName = target.endsWith(".test.ts") || target.endsWith(".test.tsx");
  if (isCoreName && CORE_TEST_DIRS.some((dir) => target.startsWith(dir))) {
    return { executed: true, reason: "tests/run-core.sh" };
  }
  if (componentsRunner.includes(target)) return { executed: true, reason: COMPONENTS_RUNNER };
  return { executed: false, reason: `named by neither tests/run-core.sh nor ${COMPONENTS_RUNNER}` };
}

/**
 * Returns violation messages (empty = in sync).
 *
 * `exists` is injected rather than read here so the whole rule set is testable without a
 * filesystem, following checkReadmes in scripts/readme-check.mjs.
 */
export function checkPosture({ posture, componentsRunner, playwrightConfig, exists, securityTestFiles }) {
  const table = findControlTable(parseTables(posture));
  if (!table) {
    return [`${POSTURE}: no control table found (expected a header of exactly: ${CONTROL_HEADER.join(" | ")})`];
  }

  const violations = [];
  const linkedTests = new Set();
  const seenIds = [];

  for (const row of table.rows) {
    const [id, , status, enforced = "", verified = ""] = row;
    seenIds.push(id);

    if (!STATUSES.has(status)) {
      violations.push(
        `${POSTURE}: control ${id} has status '${status}', which is not one of ${[...STATUSES].join(", ")}`,
      );
    }

    const verifiers = linkTargets(verified);
    if (verifiers.length === 0 && (status === "Implemented" || status === "Partial")) {
      violations.push(`${POSTURE}: control ${id} claims '${status}' but links nothing that verifies it`);
    }

    for (const target of linkTargets(enforced)) {
      if (!exists(target)) {
        violations.push(`${POSTURE}: control ${id} links ${target}, which does not exist`);
        continue;
      }
      const { executed, reason } = isExecuted(target, { componentsRunner, playwrightConfig });
      if (!executed) {
        violations.push(`${POSTURE}: control ${id} links ${target}, which is never executed (${reason})`);
      }
    }
    for (const target of verifiers) {
      // Recorded regardless of what follows: the reciprocal check below asks "does some row CLAIM
      // to be verified by this file", not "does that claim also check out" - those are separate
      // violations, and folding them together would hide the missing-file or not-a-test violation
      // behind a second, misleading "no control row claims this test" one.
      linkedTests.add(target);
      if (!exists(target)) {
        violations.push(`${POSTURE}: control ${id} links ${target}, which does not exist`);
        continue;
      }
      // requireTest: true - a "Verified by" cell is a claim that a test verifies the control, and
      // isExecuted's normal existence-is-enough-for-a-source-file allowance would otherwise let a
      // checker script or a policy document stand in for a test that does not exist (0.4, 0.5).
      const { executed, reason } = isExecuted(target, { componentsRunner, playwrightConfig, requireTest: true });
      if (!executed) {
        violations.push(`${POSTURE}: control ${id} links ${target}, which is never executed (${reason})`);
      }
    }
  }

  // The other direction. A control can ship with a test and never reach the page; nothing above
  // would notice, because every row it checked was fine.
  for (const file of securityTestFiles) {
    if (!linkedTests.has(file)) {
      violations.push(`${POSTURE}: ${file} is verified by no control row - add the row or delete the test`);
    }
  }

  const missing = PROGRAMME_CONTROL_IDS.filter((id) => !seenIds.includes(id));
  const extra = seenIds.filter((id) => !PROGRAMME_CONTROL_IDS.includes(id));
  if (missing.length > 0) violations.push(`${POSTURE}: missing ${missing.join(", ")} from the control table`);
  if (extra.length > 0) violations.push(`${POSTURE}: rows ${extra.join(", ")} are not in the programme control set`);

  // Presence alone cannot see this: a page carrying all 16 IDs plus a second "0.1" produces
  // neither a missing nor an extra ID, because both filters only ask "is this ID somewhere in the
  // other list" - never "how many times does it appear here".
  const duplicates = [...new Set(seenIds.filter((id, index) => seenIds.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    violations.push(`${POSTURE}: duplicate control id(s) ${duplicates.join(", ")} in the control table`);
  }

  return violations;
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? path.resolve(import.meta.dirname, "..") : argv[rootFlag + 1];
  const posturePath = path.join(root, POSTURE);
  if (!fs.existsSync(posturePath)) {
    console.error(`ERROR: ${POSTURE} not found in ${root}`);
    process.exit(1);
  }
  const securityDir = path.join(root, SECURITY_TEST_DIR);
  const securityTestFiles = fs.existsSync(securityDir)
    ? fs
        .readdirSync(securityDir)
        .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx"))
        .map((name) => `${SECURITY_TEST_DIR}/${name}`)
        .sort()
    : [];

  const violations = checkPosture({
    posture: fs.readFileSync(posturePath, "utf8"),
    componentsRunner: fs.readFileSync(path.join(root, COMPONENTS_RUNNER), "utf8"),
    playwrightConfig: fs.readFileSync(path.join(root, PLAYWRIGHT_CONFIG), "utf8"),
    exists: (target) => fs.existsSync(path.join(root, target)),
    securityTestFiles,
  });

  if (violations.length > 0) {
    for (const violation of violations) console.error(`ERROR: ${violation}`);
    console.error(`\nFix: bring ${POSTURE} back in line with the repository in this PR.`);
    process.exit(1);
  }
  console.log(
    `OK: ${PROGRAMME_CONTROL_IDS.length} controls documented, ${securityTestFiles.length} security tests accounted for`,
  );
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
