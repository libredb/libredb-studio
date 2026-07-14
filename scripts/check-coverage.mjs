#!/usr/bin/env node
// Enforce 100% line coverage on the merged lcov report.
//
// The project reached 100% on 2026-07-14 (#192/#195/#196) and this guard keeps
// it there: it fails CI the moment any merged DA record reports zero hits, and
// prints the offending file:line ranges so the gap is actionable. Measurement
// quirks (phantom lines from load-only processes, non-executable lines) are
// already handled upstream by scripts/merge-lcov.mjs — anything this script
// flags is a genuine uncovered line.

import fs from "node:fs";

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

function main() {
  const reportPath = process.argv[2] || "coverage/lcov.info";

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

  for (const line of content.split("\n")) {
    if (line.startsWith("SF:")) {
      currentFile = line.slice(3).trim();
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
