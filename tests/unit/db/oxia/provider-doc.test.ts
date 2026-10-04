/**
 * `docs/providers/oxia.md` quotes sentences, numbers, commands and declarations the provider's own modules own
 * (SB3-4.1, SB2-11.2 item 2), the shape of the Qdrant and etcd doc tests, written again.
 *
 * A value copied into prose is true only until the code moves, so every bound, refusal, notice, command example,
 * capability and label the doc quotes is read back here from the module that owns it, and every number from
 * `constants.ts`. This is part 1: what the provider's modules export. The dialog hints, the security rows and the
 * seed fixture are read once the type-id is registered (part 2).
 * Part 2 reads what needed the registered type-id: the dialog's hints, the credential warning, the capabilities the
 * factory builds, the SECURITY rows, the seed fixture and its SEED_CONNECTIONS row.
 *
 * The doc test never connects: the provider is built with a client factory that throws if it is called.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { connectionFieldHint, DB_UI_CONFIG, hostUriSchemes, offersSshTunnel, readOnlyHint } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS, credentialWarningFor, readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { createDatabaseProvider } from "@/lib/db/factory";
import { DEFAULT_QUERY_TIMEOUT } from "@/lib/db/types";
import {
  OXIA_COMMAND_TABLE,
  OXIA_INTERNAL_KEY_SENTENCE,
  OXIA_REFUSED_COMMANDS,
  OXIA_REFUSED_FLAGS,
  type OxiaParseContext,
  parseOxiaCommand,
  writeCommandSentence,
} from "@/lib/db/providers/keyvalue/oxia/commands";
import {
  admitLeaders,
  buildOxiaConnectionOptions,
  leaderPlaintextTokenRefusal,
  type OxiaConnectionOptions,
  oxiaErrorConnection,
} from "@/lib/db/providers/keyvalue/oxia/connection-options";
import {
  OXIA_CELL_LIMIT,
  OXIA_DEFAULT_PORT,
  OXIA_DISCOVERY_DEADLINE_MS,
  OXIA_DISCOVERY_MAX_CALLS,
  OXIA_DISCOVERY_MAX_ROUNDS,
  OXIA_INTERNAL_PREFIX,
  OXIA_KEY_SCAN_DEFAULT_COUNT,
  OXIA_KEY_SCAN_MAX_COUNT,
  OXIA_LEADER_MAX_BYTES,
  OXIA_LIMITER_OPTIONS,
  OXIA_LIST_DEFAULT_LIMIT,
  OXIA_MAX_DATA_SERVERS,
  OXIA_MAX_LIMIT,
  OXIA_MAX_SHARD_STREAMS,
  OXIA_MAX_SHARDS,
  OXIA_MAX_TEXT_BYTES,
  OXIA_NAMESPACE_MAX_BYTES,
  OXIA_PAGE_KEPT_BYTES,
  OXIA_PAGE_STREAM_BYTES,
  OXIA_RECEIVE_CAP_BYTES,
  OXIA_RUN_BYTE_BUDGET,
  OXIA_SCAN_DEFAULT_LIMIT,
  OXIA_SOURCE_HEX_BYTES,
} from "@/lib/db/providers/keyvalue/oxia/constants";
import { OXIA_CURSOR_FOREIGN_REFUSAL, OXIA_CURSOR_ORDER_REFUSAL } from "@/lib/db/providers/keyvalue/oxia/cursor";
import {
  OXIA_ADAPTER_INTERNAL_KEY_SENTENCE,
  OXIA_HEALTH_NO_SHARD_MAP,
  OXIA_INDEX_NAME_SENTENCE,
  OXIA_LIST_RECEIVE_CAP_SENTENCE,
  OXIA_LONE_SURROGATE_SENTENCE,
  OXIA_STALLED_PAGE_SENTENCE,
  OxiaError,
  type OxiaErrorCategory,
  type OxiaErrorFields,
  type OxiaSnapshotProblem,
  receiveCapNotice,
  runBudgetNotice,
  silentAssignmentsSentence,
  snapshotInvalidSentence,
  toProviderError,
} from "@/lib/db/providers/keyvalue/oxia/errors";
import { OxiaProvider } from "@/lib/db/providers/keyvalue/oxia/index";
import { OXIA_CURSOR_KEY_TOO_LONG_SENTENCE, OXIA_KEY_SCAN } from "@/lib/db/providers/keyvalue/oxia/key-scan";
import { keyOrderWords, OXIA_LABELS, OXIA_STATEMENT_EXAMPLES } from "@/lib/db/providers/keyvalue/oxia/labels";
import { oxiaHealth } from "@/lib/db/providers/keyvalue/oxia/monitoring-reads";
import {
  OXIA_KEYS_LISTED_ELSEWHERE,
  OXIA_OBJECT_KINDS,
  oxiaKeyOnShardsSentence,
} from "@/lib/db/providers/keyvalue/oxia/objects";
import { OXIA_RECORD_FIELDS } from "@/lib/db/providers/keyvalue/oxia/results";
import { SNAPSHOT_PROBLEM_REASONS, type SnapshotProblem } from "@/lib/db/providers/keyvalue/oxia/routing";
import { WITHHELD_VALUE_TEXT } from "@/lib/db/providers/keyvalue/oxia/values";
import type { OxiaSurface } from "@/lib/db/providers/keyvalue/oxia/walks";
import { SeedConfigSchema } from "@/lib/seed/types";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { oxiaConnection } from "../../../helpers/oxia-connection";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/oxia.md");
const PROVIDER_DIRECTORY = "src/lib/db/providers/keyvalue/oxia";

const provider = new OxiaProvider(oxiaConnection(), {}, {}, () => {
  throw new Error("the doc test never connects");
});

/**
 * Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces.
 * A placeholder outside a code span is written `\<n\>`, since a bare `<n>` is an HTML tag a renderer hides, and is
 * compared as the sentence writes it.
 */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ").replace(/\\([<>])/g, "$1");
