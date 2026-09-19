#!/usr/bin/env node
/**
 * Refuse a committed focused test before the run, not after it.
 *
 * bun honours `.only` by default, and it does so honestly: a file holding `it.only`
 * beside a failing `it`, a `describe.todo` and a `describe.concurrent` writes a
 * junit report of `tests="1" failures="0"`, exits 0, and prints
 * `PASS 0.0s tests/unit/only.test.ts 1 pass`. The same file without the `.only`
 * registers five tests. So four registered tests, one of them failing, are absent
 * from the report, from the run totals and from CI's verdict, and the run is green
 * (measured on bun 1.4.2). `tests/runner/report.ts` reads a file's verdict from
 * that report rather than from its console output, which is what makes a focused
 * file's report trustworthy - and useless, because the file is telling the truth
 * about the one test it ran.
 *
 * The coverage gate is not a second line of defence either: whether it goes red
 * depends on which lines the unrun tests happened to be the only cover for, so a
 * focused file may ship a real gap as easily as it may trip the gate.
 *
 * So this reads the source. It is shape 2 from #979 - one command, no new
 * dependency - and it is a script beside the other `scripts/*-check.mjs` guards
 * rather than a lint rule, because what is wrong is reported as a file and a line
 * rather than as a rule id, and because `docs/TOOLCHAIN.md` records why the lint
 * pipeline is layered the way it is.
 *
 * Scope is the two directories the runner and Playwright read: `tests/` and
 * `e2e/`. Enumeration is `git ls-files`, for the reason #980 gives from the other
 * side - a glob walks whatever is on disk, so an untracked draft in the working
 * tree would red a gate that CI, which checks out tracked files only, cannot see.
 *
 * The pattern is anchored to `.only(` rather than to a bare `only` word, and that
 * is load-bearing rather than cosmetic. A looser `\b(it|test|describe)\s*\.\s*only\b`
 * matches prose the repository is full of - `it.The`, `it.Both`, `it.Reading`,
 * `it.com` and dozens more appear in test titles today - and a bare `\bonly\b`
 * matches `only` in every sentence of every comment. Either would red the whole
 * gate on a clean checkout. A call has a parenthesis and the prose does not.
 *
 * The one path it does not read is its own test, for the reason recorded on
 * `EXCLUDED` below.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The two directories the runner and Playwright read. */
export const SCAN_ROOTS = ["tests", "e2e"];

/**
 * Extensions a focused test can be written in. The `.d.ts` guard is separate
 * because `git ls-files "*.ts"` matches `foo.d.ts` as well, and a declaration file
 * contains no call to focus.
 */
export const TEST_FILE = /\.(?:[cm]?js|tsx?)$/;

/**
 * A focused test call, and only that.
 *
 * The trailing `(` is what separates a call from the prose. A newline between the
 * receiver and the opening parenthesis is admitted because a formatter is entitled
 * to put one there: Biome at lineWidth 120 will wrap a long
 * `it.only("a title that runs long", () => { ... })`.
 */
