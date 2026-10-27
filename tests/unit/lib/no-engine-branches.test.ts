/**
 * Outside the provider layer, no source file branches on a database type id, apart from a closed list (engine
 * contract spec 6.4).
 *
 * It reads every source file under `src/` and `vscode-extension/src/` that git lists (tracked, and untracked but not
 * ignored), outside `src/lib/db/**` and `src/lib/agent/languages/**`, and finds each branch shape
 * `./no-engine-branches/scan.ts` names: a table keyed by a type id, an array of type ids, a comparison or `case` label
 * with one, and one in default position. Every finding is held, by file and declaration name, to exactly one of three
 * lists, and each entry names how many findings its declaration holds, so a branch added inside a listed declaration
 * fails as one added anywhere else does:
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
const PROVIDER_LAYER = ["src/lib/db/", "src/lib/agent/languages/"];
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
const AWS_CLI_SERVICE = "the AWS CLI service name `s3` in a typed command, not the engine";
const MONACO_LANGUAGE =
  "a Monaco language id the editor registers, which the dialect editor table picks, not the engine";

/** The registries of spec 5.6, which stay. */
export const REGISTRIES: readonly Listed[] = [
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
  { path: "src/lib/editor/s3-completions.ts", declaration: "operationOf", count: 1, reason: AWS_CLI_SERVICE },
  { path: "src/lib/editor/s3-completions.ts", declaration: "s3CompletionContext", count: 1, reason: AWS_CLI_SERVICE },
  { path: "src/lib/editor/s3-completions.ts", declaration: "itemsOf", count: 1, reason: AWS_CLI_SERVICE },
  {
    path: "src/lib/editor/firestore-language.ts",
    declaration: "FIRESTORE_MONARCH",
    count: 1,
    reason: "the `firestore` namespace of the Firestore SDK, highlighted as a type name",
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
  { path: "src/components/QueryEditor.tsx", declaration: "QueryEditor", count: 2, reason: MONACO_LANGUAGE },
  { path: "src/lib/editor/etcd-language.ts", declaration: "registerEtcdLanguage", count: 1, reason: MONACO_LANGUAGE },
  {
    path: "src/lib/editor/firestore-language.ts",
    declaration: "registerFirestoreLanguage",
    count: 1,
    reason: MONACO_LANGUAGE,
  },
  {
    path: "src/lib/editor/libredb-language.ts",
    declaration: "registerLibreDBLanguage",
    count: 1,
    reason: MONACO_LANGUAGE,
  },
  { path: "src/lib/editor/oxia-language.ts", declaration: "registerOxiaLanguage", count: 1, reason: MONACO_LANGUAGE },
  { path: "src/lib/editor/redis-language.ts", declaration: "registerRedisLanguage", count: 1, reason: MONACO_LANGUAGE },
  { path: "src/lib/editor/s3-language.ts", declaration: "registerS3Language", count: 1, reason: MONACO_LANGUAGE },
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
    path: "src/components/agent/AnswerCard.tsx",
    declaration: "LANGUAGE_ACCENTS",
    count: 1,
    reason: "keyed by the agent statement language, some of whose names are spelled like type ids",
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
