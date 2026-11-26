#!/usr/bin/env bun
/**
 * The isolation ratchet: counters of provider knowledge in Studio's core and in its non-engine packages that may only
 * fall, and of engines in packages that may only rise (issue #2514).
 * `tests/unit/isolation-ratchet.test.ts` measures the working tree and holds it to the committed baseline
 * `tests/unit/isolation-ratchet.baseline.json`, so a change that adds engine knowledge to core fails, and a change
 * that removes some fails too until it regenerates the baseline, so an improvement can never be undone silently.
 *
 * Run: bun scripts/isolation-ratchet.ts [--write]
 * With no argument it prints every counter, gate and report-only, one per line.
 * `--write` (as `bun run isolation:baseline`) writes the baseline, and refuses, writing nothing, when an exception or
 * a non-engine package entry is stale or when any counter is worse than the committed baseline: the command never
 * raises a counter. It writes when no baseline exists yet.
 * A baseline that does not parse is refused by `--write` too, so a change that adds or removes a counter deletes the
 * file and regenerates it, which review sees as a whole-file rewrite.
 *
 * The measurement is a pure function over a file list and a reader. It reads files and starts nothing.
 *
 * Definitions:
 * - Files: `git ls-files -z --cached --others --exclude-standard`, deduplicated, kept only when the path exists on
 *   disk, sorted. Ignored files never count, so every checkout of one commit measures the same.
 * - Engine ids: the base name of every `.json` file under `src/lib/db/engine-declarations/`, plus `<id>` of every
 *   `packages/provider-<id>/` directory except those `NON_ENGINE_PACKAGES` lists, so an id survives its move into a
 *   package. Each `NON_ENGINE_PACKAGES` entry must name an existing directory.
 * - A line names an engine when it holds an id as a whole quoted literal (`"id"`, `'id'` or a backtick pair, the same
 *   quote on both sides), or as an object key: the id at line start or after whitespace, `{`, `,` or `;`, then an
 *   optional `?`, optional whitespace and `:`. Comments and string contents count. Matching is case-sensitive: an id
 *   is an exact string, and a display label such as "Kafka" is not the id.
 * - Core source: files under `src/`, `bin/`, `scripts/` and `vscode-extension/src/` ending in `.ts`, `.tsx`, `.js`,
 *   `.jsx`, `.mjs`, `.cjs`, `.mts` or `.cts`, outside `src/lib/db/providers/` (counted as legacy provider files) and
 *   `packages/`, except this script: its exception list quotes the excepted lines, so counting it would keep those ids
 *   named in core for as long as the list exists.
 * - Generated: a core source file whose base name holds `.generated.`. It counts toward generated lines only.
 * - Non-engine package files: every file, of any extension, under `packages/<directory>/` for each
 *   `NON_ENGINE_PACKAGES` entry, except those under that directory's `tests/`. No exception applies to them.
 * - Lines of a file: the number of newlines, plus one when the text is non-empty and does not end with one.
 * - Exceptions: `EXCEPTIONS`, a closed list of reviewed lines that name an id but carry no engine knowledge, each with
 *   its file, its ids, the exact trimmed text of the line and the reason. Only two kinds exist: a `STORAGE_PROVIDER`
 *   value (`postgres`, `sqlite`) in a file under `src/lib/storage/`, and the product name `libredb` where it is not the
 *   engine. An entry removes only its ids, only from lines of its file whose trimmed text equals its text, and only
 *   from the hand-written core naming counters; any other id on that line still counts. An entry that matches no line
 *   naming each of its ids is stale and fails. Lines are matched by text, not by number, so an entry never goes stale
 *   silently when the file around it moves.
 *
 * Gate counters, in the baseline (all only fall, except engines in packages, which only rises):
 * - `enginesInPackages`: engine ids from `packages/provider-<id>/`.
 * - `coreHandwritten.distinctEngineIds`, `.filesNamingAnEngine`, `.linesNamingAnEngine`: hand-written core source,
 *   after the exceptions.
 * - `coreGenerated.lines`: lines of generated core source.
 * - `legacyProviders.files`: every file under `src/lib/db/providers/`.
 * - `agentLanguages.filesInLanguageDirs`: every file in a subdirectory of `src/lib/agent/languages/`.
 * - `languages.files`: every file under `src/lib/languages/`.
 * - `engineDeclarations.files`: every `.json` file under `src/lib/db/engine-declarations/`.
 * - `providerDocsInCore`: every `docs/providers/<id>.md` whose `<id>` is an engine id.
 * - `providerIntegrationTestsInCore`: every `tests/integration/db/<name>-provider.test.ts`.
 * - `inwardImportPairs`: the module count over `INWARD_IMPORTS`
 *   (tests/unit/lib/db/provider-imports/inward-allowlist.ts), which `provider-imports.test.ts` holds equal to the tree.
 * - `engineKeyedTypePositions`: in hand-written core source, every `Record<`, `Map<`, `ReadonlyMap<` or `WeakMap<`
 *   whose first type argument is `DatabaseType`, and every mapped type `[K in DatabaseType]`, either optionally inside
 *   `Exclude<` or `Extract<`, across line breaks. A list such as `readonly DatabaseType[]` is not a key.
 * - `nonEnginePackages.linesNamingAnEngine`: lines naming an engine in non-engine package files.
 * The baseline also lists the ids behind three id counters, `coreHandwritten.engineIdsNamed`, `enginesInPackages.ids`
 * and `nonEnginePackages.engineIdsNamed`: an id named in core or in a non-engine package that the baseline does not
 * list is refused even when the count is unchanged, and a packaged id that is gone is refused.
 *
 * Report counters, printed and never compared: the engine id count, generated core files, lines of the legacy
 * provider, agent language and languages files and of the declarations, and over test code (`tests/`, `e2e/`,
 * `vscode-extension/test/`) the files and lines naming an engine (no exceptions), plus the test code and fixture files
 * under `tests/` and `e2e/` with an engine id as a path segment, and the core source files with an engine id as a path
 * segment.
 * An id is a path segment when it is bounded on each side by the path's start or end or by one of `/`, `_`, `.` or `-`,
 * matched case-sensitively.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INWARD_IMPORTS } from "../tests/unit/lib/db/provider-imports/inward-allowlist";

/** The committed baseline, relative to the repository root. */
export const BASELINE_FILE = "tests/unit/isolation-ratchet.baseline.json";

