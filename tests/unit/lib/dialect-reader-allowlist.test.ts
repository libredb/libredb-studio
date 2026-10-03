/**
 * Every reader of a query dialect outside the dialect registries, held to a closed list (vector-family spec 3.8).
 *
 * The registries (`src/lib/db/query-dialects.ts`, `src/lib/editor/dialect-editors.ts`, and `DIALECT_GENERATORS`
 * in `src/lib/query-generators.ts`) answer what the per-dialect arms used to: a tab type, a Monaco language, a
 * formatter, three row-menu gates and the generated statements. A comparison of `queryDialect` anywhere else, or
 * a read of the JSON language that would take a dialect's text for MongoDB's, is the #427 class coming back, so
 * every such line under `src/` must be on the list below with the owner that keeps it.
 *
 * A list and not a ban, because the MongoDB reads are right where they are: MongoDB declares JSON with no
 * dialect, so the JSON arm of each generator, the quoting helpers and the test data generator are its own. A
 * line that matches and is not listed fails by file, line and text; a listed line that no longer exists fails
 * too, so the list cannot outlive the code it describes.
 *
 * It reads the repository's files through git's own lists (tracked, and untracked but not ignored), as
 * `tests/unit/db/etcd/seam-guard.test.ts` does, so a new file is read the day it is written.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;

/** The two whole-file registries, whose own reads are the registry. */
const REGISTRIES: ReadonlySet<string> = new Set(["src/lib/db/query-dialects.ts", "src/lib/editor/dialect-editors.ts"]);

/** A comparison of the declared dialect, `===` or `!==`. */
const DIALECT_COMPARISON = /queryDialect\s*[!=]==/;
/** A read of the JSON language, which without a dialect check means MongoDB. */
const JSON_LANGUAGE_READ = /queryLanguage === "json"/;

/** A reader outside the registries: its file, its trimmed line text, and who owns it. */
interface Reader {
  readonly path: string;
  readonly text: string;
  readonly owner: string;
}

/**
 * The closed list. A text that occurs on several lines of one file is listed once per line.
 */
const ALLOWED: readonly Reader[] = [
  {
    path: "src/app/api/db/profile/route.ts",
    text: 'const dialect = capabilities.queryDialect === undefined ? "" : ` in the ${capabilities.queryDialect} dialect`;',
    owner: "the profile route's refusal sentence, which names the declared dialect after offersColumnProfiling refused",
  },
  {
    path: "src/components/QueryEditor.tsx",
    text: "const completesMongoDB = capabilities?.queryDialect === undefined;",
    owner: "QueryEditor: the MongoDB completion provider registers only where no dialect is declared",
  },
  {
    path: "src/components/TestDataGenerator.tsx",
    text: 'if (capabilities?.queryLanguage === "json") {',
    owner:
      "Generate Test Data: MongoDB's insertMany, unreachable for a dialect since no dialect kind accepts row writes",
  },
  {
    path: "src/lib/db/types.ts",
    text: 'return capabilities.queryLanguage === "json" && profilesDialect;',
    owner: "offersColumnProfiling: the language half, a dialect's answer read from its registry record",
  },
  {
    path: "src/lib/db/types.ts",
    text: 'return capabilities?.queryLanguage === "sql" || capabilities?.queryLanguage === "json";',
    owner: "offersCodeGeneration: the language half, after the registry record's refusal",
  },
  {
    path: "src/lib/db/types.ts",
    text: 'return capabilities.queryLanguage === "sql" || capabilities.queryLanguage === "json";',
    owner: "offersCountQuery: the language half, after the registry record's refusal",
  },
  {
    path: "src/lib/editor/tab-language.ts",
    text: 'if (capabilities?.queryLanguage === "json") return "mongodb";',
    owner: "resolveTabType: MongoDB's rung, below the registry record's tabType",
  },
  {
    path: "src/lib/query-generators.ts",
    text: 'if (capabilities.queryLanguage === "json") return name;',
    owner: "quoteIdentifier: JSON names are never SQL-quoted",
  },
  {
    path: "src/lib/query-generators.ts",
    text: 'if (capabilities.queryLanguage === "json") return path.join(".");',
    owner: "quoteObjectPath: JSON addresses are never SQL-quoted",
  },
  {
    path: "src/lib/query-generators.ts",
    text: 'if (capabilities.queryLanguage === "json") {',
    owner: "generateTableQuery: MongoDB's find, below the DIALECT_GENERATORS record",
  },
  {
    path: "src/lib/query-generators.ts",
    text: 'if (capabilities.queryLanguage === "json") {',
    owner: "generateSelectQuery: MongoDB's find, below the DIALECT_GENERATORS record",
  },
  {
    path: "src/lib/query-generators.ts",
    text: 'if (capabilities.queryLanguage === "json") {',
    owner: "generateCountQuery: MongoDB's count, reached only where offersCountQuery allows it",
  },
];

/**
 * Lines that test a type-id where a reader might expect a dialect, listed so nobody moves them into the registry
 * by mistake: neither pattern above matches them, and this file checks that they still exist as written.
 */
const NOT_DIALECT_READERS: readonly Reader[] = [
  {
    path: "src/hooks/use-query-execution.ts",
    text: 'const keepKeyword = activeConnection.type === "redis" ? "EXEC" : "COMMIT";',
    owner: "picks the keyword that keeps an open transaction, an engine fact and not a dialect reader",
  },
];

