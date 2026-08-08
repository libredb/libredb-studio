#!/usr/bin/env node
/**
 * Localized README drift guard.
 *
 * README_zh.md and README_ja.md (#317) restate two things README.md already
 * says: which engines exist, and what the install commands are. Both are
 * hardcoded in all three files, and the repo has no other check that notices
 * when they diverge - `distribution:check` covers channels.yaml, `chart:check`
 * covers the chart, nothing covered this. Review of #317 found a Homebrew row
 * missing its mandatory `brew trust`, a Snap row missing `sudo`, and a Helm row
 * that added a repo without installing anything; the next provider to land will
 * leave both translations claiming the old engine count.
 *
 * Two invariants, chosen so that abridgement stays legal and errors do not:
 *
 *   1. The engine name set is identical in all three files. A translation that
 *      omits an engine is wrong, and so is one that invents an engine.
 *   2. Every command in a localized install table appears verbatim in
 *      README.md's. Localized files may list fewer channels - they deliberately
 *      drop Chocolatey and the portable zip - but may not paraphrase a command.
 *
 * Tables are located structurally (the table holding the PostgreSQL row, the
 * table holding `docker run`) rather than by heading text, because the headings
 * are in Chinese and Japanese.
 *
 * Pure functions below are unit tested in tests/unit/readme-check.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL = "README.md";
const LOCALIZED = ["README_zh.md", "README_ja.md"];

/** Splits a markdown row into trimmed cells, dropping the leading/trailing empties. */
function cells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Returns every markdown table as { header, rows }. A table is a run of
 * consecutive pipe lines whose second line is the delimiter row; anything else
 * that happens to start with a pipe is skipped.
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
    if (line.trim().startsWith("|")) {
      block.push(line);
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

/** The engine table is the one carrying the PostgreSQL row. */
export function findEngineTable(tables) {
  return tables.find((t) => t.rows.some((r) => r[0] === "**PostgreSQL**")) ?? null;
}

/** The install table is the one carrying the Docker run command. */
export function findInstallTable(tables) {
  return tables.find((t) => t.rows.some((r) => r.some((c) => c.includes("docker run")))) ?? null;
}

/** Engine names in document order, from the bolded first cell of each row. */
export function engineNames(table) {
  return table.rows.map((r) => /^\*\*(.+?)\*\*$/.exec(r[0] ?? "")?.[1]).filter((name) => name !== undefined);
}

/**
 * Every code span in the table's command column, in document order.
 *
 * Restricted to one column deliberately. README.md's install table carries a
 * Notes column whose code spans (`brew update`, `sudo snap logs
 * libredb-studio`, `libredb-studio.exe`) are not install commands; admitting
 * them to the canonical set would let a localized file put a note in its
 * Command cell and still pass. Both table shapes - Channel/Command/Notes in
 * README.md, and the two-column translations - put the command in column 1.
 */
export function commandSpans(table, columnIndex = 1) {
  const spans = [];
  for (const row of table.rows) {
    const cell = row[columnIndex];
    if (cell === undefined) {
      continue;
    }
    for (const match of cell.matchAll(/`([^`]+)`/g)) {
      spans.push(match[1]);
    }
  }
  return spans;
}

/**
 * Returns violation messages (empty = in sync). `localized` is a list of
 * { name, text }; a file that could not be read is simply not passed in.
 */
export function checkReadmes({ canonical, localized }) {
  const violations = [];
  const canonicalTables = parseTables(canonical);
  const canonicalEngineTable = findEngineTable(canonicalTables);
  const canonicalInstallTable = findInstallTable(canonicalTables);
  if (!canonicalEngineTable) {
    return [`${CANONICAL}: no engine table found (expected a table with a **PostgreSQL** row)`];
  }
  if (!canonicalInstallTable) {
    return [`${CANONICAL}: no install table found (expected a table containing 'docker run')`];
  }
  const canonicalEngines = engineNames(canonicalEngineTable);
  const canonicalCommands = new Set(commandSpans(canonicalInstallTable));

  for (const { name, text } of localized) {
    const tables = parseTables(text);
    const engineTable = findEngineTable(tables);
    const installTable = findInstallTable(tables);
    if (!engineTable) {
      violations.push(`${name}: no engine table found (expected a table with a **PostgreSQL** row)`);
      continue;
    }
    if (!installTable) {
      violations.push(`${name}: no install table found (expected a table containing 'docker run')`);
      continue;
    }
    const engines = engineNames(engineTable);
    const missing = canonicalEngines.filter((e) => !engines.includes(e));
    const extra = engines.filter((e) => !canonicalEngines.includes(e));
    if (missing.length > 0 || extra.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
      if (extra.length > 0) parts.push(`not in ${CANONICAL}: ${extra.join(", ")}`);
      violations.push(`${name}: engine table out of sync with ${CANONICAL} (${parts.join("; ")})`);
    }
    for (const command of commandSpans(installTable)) {
      if (!canonicalCommands.has(command)) {
        violations.push(`${name}: install command \`${command}\` does not appear verbatim in ${CANONICAL}`);
      }
    }
  }
  return violations;
}

function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag === -1 ? path.resolve(import.meta.dirname, "..") : argv[rootFlag + 1];
  const canonicalPath = path.join(root, CANONICAL);
  if (!fs.existsSync(canonicalPath)) {
    console.error(`ERROR: ${CANONICAL} not found in ${root}`);
    process.exit(1);
  }
  const localized = LOCALIZED.filter((name) => fs.existsSync(path.join(root, name))).map((name) => ({
    name,
    text: fs.readFileSync(path.join(root, name), "utf8"),
  }));
  const violations = checkReadmes({ canonical: fs.readFileSync(canonicalPath, "utf8"), localized });
  if (violations.length > 0) {
    for (const violation of violations) console.error(`ERROR: ${violation}`);
    console.error(`\nFix: bring the localized READMEs back in line with ${CANONICAL} in this PR.`);
    process.exit(1);
  }
  const engineCount = engineNames(findEngineTable(parseTables(fs.readFileSync(canonicalPath, "utf8")))).length;
  const names = localized.map((l) => l.name).join(", ") || "none";
  console.log(`OK: ${engineCount} engines and the install commands match ${CANONICAL} in ${names}`);
}

// CLI entry only when executed directly (the unit test imports this module).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