/** The sentence every refusal of an improvement ends with. */
export const REGENERATE_SENTENCE = "run bun run isolation:baseline and commit the result";

const HEADER = "Generated by bun run isolation:baseline from scripts/isolation-ratchet.ts; never edit by hand.";
const PARSE_SUFFIX = "; the file is generated by bun run isolation:baseline and never edited by hand";
const USAGE = "Usage: bun scripts/isolation-ratchet.ts [--write]";
const THIS_SCRIPT = "scripts/isolation-ratchet.ts";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** A gate counter, held to the baseline, with the one direction it may move in. */
export interface GateCounter {
  readonly name: string;
  readonly direction: "falls" | "rises";
}

/** The gate counters, in the baseline's order. */
export const GATE_COUNTERS: readonly GateCounter[] = [
  { name: "enginesInPackages", direction: "rises" },
  { name: "coreHandwritten.distinctEngineIds", direction: "falls" },
  { name: "coreHandwritten.filesNamingAnEngine", direction: "falls" },
  { name: "coreHandwritten.linesNamingAnEngine", direction: "falls" },
  { name: "coreGenerated.lines", direction: "falls" },
  { name: "legacyProviders.files", direction: "falls" },
  { name: "agentLanguages.filesInLanguageDirs", direction: "falls" },
  { name: "languages.files", direction: "falls" },
  { name: "engineDeclarations.files", direction: "falls" },
  { name: "providerDocsInCore", direction: "falls" },
  { name: "providerIntegrationTestsInCore", direction: "falls" },
  { name: "inwardImportPairs", direction: "falls" },
  { name: "engineKeyedTypePositions", direction: "falls" },
  { name: "nonEnginePackages.linesNamingAnEngine", direction: "falls" },
];

