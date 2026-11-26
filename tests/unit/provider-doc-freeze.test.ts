/**
 * The per-engine provider documents are frozen: no test or script holds the text of a `docs/providers/<type-id>.md`
 * to code, so a change to a projection or to a provider edits no document. Each document stays as it is until its
 * engine moves into its own package, where the document is rewritten from the package's manifest.
 *
 * The scan reads every tracked TypeScript and JavaScript file whose text holds `providers` or `providerTriad`, parses it with the
 * TypeScript compiler, and reports a file that builds a per-engine document path in one of six forms:
 * 1. a string whose whole text, after any leading `./` or `../` segments, is `docs/providers/<name>.md`, with a
 *    `<name>` of lowercase letters and digits, so CONTRACT.md and README.md never match;
 * 2. a string whose whole text, after the same prefix, is the directory `docs/providers` or `docs/providers/`;
 * 3. a string whose whole text, after the same prefix, starts with `docs/providers/` and holds a glob metacharacter
 *    (`*`, `?`, `[` or `{`), a pattern that matches every provider document;
 * 4. a template expression whose head or any span text ends with `docs/providers/`;
 * 5. the strings `"docs"` then `"providers"` side by side in a call's arguments or an array literal, unless the next
 *    element is `"CONTRACT.md"` or `"README.md"`;
 * 6. the member `.doc` of a `providerTriad(...)` call.
 * A path inside a comment, a regular expression or a longer sentence is never a form, because only whole string
 * nodes of the syntax tree are read. The scan is form-based: a path assembled another way (a variable holding
 * `"docs"` joined later with `"providers"`) is not seen, so a form found in review is added here. The engine set is
 * never read: any lowercase name counts, so this file names no engine.
 *
 * Whole-repository text guards that read every tracked document for a rule of their own (no line citations, no fixed
 * tool count) build no per-engine path and are outside this scan.
 *
 * `ALLOWED` is the reviewed list of files that build such a path, each with its reason. A reader outside it is refused
 * by name, and an entry whose file is gone or builds no path is refused as stale, so the list only shrinks.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { trackedFiles } from "../helpers/repo-text-scope";

const ROOT = path.resolve(import.meta.dir, "../..");

/** The files allowed to build a per-engine provider document path, each with the reason it may. */
const ALLOWED: Readonly<Record<string, string>> = {
  "tests/helpers/provider-layout.ts":
    "the triad builds each type-id's doc path to check the file exists and reads no text",
  "tests/unit/helpers/provider-layout.test.ts": "plants provider docs in a temporary root for the triad's rules",
  "tests/unit/isolation-ratchet.test.ts": "plants doc paths in a temporary tree for the provider docs counter",
  "tests/live/oxia-live-check.ts":
    "hand-run live check, not in `bun run test`, that runs the doc's console examples against a live server",
  "tests/live/s3-live-support.ts": "names the doc as evidence in its acceptance rows and reads no doc text",
  "tests/unit/db/errors.test.ts": "asserts that a load-failure message names the doc's path and reads no doc",
  "tests/unit/fixed-tool-count-matcher.test.ts": "a planted path in the matcher's scope test",
  "tests/unit/source-line-citation-matcher.test.ts": "a planted path in the matcher's citation test",
  "tests/unit/mcp-documentation.test.ts":
    "globs every provider doc for a fixed-text absence rule (no doc sends a language to an arm of its own) held to no code",
};

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const PREFIX = String.raw`(?:\.{1,2}/)*`;
const DOC_PATH = new RegExp(`^${PREFIX}docs/providers/[a-z0-9]+\\.md$`);
const DOC_DIRECTORY = new RegExp(`^${PREFIX}docs/providers/?$`);
const DOC_GLOB = new RegExp(`^${PREFIX}docs/providers/.*[*?[{]`);
const TEMPLATE_TAIL = /(?:^|\/)docs\/providers\/$/;
const CENTRAL_DOCS = new Set(["CONTRACT.md", "README.md"]);

type Form = "literal" | "directory" | "glob" | "template" | "join" | "triad";

