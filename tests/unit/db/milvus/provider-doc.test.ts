/**
 * `docs/providers/milvus.md`, `docs/SECURITY.md` and `docs/SEED_CONNECTIONS.md` quote sentences and numbers the
 * code owns (vector-family spec 8.3 gate 1, E23), the shape of `tests/unit/db/etcd/provider-doc.test.ts`.
 *
 * A value copied into prose is true only until the code moves, so every bound, label, refusal and warning the doc
 * quotes is read back from the module that owns it, and every limit of E23 is pinned in the doc and in the
 * security page, the authorization-off clause included.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS, credentialWarningFor } from "@/lib/db/credential-warnings";
import { MilvusError } from "@/lib/db/providers/vector/milvus/client";
import {
  buildMilvusConnectionOptions,
  MILVUS_DEFAULT_PORT,
  MILVUS_RECEIVE_CAP_BYTES,
} from "@/lib/db/providers/vector/milvus/connection-options";
import { toProviderError } from "@/lib/db/providers/vector/milvus/errors";
import { MilvusProvider } from "@/lib/db/providers/vector/milvus/index";
import { MILVUS_MAINTENANCE_SPECS } from "@/lib/db/providers/vector/milvus/maintenance";
import { MILVUS_BOUNDS, MILVUS_CONSOLE } from "@/lib/db/providers/vector/milvus/routes";
import { MILVUS_TESTED_VERSION } from "@/lib/db/providers/vector/milvus/versions";
import { readOnlySentence } from "@/lib/db/providers/vector/milvus/write-policy";
import type { DatabaseConnection } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const TEST_PASSWORD = "password";
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/milvus.md");
const SECURITY = read("docs/SECURITY.md");
const SEEDS = read("docs/SEED_CONNECTIONS.md");
const MILVUS: DatabaseConnection = {
  id: "milvus-doc",
  name: "Milvus",
  type: "milvus",
  host: "milvus.internal",
  port: 19530,
  createdAt: new Date(0),
};
const labels = new MilvusProvider(MILVUS).getLabels();
const n = (value: number): string => value.toLocaleString("en-US");

/** The section under the heading line `heading`, up to the next heading of its level or above. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) throw new Error(`no heading ${heading}`);
  const level = heading.indexOf(" ");
  const inFence = (at: number) => lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
  const end = lines.findIndex(
    (line, at) => at > start && /^#{1,6} /.test(line) && line.indexOf(" ") <= level && !inFence(at),
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/** The table row of `text` whose first cell is exactly `cell`. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

/** The bullet of `text` that starts with `head`, up to the next top-level bullet or heading. */
function bulletOf(text: string, head: string): string {
  const start = text.indexOf(`\n- ${head}`);
  if (start < 0) throw new Error(`no bullet ${head}`);
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(- |#)/);
  return end < 0 ? rest : rest.slice(0, end);
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

/** The sentence a code 101 answer maps to, for the collection and load state the doc's example names. */
function notLoaded(collection: string, loadState: string): string {
  const error = new MilvusError("status", "collection not loaded", { status: { code: 101, errorCode: "" } });
  return toProviderError(error, {
    operation: "query",
    write: false,
    database: "default",
    collection,
    loadState,
    connection: {
      host: "milvus.internal",
      port: 19530,
      runtimeReportsTlsCause: true,
      receiveCapBytes: MILVUS_RECEIVE_CAP_BYTES,
      timeoutMs: 30_000,
    },
    secretForms: [],
  }).message;
}

const CONTEXT = { executionReadOnly: false, queryTimeout: 30_000 };

describe("the readers find what exists and nothing that does not", () => {
  test("sectionOf, rowOf and bulletOf", () => {
    expect(() => sectionOf(DOC, "### 9.9 No such section")).toThrow("no heading");
    expect(() => bulletOf(SECURITY, "**No such limit.**")).toThrow("no bullet");
    expect(rowOf(DOC, "No such row")).toBeUndefined();
    // A section ends at the next heading of its level, and a `#` comment inside a fenced block is no heading.
    expect(sectionOf("## A\n```text\n# a comment\n```\nafter\n## B", "## A")).toBe(
      "## A\n```text\n# a comment\n```\nafter",
    );
    expect(sectionOf("## A\ntext", "## A")).toBe("## A\ntext");
    expect(bulletOf("x\n- a\n  b", "a")).toBe("- a\n  b");
    expect(thrown(() => thrown(() => undefined))).toBe("expected a refusal");
  });
});

describe("docs/providers/milvus.md quotes what the code says", () => {
  test("the version claim names the tested version", () => {
    expect(DOC).toContain(
      `Tested against Milvus ${MILVUS_TESTED_VERSION}; other 3.0.x releases are expected to work and are not tested; 2.6 and older connect and are not tested.`,
    );
  });

  test("the request language is the generated statementLanguage, word for word", () => {
    expect(sectionOf(DOC, "### 5.1 The request")).toContain(`\`\`\`text\n${labels.statementLanguage}\n\`\`\``);
  });

  test("the not-loaded sentence is the provider's", () => {
    expect(sectionOf(DOC, "### 3.2 Nothing loads implicitly")).toContain(notLoaded("unloaded_big", "NotLoad"));
  });

  test("each read-only refusal is write-policy.ts's sentence for where the mode was set", () => {
    const section = sectionOf(DOC, "### 3.4 The read-only mode");
    expect(rowOf(section, "The operator's seed file")).toBe(
      `| The operator's seed file | ${readOnlySentence("seed")} |`,
    );
    expect(rowOf(section, "A connection of the user's own")).toBe(
      `| A connection of the user's own | ${readOnlySentence("connection")} |`,
    );
    expect(rowOf(section, "An agent execution profile, on a connection that is not read-only")).toBe(
      `| An agent execution profile, on a connection that is not read-only | ${readOnlySentence("execution-profile")} |`,
    );
    expect(READ_ONLY_ENFORCED.milvus).toBe(true);
  });

  test("the authorization-off clause is in the read-only section and the limits", () => {
    const clause = "Milvus with `authorizationEnabled: false`, its default, accepts any credential or none";
    expect(sectionOf(DOC, "### 3.4 The read-only mode")).toContain(clause);
    expect(sectionOf(DOC, "## 13. Known limitations")).toContain(clause);
  });

  test("the field rows are the dialog's hints, and the port is the provider's default", () => {
    const fields = sectionOf(DOC, "### 4.1 Configuration fields");
    const hints = DB_UI_CONFIG.milvus.fieldHints ?? {};
    expect(rowOf(fields, "Host")).toBe(`| Host | ${hints.host} |`);
    expect(rowOf(fields, "Database")).toBe(`| Database | ${hints.database} |`);
    expect(rowOf(fields, "User")).toBe(`| User | ${hints.user} |`);
    expect(rowOf(fields, "Password or token")).toBe(`| Password or token | ${hints.password} |`);
    expect(rowOf(fields, "Port")).toContain(`\`${MILVUS_DEFAULT_PORT}\` by default`);
    expect(DB_UI_CONFIG.milvus.fieldLabels?.password).toBe("Password or token");
  });

  test("the host refusal and the plaintext refusal are connection-options.ts's", () => {
    const scheme = thrown(() => buildMilvusConnectionOptions({ ...MILVUS, host: "http://localhost" }, CONTEXT));
    expect(sectionOf(DOC, "### 4.1 Configuration fields")).toContain(`"${scheme}"`);
    const plaintext = thrown(() =>
      buildMilvusConnectionOptions({ ...MILVUS, host: "milvus.example.com", password: TEST_PASSWORD }, CONTEXT),
    );
    expect(sectionOf(DOC, "### 4.6 A password needs TLS off this machine")).toContain(`> ${plaintext}`);
    for (const exit of ["SSL / TLS", "SSH tunnel", "clear the password"]) expect(plaintext).toContain(exit);
  });

  test("the credential warning is the record's sentence, read by reference", () => {
    const pair = CREDENTIAL_WARNINGS.milvus?.find((entry) => entry.kind === "pair");
    if (pair?.kind !== "pair") throw new Error("the milvus record declares no pair");
    const sentence = credentialWarningFor("milvus", { user: pair.user, password: pair.password });
    expect(sentence).toBeDefined();
    expect(sectionOf(DOC, "### 4.2 Authentication")).toContain(`> ${sentence}`);
  });

  test("every bound of section 5.6 is the number the code enforces", () => {
    const bounds = sectionOf(DOC, "### 5.6 Bounds");
    expect(rowOf(bounds, "Console text")).toContain(`${n(MILVUS_CONSOLE.maxTextBytes)} bytes of UTF-8`);
    expect(rowOf(bounds, "Default page")).toContain(`${n(MILVUS_BOUNDS.defaultLimit)} rows`);
    expect(rowOf(bounds, "Rows per query or get")).toContain(`1 to ${n(MILVUS_BOUNDS.maxRows)}`);
    expect(rowOf(bounds, "Query window")).toContain(`at most ${n(MILVUS_BOUNDS.queryWindow)}`);
    expect(rowOf(bounds, "Search")).toContain(
      `\`nq\` at most ${n(MILVUS_BOUNDS.maxNq)}, \`limit\` at most ${n(MILVUS_BOUNDS.maxTopK)}`,
    );
    expect(rowOf(bounds, "Search")).toContain(`at most ${n(MILVUS_BOUNDS.maxSearchEntries)}`);
    expect(rowOf(bounds, "Hybrid search")).toContain(`at most ${n(MILVUS_BOUNDS.maxSubRequests)} sub-requests`);
    expect(rowOf(bounds, "Filter text")).toContain(`${n(MILVUS_BOUNDS.maxFilterBytes)} bytes`);
    expect(rowOf(bounds, "`exprParams`")).toContain(
      `${n(MILVUS_BOUNDS.maxExprParamKeys)} keys, each a scalar or an array of at most ${n(MILVUS_BOUNDS.maxExprParamArray)} scalars`,
    );
    expect(rowOf(bounds, "Arrays")).toContain(
      `ids at most ${n(MILVUS_BOUNDS.maxGetIds)}; search \`ids\` at most ${n(MILVUS_BOUNDS.maxSearchIds)}; \`outputFields\` at most ${n(MILVUS_BOUNDS.maxOutputFields)}; \`partitionNames\` at most ${n(MILVUS_BOUNDS.maxPartitionNames)}`,
    );
    expect(rowOf(bounds, "String cells")).toContain(`${n(MILVUS_BOUNDS.stringCellUnits)} UTF-16 code units`);
    expect(rowOf(bounds, "Result budget")).toContain(`${n(MILVUS_BOUNDS.resultBudgetBytes)} bytes`);
    expect(rowOf(bounds, "Receive cap")).toContain(`${n(MILVUS_RECEIVE_CAP_BYTES)} bytes`);
  });

  test("the monitoring labels are the provider's", () => {
    const monitoring = sectionOf(DOC, "## 7. Monitoring & health");
    expect(monitoring).toContain(`\n${labels.tableStatsCaption}\n`);
    expect(monitoring).toContain(`> ${labels.slowQueriesEmptyState}`);
    expect(monitoring).toContain(`> ${labels.sessionsEmptyState}`);
    expect(labels.slowQueriesEmptyState).toContain("9091");
  });

  test("the maintenance rows are the declared specs", () => {
    const maintenance = sectionOf(DOC, "## 8. Maintenance");
    const { load, release } = MILVUS_MAINTENANCE_SPECS;
    if (load === undefined || release === undefined) throw new Error("Milvus declares no Load or Release spec");
    expect(rowOf(maintenance, "Load")).toContain(`"${load.label}"`);
    expect(rowOf(maintenance, "Release")).toContain(`"${release.label}"`);
    expect(rowOf(maintenance, "Release")).toContain(String(release.description));
  });

  test("machine access is what the records say", () => {
    expect(MCP_EXPOSABLE.milvus).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).not.toContain("milvus");
    const machine = sectionOf(DOC, "### 3.5 Machine access");
    expect(machine).toContain("(`mcp: true`)");
    expect(machine).toContain("agent execution and MCP `run_read_query` refuse Milvus");
  });

  test("the object edit section states the abstention the census holds", () => {
    const edit = sectionOf(DOC, "### 6.4 Object edit (#789): nothing to write");
    expect(edit).toContain("`milvus`'s entry in `EXPECTED_EDIT_ABSTAINERS`");
  });

  test("the doc keeps every sentence of the E23 limits, and none says how a crafted id is read", () => {
    const limits = sectionOf(DOC, "## 13. Known limitations");
    for (const fragment of E23_FRAGMENTS) expect(limits).toContain(fragment);
    for (const text of [DOC, SECURITY]) expect(text).not.toMatch(/concatenat/i);
  });

  test("the doc carries no em dash and no en dash", () => {
    expect(DOC).not.toMatch(/[\u2013\u2014]/);
  });
});

/** One fragment per limit of E23, in the order the spec lists them. */
const E23_FRAGMENTS: readonly string[] = [
  "Vectors and payloads reach query history and saved queries",
  "A filter's text is echoed in errors and in the Studio log.",
  "A load holds shared query-node memory until it is released",
  "Milvus RBAC hides neither the topology nor other databases' row counts from any authenticated user, since GetMetrics needs no privilege.",
  "A `dbName` in a body overrides the connection's database, so only Milvus RBAC on a user that is not root scopes a seed to one database.",
  "any user who knows a run's id can cancel it",
  "Milvus with `authorizationEnabled: false`, its default, accepts any credential or none",
  "TLS mode `require` sends the password to an unverified peer.",
  "gRPC, and every request the Milvus server itself makes, is outside the HTTP egress guard.",
  "REST `entities/get` and `entities/delete` by a VarChar id holding a quote differ from Studio's template on 3.0.2.",
  "A vendor address pasted into the connection-string box instead of the Host box still selects ClickHouse.",
  "Zilliz users should prefer a cluster-scoped user or key to a project-wide key",
  "Studio withholds only the forms it sends.",
  "The management port 9091 answers without authentication on 3.0.2, so the operator keeps it off the network.",
];

describe("docs/SECURITY.md states Milvus's limits and its plaintext rule", () => {
  const bullet = bulletOf(SECURITY, "**Milvus is reached over a gRPC client of Studio's own.**");

  test.each([...E23_FRAGMENTS])("the Milvus bullet keeps: %s", (fragment) => {
    expect(bullet).toContain(fragment);
  });

  test("the plaintext rule and row 3.8 name Milvus", () => {
    expect(bullet).toContain(
      "A Milvus password or token over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection.",
    );
    expect(SECURITY).toContain("etcd's, Neo4j's, Milvus's and Qdrant's providers keep the mode today");
    expect(SECURITY).toContain("src/lib/db/providers/vector/milvus/write-policy.ts");
  });
});

describe("docs/SEED_CONNECTIONS.md names the Milvus refusals", () => {
  test("Milvus is a type the file takes, and the record's two refusals are stated", () => {
    expect(SEEDS).toContain("`etcd`, `neo4j`, `milvus`, `qdrant`");
    expect(SEEDS).toContain(
      "Milvus declares both: its documented default `root` pair, and no password ([providers/milvus.md](providers/milvus.md), section 4.2).",
    );
    expect(SEEDS).toContain("load refuses what the file shows; resolution refuses the rest");
  });
});

describe("the audit pages name the engineUser() the code gives", () => {
  const API_DOCS = read("docs/API_DOCS.md");
  const principalOf = (password: string) =>
    buildMilvusConnectionOptions({ ...MILVUS, host: "localhost", password }, CONTEXT).principal;
  const SENTENCE =
    "the Milvus user name, the user name before the colon when Password or token carries a `user:password` token with User empty, or the word `token` for a token with no colon.";

  test("a user:password token is audited as its user, a token with no colon as the word token", () => {
    expect(principalOf(`reader:${TEST_PASSWORD}`)).toBe("reader");
    expect(principalOf(TEST_PASSWORD)).toBe("token");
  });

  test("docs/SECURITY.md and docs/API_DOCS.md state both token forms", () => {
    expect(SECURITY).toContain(`Milvus's provider implements it: ${SENTENCE}`);
    expect(API_DOCS).toContain(`Milvus's provider implements \`engineUser()\`: ${SENTENCE}`);
  });
});