/** A byte size as the doc and the sentences write it. */
const mib = (bytes: number): string => `${bytes / (1024 * 1024)} MiB`;
/** A count with an en-US thousands separator. */
const n = (count: number): string => count.toLocaleString("en-US");
/** A sentence with its parameters standing in, as the doc writes it: each value replaced by its name, in order. */
const placeholder = (sentence: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce((text, [value, name]) => text.split(value).join(name), sentence);

/** Whether line `at` of `lines` is inside a fenced block. */
const inFence = (lines: readonly string[], at: number): boolean =>
  lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;

/** The heading lines of `text`, outside fenced blocks. */
function headings(text: string): string[] {
  const lines = text.split("\n");
  return lines.filter((line, at) => /^#{1,6} /.test(line) && !inFence(lines, at));
}

/** The section under the heading line `heading`, up to the next heading of its level or above. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(lines, at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** The table row of `text` whose first cell is exactly `cell`. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

/** A label the provider declares; an undeclared one fails the case rather than matching an empty string. */
function declaredLabel(value: string | undefined): string {
  if (value === undefined) throw new Error("the provider declares no such label");
  return value;
}

/** A code span as a Markdown table cell writes it: a pipe inside it escaped. */
const tableCode = (text: string): string => `\`${text.replaceAll("|", "\\|")}\``;

const OUTLINE: readonly string[] = [
  "# Oxia Provider",
  "## Before you connect",
  "## 1. Overview",
  "### Concept mapping",
  "## 2. Architecture",
  "### 2.1 Where it sits",
  "### 2.2 Modules",
  "### 2.3 Registration & lifecycle",
  "### 2.4 The client, and why",
  "## 3. Design decisions",
  "### 3.1 Read-only v1",
  "### 3.2 Key order probed, not configured",
  "### 3.3 The dial policy",
  "### 3.4 Internal keys",
  "### 3.5 The read-only mode",
  "### 3.6 Machine access",
  "### 3.7 Lossless integers",
  "## 4. Connection",
  "### 4.1 Configuration fields",
  "### 4.2 Authentication",
  "### 4.3 TLS",
  "### 4.4 Data servers and the dial policy",
  "### 4.5 SSH tunnel",
  "### 4.6 A token needs TLS off this machine",
  "### 4.7 Server versions",
  "### 4.8 Pulsar's oxia:// URL",
  "## 5. Query interface",
  "### 5.1 The command",
  "### 5.2 Commands and flags",
  "### 5.3 Refused commands",
  "### 5.4 Examples",
  "### 5.5 Result shape",
  "### 5.6 Bounds",
  "### 5.7 Cancellation and the confirmation gate",
  "### 5.8 Natural-order notice",
  "## 6. Schema introspection",
  "### 6.1 The object surface",
  "### 6.2 Object source",
  "### 6.3 Generated commands",
  "### 6.4 The Keys panel",
  "### 6.5 Object edit (#789): nothing to write",
  "## 7. Monitoring & health",
  "## 8. Maintenance",
  "## 9. Capabilities & labels",
  "## 10. Error handling",
  "## 11. Testing",
  "### 11.1 How the tests work",
  "### 11.2 Run it",
  "### 11.3 The live fixtures",
  "### 11.4 The raw seeder, the evidence harness and the live check",
  "## 12. Running Oxia for Studio",
  "## 13. Known limitations",
  "## 14. References",
];

/** The modules of the browser set (the Global Constraints of the plan): the rest run on the server. */
const BROWSER_SET: ReadonlySet<string> = new Set([
  "constants.ts",
  "lexer.ts",
  "commands.ts",
  "guard.ts",
  "labels.ts",
  "generators.ts",
  "order.ts",
  "cursor.ts",
]);

/** The version note of contract section 23 (SB1-6.6), the one text three files hold identically. */
const VERSION_NOTE =
  "An Oxia 0.16 standalone server (measured on 0.16.10) stops sending shard assignments to every client after one request whose authority is not `host:port`, which Studio never sends, until restarted (upstream #1450, about standalone mode only). 0.17.1 is not affected; fixed on main by #1450, in no 0.16 release as of 2026-10-04.";

/** The BACKLOG ids section 13 cites, each as a link to its entry (part 2, case P11). */
const LIMITATION_IDS: readonly string[] = [
  "D205",
  "D206",
  "D207",
  "D208",
  "D209",
  "D210",
  "D211",
  "D212",
  "D213",
  "D214",
  "D216",
  "D217",
  "D218",
  "D224",
  "B100",
];

/** Every `.ts` file under `directory`, as a path relative to it. */
function typescriptFiles(directory: string, prefix = ""): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return typescriptFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`);
    return entry.name.endsWith(".ts") ? [`${prefix}${entry.name}`] : [];
  });
}

type Overrides = Record<string | symbol, unknown>;

/** The options the builder makes of an Oxia connection with `overrides`. */
function options(overrides: Overrides = {}): OxiaConnectionOptions {
  const config = oxiaConnection(overrides as Partial<DatabaseConnection>) as DatabaseConnection & WithTunnelFarEnd;
  return buildOxiaConnectionOptions(config, { executionReadOnly: false, queryTimeout: DEFAULT_QUERY_TIMEOUT });
}

/** The builder's refusal of a connection with `overrides`. */
function builderRefusal(overrides: Overrides): string {
  try {
    options(overrides);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the builder to refuse");
}

/** The parser's refusal of `text`, by default with no connection context (the browser's reading). */
function parserRefusal(text: string, context: OxiaParseContext = {}): string {
  const result = parseOxiaCommand(text, context);
  if (result.ok) throw new Error(`expected a refusal of ${text}`);
  return result.refusal.message;
}

/** A placeholder bearer token, header {"alg":"none"}, payload {"exp":1791590400}, an empty signature. */
const TEST_TOKEN = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"exp":1791590400}').toString("base64url")}.`;
const TEST_TOKEN_EXPIRY = new Date(1791590400 * 1000).toISOString();
const ERROR_HOST = "oxia.example.com";
const ERROR_ENDPOINT = `${ERROR_HOST}:6648`;
const ERROR_LEADER = "oxia-1.example.com:6648";
const fixtures = loadTlsFixtures();
const TLS = { mode: "verify-full", caCert: fixtures.ca };

/** One row of the error table: the error the adapter would produce, the connection it is worded for, its placeholders. */
interface ErrorRow {
  readonly category: OxiaErrorCategory;
  readonly fields?: OxiaErrorFields;
  readonly connection?: Overrides;
  readonly runtimeReportsTlsCause?: boolean;
  readonly values?: Readonly<Record<string, string>>;
}

/** The connection view the defect row is worded with. */
const CONNECTION = oxiaErrorConnection(options({ host: ERROR_HOST, port: 6648 }));

/** The part of `database-compose.yml` the fixtures section is held to. */
interface ComposeFile {
  readonly services: Readonly<Record<string, { readonly profiles?: readonly string[] }>>;
}

const OPERATION = { "the get": "the <operation>", "The get": "The <operation>" };
const SHARD = { shardId: "2", leader: ERROR_LEADER } as const;
const SHARD_VALUES = { ...OPERATION, "Shard 2": "Shard <id>", "shard 2": "shard <id>", [ERROR_LEADER]: "<leader>" };
const ENDPOINT_VALUES = { [ERROR_ENDPOINT]: "<host>:<port>" };

/** SB1-6.3's rows and SB1-6.4's causes, each as the adapter would raise it. */
const ERROR_ROWS: readonly ErrorRow[] = [
  { category: "not-initialized" },
  { category: "leader-changing", fields: SHARD, values: SHARD_VALUES },
  { category: "not-leader", fields: SHARD, values: SHARD_VALUES },
  { category: "server-cancelled", values: OPERATION },
  { category: "server-state", fields: { grpcCode: 105 }, values: { ...OPERATION, "error 105": "error <code>" } },
  { category: "namespace-not-found", values: { "No namespace default ": "No namespace <name> " } },
  { category: "shard-not-found", fields: SHARD, values: SHARD_VALUES },
  { category: "invalid-argument", values: OPERATION },
  { category: "permission-denied", values: { [ERROR_ENDPOINT]: "<sentAuthority>" } },
  { category: "unimplemented", values: ENDPOINT_VALUES },
  { category: "not-connected", values: ENDPOINT_VALUES },
  { category: "not-connected", connection: { ssl: TLS }, runtimeReportsTlsCause: true, values: ENDPOINT_VALUES },
  { category: "not-connected", connection: { ssl: TLS }, runtimeReportsTlsCause: false, values: ENDPOINT_VALUES },
  {
    category: "not-connected",
    connection: { ssl: { ...TLS, clientCert: fixtures.client.cert, clientKey: fixtures.client.key } },
    runtimeReportsTlsCause: false,
    values: ENDPOINT_VALUES,
  },
  { category: "refused", values: ENDPOINT_VALUES },
  { category: "refused", connection: { host: "localhost" }, values: { "localhost:6648": "<host>:<port>" } },
  { category: "dns", values: { [ERROR_HOST]: "<host>" } },
  { category: "tls", fields: { tlsFailure: "chain" }, connection: { ssl: TLS } },
  { category: "tls", fields: { tlsFailure: "chain" }, connection: { ssl: { mode: "verify-full" } } },
  { category: "tls", fields: { tlsFailure: "name" }, connection: { ssl: TLS }, values: { [ERROR_HOST]: "<host>" } },
  {
    category: "tls",
    fields: { tlsFailure: "name" },
    connection: { ssl: TLS, dataServers: ERROR_LEADER },
    values: { [ERROR_HOST]: "<host>" },
  },
  { category: "tls", fields: { tlsFailure: "not-tls" }, connection: { ssl: TLS } },
  { category: "tls", fields: { tlsFailure: "client-certificate-required" }, connection: { ssl: TLS } },
  {
    category: "tls",
    fields: { tlsFailure: "client-certificate-required" },
    connection: { ssl: { ...TLS, clientCert: fixtures.client.cert, clientKey: fixtures.client.key } },
  },
  { category: "tls", fields: { tlsFailure: "client-certificate-refused" }, connection: { ssl: TLS } },
  { category: "tls", fields: { tlsFailure: "client-certificate-expired" }, connection: { ssl: TLS } },
  { category: "tls", connection: { ssl: TLS } },
  { category: "unauthenticated", fields: { authCause: "empty-token" } },
  { category: "unauthenticated", fields: { authCause: "malformed-token" } },
  { category: "unauthenticated", fields: { authCause: "unknown-issuer" } },
  { category: "unauthenticated", fields: { authCause: "forbidden-audience" } },
  { category: "unauthenticated", fields: { authCause: "bad-signature" } },
  {
    category: "unauthenticated",
    fields: { authCause: "expired" },
    connection: { password: TEST_TOKEN, allowInsecureAuth: true },
    values: { [TEST_TOKEN_EXPIRY]: "<tokenExpiry>" },
  },
  { category: "unauthenticated", fields: { authCause: "expired" } },
  { category: "unauthenticated", fields: { authCause: "no-username" } },
  { category: "unauthenticated", fields: { authCause: "other" } },
  { category: "deadline-exceeded", fields: SHARD, values: { ...OPERATION, [n(DEFAULT_QUERY_TIMEOUT)]: "<n>" } },
  { category: "cancelled", values: OPERATION },
  { category: "cancelled", fields: { unsent: true }, values: OPERATION },
  { category: "receive-cap", fields: { rpc: "List" } },
  { category: "receive-cap", fields: { rpc: "Read" }, values: OPERATION },
  { category: "connection-dropped", values: OPERATION },
  { category: "unavailable", values: OPERATION },
  { category: "closed" },
  { category: "silent-assignments", values: { [`${DEFAULT_QUERY_TIMEOUT / 1000} s`]: "<n> s" } },
  { category: "malformed", values: OPERATION },
  { category: "record-changed", values: { "this get": "this <operation>" } },
  { category: "unknown", fields: { grpcCode: 8 }, values: OPERATION },
  { category: "unknown", fields: { grpcCode: 99 }, values: { ...OPERATION, "code 99": "code <code>" } },
  { category: "unknown", values: OPERATION },
];

/** The sentence `toProviderError` words for one row, with its values replaced by the placeholders. */
function wordedRow(row: ErrorRow): string {
  const view = oxiaErrorConnection(options({ host: ERROR_HOST, port: 6648, ...row.connection }));
  const connection =
    row.runtimeReportsTlsCause === undefined ? view : { ...view, runtimeReportsTlsCause: row.runtimeReportsTlsCause };
  const error = toProviderError(new OxiaError(row.category, row.fields), { operation: "get", connection });
  return placeholder(error.message, row.values ?? {});
}

/** The failure `oxiaHealth` raises over a surface whose shard map read throws `snapshotError` and whose Check answers `status`. */
async function healthFailure(snapshotError: Error | undefined, status: string): Promise<string> {
  const client = {
    getSnapshot: async () => {
      if (snapshotError !== undefined) throw snapshotError;
    },
    health: async () => status,
  };
  try {
    await oxiaHealth({ client } as unknown as OxiaSurface, 7_000, new AbortController().signal);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the health check to fail");
}

describe("docs/providers/oxia.md quotes what the provider's modules say", () => {
  test("1. the doc has the header and the 14 sections, in order, and every subsection the outline names", () => {
    expect(headings(DOC)).toEqual([...OUTLINE]);
    expect(DOC).toContain(
      "The `oxia` type-id: read-only browsing, key lookups, lists and range scans over Oxia's gRPC client API, tested against Oxia 0.16.10 and 0.17.1.",
    );
    expect(DOC).toContain(
      `Source: [\`${PROVIDER_DIRECTORY}/\`](../../${PROVIDER_DIRECTORY}/).\nTests: [\`tests/unit/db/oxia/\`](../../tests/unit/db/oxia/) and [\`tests/integration/db/oxia-provider.test.ts\`](../../tests/integration/db/oxia-provider.test.ts).\nTracking issue: [#424](https://github.com/libredb/libredb-studio/issues/424).`,
    );
  });

  test("2. the module table names every module of the provider directory, and where it runs", () => {
    const modules = sectionOf(DOC, "### 2.2 Modules");
    const files = typescriptFiles(PROVIDER_DIRECTORY);
    expect(files).toContain("proto/descriptor.ts");
    for (const file of files) {
      const row = rowOf(modules, `\`${file}\``);
      expect(row, file).toBeDefined();
      const where = BROWSER_SET.has(file) ? "browser" : "server";
      expect(row?.endsWith(`| ${where} |`), `${file} runs on the ${where}`).toBe(true);
    }
    const documented = modules.split("\n").filter((line) => /^\| `[a-z/-]+\.ts` \|/.test(line));
    expect(documented).toHaveLength(files.length);
  });

  test("3. the vendored proto's digest is the README's", () => {
    const readme = read(`${PROVIDER_DIRECTORY}/proto/README.md`);
    const digest = /^\| `client\.proto` \| [^|]+ \| `([0-9a-f]{64})` \|$/m.exec(readme)?.[1];
    expect(digest).toBeDefined();
    expect(sectionOf(DOC, "### 2.4 The client, and why")).toContain(`\`${digest}\``);
  });

  test("4. the key order words are labels.ts's", () => {
    const order = flat(sectionOf(DOC, "### 3.2 Key order probed, not configured"));
    const verdicts = [
      { order: "hierarchical", learnedBy: "ceiling-probe" },
      { order: "natural", learnedBy: "ceiling-probe" },
      { order: "hierarchical", learnedBy: "assumed", exhausted: true },
      { order: "hierarchical", learnedBy: "assumed" },
      { order: "hierarchical", learnedBy: "empty" },
    ] as const;
    for (const verdict of verdicts) expect(order).toContain(`\`${keyOrderWords(verdict)}\``);
    for (const learnedBy of ["ceiling-probe", "decisive-list", "pair-sample", "assumed", "empty"]) {
      expect(order).toContain(`\`${learnedBy}\``);
    }
  });

  test("5. the dial-policy refusals are admitLeaders'", () => {
    const policy = flat(sectionOf(DOC, "### 3.3 The dial policy"));
    const loopback = admitLeaders(options(), ["oxia-0.internal:6648"]).refusal ?? "";
    expect(policy).toContain(
      `\`${placeholder(loopback, { "localhost:6648": "<sentAuthority>", "oxia-0.internal:6648": "<leader>" })}\``,
    );
    const callsItself = admitLeaders(options({ host: "oxia.example.com" }), ["other.example.com:6648"]).refusal ?? "";
    expect(policy).toContain(
      `\`${placeholder(callsItself, { "other.example.com:6648": "<leader>", "other.example.com": "<leader host>" })}\``,
    );
    const unlisted =
      admitLeaders(options({ host: "oxia.example.com" }), ["a.internal:6671", "b.internal:6672"]).refusal ?? "";
    expect(policy).toContain(`\`${placeholder(unlisted, { "a.internal:6671, b.internal:6672": "<a>, <b>" })}\``);
    const leaders = Array.from({ length: OXIA_MAX_DATA_SERVERS + 1 }, (_, index) => `oxia-${index}.internal:6648`);
    const tooMany = admitLeaders(options({ host: "oxia.example.com" }), leaders).refusal ?? "";
    expect(policy).toContain(`\`${placeholder(tooMany, { [String(leaders.length)]: "<n>" })}\``);
    expect(policy).toContain("and every other data server of the cluster");
    expect(policy).toContain(`at most ${OXIA_MAX_DATA_SERVERS}`);
    expect(policy).not.toContain("more:");
    expect(policy).not.toContain("and N more");
  });

  test("6. the internal-key sentences are the adapter's and the parser's", () => {
    const internal = flat(sectionOf(DOC, "### 3.4 Internal keys"));
    expect(internal).toContain(OXIA_ADAPTER_INTERNAL_KEY_SENTENCE);
    expect(internal).toContain(OXIA_INTERNAL_KEY_SENTENCE);
    expect(internal).toContain(`\`${OXIA_INTERNAL_PREFIX}\``);
  });

  test("7. the read-only mode's two wordings are the parser's", () => {
    const mode = flat(sectionOf(DOC, "### 3.5 The read-only mode"));
    expect(mode).toContain(writeCommandSentence("put", true));
    expect(mode).toContain(writeCommandSentence("put", false));
  });

  test("8. the token, namespace and Data servers refusals are the builder's", () => {
    expect(flat(sectionOf(DOC, "### 4.2 Authentication"))).toContain(builderRefusal({ password: "two words" }));
    expect(flat(sectionOf(DOC, "### 4.1 Configuration fields"))).toContain(
      builderRefusal({ database: "n".repeat(OXIA_NAMESPACE_MAX_BYTES + 1) }),
    );
    const dataServers = flat(sectionOf(DOC, "### 4.4 Data servers and the dial policy"));
    expect(dataServers).toContain(builderRefusal({ dataServers: "oxia-1.internal.:6648" }));
    expect(dataServers).toContain(builderRefusal({ dataServers: "*.oxia.internal:6648" }));
    const many = Array.from({ length: OXIA_MAX_DATA_SERVERS + 1 }, (_, index) => `oxia-${index}.internal:6648`);
    expect(dataServers).toContain(builderRefusal({ dataServers: many.join(",") }));
    const position = builderRefusal({ dataServers: "oxia-1.internal" });
    expect(position).toContain("the 1st entry");
    expect(dataServers).toContain(placeholder(position, { "the 1st entry": "the <n> entry" }));
    expect(dataServers).toContain(`at most ${OXIA_MAX_DATA_SERVERS}`);
    const tunnel = builderRefusal({
      [TUNNEL_FAR_END]: { host: "oxia.internal", port: 6648 },
      host: "127.0.0.1",
      port: 41000,
      sshTunnel: { enabled: true },
      dataServers: "oxia-1.internal:6648",
    });
    expect(flat(sectionOf(DOC, "### 4.5 SSH tunnel"))).toContain(tunnel);
  });

  test("9. the plaintext refusals are the builder's and the leader function's", () => {
    const plaintext = flat(sectionOf(DOC, "### 4.6 A token needs TLS off this machine"));
    expect(plaintext).toContain(builderRefusal({ host: "oxia.example.com", password: TEST_TOKEN }));
    expect(plaintext).toContain(leaderPlaintextTokenRefusal("<address>"));
  });

  test("10. the version note is word for word the one docker/oxia/README.md holds, and 0.17.1 is recommended", () => {
    const versions = flat(sectionOf(DOC, "### 4.7 Server versions"));
    const fixtureReadme = read("docker/oxia/README.md");
    expect(versions).toContain(VERSION_NOTE);
    expect(flat(fixtureReadme)).toContain(VERSION_NOTE);
    expect(versions).toContain("Recommended: 0.17.1.");
    expect(flat(DOC).split(VERSION_NOTE)).toHaveLength(2);
    const digests = flat(sectionOf(fixtureReadme, "## Server versions")).match(/sha256:[0-9a-f]{64}/g) ?? [];
    expect(digests).toHaveLength(2);
    for (const digest of digests) expect(versions).toContain(digest);
  });

  test("11. the command table is commands.ts's", () => {
    const table = sectionOf(DOC, "### 5.2 Commands and flags");
    const verbRows = table.split("\n").filter((line) => /^\| `[a-z]/.test(line));
    expect(verbRows).toHaveLength(OXIA_COMMAND_TABLE.length);
    for (const command of OXIA_COMMAND_TABLE) {
      const row = rowOf(table, `\`${command.verb}\``);
      expect(row, command.verb).toBeDefined();
      for (const alias of command.aliases) expect(row).toContain(`\`${alias}\``);
      expect(row).toContain(tableCode(command.arguments));
      for (const flag of command.flags) expect(row).toContain(tableCode(flag));
    }
    const prose = flat(table);
    expect(prose).toContain(`\`list\` answers ${n(OXIA_LIST_DEFAULT_LIMIT)} keys by default`);
    expect(prose).toContain(`\`range-scan\` ${n(OXIA_SCAN_DEFAULT_LIMIT)} records`);
    expect(prose).toContain(`\`--limit\` above ${n(OXIA_MAX_LIMIT)}`);
    expect(prose).toContain("`secondary_index_key`");
    expect(prose).toContain(placeholder(parserRefusal("get /a -t"), { "-t": "<flag>" }));
  });

  test("12. every refused command and flag is named with its sentence", () => {
    const refused = flat(sectionOf(DOC, "### 5.3 Refused commands"));
    for (const entry of OXIA_REFUSED_COMMANDS) {
      expect(refused).toContain(`\`${entry.verb}\``);
      expect(refused).toContain(entry.message);
    }
    for (const entry of OXIA_REFUSED_FLAGS) {
      expect(refused).toContain(`\`${entry.flag}\``);
      if (entry.shorthand !== undefined) expect(refused).toContain(`\`${entry.shorthand}\``);
      expect(refused).toContain(entry.reason);
    }
    expect(refused).toContain(parserRefusal("list --index by-email"));
    const nul = parserRefusal("get '/a\u0000b'");
    expect(refused).toContain(placeholder(nul, { "line 1,": "line <line>,", "column 5 ": "column <column> " }));
    const context = { endpoint: ERROR_ENDPOINT, namespace: "tenant-a" };
    const address = parserRefusal("get -a other.example.com:6648 /a", context);
    expect(refused).toContain(placeholder(address, ENDPOINT_VALUES));
    const namespace = parserRefusal("get -n other /a", context);
    expect(refused).toContain(placeholder(namespace, { "tenant-a": "<namespace>" }));
  });

  test("13. every example parses, and is a read", () => {
    const examples = [...DOC.matchAll(/^```oxia\n([\s\S]*?)\n```$/gm)].map((match) => match[1]);
    expect(examples.length).toBeGreaterThanOrEqual(8);
    for (const example of examples) {
      expect(example.split("\n"), example).toHaveLength(1);
      const result = parseOxiaCommand(example, {});
      expect(result.ok, example).toBe(true);
    }
    for (const statement of OXIA_STATEMENT_EXAMPLES) expect(examples).toContain(statement);
  });

  test("14. the record fields are results.ts's, in order", () => {
    const shape = flat(sectionOf(DOC, "### 5.5 Result shape"));
    expect(shape).toContain(OXIA_RECORD_FIELDS.map((field) => `\`${field}\``).join(", "));
    expect(shape).toContain(WITHHELD_VALUE_TEXT);
  });

  test("15. every bound the doc quotes is the number the code enforces", () => {
    const bounds = sectionOf(DOC, "### 5.6 Bounds");
    expect(rowOf(bounds, "Receive cap")).toContain(mib(OXIA_RECEIVE_CAP_BYTES));
    expect(rowOf(bounds, "Console run budget")).toContain(mib(OXIA_RUN_BYTE_BUDGET));
    expect(rowOf(bounds, "Per-stream received limit")).toContain(
      `${mib(OXIA_PAGE_STREAM_BYTES)} per Keys panel stream, ${mib(OXIA_RUN_BYTE_BUDGET)} per console stream`,
    );
    expect(rowOf(bounds, "Walk page")).toContain(mib(OXIA_PAGE_KEPT_BYTES));
    expect(rowOf(bounds, "Shard streams")).toContain(`${n(OXIA_MAX_SHARD_STREAMS)} shard streams`);
    expect(rowOf(bounds, "Shard map")).toContain(`${n(OXIA_MAX_SHARDS)} shards`);
    expect(rowOf(bounds, "Leader address and index name")).toContain(`${n(OXIA_LEADER_MAX_BYTES)} bytes`);
    expect(rowOf(bounds, "Rows")).toContain(
      `\`list\` ${n(OXIA_LIST_DEFAULT_LIMIT)} keys and \`range-scan\` ${n(OXIA_SCAN_DEFAULT_LIMIT)} records by default; \`--limit\` from 1 to ${n(OXIA_MAX_LIMIT)}`,
    );
    expect(rowOf(bounds, "Command text")).toContain(`${n(OXIA_MAX_TEXT_BYTES)} bytes`);
    expect(rowOf(bounds, "Grid cell")).toContain(`${n(OXIA_CELL_LIMIT)} characters`);
    expect(rowOf(bounds, "Source hex dump")).toContain(`${n(OXIA_SOURCE_HEX_BYTES)} bytes`);
    expect(rowOf(bounds, "Permits")).toContain(
      `${OXIA_LIMITER_OPTIONS.perProvider} shard calls per connection and ${OXIA_LIMITER_OPTIONS.perEngine} per process, with a queue of ${OXIA_LIMITER_OPTIONS.queueDepth}`,
    );
    const prose = flat(bounds);
    expect(prose).toContain(placeholder(runBudgetNotice("range-scan", 7), { "after 7 ": "after <n> " }));
    expect(prose).toContain(placeholder(runBudgetNotice("list", 7), { "after 7 ": "after <n> " }));
    expect(prose).toContain(placeholder(receiveCapNotice(7), { "after 7 ": "after <n> " }));
    const permits = OXIA_LIMITER_OPTIONS.perEngine;
    const perPermit = OXIA_RUN_BYTE_BUDGET + OXIA_RECEIVE_CAP_BYTES;
    expect(prose).toContain(
      `${permits} permits x (the largest per-stream limit, ${mib(OXIA_RUN_BYTE_BUDGET)}, plus one message under the ${mib(OXIA_RECEIVE_CAP_BYTES)} receive cap) = ${permits} x ${mib(perPermit)} = ${mib(permits * perPermit)} of received messages across every Oxia provider of the process; plus what runs keep for their answers: ${mib(OXIA_RUN_BYTE_BUDGET)} per console run and ${mib(OXIA_PAGE_KEPT_BYTES)} per Keys panel page, each plus one key per shard of the round.`,
    );
    expect(mib(permits * perPermit)).toBe("384 MiB");
  });

  test("16. the Keys panel's numbers and sentences are key-scan.ts's, cursor.ts's and the walks'", () => {
    const panel = flat(sectionOf(DOC, "### 6.4 The Keys panel"));
    expect(OXIA_KEY_SCAN.defaultCount).toBe(OXIA_KEY_SCAN_DEFAULT_COUNT);
    expect(OXIA_KEY_SCAN.maxCount).toBe(OXIA_KEY_SCAN_MAX_COUNT);
    expect(panel).toContain(
      `${n(OXIA_KEY_SCAN.defaultCount)} keys by default and at most ${n(OXIA_KEY_SCAN.maxCount)}`,
    );
    expect(panel).toContain(OXIA_CURSOR_ORDER_REFUSAL);
    expect(panel).toContain(OXIA_CURSOR_FOREIGN_REFUSAL);
    expect(panel).toContain(OXIA_STALLED_PAGE_SENTENCE);
    expect(panel).toContain(OXIA_CURSOR_KEY_TOO_LONG_SENTENCE);
    expect(panel).toContain(`${n(OXIA_DISCOVERY_MAX_ROUNDS)} rounds`);
    expect(panel).toContain(`${n(OXIA_DISCOVERY_MAX_CALLS)} calls`);
    expect(panel).toContain(`${n(OXIA_DISCOVERY_DEADLINE_MS)} ms`);
    expect(panel).toContain(
      `on a namespace whose top level holds very many nodes, or many keys of its own under natural sorting, the first page names the first ${n(OXIA_DISCOVERY_MAX_ROUNDS)} steps' worth of folders`,
    );
    expect(panel).toContain("may exceed the distinct key count by at most the representatives");
  });

  test("17. the object surface is objects.ts's", () => {
    const surface = flat(sectionOf(DOC, "### 6.1 The object surface"));
    for (const kind of OXIA_OBJECT_KINDS) {
      expect(surface).toContain(`\`${kind.id}\``);
      expect(surface).toContain(kind.label);
    }
    expect(surface).toContain(OXIA_KEYS_LISTED_ELSEWHERE);
  });

  test("17a. the Source tab's partition-key refusal is objects.ts's (ruling R33)", () => {
    const source = flat(sectionOf(DOC, "### 6.2 Object source"));
    expect(source).toContain(
      placeholder(oxiaKeyOnShardsSentence("/k", 2), { "/k": "<key>", "2 shards": "<n> shards" }),
    );
  });

  test("18. the object edit section is there, naming the absence", () => {
    expect(flat(sectionOf(DOC, "### 6.5 Object edit (#789): nothing to write"))).toContain(
      "No editable kind: v1 reads only.",
    );
  });

  test("19. health and monitoring say what monitoring-reads.ts and errors.ts say", async () => {
    const monitoring = flat(sectionOf(DOC, "## 7. Monitoring & health"));
    expect(monitoring).toContain(OXIA_HEALTH_NO_SHARD_MAP);
    expect(monitoring).toContain(placeholder(silentAssignmentsSentence(7), { "7 s": "<n> s" }));
    const silent = await healthFailure(new OxiaError("silent-assignments"), "SERVING");
    expect(monitoring).toContain(placeholder(silent, { "7 s": "<n> s" }));
    const notServing = await healthFailure(undefined, "NOT_SERVING");
    expect(monitoring).toContain(placeholder(notServing, { NOT_SERVING: "<STATUS>" }));
    expect(monitoring).toContain(declaredLabel(OXIA_LABELS.slowQueriesEmptyState));
    expect(monitoring).toContain(declaredLabel(OXIA_LABELS.sessionsEmptyState));
    expect(monitoring).toContain(declaredLabel(OXIA_LABELS.tableStatsCaption));
    expect(monitoring).not.toMatch(/restart/i);
  });

  test("20. maintenance is the label's", () => {
    expect(flat(sectionOf(DOC, "## 8. Maintenance"))).toContain(OXIA_LABELS.vacuumGlobalDesc);
  });

  test("21. the capabilities and labels are the provider's", () => {
    const declared = sectionOf(DOC, "## 9. Capabilities & labels");
    const capabilities = provider.getCapabilities();
    const written: Record<string, string> = {
      objectKinds: "`OXIA_OBJECT_KINDS`",
      keyScan: "`OXIA_KEY_SCAN`",
    };
    for (const [key, value] of Object.entries(capabilities)) {
      let cell = written[key];
      if (cell === undefined) {
        if (Array.isArray(value)) {
          expect(value, key).toEqual([]);
          cell = "`[]`";
        } else if (typeof value === "string") cell = `\`${JSON.stringify(value)}\``;
        else cell = `\`${String(value)}\``;
      }
      expect(rowOf(declared, `\`${key}\``), key).toBe(`| \`${key}\` | ${cell} |`);
    }
    expect(capabilities.defaultPort).toBe(OXIA_DEFAULT_PORT);
    for (const [key, value] of Object.entries(provider.getLabels())) {
      if (key === "statementLanguage") continue;
      expect(rowOf(declared, `\`${key}\``), key).toBe(`| \`${key}\` | ${value} |`);
    }
  });

  test("22. the error table is the provider's sentences", () => {
    const errors = flat(sectionOf(DOC, "## 10. Error handling"));
    const auth = flat(sectionOf(DOC, "### 4.2 Authentication"));
    for (const row of ERROR_ROWS) {
      expect(row.category === "unauthenticated" ? auth : errors).toContain(wordedRow(row));
    }
    const problems: readonly OxiaSnapshotProblem[] = [
      ...(Object.keys(SNAPSHOT_PROBLEM_REASONS) as SnapshotProblem[]),
      "too-large",
    ];
    for (const problem of problems) expect(errors).toContain(snapshotInvalidSentence(problem));
    expect(errors).toContain(OXIA_LIST_RECEIVE_CAP_SENTENCE);
    expect(errors).toContain(OXIA_LONE_SURROGATE_SENTENCE);
    expect(errors).toContain(OXIA_INDEX_NAME_SENTENCE);
    expect(errors).toContain(OXIA_ADAPTER_INTERNAL_KEY_SENTENCE);
    expect(errors).toContain(toProviderError("not an Error", { operation: "get", connection: CONNECTION }).message);
    expect(errors).toContain("no grpc-js error text is ever shown");
  });

  test("23. the run commands are the runner's", () => {
    const run = sectionOf(DOC, "### 11.2 Run it");
    expect(run).toContain("\nbun tests/run-tests.ts tests/unit/db/oxia/\n");
    expect(run).toContain("\nbun tests/run-tests.ts tests/integration/db/oxia-provider.test.ts\n");
  });

  test("24. the fixtures section matches the compose file", () => {
    const compose = parseYaml(read("database-compose.yml")) as ComposeFile;
    const oxia = Object.entries(compose.services).filter(([name]) => name.startsWith("oxia"));
    const plain = oxia.filter(([, service]) => service.profiles === undefined).map(([name]) => name);
    expect(plain).toEqual(["oxia", "oxia-seed"]);
    const profiles = [...new Set(oxia.flatMap(([, service]) => service.profiles ?? []))].sort();
    expect(profiles).toEqual(["oxia-017", "oxia-auth", "oxia-cluster", "oxia-natural"]);
    const live = flat(sectionOf(DOC, "### 11.3 The live fixtures"));
    expect(live).toContain("A plain `up` starts `oxia` and `oxia-seed` only");
    for (const profile of profiles) expect(live).toContain(`the \`${profile}\` profile`);
    expect(live).toContain("](../../docker/oxia/README.md)");
  });

  test("25. the doc keeps every limitation SB3-4.1 section 13 lists", () => {
    const limits = flat(sectionOf(DOC, "## 13. Known limitations"));
    const words = [
      "read-only",
      "Data servers",
      "port-forward",
      "namespace",
      "notifications",
      "metrics",
      n(OXIA_DISCOVERY_MAX_ROUNDS),
      "egress",
      "MCP",
      "client_identity",
    ];
    for (const word of words) expect(limits).toContain(word);
    for (const id of LIMITATION_IDS) expect(limits).toContain(`([${id}](../BACKLOG.md#`);
  });

  test("26. nothing the doc must not say", () => {
    expect(DOC).not.toMatch(/[\u2013\u2014]/);
    for (const word of [/poison/i, /segment is full/i, /invalid next offset/i, /corrupt/i]) {
      expect(DOC).not.toMatch(word);
    }
    expect(DOC).not.toContain("/tmp/");
    expect(DOC).not.toContain("scratchpad");
    const lines = DOC.split("\n");
    const bareTags = lines.filter(
      (line, at) =>
        !line.startsWith("```") &&
        !inFence(lines, at) &&
        /(?<!\\)<[A-Za-z]/.test(line.replace(/`[^`]*`/g, "").replace(/\]\([^)]*\)/g, "")),
    );
    expect(bareTags, "a placeholder outside a code span is written \\<name\\>").toEqual([]);
    lines.forEach((line, at) => {
      if (!line.startsWith("## ") || inFence(lines, at)) return;
      const next = lines.slice(at + 1).find((candidate) => candidate.trim() !== "");
      expect(next?.startsWith("#"), `${line} is followed by text`).toBe(false);
    });
  });
});

const SECURITY = read("docs/SECURITY.md");
const BACKLOG = read("docs/BACKLOG.md");
const SEED_FIXTURE = "tests/fixtures/seed-connections/oxia-read-only-config.yaml";

/** One row of the SECURITY control table, split into its five cells. */
interface ControlRow {
  readonly control: string;
  readonly status: string;
  readonly enforcedIn: readonly string[];
  readonly verifiedBy: readonly string[];
}

/** The repository paths a cell links, read from its `](../path)` targets. */
const linkedPaths = (cell: string): string[] => [...cell.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map((match) => match[1]);

/** The control table row of `id`, or a failure naming the missing id. */
function controlRow(id: string): ControlRow {
  const line = rowOf(SECURITY, id);
  if (line === undefined) throw new Error(`docs/SECURITY.md has no row ${id}`);
  const cells = line.slice(2, -2).split(" | ");
  expect(cells, id).toHaveLength(5);
  return { control: cells[1], status: cells[2], enforcedIn: linkedPaths(cells[3]), verifiedBy: linkedPaths(cells[4]) };
}

/** The bullet of the Known limits section that begins with `lead`, up to the next bullet, as one line. */
function knownLimit(lead: string): string {
  const limits = sectionOf(SECURITY, "## Known limits");
  const start = limits.indexOf(`- ${lead}`);
  if (start < 0) throw new Error(`no Known limits bullet ${lead}`);
  const end = limits.indexOf("\n- ", start + 1);
  return flat(limits.slice(start, end < 0 ? limits.length : end));
}

/** A BACKLOG entry, from its heading to the next heading, as one line. */
function backlogEntry(id: string): string {
  const start = BACKLOG.indexOf(`\n### ${id}. `);
  if (start < 0) throw new Error(`docs/BACKLOG.md has no entry ${id}`);
  const end = BACKLOG.indexOf("\n#", start + 1);
  return flat(BACKLOG.slice(start, end));
}

/** GitHub's heading anchor: lower case, spaces to `-`, everything but letters, digits, `-` and `_` dropped. */
const anchorOf = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^a-z0-9_-]/g, "");

/** The anchor of BACKLOG entry `id`, from its heading. */
function backlogAnchor(id: string): string {
  const heading = BACKLOG.split("\n").find((line) => line.startsWith(`### ${id}. `));
  if (heading === undefined) throw new Error(`docs/BACKLOG.md has no entry ${id}`);
  return anchorOf(heading.slice("### ".length));
}

/** A token with a payload that declares no expiry, as the Qdrant doc test builds one (no signature is checked). */
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const NO_EXPIRY_TOKEN = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "studio" })}.c2lnbmF0dXJl`;

/** A review finding id (C6, F11 d, SEC-01, J1-10) or TRIAGE: private documents a BACKLOG reader cannot open (SB3-4.8). */
const PRIVATE_FINDING_ID = /\b(?:C\d+|F\d+(?: [a-z]\b)?|SEC-\d+|J\d+(?:-\d+)?|TRIAGE)\b/;

/** The SB3-4.2 Control text of row 3.14. */
const CONTROL_3_14 =
  "On an Oxia connection, a shard leader is dialled only when its advertised address is byte-equal to the address the connection's bootstrap call was sent to, or is an exact entry of the connection's Data servers; every call's authority is the dialled host and port; every listed leader gets the connection's TLS mode, CA and client pair with its own host as TLS identity, and the plaintext-token refusal; a leader that fails the policy fails the operation before any call on it, and the token is never sent to it";
/** The SB3-4.2 Control text of row 3.15. */
const CONTROL_3_15 =
  "On an Oxia connection, the client can call only `GetShardAssignments`, `Read`, `List`, `RangeScan` and the health check, every key under `__oxia/` is refused before any call, internal keys are never requested, and the admin port is never dialled";

describe("docs/providers/oxia.md quotes what the registered type-id declares (part 2)", () => {
  test("P1. the five field hints in section 4.1 are the dialog's, and the labels", () => {
    const fields = flat(sectionOf(DOC, "### 4.1 Configuration fields"));
    const config = DB_UI_CONFIG.oxia;
    for (const field of ["host", "password", "database", "dataServers", "allowInsecureAuth"] as const) {
      const hint = connectionFieldHint(config, field);
      expect(hint, field).toBeDefined();
      expect(fields, field).toContain(hint ?? "");
    }
    expect(config.fieldLabels).toEqual({ password: "Token", database: "Namespace", dataServers: "Data servers" });
    for (const label of ["Token", "Namespace", "Data servers"]) expect(fields).toContain(`| ${label} |`);
    expect(rowOf(sectionOf(DOC, "### 4.1 Configuration fields"), "Port")).toContain(config.defaultPort);
    expect(config.defaultPort).toBe(String(OXIA_DEFAULT_PORT));
  });

  test("P2. the read-only hint in section 3.5 is the dialog's", () => {
    expect(flat(sectionOf(DOC, "### 3.5 The read-only mode"))).toContain(readOnlyHint(DB_UI_CONFIG.oxia));
  });

  test("P3. the credential warning is the record's, and a seed without a token is not refused", () => {
    const auth = flat(sectionOf(DOC, "### 4.2 Authentication"));
    const message = CREDENTIAL_WARNINGS.oxia?.[0]?.message ?? "";
    expect(message).not.toBe("");
    expect(auth).toContain(message);
    expect(credentialWarningFor("oxia", { password: NO_EXPIRY_TOKEN })).toBe(`Credential warning: ${message}`);
    expect(readOnlySeedRefusal("oxia", { password: "" })).toBeUndefined();
    expect(auth).toContain("A read-only seed without a token is not refused");
  });

  test("P4. the capabilities through the factory are the ones section 9 states", async () => {
    const built = await createDatabaseProvider(oxiaConnection());
    expect(built).toBeInstanceOf(OxiaProvider);
    expect(built.getCapabilities()).toEqual(provider.getCapabilities());
    expect(READ_ONLY_ENFORCED.oxia).toBe(provider.getCapabilities().enforcesReadOnly === true);
    expect(offersSshTunnel("oxia")).toBe(true);
    expect(flat(sectionOf(DOC, "### 4.5 SSH tunnel"))).toContain(
      "The dialog offers the SSH tunnel on every Oxia connection",
    );
    expect(hostUriSchemes("oxia")).toEqual([]);
    expect(flat(sectionOf(DOC, "### 4.8 Pulsar's oxia:// URL"))).toContain("The URL is not pasted whole");
  });

  test("P5. machine access is what the records say", () => {
    const machine = flat(sectionOf(DOC, "### 3.6 Machine access"));
    expect(machine).toContain("No agent execution and no MCP");
    expect(MCP_EXPOSABLE.oxia).toBe(false);
    expect(AGENT_EXECUTION_ENGINES).not.toContain("oxia");
    expect(machine).toContain(`](../BACKLOG.md#${backlogAnchor("B100")})`);
  });

  test("P6. the seed fixture loads as a seed file, read-only, and section 3.5 points to it", () => {
    const file = parseYaml(read(SEED_FIXTURE)) as { connections: Record<string, unknown>[] };
    const parsed = SeedConfigSchema.safeParse(file);
    expect(parsed.success).toBe(true);
    const connections = parsed.data?.connections ?? [];
    expect(connections).toHaveLength(1);
    const [connection] = connections;
    expect(connection).toMatchObject({ type: "oxia", readOnly: true, host: "localhost", port: 6648 });
    expect(connection.password).toBeUndefined();
    expect(connection.dataServers).toBeUndefined();
    expect(flat(sectionOf(DOC, "### 3.5 The read-only mode"))).toContain(`\`${SEED_FIXTURE}\``);
    const withMcp = { ...file, connections: [{ ...file.connections[0], mcp: true }] };
    const refused = SeedConfigSchema.safeParse(withMcp);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message)).toContain(
      "mcp is not offered for oxia: the product does not expose this engine to MCP clients. Remove mcp from this connection.",
    );
  });

  test("P7. SEED_CONNECTIONS has the dataServers row the doc points to", () => {
    const row = rowOf(read("docs/SEED_CONNECTIONS.md"), "`connections[].dataServers`");
    expect(row).toBeDefined();
    for (const words of ["Oxia only", "resolved", "Not a secret"]) expect(row).toContain(words);
    expect(sectionOf(DOC, "### 4.4 Data servers and the dial policy")).toContain("](../SEED_CONNECTIONS.md)");
  });

  test("P8. SECURITY rows 3.14 and 3.15 are the controls this doc describes", () => {
    const expected = [
      {
        id: "3.14",
        control: CONTROL_3_14,
        enforcedIn: [
          `${PROVIDER_DIRECTORY}/connection-options.ts`,
          `${PROVIDER_DIRECTORY}/grpc-client.ts`,
          "src/lib/db/grpc/credentials.ts",
        ],
        verifiedBy: [
          "tests/unit/db/oxia/connection-options.test.ts",
          "tests/unit/db/oxia/grpc-client.test.ts",
          "tests/unit/db/oxia/cluster-policy.test.ts",
        ],
      },
      {
        id: "3.15",
        control: CONTROL_3_15,
        enforcedIn: [
          `${PROVIDER_DIRECTORY}/grpc-client.ts`,
          `${PROVIDER_DIRECTORY}/commands.ts`,
          `${PROVIDER_DIRECTORY}/guard.ts`,
        ],
        verifiedBy: [
          "tests/unit/db/oxia/seam-guard.test.ts",
          "tests/unit/db/oxia/grpc-client.test.ts",
          "tests/unit/db/oxia/guard.test.ts",
        ],
      },
    ];
    for (const row of expected) {
      const actual = controlRow(row.id);
      expect(actual.control).toBe(row.control);
      expect(actual.status).toBe("Implemented");
      expect(actual.enforcedIn).toEqual(row.enforcedIn);
      expect(actual.verifiedBy).toEqual(row.verifiedBy);
      for (const file of [...actual.enforcedIn, ...actual.verifiedBy])
        expect(existsSync(path.join(ROOT, file)), file).toBe(true);
    }
    expect(rowOf(SECURITY, "3.14")).not.toContain("routing.ts");
    const policy = flat(sectionOf(DOC, "### 3.3 The dial policy"));
    expect(policy).toContain("[row 3.14](../SECURITY.md)");
    expect(flat(sectionOf(DOC, "### 3.4 Internal keys"))).toContain("[row 3.15](../SECURITY.md)");
  });

  test("P9. row 3.8 and its note name Oxia", () => {
    const row = controlRow("3.8");
    expect(row.enforcedIn).toContain(`${PROVIDER_DIRECTORY}/guard.ts`);
    expect(row.enforcedIn).toContain(`${PROVIDER_DIRECTORY}/grpc-client.ts`);
    expect(row.verifiedBy).toContain("tests/unit/db/oxia/read-only-end-to-end.test.ts");
    const start = SECURITY.indexOf("**3.8.**");
    const note = flat(SECURITY.slice(start, SECURITY.indexOf("\n\n", start)));
    expect(note).toContain(
      "Oxia's names the read-only mode while it holds and says v1 reads only otherwise ([`docs/providers/oxia.md`](./providers/oxia.md) section 3.5).",
    );
  });

  test("P10. the Known limits state Oxia's two facts", () => {
    expect(knownLimit("**The HTTP destination guard is opt-in and address-based.**")).toContain(
      "Oxia is reached over gRPC, as Milvus is, and is outside this guard: grpc-js resolves names itself, so an address check would be believed and not hold; a pinned gRPC guard is a backlog entry (D212).",
    );
    expect(knownLimit("**Oxia has no authorization.**")).toBe(
      "- **Oxia has no authorization.** A token that authenticates reads and writes every namespace, so Studio's read-only mode is a property of what Studio sends (it has no write call at all, row 3.15), never of the token. A standalone server has no authentication. An advertised leader decides where reads go, which row 3.14 bounds, and a Data servers entry is the operator's statement that the token may go there.",
    );
    expect(knownLimit("**A statement the editor refuses is never sent and never written to history.**")).toContain(
      "The Milvus, Qdrant, InfluxDB (InfluxQL) and Oxia rows declare both (rows 3.11, 3.12 and 3.15); no other shipped engine declares either.",
    );
  });

  test("P11. every BACKLOG id the doc cites exists, and section 13 links each", () => {
    const limits = sectionOf(DOC, "## 13. Known limitations");
    const cited = new Set([...limits.matchAll(/\b([DB]\d+)\b/g)].map((match) => match[1]));
    expect([...cited].sort()).toEqual([...LIMITATION_IDS].sort());
    const anchors = BACKLOG.split("\n")
      .filter((line) => line.startsWith("### "))
      .map((line) => anchorOf(line.slice("### ".length)));
    for (const [, anchor] of DOC.matchAll(/\]\(\.\.\/BACKLOG\.md#([^)]+)\)/g))
      expect(anchors, anchor).toContain(anchor);
    for (const id of LIMITATION_IDS) {
      expect(BACKLOG, id).toContain(`\n### ${id}. `);
      expect(limits, id).toContain(`[${id}](../BACKLOG.md#${backlogAnchor(id)})`);
    }
    expect(anchorOf("D210. Pasting Pulsar's oxia://host:6648/ns does not split it")).toBe(
      "d210-pasting-pulsars-oxiahost6648ns-does-not-split-it",
    );
  });

  test("P12. the version note is identical in the doc, the fixtures README and D217", () => {
    expect(flat(sectionOf(DOC, "### 4.7 Server versions"))).toContain(VERSION_NOTE);
    expect(flat(read("docker/oxia/README.md"))).toContain(VERSION_NOTE);
    expect(backlogEntry("D217")).toContain(VERSION_NOTE);
  });

  test("P13. the shell-word rule's BACKLOG entry is filed", () => {
    const entry = backlogEntry("D215");
    expect(entry).toContain("`src/lib/db/console/shell-words.ts`");
    expect(entry).toContain("`tests/unit/db/etcd/lexer.test.ts`");
  });

  test("P15. a key several shards hold is one key in every walk, and D224 files its one record (ruling R38)", () => {
    expect(flat(sectionOf(DOC, "## 13. Known limitations"))).toContain(
      "A key stored on several shards under different partition keys is one key in every walk, and `range-scan` shows one record for it, read on the lowest shard id that listed it; read the others with `get -p` ([D224](../BACKLOG.md#d224-an-oxia-key-on-several-shards-shows-one-record-in-a-record-walk)).",
    );
    expect(backlogEntry("D224")).toContain("lowest shard id");
    expect(backlogEntry("D224")).not.toMatch(PRIVATE_FINDING_ID);
  });

  test("P14. no Oxia BACKLOG entry cites a private finding id", () => {
    for (let n = 205; n <= 218; n++) expect(backlogEntry(`D${n}`)).not.toMatch(PRIVATE_FINDING_ID);
    expect(backlogEntry("B100")).not.toMatch(PRIVATE_FINDING_ID);
  });
});