interface Found {
  readonly line: number;
  readonly form: Form;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Every per-engine provider document path `text` builds, by line and form. */
function docPathForms(file: string, text: string): Found[] {
  if (!text.includes("providers") && !text.includes("providerTriad")) return [];
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const found: Found[] = [];
  const add = (node: ts.Node, form: Form): void => {
    found.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, form });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (DOC_PATH.test(node.text)) add(node, "literal");
      else if (DOC_DIRECTORY.test(node.text)) add(node, "directory");
      else if (DOC_GLOB.test(node.text)) add(node, "glob");
    }
    if (
      ts.isTemplateExpression(node) &&
      [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].some((part) => TEMPLATE_TAIL.test(part))
    ) {
      add(node, "template");
    }
    if (ts.isCallExpression(node) || ts.isArrayLiteralExpression(node)) {
      const parts = (ts.isCallExpression(node) ? node.arguments : node.elements).map((part) =>
        ts.isStringLiteralLike(part) ? part.text : null,
      );
      for (let index = 0; index + 1 < parts.length; index++) {
        if (parts[index] === "docs" && parts[index + 1] === "providers" && !CENTRAL_DOCS.has(parts[index + 2] ?? "")) {
          add(node, "join");
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "doc" &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "providerTriad"
    ) {
      add(node, "triad");
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Each tracked code file that builds a per-engine provider document path, with what it builds. */
function scanTree(root: string): Map<string, Found[]> {
  const readers = new Map<string, Found[]>();
  for (const file of trackedFiles(root).filter((tracked) => CODE_FILE.test(tracked))) {
    const forms = docPathForms(file, readFileSync(path.join(root, file), "utf8"));
    if (forms.length > 0) readers.set(file, forms);
  }
  return readers;
}

/** Every reader that is not a key of `allowed`, one line per form it builds. */
function unlistedReaders(found: ReadonlyMap<string, readonly Found[]>, allowed: Readonly<Record<string, string>>) {
  return [...found]
    .filter(([file]) => !Object.hasOwn(allowed, file))
    .flatMap(([file, forms]) => forms.map((form) => `${file}: line ${form.line} ${form.form}`));
}

/** Every key of `allowed` whose file is not tracked here or builds no provider document path. */
function staleEntries(
  found: ReadonlyMap<string, readonly Found[]>,
  allowed: Readonly<Record<string, string>>,
  tracked: ReadonlySet<string>,
): string[] {
  return Object.keys(allowed).filter((file) => !tracked.has(file) || !found.has(file));
}

describe("the per-engine provider documents are frozen", () => {
  const tracked = new Set(trackedFiles(ROOT));
  const found = scanTree(ROOT);

  test("no test or script outside the reviewed list reads the text of a per-engine provider doc", () => {
    expect(found.has("tests/helpers/provider-layout.ts")).toBe(true);
    const planted = new Map<string, Found[]>([["tests/unit/planted-reader.test.ts", [{ line: 3, form: "join" }]]]);
    expect(unlistedReaders(planted, ALLOWED)).toEqual(["tests/unit/planted-reader.test.ts: line 3 join"]);
    expect(
      unlistedReaders(found, ALLOWED),
      "a provider doc is frozen: assert the code, or list the file with its reason",
    ).toEqual([]);
  }, 120_000);

  test("an entry of the list that reads no provider doc is refused as stale", () => {
    const planted = {
      ...ALLOWED,
      "tests/unit/planted-missing.test.ts": "a file that does not exist",
      "tests/helpers/repo-text-scope.ts": "a tracked file that builds no provider doc path",
    };
    expect(staleEntries(found, planted, tracked)).toEqual([
      "tests/unit/planted-missing.test.ts",
      "tests/helpers/repo-text-scope.ts",
    ]);
    expect(existsSync(path.join(ROOT, "tests/helpers/repo-text-scope.ts"))).toBe(true);
    expect(staleEntries(found, ALLOWED, tracked), "remove the entry: the list only shrinks").toEqual([]);
  });
});

describe("the scanner finds each form and nothing else", () => {
  const formsOf = (source: string): Form[] => docPathForms("planted.ts", source).map((form) => form.form);
  /**
   * The directory, joined from a literal and a constant so that the planted sources below are the only forms: this
   * file's own syntax tree holds none, which the real-tree scan above proves by not naming it.
   */
  const segment = "providers";
  const providers = path.posix.join("docs", segment);

  test.each<[string, Form]>([
    [`const doc = readFileSync("${providers}/example.md", "utf8");`, "literal"],
    [`const doc = readFileSync("../../${providers}/example2.md", "utf8");`, "literal"],
    [`const doc = readFileSync(\`./${providers}/example.md\`, "utf8");`, "literal"],
    [`const dir = join(ROOT, "${providers}");`, "directory"],
    [`const dir = join(ROOT, "${providers}/");`, "directory"],
    [`const docs = new Bun.Glob("${providers}/*.md").scanSync(ROOT);`, "glob"],
    [`const docs = glob("./${providers}/**/*.md");`, "glob"],
    [`const docs = glob("${providers}/{a,b}.md");`, "glob"],
    [`const docs = glob("${providers}/[a-z]?.md");`, "glob"],
    [`const doc = \`${providers}/\${type}.md\`;`, "template"],
    [`const doc = \`\${ROOT}/${providers}/\${type}.md\`;`, "template"],
    [`const doc = path.join(ROOT, "docs", "providers", name);`, "join"],
    [`const parts = ["docs", "providers", \`\${type}.md\`];`, "join"],
    [`const doc = providerTriad(ROOT, type).doc;`, "triad"],
  ])("%s is a %s", (source, form) => {
    expect(formsOf(source)).toEqual([form]);
  });

  test.each<string>([
    `// ${providers}/example.md`,
    `/** ${providers}/example.md */`,
    `const said = "see ${providers}/example.md section 4";`,
    `const pattern = /docs\\/providers\\/example\\.md/;`,
    `const contract = "${providers}/CONTRACT.md";`,
    `const index = "${providers}/README.md";`,
    `const contract = join(ROOT, "docs", "providers", "CONTRACT.md");`,
    `const index = join(ROOT, "docs", "providers", "README.md");`,
    `const code = providerTriad(ROOT, type).code;`,
    `const doc = other(ROOT, type).doc;`,
    `const doc = "${providers}/Example.md";`,
    `const docs = new Bun.Glob("docs/*.md");`,
    `const said = "see ${providers}/*.md for each engine";`,
    `const docs = new Bun.Glob("src/${providers}/*.md");`,
  ])("%s is not", (source) => {
    expect(formsOf(source)).toEqual([]);
  });

  test("a file that names neither providers nor providerTriad is not parsed, and the line of each form is its own", () => {
    expect(docPathForms("planted.ts", "const doc = readFileSync(other);")).toEqual([]);
    expect(
      docPathForms("planted.ts", ["const a = 1;", "", `const doc = "${providers}/example.md";`].join("\n")),
    ).toEqual([{ line: 3, form: "literal" }]);
  });

  test("JavaScript and TSX files are parsed as what they are", () => {
    expect(docPathForms("planted.mjs", `export const doc = "${providers}/example.md";`)).toEqual([
      { line: 1, form: "literal" },
    ]);
    expect(docPathForms("planted.tsx", `export const View = () => <a href="${providers}/example.md">doc</a>;`)).toEqual(
      [{ line: 1, form: "literal" }],
    );
  });
});