export const FOCUSED = /\.only\s*\(/;

/**
 * Paths this guard does not read, each with the reason it cannot.
 *
 * Its own test is the whole list, and it has to be. A guard that reads source text
 * cannot both scan a file and be tested by that file: the test has to hold the
 * string it is looking for, so the fixture that proves the gate can fail is itself
 * a string the gate reports. Spelling the call out of concatenated pieces does not
 * help - the literal still has to exist somewhere in the file - and neither does a
 * regex character class, which is simply a second spelling of the same problem.
 *
 * This is the shape every linter that refuses focused tests arrives at, and the
 * cost of it here is bounded and stated rather than hidden: a `.only` committed in
 * this one file would not be refused. It would also not run alone, because that
 * file is a single test file among 643 and is executed in full; the failure mode
 * this guard exists for - a file reporting PASS while its siblings never run -
 * needs the file to be selected, and nothing selects this one.
 *
 * `tests/runner/discover.ts` keeps the same kind of list, with the same kind of
 * docblock, for the two files it runs without coverage.
 */
export const EXCLUDED = ["tests/unit/only-check.test.ts"];

/** Whether a tracked path is one this guard reads. */
export function isScannedFile(file) {
  if (file.endsWith(".d.ts")) {
    return false;
  }
  if (EXCLUDED.includes(file)) {
    return false;
  }
  if (!SCAN_ROOTS.some((root) => file.startsWith(`${root}/`))) {
    return false;
  }
  return TEST_FILE.test(file);
}

/**
 * Every focused test in the given sources, one finding per call.
 *
 * `entries` is a list of `{ path, content? }`. When `content` is absent the file
 * is read through `readFile`, which is defaulted to a filesystem read so the CLI
 * path needs no wiring and injected so the unit test never touches the disk. The
 * path is reported exactly as given, so a caller handing over
 * repository-relative paths gets a message a reader can paste into an editor.
 *
 * A path that cannot be read is named rather than skipped: failing loudly on a
 * file this guard cannot see is its whole job, and a silent skip is the shape of
 * defect it exists to refuse.
 */
export function findFocusedTests(entries, readFile = (file) => fs.readFileSync(file, "utf8")) {
  const found = [];
  for (const entry of entries) {
    let content = entry.content;
    if (content === undefined) {
      try {
        content = readFile(entry.path);
      } catch (error) {
        found.push({ path: entry.path, line: 1, text: `<unreadable: ${error.message}>` });
        continue;
      }
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (FOCUSED.test(line)) {
        found.push({ path: entry.path, line: index + 1, text: line.trim() });
      }
    }
  }
  return found;
}

/**
 * Every tracked file under `SCAN_ROOTS`, as repository-relative `tests/...` paths.
 *
 * Paths are normalised to forward slashes because git answers in the platform's
 * separator on Windows, while every path the guard prints, and every path a
 * docblock or an editor link in this repository uses, is a forward-slashed one.
 */
export function trackedFiles(root, git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" })) {
  const lists = SCAN_ROOTS.map((dir) => {
    // `-z` because git otherwise quotes a path holding a non-ASCII byte, and this
    // repository's own test titles are not ASCII. A quoted path would never match
    // the leading `tests/` that isScannedFile looks for.
    const out = git(["ls-files", "-z", "--", dir]);
    return out
      .split("\0")
      .filter((file) => file !== "")
      .map((file) => file.replace(/\\/g, "/"));
  });
  return lists.flat().filter(isScannedFile);
}

/** Formats one finding as `path:line: text`, the shape an editor can jump to. */
export function report(finding) {
  return `  ${finding.path}:${finding.line}: ${finding.text}`;
}

/** The guard's whole behaviour, in a function: `{ code, lines }`. */
export function runOnlyCheck(root, options = {}) {
  const listTracked = options.trackedFiles ?? trackedFiles;
  const read = options.readFile ?? ((file) => fs.readFileSync(path.join(root, file), "utf8"));

  let files;
  try {
    files = listTracked(root);
  } catch (error) {
    return {
      code: 1,
      lines: [
        `only-check: cannot enumerate tracked files: ${error.message}`,
        `  git is required here: the guard reads what is committed under ${SCAN_ROOTS.join("/ and ")}/, not what is on disk (#980).`,
      ],
    };
  }

  // A broken enumeration must fail loudly rather than pass vacuously, so an empty
  // list is an error and not a green run. The floor is emptiness rather than a
  // count of today's tree, because a count would be a second thing to keep in sync
  // and this guard's job is the `.only`, not the census.
  if (files.length === 0) {
    return {
      code: 1,
      lines: [`only-check: git listed no files under ${SCAN_ROOTS.join("/ or ")}/, so nothing was checked.`],
    };
  }

  const entries = files.map((file) => ({ path: file }));
  const found = findFocusedTests(entries, read);

  if (found.length === 0) {
    return {
      code: 0,
      lines: [`only-check: OK — ${files.length} tracked file(s) under ${SCAN_ROOTS.join("/, ")}/, none focused.`],
    };
  }

  return {
    code: 1,
    lines: [
      `only-check: FAIL — ${found.length} focused test(s) would hide the rest of their file from the run:`,
      ...found.map(report),
      "",
      "  Remove the `.only`. A committed one makes bun run that test alone and still exit 0,",
      "  so every other test in the file is absent from the report, the totals and the verdict.",
    ],
  };
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? process.cwd() : path.resolve(argv[rootFlag + 1]);
  const { code, lines } = runOnlyCheck(root);
  for (const line of lines) {
    if (code === 0) {
      console.log(line);
    } else {
      console.error(line);
    }
  }
  process.exit(code);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
