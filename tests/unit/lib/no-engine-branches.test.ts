/**
 * Outside the provider layer, no source file branches on a database type id, apart from a closed list (engine
 * contract spec 6.4).
 *
 * It reads every source file under `src/` and `vscode-extension/src/` that git lists (tracked, and untracked but not
 * ignored), outside the provider layer, and finds each branch shape
 * `./no-engine-branches/scan.ts` names: a table keyed by a type id, an array of type ids, a comparison or `case` label
 * with one, and one in default position. Every finding is held, by file and declaration name, to exactly one of three
 * lists, and each entry names how many findings its declaration holds, so a branch added inside a listed declaration
 * fails as one added anywhere else does:
 *
 * The provider layer is `src/lib/db/providers/**` and the statement-language packs under `src/lib/agent/languages/**`.
 * The rest of `src/lib/db/` is a shared core like any other and is scanned, the engine contract directories with it:
 * their index tables, which collect one row per engine declared beside its provider, are listed as registries, as are
 * the other tables keyed by type id, and `factory.ts` as the composition root.
 *
 * 1. `REGISTRIES`, the mappings of spec 5.6 that stay, because their job is the mapping;
 * 2. `FALSE_POSITIVES`, a word spelled like a type id that names something else, each with what it names;
 * 3. `DEBT`, a branch that moves into an engine contract, each naming the PR that removes it.
 *
 * A listed entry that no longer matches a finding fails too, so each later PR deletes its debt entries, or lowers the
 * count of one it moves in part, and the debt list ends empty.
 *
 * It also carries the two other rules of the guard it replaces (#1822): `src/components/CreateTableModal.tsx` knows
 * no engine, and the removed `supportsCreateTable` flag is named nowhere under `src/`, `tests/` or `docs/`, apart
 * from this file and the history in `docs/BACKLOG.md`.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { type BranchFinding, findEngineBranches } from "./no-engine-branches/scan";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
/** The engine contract directories, scanned like the rest of the shared db core. */
const CONTRACT_DIRECTORIES = [
  "src/lib/db/connection-string/",
  "src/lib/db/execution-ui/",
  "src/lib/db/migration-ddl/",
  "src/lib/db/sql-grammar/",
  "src/lib/db/sql-writing/",
];
const PROVIDER_LAYER = ["src/lib/db/providers/", "src/lib/agent/languages/"];
const THIS_FILE = "tests/unit/lib/no-engine-branches.test.ts";
const CREATE_TABLE_MODAL = "src/components/CreateTableModal.tsx";
const TYPE_IDS: ReadonlySet<string> = new Set([...EXTERNAL_DATABASE_TYPES, "libredb"]);

/**
 * A declaration allowed to branch on a type id, by file and declaration name, with how many findings it holds and the
 * reason it may.
 */
export interface Listed {
  readonly path: string;
  readonly declaration: string;
  readonly count: number;
  readonly reason: string;
}

