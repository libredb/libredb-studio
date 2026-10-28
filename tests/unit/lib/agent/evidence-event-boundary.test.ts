import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { AGENT_EVIDENCE_EVENTS } from "@/lib/agent/languages/client";

/**
 * The evidence events a language pack declares are the pack's: no core module names one.
 *
 * A pack writes an event of its own kind beside a reading its verdict asks for, and declares, in its client facet, what
 * the timeline shows for it, what a resumed run is told of it, and whether a claim may cite it. The ledger, the
 * timeline, the resume narration and the citation check read that declaration through `AGENT_EVIDENCE_EVENTS`, so a
 * new language with evidence of its own edits its pack and no core file.
 *
 * Held: every `.ts` and `.tsx` file under `src/lib/agent/` outside `src/lib/agent/languages/`, under
 * `src/components/agent/` and under `src/app/api/agent/`. A finding is a string literal, a no-substitution template or
 * a literal type whose whole text is a kind a pack declares, keyed `${file}#${innermost named declaration}: "kind"`.
 * Only AST nodes are visited, so a comment never counts, and an import specifier is never a kind. There is no
 * allowlist: a kind the core needs is a kind the core owns.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const LANGUAGES = "src/lib/agent/languages/";
const HELD = ["src/lib/agent", "src/components/agent", "src/app/api/agent"];

const PACK_KINDS: ReadonlySet<string> = new Set(Object.keys(AGENT_EVIDENCE_EVENTS));

function sourcesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = `${directory}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) files.push(...sourcesUnder(path));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

const CORE_FILES = HELD.flatMap(sourcesUnder).filter((file) => !file.startsWith(LANGUAGES));

/** The name of the innermost function, method, class, variable, type alias or interface around `node`. */
function declarationOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isClassDeclaration(at) ||
        ts.isVariableDeclaration(at) ||
        ts.isTypeAliasDeclaration(at) ||
        ts.isInterfaceDeclaration(at)) &&
      at.name !== undefined &&
      (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))
    ) {
      return at.name.text;
    }
  }
  return "<module>";
}

type Planted = Readonly<Record<string, string>>;

function evidenceKindFindings(planted: Planted = {}): string[] {
  const findings: string[] = [];
  for (const file of CORE_FILES) {
    const text = planted[file] ?? readFileSync(join(ROOT, file), "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined,
    );
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        !ts.isImportDeclaration(node.parent) &&
        !ts.isExportDeclaration(node.parent) &&
        PACK_KINDS.has(node.text)
      ) {
        findings.push(`${file}#${declarationOf(node)}: ${JSON.stringify(node.text)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

/** A copy of `file` with `statement` planted as the first statement of the function `name`. */
function plantInFunction(file: string, name: string, statement: string): Planted {
  const text = readFileSync(join(ROOT, file), "utf8");
  const marker = new RegExp(`function ${name}\\([^{]*\\{`);
  const match = marker.exec(text);
  if (match === null) throw new Error(`no function ${name} in ${file}`);
  const at = match.index + match[0].length;
  return { [file]: `${text.slice(0, at)}\n${statement}\n${text.slice(at)}` };
}

describe("the agent core names no evidence event a pack declares", () => {
  test("the scan reads the packs' declarations and real core files", () => {
    expect(PACK_KINDS.size).toBeGreaterThan(0);
    expect(CORE_FILES).toContain("src/lib/agent/types.ts");
    expect(CORE_FILES).toContain("src/components/agent/timeline.ts");
    expect(CORE_FILES.some((file) => file.startsWith("src/app/api/agent/"))).toBe(true);
    expect(CORE_FILES.some((file) => file.startsWith(LANGUAGES))).toBe(false);
  });

  test("the real core sources hold no pack's evidence event kind", () => {
    expect(evidenceKindFindings()).toEqual([]);
  });

  test("a pack's kind compared in a core module, a component or a route is a finding, and a comment is not", () => {
    const [kind] = [...PACK_KINDS];
    const literal = JSON.stringify(kind);
    expect(
      evidenceKindFindings({
        ...plantInFunction("src/lib/agent/tools.ts", "producedArtifact", `if (correlationId === ${literal}) {}`),
        ...plantInFunction(
          "src/components/agent/timeline.ts",
          "describeEvent",
          `// ${kind} named in a comment\nconst planted: ${literal} | null = null;`,
        ),
      }),
    ).toEqual([
      `src/lib/agent/tools.ts#producedArtifact: ${literal}`,
      `src/components/agent/timeline.ts#planted: ${literal}`,
    ]);
  });
});