/** Every source file under `src/` git lists at `root`: tracked, or untracked and not ignored. */
function sourceFiles(root: string, env?: NodeJS.ProcessEnv): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return [...new Set(listed.split("\0"))]
    .filter((path) => SOURCE_FILE.test(path) && existsSync(join(root, path)))
    .sort();
}

/** Every matching line outside the registries, as `path`, 1-based `line` and trimmed `text`. */
function dialectReaders(root: string, env?: NodeJS.ProcessEnv): { path: string; line: number; text: string }[] {
  return sourceFiles(root, env)
    .filter((path) => !REGISTRIES.has(path))
    .flatMap((path) =>
      readFileSync(join(root, path), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          DIALECT_COMPARISON.test(line) || JSON_LANGUAGE_READ.test(line)
            ? [{ path, line: index + 1, text: line.trim() }]
            : [],
        ),
    );
}

/** What differs from the closed list: each unlisted reader by location, and each listed one that is gone. */
function allowlistFindings(root: string, env?: NodeJS.ProcessEnv): string[] {
  const unmatched = [...ALLOWED];
  const findings: string[] = [];
  for (const reader of dialectReaders(root, env)) {
    const index = unmatched.findIndex((allowed) => allowed.path === reader.path && allowed.text === reader.text);
    if (index === -1) findings.push(`unlisted ${reader.path}:${reader.line} ${reader.text}`);
    else unmatched.splice(index, 1);
  }
  for (const gone of unmatched) findings.push(`listed but absent ${gone.path}: ${gone.text} (${gone.owner})`);
  return findings;
}

/**
 * git's environment for a temporary repository: every GIT_ variable dropped and an empty global configuration,
 * so the caller's own settings cannot change what git lists (the etcd seam guard's helper).
 */
function isolatedGitEnvironment(home: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "gitconfig"), "");
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.XDG_CONFIG_HOME = home;
  return env;
}

/** Runs `check` over a temporary git repository holding this repository's listed files plus `planted`. */
function inPlantedRepository<T>(
  planted: Readonly<Record<string, string>>,
  check: (root: string, env: NodeJS.ProcessEnv) => T,
): T {
  const home = mkdtempSync(join(tmpdir(), "dialect-allowlist-"));
  try {
    const root = join(home, "repository");
    mkdirSync(root);
    const env = isolatedGitEnvironment(join(home, "git-home"));
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, encoding: "utf8", env });
    const files: Record<string, string> = {};
    for (const { path } of ALLOWED) files[path] = readFileSync(join(ROOT, path), "utf8");
    for (const path of REGISTRIES) files[path] = readFileSync(join(ROOT, path), "utf8");
    for (const [path, text] of Object.entries({ ...files, ...planted })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return check(root, env);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("readers of a query dialect outside the registries", () => {
  test("are exactly the closed list, each with its owner", () => {
    expect(allowlistFindings(ROOT)).toEqual([]);
  });

  test("a type-id test listed as not a dialect reader still reads as written, and matches neither pattern", () => {
    for (const { path, text } of NOT_DIALECT_READERS) {
      const lines = readFileSync(join(ROOT, path), "utf8")
        .split("\n")
        .map((line) => line.trim());
      expect(lines, `${path} no longer holds: ${text}`).toContain(text);
      expect(DIALECT_COMPARISON.test(text) || JSON_LANGUAGE_READ.test(text)).toBe(false);
    }
  });
});

describe("planted readers fail by name", () => {
  test("the copied tree alone is clean, so a finding below is the plant's", () => {
    expect(inPlantedRepository({}, allowlistFindings)).toEqual([]);
  });

  test("a dialect comparison planted in a new source file is reported by file, line and text", () => {
    const plant = 'export const isRedis = (c: { queryDialect?: string }) => c.queryDialect === "redis";\n';
    expect(inPlantedRepository({ "src/lib/planted.ts": `// a planted reader\n${plant}` }, allowlistFindings)).toEqual([
      `unlisted src/lib/planted.ts:2 ${plant.trim()}`,
    ]);
  });

  test("a JSON-language read planted beside a listed one is reported, and the listed one is not", () => {
    const listed = readFileSync(join(ROOT, "src/lib/editor/tab-language.ts"), "utf8");
    const plant = '  if (capabilities?.queryLanguage === "json") return "sql";';
    const planted = `${listed}\nexport function planted(capabilities?: { queryLanguage?: string }) {\n${plant}\n}\n`;
    const findings = inPlantedRepository({ "src/lib/editor/tab-language.ts": planted }, allowlistFindings);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(
      /^unlisted src\/lib\/editor\/tab-language\.ts:\d+ if \(capabilities\?\.queryLanguage === "json"\) return "sql";$/,
    );
  });

  test("a comparison inside a registry is the registry's own, and a test file is out of scope", () => {
    const plant = 'export const x = (c: { queryDialect?: string }) => c.queryDialect !== "etcd";\n';
    const registry = readFileSync(join(ROOT, "src/lib/db/query-dialects.ts"), "utf8");
    expect(
      inPlantedRepository(
        { "src/lib/db/query-dialects.ts": `${registry}${plant}`, "tests/unit/planted.test.ts": plant },
        allowlistFindings,
      ),
    ).toEqual([]);
  });

  test("a listed reader that is removed is reported as absent", () => {
    const findings = inPlantedRepository({ "src/components/TestDataGenerator.tsx": "export {};\n" }, allowlistFindings);
    expect(findings).toEqual([
      'listed but absent src/components/TestDataGenerator.tsx: if (capabilities?.queryLanguage === "json") { (Generate Test Data: MongoDB\'s insertMany, unreachable for a dialect since no dialect kind accepts row writes)',
    ]);
  });
});