/** A branch that moves into an engine contract, with the PR of the engine contract plan that removes it. */
export interface Debt extends Listed {
  readonly pr: 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

const DISPLAY_ORDER = "display order only";
const INBOUND = "an inbound mapping from an outside name to a type id";
const AGENT_LEG = "the agent-leg pattern, guarded by its own tests";
const STORAGE_BACKEND = "the storage backend `STORAGE_PROVIDER` names, not an engine";
const COMPATIBILITY = "a total per-engine compatibility table, compile-enforced over the type-id union";
const FIELDS = "the UI-free connection field table, compile-enforced over the type-id union";
const CONTRACT = "an engine contract's index, which collects the row each engine declares beside its provider";
const NO_CONNECTION = "the engine a view with no connection open has always named, kept as the no-connection row";

/** The registries of spec 5.6, which stay. */
export const REGISTRIES: readonly Listed[] = [
  ...[
    "SHIPPED",
    "EXTERNAL",
    "READ_ONLY_ENFORCED",
    "READS_FILE_ACCESS_POSTURE",
    "SINGLE_WRITER_FILE",
    "MCP_EXPOSABLE",
    "MCP_STATEMENT_READ",
    "CONNECTION_FORM_URI_MODE",
    "CONNECTION_STRING_ACCEPTED",
    "OPENS_LOCAL_FILE",
    "OPENS_SERVER_LEVEL_WITHOUT_DATABASE",
  ].map((declaration) => ({ path: "src/lib/db/compatibility.ts", declaration, count: 1, reason: COMPATIBILITY })),
  ...["CONNECTION_FIELD_ROWS", "CONNECTION_FIELDS", "SEED_ONLY_FIELDS"].map((declaration) => ({
    path: "src/lib/db/connection-fields.ts",
    declaration,
    count: 1,
    reason: FIELDS,
  })),
  ...[
    ["src/lib/db/connection-string/index.ts", "CONNECTION_STRING"],
    ["src/lib/db/execution-ui/index.ts", "EXECUTION_UI"],
    ["src/lib/db/migration-ddl/index.ts", "MIGRATION_DDL"],
    ["src/lib/db/sql-grammar/index.ts", "SQL_GRAMMAR"],
    ["src/lib/db/sql-writing/index.ts", "SQL_WRITING"],
  ].map(([path, declaration]) => ({ path, declaration, count: 1, reason: CONTRACT })),
  {
    path: "src/lib/db/connection-string/index.ts",
    declaration: "CONNECTION_STRING_PASTE_ORDER",
    count: 1,
    reason: "the order the parser offers a paste to the rows that read one, the one place that order is kept",
  },
  {
    path: "src/lib/db/connection-string/index.ts",
    declaration: "pasteRows",
    count: 1,
    reason: "the parameter type of the connection string index it is handed, which holds no row here",
  },
  {
    path: "src/lib/db/connection-string/index.ts",
    declaration: "ENGINE_URI_SCHEMES",
    count: 1,
    reason: "the scheme of each row that has one, built from the connection string index",
  },
  {
    path: "src/lib/db/execution-ui/explain-request.ts",
    declaration: "explainRequestEngine",
    count: 1,
    reason: NO_CONNECTION,
  },
  {
    path: "src/lib/db/migration-ddl/index.ts",
    declaration: "migrationDialectHeader",
    count: 1,
    reason: NO_CONNECTION,
  },
  {
    path: "src/lib/db/connection-form.ts",
    declaration: "CONNECTION_FORM",
    count: 1,
    reason: "each engine's UI-free connection form row, compile-enforced over the type-id union",
  },
  { path: "src/lib/db/connection-form.ts", declaration: "CONNECTION_PICKER_ORDER", count: 1, reason: DISPLAY_ORDER },
  {
    path: "src/lib/db/credential-warnings.ts",
    declaration: "CREDENTIAL_WARNINGS",
    count: 1,
    reason: "the credential warning each engine's form shows, one row per engine",
  },
  {
    path: "src/lib/db/destructive-commands.ts",
    declaration: "NON_SQL_DESTRUCTIVE_VOCABULARY",
    count: 1,
    reason: "the confirmation gate's registry, each row declared beside its provider",
  },
  {
    path: "src/lib/db/factory.ts",
    declaration: "createDatabaseProvider",
    count: 43,
    reason: "the composition root, which maps each type id to its provider class",
  },
  {
    path: "src/lib/db/graph-policy-profiles.ts",
    declaration: "GRAPH_POLICY_PROFILES",
    count: 1,
    reason: "the graph policy profile of each graph engine, a partial registry",
  },
  {
    path: "src/components/admin/tabs/OverviewTab.tsx",
    declaration: "DB_TYPES_PREVIEW",
    count: 1,
    reason: DISPLAY_ORDER,
  },
  { path: "src/lib/db-showcase.ts", declaration: "SHOWCASE_RANK", count: 1, reason: DISPLAY_ORDER },
  {
    path: "src/lib/db-ui-config.ts",
    declaration: "DB_UI_CONFIG",
    count: 1,
    reason: "each engine's icon and identity colour, joined to the UI-free form data of src/lib/db/connection-form.ts",
  },
  {
    path: "src/lib/seed/types.ts",
    declaration: "SeedDatabaseType",
    count: 1,
    reason: "the seed file's validation mirror of the type-id union",
  },
  { path: "src/lib/seed/discovery-fingerprint.ts", declaration: "IMAGE_ENGINES", count: 3, reason: INBOUND },
  {
    path: "src/lib/seed/discovery-fingerprint.ts",
    declaration: "credentialsOf",
    count: 4,
    reason: "an inbound mapping of a container image's env names, owned by the discovery spec",
  },
  {
    path: "src/lib/sql/fence-tags.ts",
    declaration: "ENGINE_FENCE_TAGS",
    count: 1,
    reason: "the total name registry of code fence tags",
  },
  { path: "src/lib/agent/agent-manifest.ts", declaration: "AGENT_STATEMENT_LANGUAGE", count: 1, reason: AGENT_LEG },
  { path: "src/lib/agent/agent-manifest.ts", declaration: "AGENT_REQUIREMENT_ENGINES", count: 2, reason: AGENT_LEG },
  {
    path: "src/lib/agent/agent-manifest.ts",
    declaration: "AgentAvailabilityTables",
    count: 1,
    reason: "the type of the agent-leg tables above, which availability is decided from",
  },
  { path: "src/lib/agent/engine-support.ts", declaration: "AGENT_EXECUTION_ENGINES", count: 1, reason: AGENT_LEG },
  {
    path: "src/lib/governance/config.ts",
    declaration: "ALLOWED_ENGINES_DEFAULT",
    count: 1,
    reason: "a policy default, not engine behaviour",
  },
  {
    path: "vscode-extension/src/host/channel.ts",
    declaration: "HELD_BACK",
    count: 1,
    reason: "the engines the VS Code channel holds back, a policy default, not engine behaviour",
  },
];

/** A spelling of a type id that names something else. */
export const FALSE_POSITIVES: readonly Listed[] = [
  {
    path: "src/lib/storage/provider-type.ts",
    declaration: "getStorageProviderType",
    count: 2,
    reason: STORAGE_BACKEND,
  },
  { path: "src/lib/storage/factory.ts", declaration: "getStorageProvider", count: 2, reason: STORAGE_BACKEND },
  {
    path: "src/lib/agent/config.ts",
    declaration: "resolveAgentAvailability",
    count: 1,
    reason: "the agent ledger's storage backend, not an engine",
  },
  {
    path: "src/lib/config/auth-preflight.ts",
    declaration: "verifyStorageSchemaAtBoot",
    count: 1,
    reason: STORAGE_BACKEND,
  },
  {
    path: "src/lib/governance/config.ts",
    declaration: "governanceSource",
    count: 2,
    reason: "the governance source setting, which names where policy is stored",
  },
  {
    path: "src/lib/distribution/channels.generated.ts",
    declaration: "LIVE_PLATFORMS",
    count: 1,
    reason: "the `kubernetes` install platform of the channel showcase",
  },
  {
    path: "src/lib/distribution/deploy-groups.ts",
    declaration: "DEPLOY_GROUP_ORDER",
    count: 1,
    reason: "the `kubernetes` channel group of the channel showcase",
  },
  {
    path: "src/lib/distribution/deploy-groups.ts",
    declaration: "DEPLOY_GROUP_LABELS",
    count: 1,
    reason: "keyed by the channel showcase groups, one of which is `kubernetes`",
  },
  {
    path: "src/lib/seed/vault-client.ts",
    declaration: "authPath",
    count: 1,
    reason: "Vault's default Kubernetes auth mount path `kubernetes`, not the engine",
  },
  {
    path: "src/lib/seed/discovery-fingerprint.ts",
    declaration: "user",
    count: 1,
    reason: "the PostgreSQL image's default role name `postgres`, when POSTGRES_USER is unset",
  },
  {
    path: "src/lib/seed/types.ts",
    declaration: "refuseMcpWhereNotOffered",
    count: 1,
    reason: "the parameter type of the `MCP_EXPOSABLE` registry it is handed, which holds no row here",
  },
];

/** Every branch of spec 2.6 not yet moved, with the PR that moves it. */
export const DEBT: readonly Debt[] = [
  // Empty: every engine-contract move has landed.
];

/** Every file git lists under `paths`: tracked, or untracked and not ignored. */
function listedFiles(...paths: string[]): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return [...new Set(listed.split("\0"))].filter((path) => path !== "" && existsSync(join(ROOT, path))).sort();
}