/** The report counters, printed and never compared. */
export const REPORT_COUNTERS = [
  "engineIds",
  "coreGenerated.files",
  "legacyProviders.lines",
  "agentLanguages.lines",
  "languages.lines",
  "engineDeclarations.lines",
  "coreTests.filesNamingAnEngine",
  "coreTests.linesNamingAnEngine",
  "coreTests.codeFilesWithEngineInPath",
  "coreTests.fixtureFilesWithEngineInPath",
  "coreSource.filesWithEngineInPath",
] as const;

type ReportCounter = (typeof REPORT_COUNTERS)[number];

/** The id lists the baseline records, in its order. */
const ID_LISTS = [
  "coreHandwritten.engineIdsNamed",
  "enginesInPackages.ids",
  "nonEnginePackages.engineIdsNamed",
] as const;

type IdList = (typeof ID_LISTS)[number];

/** What the baseline file holds: every gate counter and the id lists, sorted. */
export interface Baseline {
  readonly counters: Readonly<Record<string, number>>;
  readonly ids: Readonly<Record<IdList, readonly string[]>>;
}

/** One measurement of a tree. `stale` names each exception or non-engine package entry that matches nothing. */
export interface Measurement {
  readonly baseline: Baseline;
  readonly report: Readonly<Record<ReportCounter, number>>;
  readonly stale: readonly string[];
}

/** A reviewed line that names an engine id and carries no engine knowledge. */
export interface Exception {
  readonly file: string;
  readonly ids: readonly string[];
  /** The exact trimmed text of the line. */
  readonly line: string;
  readonly reason: string;
}

/** A `packages/<directory>/` that is not an engine. */
export interface NonEnginePackage {
  readonly directory: string;
  readonly reason: string;
}

/** The lists a measurement takes besides the tree. */
export interface MeasureLists {
  readonly inward: readonly { readonly modules: readonly string[] }[];
  readonly exceptions: readonly Exception[];
  readonly nonEnginePackages: readonly NonEnginePackage[];
}

/** A tree to measure: its file paths, relative to the root with forward slashes, and a reader for them. */
export interface Tree {
  readonly files: readonly string[];
  readonly read: (file: string) => string;
}

export const NON_ENGINE_PACKAGES: readonly NonEnginePackage[] = [
  { directory: "provider-sdk", reason: "the contract SDK that providers build against, not an engine" },
];

const STORAGE_VALUE = "a STORAGE_PROVIDER value naming the storage backend, not the engine";
const GITHUB_OWNER = "the GitHub organisation name in a repository reference, not the engine";
const EXAMPLE_TEXT = "an example string value in a PromQL compatibility note, not the engine";
const MARKER = "the product's prefix of a marker line Studio writes into a statement, not the engine";
const MCP_SERVER = "the name of Studio's MCP server in a client configuration snippet, not the engine";
const SOCIAL_HANDLE = "the product's social media handle, not the engine";
const VSCODE_SECTION = "the VS Code extension's configuration section, not the engine";
const VSCODE_VIEW = "the VS Code extension's view container id, not the engine";

