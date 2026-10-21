/**
 * Each provider doc keeps a `SQL grammar` subsection that states the facts its engine's grammar module declares:
 * the module path, the grammar constant it uses, `readsSqlText` and the redaction kind. The facts are read from the
 * registry and the module source, so a doc that drifts from its module fails here (the code, docs and tests triad).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import type { DatabaseType } from "@/lib/types";
import { engineModules, ROOT } from "./engine-modules";

const HEADING = /^(#{2,4}) (?:[\d.]+ )?SQL grammar$/m;

/** The subsection under the `SQL grammar` heading, to the next heading of the same or a higher level. */
function grammarSubsection(doc: string): string | null {
  const match = HEADING.exec(doc);
  if (match === null) return null;
  const level = match[1].length;
  const rest = doc.slice(match.index + match[0].length);
  const next = new RegExp(`^#{1,${level}} `, "m").exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/** Every Markdown file under `dir`, recursively. */
function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

const MODULES = engineModules();

describe("provider docs state their SQL grammar facts", () => {
  test("every type id has a grammar module to document", () => {
    expect(MODULES.map((engine) => engine.id)).toEqual(Object.keys(SQL_GRAMMAR).sort());
  });

  for (const engine of MODULES) {
    const id = engine.id as DatabaseType;
    test(`docs/providers/${id}.md`, () => {
      const doc = readFileSync(join(ROOT, "docs", "providers", `${id}.md`), "utf8");
      const section = grammarSubsection(doc);
      expect(section, `${id}.md has no "SQL grammar" heading`).not.toBeNull();
      const body = section ?? "";

      // Docs cite the module with forward slashes, the separator `relative` uses on Windows is a backslash.
      expect(body).toContain(relative(ROOT, engine.path).split(sep).join("/"));

      const constant = readFileSync(engine.path, "utf8").match(/^\s*grammar:\s*([A-Z0-9_]+)/m)?.[1];
      expect(constant, `${engine.path} names no grammar constant`).toBeDefined();
      expect(body).toContain(`\`${constant}\``);

      const spec = SQL_GRAMMAR[id];
      expect(body).toMatch(new RegExp(`readsSqlText\`? (?:is )?\`${spec.readsSqlText}\``));
      expect(body).toContain(`\`${spec.redaction.kind}\``);
      if (spec.redaction.kind === "sql") {
        // The name quote decides whether a quoted run is kept as a name or masked as a literal.
        const { nameQuote } = spec.redaction;
        const quote =
          nameQuote === null
            ? "no name quote"
            : nameQuote === "`"
              ? "a backtick as its name quote"
              : `\`${nameQuote}\` as its name quote`;
        expect(body).toContain(`Redaction is \`sql\` with ${quote}`);
      }
    });
  }

  test("no doc cites the removed PostgreSQL identifier module", () => {
    const citing = markdownFiles(join(ROOT, "docs"))
      .filter((path) => readFileSync(path, "utf8").includes("src/lib/editor/postgres-identifiers.ts"))
      .map((path) => relative(ROOT, path));
    expect(citing).toEqual([]);
  });
});
