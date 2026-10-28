import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  AGENT_EVIDENCE_EVENTS,
  AGENT_PACK_READING_REFUSAL_HEADLINES,
  AGENT_PACK_REQUIREMENTS,
  AGENT_PACK_SHORTFALL_SENTENCES,
} from "@/lib/agent/languages/client";
import { AGENT_EVIDENCE_TOOLS } from "@/lib/agent/languages/index";

/**
 * The evidence events a language pack declares are the pack's: no core module names one, and neither the other names
 * a pack owns.
 *
 * A pack writes an event of its own kind beside a reading its verdict asks for, and declares, in its client facet, what
 * the timeline shows for it, what a resumed run is told of it, and whether a claim may cite it. The ledger, the
 * timeline, the resume narration and the citation check read that declaration through `AGENT_EVIDENCE_EVENTS`, so a
 * new language with evidence of its own edits its pack and no core file.
 *
 * The same holds for the other names a pack owns beside its events: its evidence tools (`AGENT_EVIDENCE_TOOLS`), the
 * reading refusal codes it alone raises, the verdict shortfalls only its verifiers report and the workflow variant
 * requirements only its engines meet. The core reads each through the pack registry that merges the packs' rows.
 *
 * Held: every `.ts` and `.tsx` file under `src/lib/agent/` outside `src/lib/agent/languages/`, under
 * `src/components/agent/` and under `src/app/api/agent/`. A finding is a string literal, a no-substitution template or
 * a literal type whose whole text is a kind or another name a pack declares, keyed `${file}#${innermost named declaration}: "kind"`.
 * Only AST nodes are visited, so a comment never counts, and an import specifier is never a kind. There is no
 * allowlist: a kind the core needs is a kind the core owns.
 */

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const LANGUAGES = "src/lib/agent/languages/";
const HELD = ["src/lib/agent", "src/components/agent", "src/app/api/agent"];

const PACK_KINDS: ReadonlySet<string> = new Set(Object.keys(AGENT_EVIDENCE_EVENTS));

/** Every name a pack owns: its evidence event kinds, and its evidence tools, refusal codes, shortfalls and requirements. */
const PACK_NAMES: ReadonlySet<string> = new Set([
  ...PACK_KINDS,
  ...Object.keys(AGENT_EVIDENCE_TOOLS),
  ...Object.keys(AGENT_PACK_READING_REFUSAL_HEADLINES),
  ...Object.keys(AGENT_PACK_SHORTFALL_SENTENCES),
  ...Object.keys(AGENT_PACK_REQUIREMENTS),
]);

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
        PACK_NAMES.has(node.text)
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

describe("the agent core names no evidence event, or other name, a pack declares", () => {
  test("the scan reads the packs' declarations and real core files", () => {
    expect(PACK_KINDS.size).toBeGreaterThan(0);
    for (const name of [
      "inspect_usage",
      "profile_workloads",
      "METRICS_UNAVAILABLE",
      "no-usage-reading",
      "no-usage-metrics",
      "cluster-usage-reading",
      "cluster-workload-reading",
    ]) {
      expect(PACK_NAMES.has(name)).toBe(true);
    }
    expect(CORE_FILES).toContain("src/lib/agent/types.ts");
    expect(CORE_FILES).toContain("src/components/agent/timeline.ts");
    expect(CORE_FILES.some((file) => file.startsWith("src/app/api/agent/"))).toBe(true);
    expect(CORE_FILES.some((file) => file.startsWith(LANGUAGES))).toBe(false);
  });

  test("the real core sources hold no pack's evidence event kind or other name", () => {
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

  test("a pack's tool, refusal code, shortfall or requirement written in a core module or a component is a finding", () => {
    const planted = (name: string) => JSON.stringify(name);
    expect(
      evidenceKindFindings({
        ...plantInFunction(
          "src/lib/agent/tools.ts",
          "producedArtifact",
          `if (correlationId === ${planted("inspect_usage")}) {}\nconst code: ${planted("METRICS_UNAVAILABLE")} | null = null;`,
        ),
        ...plantInFunction(
          "src/components/agent/timeline.ts",
          "describeEvent",
          `const shortfall = ${planted("no-usage-metrics")};\nconst requirement = ${planted("cluster-usage-reading")};`,
        ),
      }),
    ).toEqual([
      `src/lib/agent/tools.ts#producedArtifact: ${planted("inspect_usage")}`,
      `src/lib/agent/tools.ts#code: ${planted("METRICS_UNAVAILABLE")}`,
      `src/components/agent/timeline.ts#shortfall: ${planted("no-usage-metrics")}`,
      `src/components/agent/timeline.ts#requirement: ${planted("cluster-usage-reading")}`,
    ]);
  });
});