/** A module a scanned file imports, read so a type alias or constant from it is followed (spec 6.4). */
const readModule = (path: string): string | undefined => {
  try {
    return readFileSync(join(ROOT, path), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
};

/** The source files the guard reads: those outside the provider layer. */
function scannedFiles(): string[] {
  return listedFiles("src", "vscode-extension/src").filter(
    (path) => SOURCE_FILE.test(path) && !PROVIDER_LAYER.some((layer) => path.startsWith(layer)),
  );
}

/** Every branch on a type id in the source files outside the provider layer. */
function branches(): BranchFinding[] {
  return scannedFiles().flatMap((path) =>
    findEngineBranches(path, readFileSync(join(ROOT, path), "utf8"), TYPE_IDS, readModule),
  );
}

const LISTS: Readonly<Record<string, readonly Listed[]>> = { REGISTRIES, FALSE_POSITIVES, DEBT };
const key = ({ path, declaration }: { path: string; declaration: string }): string => `${path} ${declaration}`;

describe("type-id branches outside the provider layer", () => {
  const found = branches();

  test("scan the VS Code extension's sources as well as src/", () => {
    expect(scannedFiles().filter((path) => path.startsWith("vscode-extension/src/")).length).toBeGreaterThan(0);
  });

  test("scan the shared db core, the MCP server and the components", () => {
    const scanned = scannedFiles();
    for (const shared of [
      "src/lib/db/factory.ts",
      "src/lib/db/destructive-commands.ts",
      "src/lib/db/utils/",
      ...CONTRACT_DIRECTORIES,
    ]) {
      expect(
        scanned.some((path) => path.startsWith(shared)),
        shared,
      ).toBe(true);
    }
    for (const shared of ["src/lib/mcp/", "src/components/"]) {
      expect(scanned.filter((path) => path.startsWith(shared)).length, shared).toBeGreaterThan(0);
    }
    expect(scanned.filter((path) => path.startsWith("src/lib/db/providers/"))).toEqual([]);
  });

  test("are each held by exactly one list", () => {
    const unheld = found
      .filter(
        (finding) => Object.values(LISTS).filter((list) => list.some((e) => key(e) === key(finding))).length !== 1,
      )
      .map((finding) => `${finding.path}:${finding.line} ${finding.declaration} ${finding.shape} ${finding.text}`);
    expect(unheld).toEqual([]);
  });

  test("leave no listed entry without a branch", () => {
    const present = new Set(found.map(key));
    const absent = Object.entries(LISTS).flatMap(([name, list]) =>
      list.filter((entry) => !present.has(key(entry))).map((entry) => `${name}: ${key(entry)} (${entry.reason})`),
    );
    expect(absent).toEqual([]);
  });

  test("hold exactly the number of findings each entry names", () => {
    const held = new Map<string, number>();
    for (const finding of found) held.set(key(finding), (held.get(key(finding)) ?? 0) + 1);
    const miscounted = Object.entries(LISTS).flatMap(([name, list]) =>
      list
        .filter((entry) => (held.get(key(entry)) ?? 0) !== entry.count)
        .map((entry) => `${name}: ${key(entry)} lists ${entry.count}, holds ${held.get(key(entry)) ?? 0}`),
    );
    expect(miscounted).toEqual([]);
  });

  test("list each entry once, and each debt entry names a PR of the plan", () => {
    const keys = Object.values(LISTS).flatMap((list) => list.map(key));
    expect(keys.filter((entry, at) => keys.indexOf(entry) !== at)).toEqual([]);
    expect(DEBT.filter((entry) => !(entry.pr >= 2 && entry.pr <= 8)).map(key)).toEqual([]);
  });
});

/** The statement text of `path`, with its comments blanked so prose about an engine is not read as a branch. */
function codeOf(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The members of a string-literal union type alias declared in `path`. */
function unionMembers(path: string, alias: string): string[] {
  const source = readFileSync(join(ROOT, path), "utf8");
  const start = source.indexOf(`export type ${alias} =`);
  const end = source.indexOf(";", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

// An engine fact the scan cannot see, because its value is not a type id, held to the module that owns it.
describe("engine facts spelled by a value other than a type id", () => {
  test("the Studio shell names no explain format: a strategy declares its live estimate", () => {
    const formats = unionMembers("src/lib/db/types.ts", "ExplainFormat");
    expect(formats.length).toBeGreaterThan(0);
    const code = codeOf("src/components/Studio.tsx");
    expect(
      formats.filter((format) => ['"', "'", "`"].some((quote) => code.includes(`${quote}${format}${quote}`))),
    ).toEqual([]);
  });

  test("the test data generator names no engine's request operation: the sql-writing row writes it", () => {
    expect(codeOf("src/components/TestDataGenerator.tsx")).not.toMatch(/["'`]insertMany["'`]/);
  });
});

describe("the Create Table form knows no engine (#1822)", () => {
  const source = readFileSync(join(ROOT, CREATE_TABLE_MODAL), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  test("imports no DatabaseType and takes no dbType", () => {
    expect(source.match(/\b(DatabaseType|dbType)\b/g) ?? []).toEqual([]);
  });

  test("spells no type id as a string literal", () => {
    const spelled = [...TYPE_IDS].filter((id) =>
      ['"', "'", "`"].some((quote) => source.includes(`${quote}${id}${quote}`)),
    );
    expect(spelled).toEqual([]);
  });
});

describe("the removed supportsCreateTable flag (#1822)", () => {
  test("is named nowhere under src, tests or docs", () => {
    const exempt = new Set([THIS_FILE, "docs/BACKLOG.md"]);
    const named = listedFiles("src", "tests", "docs")
      .filter((path) => !exempt.has(path))
      .filter((path) => readFileSync(join(ROOT, path), "utf8").includes("supportsCreateTable"));
    expect(named, "declare `createTable` in the provider's capabilities").toEqual([]);
  });
});