export const EXCEPTIONS: readonly Exception[] = [
  { file: "src/lib/storage/factory.ts", ids: ["sqlite"], line: 'case "sqlite": {', reason: STORAGE_VALUE },
  { file: "src/lib/storage/factory.ts", ids: ["postgres"], line: 'case "postgres": {', reason: STORAGE_VALUE },
  {
    file: "src/lib/storage/provider-type.ts",
    ids: ["sqlite", "postgres"],
    line: 'export type StorageProviderType = "local" | "sqlite" | "postgres";',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/provider-type.ts",
    ids: ["sqlite", "postgres"],
    line: 'if (env === "sqlite" || env === "postgres") return env;',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/postgres.ts",
    ids: ["postgres"],
    line: 'provider: "postgres",',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/postgres.ts",
    ids: ["postgres"],
    line: 'logger.error("PostgreSQL storage pool client error", error, { provider: "postgres" });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/postgres.ts",
    ids: ["postgres"],
    line: 'logger.error("PostgreSQL storage initialization failed", error, { provider: "postgres" });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/postgres.ts",
    ids: ["postgres"],
    line: 'logger.warn("Skipping corrupted storage data", { provider: "postgres", collection: row.collection });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/postgres.ts",
    ids: ["postgres"],
    line: 'logger.warn("Corrupted data in storage collection", { provider: "postgres", collection });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/postgres.ts",
    ids: ["postgres"],
    line: '{ provider: "postgres", removed },',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/sqlite.ts",
    ids: ["sqlite"],
    line: 'logger.error("SQLite storage initialization failed", error, { provider: "sqlite", path: this.dbPath });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/sqlite.ts",
    ids: ["sqlite"],
    line: 'logger.warn("Skipping corrupted storage data", { provider: "sqlite", collection: row.collection });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/sqlite.ts",
    ids: ["sqlite"],
    line: 'logger.warn("Corrupted data in storage collection", { provider: "sqlite", collection });',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/providers/sqlite.ts",
    ids: ["sqlite"],
    line: '{ provider: "sqlite", removed },',
    reason: STORAGE_VALUE,
  },
  {
    file: "src/lib/storage/types.ts",
    ids: ["sqlite", "postgres"],
    line: 'provider: "local" | "sqlite" | "postgres";',
    reason: STORAGE_VALUE,
  },
  {
    file: "scripts/distribution-check.mjs",
    ids: ["libredb"],
    line: 'return owner === "libredb" && repo === "libredb-studio" ? `#${number}` : `${owner}/${repo}#${number}`;',
    reason: GITHUB_OWNER,
  },
  {
    file: "src/lib/db/compatibility.ts",
    ids: ["libredb"],
    line: "'A string expression such as \"libredb\" returns no rows: VictoriaMetrics answers it with an empty vector, where Prometheus answers a string.',",
    reason: EXAMPLE_TEXT,
  },
  {
    file: "src/lib/explain/bigquery-dryrun.ts",
    ids: ["libredb"],
    line: 'export const BIGQUERY_DRY_RUN_MARKER = "-- libredb:bigquery-dry-run\\n";',
    reason: MARKER,
  },
  {
    file: "src/lib/explain/firestore-explain.ts",
    ids: ["libredb"],
    line: 'export const FIRESTORE_EXPLAIN_MARKER = "-- libredb:firestore-explain\\n";',
    reason: MARKER,
  },
  {
    file: "src/lib/languages/kubectl/paging.ts",
    ids: ["libredb"],
    line: "* one last line `# libredb:page offset=<n> limit=<n>`, which a shell reads as a comment, so the prepared text still",
    reason: MARKER,
  },
  {
    file: "src/lib/languages/kubectl/paging.ts",
    ids: ["libredb"],
    line: "const CLAUSE = /\\n# libredb:page offset=(0|[1-9][0-9]{0,8}) limit=([1-9][0-9]{0,8})$/;",
    reason: MARKER,
  },
  {
    file: "src/lib/languages/kubectl/paging.ts",
    ids: ["libredb"],
    line: "return `${text}\\n# libredb:page offset=${page.offset} limit=${page.limit}`;",
    reason: MARKER,
  },
  {
    file: "src/lib/mcp/client-config.ts",
    ids: ["libredb"],
    line: 'mcpServers: { libredb: { type: "http", url, headers: { Authorization: `Bearer \\${${MCP_TOKEN_ENV_NAME}}` } } },',
    reason: MCP_SERVER,
  },
  {
    file: "src/lib/mcp/client-config.ts",
    ids: ["libredb"],
    line: "mcpServers: { libredb: { url, headers: { Authorization: `Bearer \\${env:${MCP_TOKEN_ENV_NAME}}` } } },",
    reason: MCP_SERVER,
  },
  {
    file: "src/lib/mcp/client-config.ts",
    ids: ["libredb"],
    line: 'libredb: { type: "http", url, headers: { Authorization: `Bearer \\${input:${MCP_VSCODE_INPUT_ID}}` } },',
    reason: MCP_SERVER,
  },
  {
    file: "src/lib/mcp/client-config.ts",
    ids: ["libredb"],
    line: "mcpServers: { libredb: { httpUrl: url, headers: { Authorization: `Bearer ${MCP_TOKEN_PLACEHOLDER}` } } },",
    reason: MCP_SERVER,
  },
  { file: "src/lib/mcp/client-config.ts", ids: ["libredb"], line: "libredb: {", reason: MCP_SERVER },
  {
    file: "src/lib/social-links.ts",
    ids: ["libredb"],
    line: "* The handle is `libredb` on every platform; GitHub Sponsors is the one exception,",
    reason: SOCIAL_HANDLE,
  },
  {
    file: "vscode-extension/src/host/connections/connection-store.ts",
    ids: ["libredb"],
    line: '/** workspace.getConfiguration("libredb").get("connections") */',
    reason: VSCODE_SECTION,
  },
  {
    file: "vscode-extension/src/host/connections/connection-store.ts",
    ids: ["libredb"],
    line: 'read: () => workspace.getConfiguration("libredb").get("connections"),',
    reason: VSCODE_SECTION,
  },
  {
    file: "vscode-extension/src/host/connections/connection-store.ts",
    ids: ["libredb"],
    line: 'workspace.getConfiguration("libredb").update("connections", value, vscode.ConfigurationTarget.Global),',
    reason: VSCODE_SECTION,
  },
  {
    file: "vscode-extension/src/host/editor/run-query.ts",
    ids: ["libredb"],
    line: 'const value: unknown = workspace.getConfiguration("libredb").get("query.rowLimit");',
    reason: VSCODE_SECTION,
  },
  {
    file: "vscode-extension/src/host/names.ts",
    ids: ["libredb"],
    line: 'export const VIEW_CONTAINER = "libredb";',
    reason: VSCODE_VIEW,
  },
];

