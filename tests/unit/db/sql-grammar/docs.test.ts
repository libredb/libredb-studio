/**
 * Each provider doc keeps a `SQL grammar` subsection that states where its engine's SQL text is declared and what the
 * registry composes from it: the declaration's path, its grammar (`DEFAULT_SQL_GRAMMAR` where the declared facts are
 * the compatibility default's, the declaration's `sqlText.grammar` otherwise), `readsSqlText`, the redaction Studio's
 * record grants and, for an engine whose grammar functions Studio binds, the module and the functions it exports. The
 * facts are read from the registry, so a doc that drifts from its declaration fails here (the code, docs and tests
 * triad).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { SQL_GRAMMAR } from "@/lib/db/sql-grammar";
import type { DatabaseType } from "@/lib/types";
import { DEFAULT_SQL_GRAMMAR } from "@libredb/provider-sdk/sql";
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
  for (const id of Object.keys(SQL_GRAMMAR) as DatabaseType[]) {
    test(`docs/providers/${id}.md`, () => {
      const doc = readFileSync(join(ROOT, "docs", "providers", `${id}.md`), "utf8");
      const section = grammarSubsection(doc);
      expect(section, `${id}.md has no "SQL grammar" heading`).not.toBeNull();
      const body = section ?? "";

      // The declaration, linked, as where the engine's statement text reading is declared.
      expect(body).toContain(`src/lib/db/engine-declarations/${id}.json`);
      const spec = SQL_GRAMMAR[id];
      if (Bun.deepEquals(spec.grammar, DEFAULT_SQL_GRAMMAR)) {
        expect(body).toContain("Its grammar is `DEFAULT_SQL_GRAMMAR`");
      } else {
        expect(body).toContain("Its grammar is the declaration's `sqlText.grammar`");
      }

      // Docs cite a function module with forward slashes, the separator `relative` uses on Windows is a backslash.
      const functions = MODULES.find((engine) => engine.id === id);
      if (functions !== undefined) {
        expect(body).toContain(relative(ROOT, functions.path).split(sep).join("/"));
        for (const name of functions.exportNames) expect(body).toContain(`\`${name}\``);
      }

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

  test("every SQL grammar module a doc cites exists, so no doc cites a module the declarations replaced", () => {
    const cited = markdownFiles(join(ROOT, "docs")).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/src\/lib\/db\/providers\/[\w/.-]*sql-grammar\.ts/g)].map((match) => ({
        doc: relative(ROOT, path).split(sep).join("/"),
        module: match[0],
      })),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter(({ module }) => !existsSync(join(ROOT, module)))).toEqual([]);
  });

  test("no doc cites the removed PostgreSQL identifier module", () => {
    const citing = markdownFiles(join(ROOT, "docs"))
      .filter((path) => readFileSync(path, "utf8").includes("src/lib/editor/postgres-identifiers.ts"))
      .map((path) => relative(ROOT, path));
    expect(citing).toEqual([]);
  });
});
