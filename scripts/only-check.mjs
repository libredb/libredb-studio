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
 * Nothing is excluded: the guard reads every tracked file under `tests/` and `e2e/`,
 * its own test included. That test has to hold the string this guard searches for, so
 * it assembles the call from pieces rather than spelling one out beside its own
 * parenthesis.
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
 * The trailing `(` is what separates a call from the prose, and between the member and
 * that parenthesis only a space or a tab is admitted - not a newline. A line ending in
 * a focus with a parenthetical on the next one is a comment far more often than it is a
 * call, and no formatter puts a break there either: measured against biome 2.5.13 (the
 * version `bun.lock` pins), a long `it.only("a title that runs long", () => {})` at
 * lineWidth 120 wraps inside its arguments.
 *
 * A chained member between `.only` and the call is admitted, and so is whitespace
 * around it including newlines, because the runtime reads every one of these as the
 * same focused call. Measured on bun 1.4.2, one file per form, each ran its own tests,
 * left the sibling that must fail unrun, and exited 0: `test.only.each([1, 2])(...)`,
 * `describe.only.each(...)(...)`, `test.each([...]).only(...)`,
 * `test.concurrent.only(...)`, and `test.only` with `.each([1, 2])(...)` on the next
 * line - one expression to the runtime, and the form an earlier pattern that kept the
 * member adjacent read as clean. It is why `findFocusedTests` matches a whole file
 * rather than one line at a time.
 *
 * The one shape this admits by mistake is prose spelled exactly that way: a line ending
 * in a focus whose next line opens with `.member(`. No file in the tree is written that
 * way, the guard reads the tree clean, and a pattern that refused it could not admit the
 * call above.
 *
 * Both sides of that trade are measured rather than assumed. Prose that only looks like
 * the call - a block comment holding `never commit .only` with `.each(...)` on the next
 * line - is reported while bun runs every test in the file, so the finding is noise a
 * reader dismisses in a second. What this cannot see runs the other way:
 * `test["only"](...)`, and a call with a comment written between the member and its
 * parenthesis, each write their own report and exit 0 on bun 1.4.2 with the sibling that
 * must fail unrun, and neither carries the spelling being searched for. This reads
 * spellings, not a program: a focus reached through a bracket lookup, an alias, or a
 * comment is out of its reach, and no text pattern reaches it.
 */
export const FOCUSED = /\.only(?:\s*\.\s*[A-Za-z_$][\w$]*)*[ \t]*\(/;

/**
 * The same pattern, global, for walking a whole file rather than one line. `matchAll`
 * needs the flag, and `FOCUSED` stays unflagged so that reading it stays stateless.
 */
const EVERY_FOCUS = new RegExp(FOCUSED.source, "g");

/** Whether a tracked path is one this guard reads. */
export function isScannedFile(file) {
  if (file.endsWith(".d.ts")) {
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
 * A file is matched as a whole rather than a line at a time, because the runtime reads
 * a focus and a chained member on separate lines as one call and a per-line scan cannot
 * see one. Each match is reported at the line it starts on, with that line as its text.
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
    for (const match of content.matchAll(EVERY_FOCUS)) {
      // Counting the newlines before the match rather than after it: a match may span
      // several lines, and the line a reader has to open is the one it starts on.
      const line = content.slice(0, match.index).split("\n").length;
      found.push({ path: entry.path, line, text: lines[line - 1].trim() });
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
