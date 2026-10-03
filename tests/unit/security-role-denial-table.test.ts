/**
 * docs/SECURITY.md lists every site that refuses a request on role, in a table, and counts them
 * in the sentence above it.
 *
 * The count was once bumped by one when a route joined, from a base that had already missed the
 * two account-administration routes, so the table and the sentence both undercounted what the
 * Admin Audit tab shows.
 * This test derives the handler set from the source and holds the table and the numerals to it.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../..");
const SECURITY = fs.readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** One entry per `auditRoleDenial(` call, as `file` or `METHOD in file` when one file holds several. */
function sourceSites(): string[] {
  const sites: string[] = [];
  for (const file of walk(path.join(ROOT, "src/app"))) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const calls = text.split("\n").filter((line) => line.includes("auditRoleDenial("));
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (calls.length === 1) sites.push(rel);
    else
      for (const line of calls) {
        const method = /"(GET|POST|PUT|PATCH|DELETE) /.exec(line)?.[1];
        if (!method) throw new Error(`${rel}: a role denial call names no method: ${line.trim()}`);
        sites.push(`${method} in ${rel}`);
      }
  }
  return sites.sort();
}

function tableSites(): string[] {
  const start = SECURITY.indexOf("| site | call |");
  if (start < 0) throw new Error("docs/SECURITY.md has no role-denial table");
  const rows = SECURITY.slice(start).split("\n").slice(2);
  const sites: string[] = [];
  for (const row of rows) {
    if (!row.startsWith("|")) break;
    const cell = row.split("|")[1].trim();
    if (cell === "`src/proxy.ts`") continue;
    sites.push(cell.replace(/`/g, ""));
  }
  return sites.sort();
}

describe("docs/SECURITY.md role-denial table", () => {
  test("names every handler site that calls auditRoleDenial, and no other", () => {
    expect(tableSites()).toEqual(sourceSites());
  });

  test("the sentences count the table's rows", () => {
    const handlers = sourceSites().length;
    const prose = SECURITY.replace(/\s+/g, " ");
    expect(prose).toContain(
      `all ${WORDS[handlers + 1]} sites that refuse on role, ${WORDS[handlers]} in handlers and one in the proxy`,
    );
    expect(prose).toContain(`and the ${WORDS[handlers]} handler sites are the`);
    expect(prose).toContain(`so those ${WORDS[handlers]} reach the tab`);
  });
});