const CODE_FILE = /\.(c|m)?(t|j)sx?$/;
const TEST_CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const CORE_ROOTS = ["src/", "bin/", "scripts/", "vscode-extension/src/"];
const TEST_ROOTS = ["tests/", "e2e/", "vscode-extension/test/"];
const PATH_TEST_ROOTS = ["tests/", "e2e/"];
const LEGACY_PROVIDERS = "src/lib/db/providers/";
const DECLARATION = /^src\/lib\/db\/engine-declarations\/([^/]+)\.json$/;
const PACKAGE = /^packages\/provider-([^/]+)\//;
const AGENT_LANGUAGE_DIR_FILE = /^src\/lib\/agent\/languages\/[^/]+\/./;
const LANGUAGES = "src/lib/languages/";
const PROVIDER_DOC = /^docs\/providers\/([^/]+)\.md$/;
const PROVIDER_INTEGRATION_TEST = /^tests\/integration\/db\/[^/]+-provider\.test\.ts$/;
const KEYED_TYPE =
  /\b(?:Record|Map|ReadonlyMap|WeakMap)<\s*(?:(?:Exclude|Extract)<\s*)?DatabaseType\b|\[\s*\w+\s+in\s+(?:(?:Exclude|Extract)<\s*)?DatabaseType\b/g;

function baseName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

function lineCount(text: string): number {
  let newlines = 0;
  for (const char of text) if (char === "\n") newlines += 1;
  return newlines + (text !== "" && !text.endsWith("\n") ? 1 : 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The naming pattern over `ids`: group 2 holds an id in a quoted literal, group 3 an id as an object key. */
export function namingPattern(ids: readonly string[]): RegExp {
  const alternatives = [...ids]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join("|");
  return new RegExp(`(["'\`])(${alternatives})\\1|(?:^|[\\s{,;])(${alternatives})\\??\\s*:`, "g");
}

/** The ids a line names. An empty id set names nothing. */
function idsNamed(line: string, pattern: RegExp | null): Set<string> {
  const found = new Set<string>();
  if (pattern === null) return found;
  for (const match of line.matchAll(pattern)) found.add((match[2] ?? match[3]) as string);
  return found;
}

/** Files, lines and ids naming an engine over `files` after `exceptions`; `used` collects each entry applied. */
function scanNaming(
  tree: Tree,
  files: readonly string[],
  pattern: RegExp | null,
  exceptions: readonly Exception[],
  used: Set<Exception>,
): { files: number; lines: number; ids: Set<string> } {
  const result = { files: 0, lines: 0, ids: new Set<string>() };
  for (const file of files) {
    const own = exceptions.filter((entry) => entry.file === file);
    let lines = 0;
    for (const line of tree.read(file).split("\n")) {
      const found = idsNamed(line, pattern);
      if (found.size === 0) continue;
      const trimmed = line.trim();
      for (const entry of own) {
        if (entry.line === trimmed && entry.ids.every((id) => found.has(id))) {
          used.add(entry);
          for (const id of entry.ids) found.delete(id);
        }
      }
      if (found.size === 0) continue;
      lines += 1;
      for (const id of found) result.ids.add(id);
    }
    if (lines > 0) {
      result.files += 1;
      result.lines += lines;
    }
  }
  return result;
}

function totalLines(tree: Tree, files: readonly string[]): number {
  return files.reduce((sum, file) => sum + lineCount(tree.read(file)), 0);
}

function under(prefixes: readonly string[], file: string): boolean {
  return prefixes.some((prefix) => file.startsWith(prefix));
}

/** Measures a tree: every gate and report counter, and the stale entries of the two lists. */
export function measure(tree: Tree, lists: MeasureLists): Measurement {
  const files = [...new Set(tree.files)].sort();
  const stale: string[] = [];

  const nonEngine = new Set(lists.nonEnginePackages.map((entry) => entry.directory));
  for (const entry of lists.nonEnginePackages) {
    if (!files.some((file) => file.startsWith(`packages/${entry.directory}/`))) {
      stale.push(`NON_ENGINE_PACKAGES: ${entry.directory} names no directory under packages/`);
    }
  }
  const declarations = files.filter((file) => DECLARATION.test(file));
  const packaged = new Set<string>();
  for (const file of files) {
    const id = PACKAGE.exec(file)?.[1];
    if (id !== undefined && !nonEngine.has(`provider-${id}`)) packaged.add(id);
  }
  const engineIds = new Set([...declarations.map((file) => DECLARATION.exec(file)?.[1] as string), ...packaged]);
  const pattern = engineIds.size === 0 ? null : namingPattern([...engineIds]);

  const core = files.filter(
    (file) =>
      under(CORE_ROOTS, file) && CODE_FILE.test(file) && !file.startsWith(LEGACY_PROVIDERS) && file !== THIS_SCRIPT,
  );
  const generated = core.filter((file) => baseName(file).includes(".generated."));
  const handwritten = core.filter((file) => !baseName(file).includes(".generated."));
  const inPath = (file: string) =>
    [...engineIds].some((id) => new RegExp(`(^|[/_.-])${escapeRegExp(id)}([/_.-]|$)`).test(file));

  const used = new Set<Exception>();
  const naming = scanNaming(tree, handwritten, pattern, lists.exceptions, used);
  const nonEngineFiles = files.filter((file) =>
    lists.nonEnginePackages.some(
      ({ directory }) => file.startsWith(`packages/${directory}/`) && !file.startsWith(`packages/${directory}/tests/`),
    ),
  );
  const nonEngineNaming = scanNaming(tree, nonEngineFiles, pattern, [], new Set());
  for (const entry of lists.exceptions) {
    if (!used.has(entry)) {
      stale.push(
        `EXCEPTIONS: ${entry.file} names ${entry.ids.join(", ")} on no line that reads exactly: ${entry.line}`,
      );
    }
  }

  const legacy = files.filter((file) => file.startsWith(LEGACY_PROVIDERS));
  const agentLanguages = files.filter((file) => AGENT_LANGUAGE_DIR_FILE.test(file));
  const languages = files.filter((file) => file.startsWith(LANGUAGES));
  const keyed = handwritten.reduce((sum, file) => sum + (tree.read(file).match(KEYED_TYPE)?.length ?? 0), 0);

  const testCode = files.filter((file) => under(TEST_ROOTS, file) && TEST_CODE_FILE.test(file));
  const testNaming = scanNaming(tree, testCode, pattern, [], new Set());
  const pathTestFiles = files.filter((file) => under(PATH_TEST_ROOTS, file) && inPath(file));

  const counters: Record<string, number> = {
    enginesInPackages: packaged.size,
    "coreHandwritten.distinctEngineIds": naming.ids.size,
    "coreHandwritten.filesNamingAnEngine": naming.files,
    "coreHandwritten.linesNamingAnEngine": naming.lines,
    "coreGenerated.lines": totalLines(tree, generated),
    "legacyProviders.files": legacy.length,
    "agentLanguages.filesInLanguageDirs": agentLanguages.length,
    "languages.files": languages.length,
    "engineDeclarations.files": declarations.length,
    providerDocsInCore: files.filter((file) => engineIds.has(PROVIDER_DOC.exec(file)?.[1] ?? "")).length,
    providerIntegrationTestsInCore: files.filter((file) => PROVIDER_INTEGRATION_TEST.test(file)).length,
    inwardImportPairs: lists.inward.reduce((sum, entry) => sum + entry.modules.length, 0),
    engineKeyedTypePositions: keyed,
    "nonEnginePackages.linesNamingAnEngine": nonEngineNaming.lines,
  };
  return {
    baseline: {
      counters,
      ids: {
        "coreHandwritten.engineIdsNamed": [...naming.ids].sort(),
        "enginesInPackages.ids": [...packaged].sort(),
        "nonEnginePackages.engineIdsNamed": [...nonEngineNaming.ids].sort(),
      },
    },
    report: {
      engineIds: engineIds.size,
      "coreGenerated.files": generated.length,
      "legacyProviders.lines": totalLines(tree, legacy),
      "agentLanguages.lines": totalLines(tree, agentLanguages),
      "languages.lines": totalLines(tree, languages),
      "engineDeclarations.lines": totalLines(tree, declarations),
      "coreTests.filesNamingAnEngine": testNaming.files,
      "coreTests.linesNamingAnEngine": testNaming.lines,
      "coreTests.codeFilesWithEngineInPath": pathTestFiles.filter((file) => TEST_CODE_FILE.test(file)).length,
      "coreTests.fixtureFilesWithEngineInPath": pathTestFiles.filter((file) => !TEST_CODE_FILE.test(file)).length,
      "coreSource.filesWithEngineInPath": core.filter(inPath).length,
    },
    stale,
  };
}

/** One difference from the baseline: a move the wrong way, or an improvement the baseline has not taken in. */
export interface Finding {
  readonly kind: "worse" | "better";
  readonly message: string;
}

/**
 * Every difference between the committed baseline and a measurement, counters first in the baseline's order, then
 * the id lists. Equal measurements yield none.
 */
export function compareWithBaseline(baseline: Baseline, current: Baseline): Finding[] {
  const findings: Finding[] = [];
  for (const { name, direction } of GATE_COUNTERS) {
    const before = baseline.counters[name] as number;
    const now = current.counters[name] as number;
    if (before === now) continue;
    const rose = now > before;
    if (rose === (direction === "rises")) {
      findings.push({
        kind: "better",
        message: `${name}: baseline ${before}, now ${now}, an improvement; ${REGENERATE_SENTENCE}`,
      });
    } else {
      findings.push({
        kind: "worse",
        message: `${name}: baseline ${before}, now ${now}; it may only ${direction === "falls" ? "fall" : "rise"}`,
      });
    }
  }
  findings.push(...namedIdFindings(baseline, current, "coreHandwritten.engineIdsNamed", "core"));
  const packaged = "enginesInPackages.ids";
  for (const id of baseline.ids[packaged]) {
    if (!current.ids[packaged].includes(id)) {
      findings.push({ kind: "worse", message: `${packaged}: ${id} is in the baseline and is no longer a package` });
    }
  }
  for (const id of current.ids[packaged]) {
    if (!baseline.ids[packaged].includes(id)) {
      findings.push({ kind: "better", message: `${packaged}: ${id} is a new package; ${REGENERATE_SENTENCE}` });
    }
  }
  findings.push(...namedIdFindings(baseline, current, "nonEnginePackages.engineIdsNamed", "a non-engine package"));
  return findings;
}

/** The findings of one list of ids named in `place`: a new id is worse, a gone id an improvement to take in. */
function namedIdFindings(baseline: Baseline, current: Baseline, list: IdList, place: string): Finding[] {
  const findings: Finding[] = [];
  for (const id of current.ids[list]) {
    if (!baseline.ids[list].includes(id)) {
      findings.push({
        kind: "worse",
        message: `${list}: ${id} is named in ${place} and the baseline does not list it`,
      });
    }
  }
  for (const id of baseline.ids[list]) {
    if (!current.ids[list].includes(id)) {
      findings.push({
        kind: "better",
        message: `${list}: ${id} is no longer named in ${place}; ${REGENERATE_SENTENCE}`,
      });
    }
  }
  return findings;
}

/** The baseline file's text: a header, every gate counter and every id list in a fixed order, and a final newline. */
export function renderBaseline(baseline: Baseline): string {
  const counters = Object.fromEntries(GATE_COUNTERS.map(({ name }) => [name, baseline.counters[name]]));
  const ids = Object.fromEntries(ID_LISTS.map((name) => [name, baseline.ids[name]]));
  return `${JSON.stringify({ "//": HEADER, counters, ids }, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the baseline file's text, refusing by name a missing, unknown or malformed counter or id list. */
export function parseBaseline(text: string): Baseline {
  const refuse = (problem: string): never => {
    throw new Error(`${BASELINE_FILE}: ${problem}${PARSE_SUFFIX}`);
  };
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || !isObject(value.counters) || !isObject(value.ids)) {
    return refuse("the file is not an object with counters and ids");
  }
  const names = new Set(GATE_COUNTERS.map(({ name }) => name));
  for (const name of Object.keys(value.counters)) {
    if (!names.has(name)) refuse(`counter ${name} is not a gate counter`);
  }
  const counters: Record<string, number> = {};
  for (const name of names) {
    const count = value.counters[name];
    if (count === undefined) refuse(`counter ${name} is missing`);
    if (!Number.isInteger(count) || (count as number) < 0) refuse(`counter ${name} is not a non-negative integer`);
    counters[name] = count as number;
  }
  for (const name of Object.keys(value.ids)) {
    if (!(ID_LISTS as readonly string[]).includes(name)) refuse(`id list ${name} is not a baseline id list`);
  }
  const ids = {} as Record<IdList, readonly string[]>;
  for (const name of ID_LISTS) {
    const list = value.ids[name];
    if (list === undefined) refuse(`id list ${name} is missing`);
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string")) {
      refuse(`id list ${name} is not a list of strings`);
    }
    ids[name] = list as string[];
  }
  return { counters, ids };
}

/** What the command line touches, so a test drives it in process. */
export interface Io {
  readonly list: () => readonly string[];
  readonly read: (file: string) => string;
  /** The committed baseline's text, or null when there is no file. */
  readonly readBaseline: () => string | null;
  readonly writeBaseline: (text: string) => void;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** The repository at `root`, listed through git, with the baseline at `baselineFile`. */
export function realIo(root: string, baselineFile: string): Io {
  return {
    list: () => {
      const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      return [...new Set(listed.split("\0"))].filter((file) => file !== "" && existsSync(path.join(root, file))).sort();
    },
    read: (file) => readFileSync(path.join(root, file), "utf8"),
    readBaseline: () => {
      try {
        return readFileSync(baselineFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeBaseline: (text) => writeFileSync(baselineFile, text),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

/** The command line; returns the exit code. */
export function main(argv: readonly string[], io: Io): number {
  const write = argv.length === 1 && argv[0] === "--write";
  if (!write && argv.length !== 0) {
    io.error(USAGE);
    return 2;
  }
  const measured = measure(
    { files: io.list(), read: io.read },
    { inward: INWARD_IMPORTS, exceptions: EXCEPTIONS, nonEnginePackages: NON_ENGINE_PACKAGES },
  );
  if (!write) {
    for (const { name } of GATE_COUNTERS) io.log(`gate ${name} ${measured.baseline.counters[name]}`);
    for (const name of REPORT_COUNTERS) io.log(`report ${name} ${measured.report[name]}`);
    return 0;
  }
  if (measured.stale.length > 0) {
    for (const line of measured.stale) io.error(line);
    io.error("The baseline is not rewritten: remove or correct each stale entry above.");
    return 1;
  }
  const committed = io.readBaseline();
  if (committed !== null) {
    const worse = compareWithBaseline(parseBaseline(committed), measured.baseline).filter(
      (finding) => finding.kind === "worse",
    );
    if (worse.length > 0) {
      for (const finding of worse) io.error(finding.message);
      io.error("The baseline is not rewritten: --write never raises a counter.");
      return 1;
    }
  }
  io.writeBaseline(renderBaseline(measured.baseline));
  io.log(`Wrote ${BASELINE_FILE}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), realIo(REPO_ROOT, path.join(REPO_ROOT, BASELINE_FILE)));
}
