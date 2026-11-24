#!/usr/bin/env node
// Enforce 100% line coverage on the merged lcov report.
//
// The project reached 100% on 2026-07-14 (#192/#195/#196) and this guard keeps
// it there: it fails CI the moment any merged DA record reports zero hits, and
// prints the offending file:line ranges so the gap is actionable. Measurement
// quirks (phantom lines from load-only processes, non-executable lines) are
// already handled upstream by scripts/merge-lcov.mjs — anything this script
// flags is a genuine uncovered line.
//
// With --packages-from=<root>, every workspace package under <root> that has a src/
// directory (scripts/workspace-packages.mjs) must contribute at least one record:
// a package no test loads has no record at all, so it could never show a gap. The
// root's coverage:check passes it; a partial run's merge and the VS Code extension's
// gate do not, since a package they never load rightly contributes nothing there.

import fs from "node:fs";
import path from "node:path";
import { workspacePackageDirectories } from "./workspace-packages.mjs";

function compressRanges(lines) {
  if (lines.length === 0) return "";
  const out = [];
  let start = lines[0];
  let end = lines[0];
  for (const n of lines.slice(1)) {
    if (n === end + 1) {
      end = n;
      continue;
    }
    out.push(start === end ? `${start}` : `${start}-${end}`);
    start = n;
    end = n;
  }
  out.push(start === end ? `${start}` : `${start}-${end}`);
  return out.join(",");
}

/** `{ reportPath, packagesFrom }` from the command line; exits 1 on a --packages-from with no directory. */
function parseArguments(args) {
  const option = args.find((arg) => arg === "--packages-from" || arg.startsWith("--packages-from="));
  const positional = args.filter((arg) => arg !== option);
  const packagesFrom = option === undefined ? null : option.slice("--packages-from=".length);
  if (packagesFrom === "") {
    console.error("check-coverage: --packages-from needs a directory, as in --packages-from=.");
    process.exit(1);
  }
  return { reportPath: positional[0] || "coverage/lcov.info", packagesFrom };
}

/** The workspace packages under `root` that have a src/ directory and no record in `files`. */
function packagesWithoutRecords(root, files) {
  return workspacePackageDirectories(root).filter(
    (directory) =>
      fs.existsSync(path.join(root, directory, "src")) && !files.some((file) => file.startsWith(`${directory}/src/`)),
  );
}

function main() {
  const { reportPath, packagesFrom } = parseArguments(process.argv.slice(2));

  let content;
  try {
    content = fs.readFileSync(reportPath, "utf8");
  } catch {
    console.error(`check-coverage: cannot read ${reportPath} — run \`bun run test:coverage\` first`);
    process.exit(1);
  }

  let totalLines = 0;
  let coveredLines = 0;
  let currentFile = "";
  const gaps = new Map();
  const files = [];

  for (const line of content.split("\n")) {
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).trim();
      files.push(currentFile);
    } else if (line.startsWith("DA:")) {
      // Gate contract: fail loudly on malformed input instead of producing
      // confusing output (empty filenames, NaN line numbers). The optional
      // third lcov field (checksum) is tolerated and ignored.
      if (!currentFile) {
        console.error(`check-coverage: malformed lcov — DA record before any SF record: "${line}"`);
        process.exit(1);
      }
      const [lineNoRaw, hitsRaw] = line.slice(3).split(",");
      const lineNo = Number(lineNoRaw);
      const hits = Number(hitsRaw);
      if (!Number.isFinite(lineNo) || !Number.isFinite(hits)) {
        console.error(`check-coverage: malformed lcov — non-numeric DA record: "${line}"`);
        process.exit(1);
      }
      totalLines += 1;
      if (hits > 0) {
        coveredLines += 1;
      } else {
        const fileGaps = gaps.get(currentFile) || [];
        fileGaps.push(lineNo);
        gaps.set(currentFile, fileGaps);
      }
    }
  }

  if (packagesFrom !== null) {
    const missing = packagesWithoutRecords(packagesFrom, files);
    if (missing.length > 0) {
      console.error(
        `check-coverage: FAIL, ${missing.length} workspace package(s) have source and no record in ${reportPath}:`,
      );
      for (const directory of missing) {
        console.error(`  ${directory}: no coverage record under ${directory}/src/, so no test loads its source`);
      }
      process.exit(1);
    }
  }

  if (totalLines === 0) {
    console.error(`check-coverage: ${reportPath} contains no DA records`);
    process.exit(1);
  }

  const pct = ((100 * coveredLines) / totalLines).toFixed(2);

  if (gaps.size === 0) {
    console.log(`check-coverage: OK — ${coveredLines}/${totalLines} lines (${pct}%)`);
    return;
  }

  console.error(`check-coverage: FAIL — ${coveredLines}/${totalLines} lines (${pct}%), 100% required`);
  console.error("Uncovered lines:");
  for (const [file, lines] of [...gaps.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.sort((a, b) => a - b);
    console.error(`  ${file}: ${lines.length} line(s) [${compressRanges(lines)}]`);
  }
  process.exit(1);
}

main();
