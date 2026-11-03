/**
 * The line-number citation matchers (tests/helpers/source-line-citation.ts), held to the forms the repository wrote
 * and the look-alikes it must leave alone: ports, clock times, bind variables, engine error text, probe ids and
 * computed report strings.
 *
 * The positive forms are planted in strings here, which the guard would read; this file and the guard name each
 * other, and the guard leaves this one file out for that reason alone.
 */
import { describe, expect, test } from "bun:test";
import { citationFindings, citationSyntax, trackedPathResolver } from "../helpers/source-line-citation";

const TRACKED = [
  "src/lib/db/factory.ts",
  "src/lib/db/http/endpoint.ts",
  "src/components/agent/AnswerCard.tsx",
  "src/components/monitoring/tabs/StorageTab.tsx",
  "src/lib/db/providers/sql/db2/migration-ddl.ts",
  "src/lib/mcp/http-transport.ts",
  "docs/providers/druid.md",
  "e2e/object-edit.spec.ts",
];
const resolves = trackedPathResolver(TRACKED);
const hits = (text: string, path = "docs/x.md"): string[] =>
  citationFindings(path, text, resolves).map((finding) => finding.text);

describe("citationSyntax", () => {
  test("reads Markdown as prose, code by its comments and strings, and the # and // syntaxes by comment", () => {
    expect(citationSyntax("docs/MCP.md")).toBe("markdown");
    expect(citationSyntax("src/lib/a.ts")).toBe("code");
    expect(citationSyntax("charts/x/values.yaml")).toBe("hash");
    expect(citationSyntax("docker/x/seed.sh")).toBe("hash");
    expect(citationSyntax("Dockerfile.alpine")).toBe("hash");
    expect(citationSyntax(".env.example")).toBe("hash");
    expect(citationSyntax("operator/Makefile")).toBe("hash");
    expect(citationSyntax("packaging/windows/launcher/main.go")).toBe("slash");
  });

  test("leaves out changelogs, lockfiles, public assets, recorded fixtures, vendored grammars and other files", () => {
    for (const path of [
      "CHANGELOG.md",
      "charts/libredb-studio/CHANGELOG.md",
      "bun.lock",
      "vscode-extension/package-lock.json",
      "public/x.js",
      "tests/fixtures/etcd/grammar-corpus.ts",
      "src/x/grammar.g4",
      "src/x/api.proto",
      "package.json",
    ])
      expect(citationSyntax(path)).toBeNull();
  });
});

describe("citationFindings", () => {
  test.each([
    ["a path with a line range", "see `src/lib/db/factory.ts:1264-1271`"],
    ["a file name with a line", "in `types.ts:779` the field"],
    ["a range after a backticked file name", "`object-route.ts` and `:2969-2972`"],
    ["lines in parentheses after a backticked path", "`src/lib/db/factory.ts` holds it (lines 1779-1792)"],
    ["a line of a backticked path", "line 429 of `src/components/agent/AnswerCard.tsx`"],
    ["around a line after a backticked path", "`e2e/object-edit.spec.ts` (around line 258)"],
    ["a dependency file with a line", "`node_modules/mysql2/lib/connection_config.js:171`"],
    ["a vendored grammar with a range", "`SqlBaseLexer-v4.2.0.g4:42-50`"],
    ["a range after a Markdown link", "[`StorageTab.tsx`](../../src/components/monitoring/tabs/StorageTab.tsx):79-80"],
    ["a GitHub permalink anchor", "https://github.com/x/y/blob/0abc/src/index.ts#L42"],
  ])("cites a line in Markdown: %s", (_name, text) => {
    expect(hits(text)).not.toEqual([]);
  });

  test("reads a fenced comment line as prose", () => {
    expect(hits("```bash\n# LLM_PROVIDER=openai (src/lib/llm/utils/config.ts:23)\n```")).toEqual([
      "src/lib/llm/utils/config.ts:23",
    ]);
  });

  test("reads a tracked path with a line suffix in a code string, and a code comment's (line N)", () => {
    expect(hits('const evidence = ["src/lib/db/http/endpoint.ts:50-95"];', "tests/live/x.ts")).toEqual([
      "src/lib/db/http/endpoint.ts:50-95",
    ]);
    expect(hits("// the branch (line 82) decides", "src/x.ts")).toEqual(["(line 82)"]);
    expect(hits("# see values.yaml:12", "charts/x/values.yaml")).toEqual(["values.yaml:12"]);
    expect(hits("// see main.go:12", "packaging/x/main.go")).toEqual(["main.go:12"]);
  });

  test("names a line beside a tracked path, never beside another dotted name", () => {
    expect(hits("the check at line 40 in factory.ts")).toEqual(["at line 40"]);
    expect(hits("the parser stops at line 40 on SYS.DBMS_OUTPUT")).toEqual([]);
  });

  test.each([
    "localhost:3000",
    "host:443",
    "12:00:00",
    "https://127.0.0.1:59999/pools in `http-transport.ts`",
    "ORA-06512: at line 24",
    '"SYS.DBMS_METADATA", line 6781',
    "line 24:6 no viable alternative",
    "Incorrect syntax near the keyword 'CREATE' at line 1, column 1. (docs/providers/druid.md)",
    "the `:1` bind",
    "port 7687",
    "Node 25 and later",
    "README_es.md",
    "probe L11 (measured, L10)",
    "a placeholder is `:1` in `src/lib/sql/values.ts`",
    "Doris answers errno 1105 in `apache/doris:4.1.3` (line 1, pos 5)",
    "shifting src/lib/db/factory.ts by 20 reported a marker at line 27 on a nine-line model",
    "```\n    at node_modules/x/lib/y.js:44826\n```",
  ])("leaves a look-alike in Markdown alone: %s", (text) => {
    expect(hits(text)).toEqual([]);
  });

  test("leaves a computed report string and a string naming no tracked path alone", () => {
    expect(hits('expect(report).toContain("index.ts:1 uses");', "tests/unit/x.test.ts")).toEqual([]);
    expect(hits('const at = "tests/mixed.test.ts:3:29";', "tests/unit/x.test.ts")).toEqual([]);
    expect(hits('const x = "(line 3)";', "tests/unit/x.test.ts")).toEqual([]);
    expect(hits('expect(out).toContain("src/lib/db/factory.ts:1");', "tests/unit/x.test.ts")).toEqual([]);
  });

  test("reads nothing in a file out of scope", () => {
    expect(hits("src/lib/db/factory.ts:12", "CHANGELOG.md")).toEqual([]);
  });
});

describe("trackedPathResolver", () => {
  test("resolves a tracked path, its tail after a slash, and a relative link to it, and nothing else", () => {
    expect(resolves("src/lib/db/factory.ts")).toBe(true);
    expect(resolves("db2/migration-ddl.ts")).toBe(true);
    expect(resolves("factory.ts")).toBe(true);
    expect(resolves("../../src/lib/db/factory.ts")).toBe(true);
    expect(resolves("b/factory.ts")).toBe(false);
    expect(resolves("SYS.DBMS_METADATA")).toBe(false);
  });
});
