/**
 * `docs/providers/neo4j.md` quotes lists, sentences, numbers and measurements the code and the captures own, the
 * shape of `tests/unit/db/etcd/provider-doc.test.ts`.
 *
 * A value copied into prose is true only until the code moves, and nothing else goes red when it stops being
 * true. So the read policy's lists are read back from `NEO4J_POLICY_PROFILE`, every refusal sentence from a run
 * of the real policy, gate, provider or error table, the TLS table from `boltEndpointOf`, the dialog's hints
 * from `DB_UI_CONFIG`, the bounds from their constants, the catalog and monitoring statements from the modules
 * that run them, the Graph tab's node cap, notices and caption length from the view's own code, and the measured
 * values from the capture README and the compose file. The repository docs that name the provider (the provider
 * index, the seed recipe, the backlog entries the doc cites) are pinned where they stand.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYAML } from "yaml";
import { MAX_GRAPH_NODES, capNotice, droppedNotice, graphAriaLabel } from "@/components/results-graph/graph-canvas";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { DB_UI_CONFIG, readOnlyHint } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { type GraphClient, GraphClientError, type GraphRunResult } from "@/lib/db/graph/bolt/client";
import { MAX_CELL_DEPTH, MAX_CELL_JSON_BYTES } from "@/lib/db/graph/bolt/record-values";
import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";
import { GRAPH_SAMPLE_LIMIT } from "@/lib/db/graph/cypher/generators";
import { checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { type ResultGraph, buildResultGraph } from "@/lib/db/graph/result-graph";
import { GRAPH_TAG } from "@/lib/db/graph/values";
import { CATALOG_ROW_BOUND, NEO4J_CATALOG_STATEMENTS } from "@/lib/db/providers/graph/neo4j/catalog";
import { mapNeo4jError } from "@/lib/db/providers/graph/neo4j/errors";
import { Neo4jProvider } from "@/lib/db/providers/graph/neo4j/index";
import { neo4jLabels } from "@/lib/db/providers/graph/neo4j/labels";
import { versionText } from "@/lib/db/providers/graph/neo4j/monitoring";
import { NEO4J_MONITORING_STATEMENTS, TABLE_STATS_LABEL_BOUND } from "@/lib/db/providers/graph/neo4j/monitoring-reads";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import { neo4jStatementGate } from "@/lib/db/providers/graph/neo4j/statement-gate";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { SeedConfigSchema } from "@/lib/seed/types";
import type { DatabaseConnection, SSLConfig } from "@/lib/types";
import { TUNNEL_FAR_END } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

const DOC = read("docs/providers/neo4j.md");
const SECURITY = read("docs/SECURITY.md");
const PROVIDERS_README = read("docs/providers/README.md");
const SEEDS = read("docs/SEED_CONNECTIONS.md");
const BACKLOG = read("docs/BACKLOG.md");
const AGENT_DOC = read("docs/AGENT.md");
const CAPTURES_README = read("tests/fixtures/neo4j/5.26.31/README.md");
const COMPOSE = read("database-compose.yml");
const POLICY = NEO4J_POLICY_PROFILE.readPolicy;

/** A heading's words without its `#` marks and its section number: "### 3.2 The read policy" reads "The read policy". */
const headingWords = (line: string): string => line.replace(/^#+ /, "").replace(/^\d+(?:\.\d+)*\.?\s+/, "");

/** Whether line `at` sits inside a fenced block, where a `#` line is a comment and never a heading. */
function inFence(lines: readonly string[], at: number): boolean {
  return lines.slice(0, at).filter((line) => line.startsWith("```")).length % 2 === 1;
}

/** The text of the section headed `heading` (any level, numbered or not), up to the next heading of its level or above. */
function docSection(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (line, at) => /^#{1,4} /.test(line) && headingWords(line) === headingWords(heading) && !inFence(lines, at),
  );
  if (start < 0) return undefined;
  const level = /^#+/.exec(lines[start])?.[0].length ?? 2;
  const end = lines.findIndex(
    (line, at) =>
      at > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0].length ?? 9) <= level && !inFence(lines, at),
  );
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/**
 * The backticked items of the line of `text` that starts with `lead`, after that line's last ": ": section 3.2 states
 * each list on one line, "Procedures `CALL` may name, ...: `db.labels`, `db.ping` and `dbms.components`.".
 */
function listedOn(text: string, lead: string): string[] {
  const line = text.split("\n").find((candidate) => candidate.startsWith(lead)) ?? "";
  const list = line.slice(line.lastIndexOf(": ") + 2);
  return [...list.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/** The table row of `text` whose first cell is exactly `cell`, or undefined. */
const rowOf = (text: string, cell: string): string | undefined =>
  text.split("\n").find((line) => line.startsWith(`| ${cell} |`));

/** The cells of a table row, without its outer pipes. */
const cellsOf = (row: string | undefined): string[] => (row ?? "").replace(/^\| /, "").replace(/ \|$/, "").split(" | ");

/** The body of the first ```yaml block of `text`, or undefined. */
function yamlBlockOf(text: string): string | undefined {
  return /```yaml\n([\s\S]*?)\n```/.exec(text)?.[1];
}

/** A constant a module keeps to itself, read from its source: `const NAME = 60_000;` or `const NAME = "5.26.";`. */
function privateText(relative: string, name: string): string {
  const match = new RegExp(`const ${name} = ("[^"]*"|[\\d_]+);`).exec(read(relative));
  if (match === null) throw new Error(`${relative} declares no ${name}`);
  return match[1].startsWith('"') ? match[1].slice(1, -1) : match[1];
}

const privateConstant = (relative: string, name: string): number =>
  Number(privateText(relative, name).replaceAll("_", ""));

/** The Bolt port, as the provider declares it: `NEO4J_DEFAULT_PORT` is file-local to index.ts. */
const NEO4J_DEFAULT_PORT = privateConstant("src/lib/db/providers/graph/neo4j/index.ts", "NEO4J_DEFAULT_PORT");
const NEO4J_TESTED_SERIES = privateText("src/lib/db/providers/graph/neo4j/monitoring.ts", "NEO4J_TESTED_SERIES");

const en = (value: number): string => value.toLocaleString("en-US");

const OVERVIEW = docSection(DOC, "1. Overview") ?? "";
const POLICY_SECTION = docSection(DOC, "3.2 The read policy") ?? "";
const REFUSALS = docSection(DOC, "3.3 Refusals") ?? "";
const WHY_LOAD_CSV = docSection(DOC, "3.4 Why LOAD CSV and APOC are refused") ?? "";
const GATE = docSection(DOC, "3.5 The statement gate") ?? "";
const MACHINE = docSection(DOC, "3.6 Machine access") ?? "";
const FIELDS = docSection(DOC, "4.1 Configuration fields") ?? "";
const TLS = docSection(DOC, "4.3 TLS") ?? "";
const VERSIONS = docSection(DOC, "4.6 Server versions") ?? "";
const RESULT = docSection(DOC, "5.2 Result shape") ?? "";
const BOUNDS = docSection(DOC, "5.3 Bounds") ?? "";
const CANCEL = docSection(DOC, "5.4 Cancellation and the confirmation gate") ?? "";
const GRAPH_TAB = docSection(DOC, "5.6 The Graph tab") ?? "";
const SCHEMA = docSection(DOC, "6. Schema introspection") ?? "";
const MONITORING = docSection(DOC, "7. Monitoring & health") ?? "";
const CAPABILITIES = docSection(DOC, "9. Capabilities & labels") ?? "";
const ERRORS = docSection(DOC, "10. Error handling") ?? "";
const TESTING = docSection(DOC, "11. Testing") ?? "";
const LIMITS = docSection(DOC, "13. Known limitations and risks") ?? "";
const RECIPE = docSection(SEEDS, "A read-only Neo4j graph") ?? "";

describe("the readers find what exists and nothing that does not", () => {
  test("docSection, rowOf and yamlBlockOf", () => {
    for (const section of [
      OVERVIEW,
      POLICY_SECTION,
      REFUSALS,
      WHY_LOAD_CSV,
      GATE,
      MACHINE,
      FIELDS,
      TLS,
      VERSIONS,
      RESULT,
      BOUNDS,
      CANCEL,
      GRAPH_TAB,
      SCHEMA,
      MONITORING,
      CAPABILITIES,
      ERRORS,
      TESTING,
      LIMITS,
      RECIPE,
    ]) {
      expect(section.length).toBeGreaterThan(0);
    }
    // A section ends before the next one of its level.
    expect(POLICY_SECTION).not.toContain("### 3.3");
    expect(docSection(DOC, "9.9 No such section")).toBeUndefined();
    // A `#` comment inside a fenced block is no heading.
    expect(docSection("## A\n```yaml\n# a comment\n```\nafter\n## B", "## A")).toBe(
      "## A\n```yaml\n# a comment\n```\nafter",
    );
    expect(rowOf(FIELDS, "Host")).toBeDefined();
    expect(rowOf(FIELDS, "No such field")).toBeUndefined();
    expect(yamlBlockOf("no block")).toBeUndefined();
    expect(listedOn("Lead: `a`, `b` and `c`.\nOther: `d`", "Lead")).toEqual(["a", "b", "c"]);
    expect(listedOn(POLICY_SECTION, "No such list")).toEqual([]);
    expect(() => privateConstant("src/lib/db/graph/graph-base-provider.ts", "NO_SUCH_CONSTANT")).toThrow();
  });
});

describe("the claim: Neo4j 5.26 LTS, later calendar releases untested", () => {
  test("the tested series is the one the overview and section 4.6 name", () => {
    expect(NEO4J_TESTED_SERIES).toBe("5.26.");
    expect(DOC).toContain("tested and claimed on Neo4j 5.26 LTS");
    expect(VERSIONS).toContain("2025.x and 2026.x");
  });

  test("the version texts quoted are the ones the overview builds", () => {
    expect(VERSIONS).toContain(`\`${versionText({ version: "5.26.31", edition: "community" })}\``);
    expect(VERSIONS).toContain(`\`${versionText({ version: "2026.01.0", edition: "enterprise" })}\``);
    expect(VERSIONS).toContain(`\`${versionText(undefined)}\``);
  });
});

describe("docs/providers/neo4j.md section 3.2 states every list of the read policy, and nothing beyond it", () => {
  /** Set equality: a list the doc states is the profile's, with no entry missing and none the code would refuse. */
  const sameSet = (stated: readonly string[], owned: readonly string[]): void => {
    expect([...stated].sort()).toEqual([...owned].sort());
    expect(new Set(stated).size).toBe(stated.length);
  };

  test("the denied words and word sequences", () => {
    sameSet(
      listedOn(POLICY_SECTION, "Denied words,"),
      POLICY.deniedWords.map((words) => words.join(" ")),
    );
  });

  test("the denied namespaces", () => {
    sameSet(listedOn(POLICY_SECTION, "Denied namespaces,"), POLICY.deniedNamespaces);
  });

  test("the allowlisted procedures", () => {
    sameSet(listedOn(POLICY_SECTION, "Procedures `CALL` may name,"), POLICY.allowedProcedures);
  });

  test("the allowlisted qualified functions", () => {
    sameSet(listedOn(POLICY_SECTION, "Qualified functions,"), POLICY.allowedQualifiedFunctions);
  });

  test("the allowed SHOW forms, a name written <name>", () => {
    sameSet(
      listedOn(POLICY_SECTION, "SHOW forms,"),
      POLICY.allowedShowForms.map((form) =>
        ["SHOW", ...form.map((word) => (word === "*" ? "<name>" : word))].join(" "),
      ),
    );
  });

  test("every refused prefix", () => {
    expect(POLICY.refusedPrefixes.filter((prefix) => !POLICY_SECTION.includes(`\`${prefix}\``))).toEqual([]);
  });

  test("SHOW TRANSACTIONS is refused to a user, as the section says, and the panel's read is not typed by one", () => {
    expect(checkCypherRead("SHOW TRANSACTIONS", NEO4J_POLICY_PROFILE).allowed).toBe(false);
    expect(POLICY_SECTION).toContain("`SHOW TRANSACTIONS` is refused");
  });

  test("the section says which lists are allowlists and which a denylist (SR8)", () => {
    expect(POLICY_SECTION).toContain("Procedures, qualified functions and SHOW forms are allowlists");
    expect(POLICY_SECTION).toContain("clauses are a denylist");
  });
});

/** A client whose every run answers `answer`. */
function answering(answer: Partial<GraphRunResult>): Pick<GraphClient, "run"> {
  return {
    run: async () => ({ fields: [], rows: [], truncated: false, ...answer }),
  };
}

const RUN_OPTIONS = { timeoutMs: 30_000, maxRows: 0 } as const;

/** The policy's sentence for `text`, which it must refuse. */
function policyRefusal(text: string): string {
  const verdict = checkCypherRead(text, NEO4J_POLICY_PROFILE);
  if (verdict.allowed) throw new Error(`the policy allowed ${text}`);
  return verdict.refusal.message;
}

/** The gate's sentence for an allowed `text` when the server classifies it `queryType`. */
async function gateRefusal(text: string, queryType: GraphRunResult["queryType"]): Promise<string> {
  const verdict = checkCypherRead(text, NEO4J_POLICY_PROFILE);
  if (!verdict.allowed) throw new Error(`the policy refused ${text}`);
  const refusal = await neo4jStatementGate(answering({ queryType }), verdict, RUN_OPTIONS);
  if (refusal === undefined) throw new Error(`the gate let ${text} run as ${queryType}`);
  return refusal.message;
}

const CONNECTION: DatabaseConnection = {
  id: "neo4j-doc",
  name: "Neo4j",
  type: "neo4j",
  host: "neo4j.internal",
  port: 7687,
  database: "neo4j",
  createdAt: new Date(0),
};

const SERVER_WORDS = "<the server's words>";

/** A connected provider over a client that answers the version read and fails every other run with SERVER_WORDS. */
async function connectedProvider(): Promise<Neo4jProvider> {
  const client: GraphClient = {
    verify: async () => ({ address: "neo4j.internal:7687", agent: "Neo4j/5.26.31", protocolVersion: "5.5" }),
    run: async (statement) => {
      if (statement === NEO4J_MONITORING_STATEMENTS.components) {
        return {
          fields: ["name", "versions", "edition"],
          rows: [{ name: "Neo4j Kernel", versions: ["5.26.31"], edition: "community" }],
          truncated: false,
        };
      }
      throw new GraphClientError("query", SERVER_WORDS);
    },
    close: async () => {},
  };
  const provider = new Neo4jProvider(CONNECTION, {}, () => client);
  await provider.connect();
  return provider;
}

async function providerRefusal(text: string, params?: unknown[]): Promise<string> {
  const provider = await connectedProvider();
  try {
    // The rejection is captured, not caught, so a statement the provider ran fails here and not as a row mismatch.
    const failure = await provider.query(text, params).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(failure instanceof Error)) throw new Error(`the provider ran ${text}`);
    return failure.message;
  } finally {
    await provider.disconnect();
  }
}

describe("docs/providers/neo4j.md section 3.3 quotes every refusal sentence as the code gives it", () => {
  test.each([
    ["A unicode escape", "RETURN 'caf\\u00e9' AS s"],
    ["Text that does not lex", "MATCH (n) RETURN 'x"],
    ["More than one statement", "MATCH (n) RETURN n; MATCH (m) RETURN m"],
    ["`EXPLAIN` or `PROFILE`", "EXPLAIN MATCH (n) RETURN n"],
    ["A denied word", "MATCH (n) SET n.seen = true"],
    ["A denied word used as a name", "MATCH (n) RETURN n.set"],
    ["A procedure outside the allowlist", "CALL dbms.listConfig()"],
    ["`CALL` used as a name", "MATCH (n:CALL) RETURN n"],
    ["A denied namespace", "CALL apoc.load.json('http://10.0.0.5/')"],
    ["A SHOW form outside the allowlist", "SHOW USERS"],
    ["`SHOW` used as a name", "MATCH (n:SHOW) RETURN n"],
    ["`SHOW TRANSACTIONS`", "SHOW TRANSACTIONS"],
    ["A qualified function outside the allowlist", "RETURN my.custom(1)"],
    ["A parameter", "MATCH (n) WHERE n.id = $id RETURN n"],
  ])("%s", (cell, text) => {
    expect(rowOf(REFUSALS, cell)).toBe(`| ${cell} | \`${text}\` | ${policyRefusal(text)} |`);
  });

  test("an empty text", () => {
    expect(rowOf(REFUSALS, "No statement")).toBe(
      `| No statement | an empty or comment-only text | ${policyRefusal("// x")} |`,
    );
  });

  test.each([
    ["The gate: a write", "w"],
    ["The gate: a read and write", "rw"],
    ["The gate: a schema or administration statement", "s"],
    ["The gate: no classification", undefined],
  ] as const)("%s", async (cell, queryType) => {
    const sentence = await gateRefusal("MATCH (n) RETURN n", queryType);
    expect(cellsOf(rowOf(REFUSALS, cell))[2]).toBe(sentence);
  });

  test("the gate's check that failed, the server's words after the provider's", async () => {
    const sentence = await providerRefusal("MATCH (n) RETURN n");
    expect(sentence.endsWith(SERVER_WORDS)).toBe(true);
    expect(cellsOf(rowOf(REFUSALS, "The gate: the check failed"))[2]).toBe(sentence);
  });

  test("parameters bound by the caller", async () => {
    const sentence = await providerRefusal("MATCH (n) RETURN n", [1]);
    expect(cellsOf(rowOf(REFUSALS, "Parameters bound by the caller"))[2]).toBe(sentence);
  });

  test("a write the READ session refused on the server", () => {
    const sentence = mapNeo4jError(
      new GraphClientError(
        "access-mode",
        "Writing in read access mode not allowed",
        "Neo.ClientError.Statement.AccessMode",
      ),
    ).message;
    expect(cellsOf(rowOf(REFUSALS, "The server's READ mode"))[2]).toBe(sentence);
  });

  test("an allowlisted procedure the server classifies s runs, as the section says", async () => {
    const verdict = checkCypherRead("CALL dbms.components()", NEO4J_POLICY_PROFILE);
    if (!verdict.allowed) throw new Error("the policy refused dbms.components");
    expect(await neo4jStatementGate(answering({ queryType: "s" }), verdict, RUN_OPTIONS)).toBeUndefined();
    expect(GATE).toContain("`CALL dbms.components()` is classified `s` and runs");
  });
});

describe("docs/providers/neo4j.md section 3.4 states why LOAD CSV and APOC are refused (E3)", () => {
  test.each(["LOAD CSV FROM 'http://10.0.0.5/x' AS row RETURN row", "LOAD /* x */ CSV FROM 'file:///x' AS r RETURN r"])(
    "%s is refused by the policy",
    (text) => {
      expect(checkCypherRead(text, NEO4J_POLICY_PROFILE).allowed).toBe(false);
    },
  );

  test("the gate alone would pass LOAD CSV: the capture classifies it r", () => {
    const capture = JSON.parse(read("tests/fixtures/neo4j/5.26.31/explain-load-csv.json")) as {
      result: GraphRunResult;
    };
    expect(capture.result.queryType).toBe("r");
    expect(WHY_LOAD_CSV).toContain("classifies `LOAD CSV` as `r`");
    expect(WHY_LOAD_CSV).toContain("private address");
  });
});

describe("docs/SECURITY.md note 3.10 names only what the policy profile refuses", () => {
  test("every name the note gives is a denied word or a denied namespace of NEO4J_POLICY_PROFILE", () => {
    const sentence = SECURITY.split("\n").find((line) =>
      line.includes("are refused by the policy before anything is sent"),
    );
    expect(sentence).toBeDefined();
    const named = [...(sentence ?? "").slice((sentence ?? "").indexOf(", so ")).matchAll(/`([^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(named).toEqual(["LOAD", "TERMINATE", "apoc.", "gds."]);
    const refused = [...POLICY.deniedWords.map((words) => words.join(" ")), ...POLICY.deniedNamespaces];
    expect(named.filter((name) => !refused.includes(name))).toEqual([]);
  });
});

describe("docs/providers/neo4j.md section 3.6 states the machine access the product offers", () => {
  test("plan mode and the MCP metadata tools, no agent execution and no run_read_query", () => {
    expect(AGENT_EXECUTION_ENGINES).not.toContain("neo4j");
    expect(MCP_EXPOSABLE.neo4j).toBe(true);
    expect(MACHINE).toContain("`list_connections` and `inspect_schema`");
    expect(MACHINE).toContain("agent execution and MCP `run_read_query` do not serve Neo4j");
  });

  test("the plan-mode statement language is the one getLabels() answers", () => {
    expect(MACHINE).toContain(`"${neo4jLabels().statementLanguage}"`);
  });
});

describe("docs/providers/neo4j.md section 4.1 states the dialog's fields", () => {
  const neo4j = DB_UI_CONFIG.neo4j;

  test.each([["Database", "database"]] as const)("the %s row carries the dialog's own hint", (cell, field) => {
    expect(rowOf(FIELDS, cell)).toBe(`| ${cell} | ${neo4j.fieldHints?.[field]} |`);
  });

  test("the port is the dialog's and the provider's", () => {
    expect(new Neo4jProvider(CONNECTION).getCapabilities().defaultPort).toBe(NEO4J_DEFAULT_PORT);
    expect(neo4j.defaultPort).toBe(String(NEO4J_DEFAULT_PORT));
    expect(rowOf(FIELDS, "Port")).toContain(`\`${NEO4J_DEFAULT_PORT}\` by default`);
  });

  test("no connection string, as the dialog declares", () => {
    expect(neo4j.showConnectionStringToggle).toBe(false);
    expect(FIELDS).toContain("There is no connection string");
  });

  test("the read-only toggle keeps the promise: the provider keeps the mode", () => {
    expect(READ_ONLY_ENFORCED.neo4j).toBe(true);
    expect(rowOf(FIELDS, "Read-only")).toContain("read-only either way");
    // The sentence the dialog draws under the toggle, quoted from the declaration (spec A7).
    expect(rowOf(FIELDS, "Read-only")).toContain(`"${readOnlyHint(neo4j)}"`);
  });
});

/** The panel to the scheme and the CA the provider builds, or the refusal it raises. */
function endpointOf(ssl: Partial<SSLConfig> | undefined, tunnelled = false) {
  return boltEndpointOf(
    {
      host: "neo4j.internal",
      port: 7687,
      ssl: ssl as SSLConfig | undefined,
      ...(tunnelled ? { [TUNNEL_FAR_END]: { host: "neo4j.internal", port: 7687 } } : {}),
    },
    NEO4J_DEFAULT_PORT,
  );
}

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";

describe("docs/providers/neo4j.md section 4.3 maps the TLS panel as uri.ts does", () => {
  test.each([
    ["No TLS panel, or `disable`", [undefined, { mode: "disable" }], "bolt", false],
    ["`require`", [{ mode: "require" }, { mode: "require", rejectUnauthorized: false }], "bolt+ssc", false],
    ["`require` with `rejectUnauthorized: true`", [{ mode: "require", rejectUnauthorized: true }], "bolt+s", false],
    ["`verify-system`, or a panel with no mode", [{ mode: "verify-system" }, {}], "bolt+s", false],
    [
      "`verify-ca` or `verify-full` with a pasted CA",
      [
        { mode: "verify-ca", caCert: PEM },
        { mode: "verify-full", caCert: PEM },
      ],
      "bolt+s",
      true,
    ],
    ["`verify-ca` or `verify-full` with no CA", [{ mode: "verify-ca" }, { mode: "verify-full" }], "bolt+s", false],
  ] as const)("%s", (cell, panels, scheme, customCa) => {
    expect(cellsOf(rowOf(TLS, cell))[1]).toBe(`\`${scheme}\``);
    for (const panel of panels) {
      const endpoint = endpointOf(panel as Partial<SSLConfig> | undefined);
      expect(endpoint.uri.startsWith(`${scheme}://`)).toBe(true);
      expect(endpoint.trustedCertificatePem !== undefined).toBe(customCa);
    }
  });

  test.each([
    ["a client certificate", () => endpointOf({ mode: "verify-full", clientCert: PEM, clientKey: PEM })],
    ["a verifying mode through an SSH tunnel", () => endpointOf({ mode: "verify-full" }, true)],
    ["a user name in the host", () => boltEndpointOf({ host: "neo4j:secret@neo4j.internal", port: 7687 }, 7687)],
  ])("the refusal of %s is the one connect() raises", (_label, build) => {
    let sentence: string | undefined;
    try {
      build();
    } catch (error) {
      sentence = (error as Error).message;
    }
    expect(sentence).toBeDefined();
    expect(DOC).toContain(`"${sentence}"`);
  });

  test("require without verification through a tunnel is allowed, as the section says", () => {
    expect(endpointOf({ mode: "require" }, true).uri).toBe("bolt+ssc://neo4j.internal:7687");
    expect(TLS).toContain("`verify-ca` also checks the host name");
  });
});

describe("docs/providers/neo4j.md section 5 states the result forms and the bounds", () => {
  test("the graph tag and the elementId caveat", () => {
    expect(RESULT).toContain(`"${GRAPH_TAG}": "node"`);
    expect(RESULT).toContain("`elementId` is stable only within one transaction");
  });

  const graphBase = "src/lib/db/graph/graph-base-provider.ts";
  test.each([
    ["`DEFAULT_QUERY_LIMIT`", DEFAULT_QUERY_LIMIT],
    ["`MAX_CELL_JSON_BYTES`", MAX_CELL_JSON_BYTES],
    ["`MAX_CELL_DEPTH`", MAX_CELL_DEPTH],
    ["`CATALOG_ROW_BOUND`", CATALOG_ROW_BOUND],
    ["`CATALOG_CACHE_MS`", privateConstant(graphBase, "CATALOG_CACHE_MS")],
    ["`CATALOG_TIMEOUT_MS`", privateConstant("src/lib/db/providers/graph/neo4j/catalog.ts", "CATALOG_TIMEOUT_MS")],
    [
      "`MONITORING_TIMEOUT_MS`",
      privateConstant("src/lib/db/providers/graph/neo4j/monitoring-reads.ts", "MONITORING_TIMEOUT_MS"),
    ],
    ["`TABLE_STATS_LABEL_BOUND`", TABLE_STATS_LABEL_BOUND],
    ["`GRAPH_SAMPLE_LIMIT`", GRAPH_SAMPLE_LIMIT],
  ])("the %s row states %d", (cell, value) => {
    expect(cellsOf(rowOf(BOUNDS, cell))[1]).toBe(en(value));
  });

  test("the cancellation measurement is the capture README's, and the R02 wording is the client's docblock", () => {
    const rejected = /rejected the run (\S+ ms) later/.exec(CAPTURES_README)?.[1];
    const left = /left `SHOW TRANSACTIONS` (\S+ ms) after the abort/.exec(CAPTURES_README)?.[1];
    expect(rejected).toBeDefined();
    expect(left).toBeDefined();
    expect(CANCEL).toContain(`rejected the run ${rejected} later`);
    expect(CANCEL).toContain(`left \`SHOW TRANSACTIONS\` ${left} after the abort`);
    const wording =
      "`session.close()` returns in 1 to 3 ms and the transaction leaves `SHOW TRANSACTIONS` within 1.5 s";
    expect(read("src/lib/db/graph/bolt/bolt-client.ts").replaceAll("\n * ", " ")).toContain(wording);
    expect(CANCEL).toContain(wording);
  });
});

describe("docs/providers/neo4j.md section 5.6 states the Graph tab's bound, notices and caption", () => {
  /** A result of `count` distinct nodes, one per row, and `orphans` relationships to a node it never returns. */
  const resultGraph = (count: number, orphans: number, maxNodes = MAX_GRAPH_NODES): ResultGraph => {
    const node = (id: string) => ({ [GRAPH_TAG]: "node", elementId: id, labels: ["Person"], properties: {} });
    const rows = Array.from({ length: count }, (_, at) => ({ n: node(`n${at}`) }));
    const relationships = Array.from({ length: orphans }, (_, at) => ({
      [GRAPH_TAG]: "relationship",
      elementId: `r${at}`,
      type: "KNOWS",
      startNodeElementId: "n0",
      endNodeElementId: "missing",
      properties: {},
    }));
    return buildResultGraph([...rows, { n: relationships }], ["n"], { maxNodes });
  };

  test("the node cap is MAX_GRAPH_NODES, and the notice is the one the tab prints", () => {
    expect(GRAPH_TAB).toContain(`the first ${en(MAX_GRAPH_NODES)} distinct nodes in row order`);
    const notice = capNotice(resultGraph(412, 0));
    expect(notice).not.toBeNull();
    expect(GRAPH_TAB).toContain(`"${notice}"`);
  });

  test("the dropped-relationship notice is the one the tab prints", () => {
    const notice = droppedNotice(resultGraph(2, 2));
    expect(notice).not.toBeNull();
    expect(GRAPH_TAB).toContain(`"${notice}"`);
  });

  test("the caption length is the model's", () => {
    const length = privateConstant("src/lib/db/graph/result-graph.ts", "CAPTION_LENGTH");
    expect(GRAPH_TAB).toContain(`at most ${length} characters`);
  });

  test("the canvas name is the shape of graphAriaLabel", () => {
    const label = graphAriaLabel(resultGraph(2, 0));
    expect(label).toBe("Graph of 2 nodes and 0 relationships");
    expect(GRAPH_TAB).toContain(
      `"${label.replace("2 nodes", "N nodes").replace("0 relationships", "M relationships")}"`,
    );
  });

  test("the toolbar list is every button's accessible name, in order", () => {
    const view = read("src/components/results-graph/GraphView.tsx");
    const tools = [...(/const TOOLS[^=]*= \[([^\]]*)\]/.exec(view)?.[1] ?? "").matchAll(/label: "([^"]+)"/g)];
    const exports = [...view.matchAll(/aria-label="(Export [^"]+)"/g)];
    const names = [...tools, ...exports].map((match) => match[1]);
    expect(names).toHaveLength(6);
    expect(GRAPH_TAB).toContain(`the toolbar holds ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`);
  });
});

describe("docs/providers/neo4j.md sections 6 and 7 quote the statements the catalog and the panels run", () => {
  test.each(Object.entries(NEO4J_CATALOG_STATEMENTS))("the catalog's %s read", (_name, statement) => {
    expect(SCHEMA).toContain(`\`${statement}\``);
  });

  test.each(Object.entries(NEO4J_MONITORING_STATEMENTS))("the monitoring %s read", (_name, statement) => {
    expect(MONITORING).toContain(`\`${statement}\``);
  });

  test("the transactions read names no parameters column (E10)", () => {
    expect(NEO4J_MONITORING_STATEMENTS.transactions).not.toContain("parameters");
    expect(MONITORING).toContain("never the `parameters` column");
  });

  test("the empty states are the labels' own", () => {
    const labels = neo4jLabels();
    expect(MONITORING).toContain(`"${labels.slowQueriesEmptyState}"`);
    expect(MONITORING).toContain(`"${labels.sessionsEmptyState}"`);
  });

  test("a label is never a source: the provider writes no readObjectSource", () => {
    expect("readObjectSource" in Neo4jProvider.prototype).toBe(false);
    expect(SCHEMA).toContain("no `readObjectSource`");
  });
});

describe("docs/providers/neo4j.md section 9 states the declarations", () => {
  const capabilities = new Neo4jProvider(CONNECTION).getCapabilities();

  test.each([
    ["queryLanguage", `\`queryLanguage: "${capabilities.queryLanguage}"\``],
    ["defaultPort", `\`defaultPort: ${capabilities.defaultPort}\``],
    ["schemaRefreshPattern", `\`schemaRefreshPattern: "${capabilities.schemaRefreshPattern}"\``],
    ["enforcesReadOnly", `\`enforcesReadOnly: ${capabilities.enforcesReadOnly}\``],
    ["supportsMaintenance", `\`supportsMaintenance: ${capabilities.supportsMaintenance}\``],
  ])("%s", (_name, quoted) => {
    expect(CAPABILITIES).toContain(quoted);
  });

  test("the row labels", () => {
    const labels = neo4jLabels();
    for (const label of [labels.entityName, labels.rowName, labels.selectAction, labels.generateAction]) {
      expect(CAPABILITIES).toContain(`"${label}"`);
    }
  });
});

describe("docs/providers/neo4j.md section 10 states the error table errors.ts keeps", () => {
  test.each(["auth", "connection", "tls", "timeout", "cancelled", "syntax", "query"] as const)(
    "the %s row",
    (category) => {
      const mapped = mapNeo4jError(new GraphClientError(category, SERVER_WORDS, "Neo.Code"));
      const cells = cellsOf(rowOf(ERRORS, `\`${category}\``));
      expect(cells[1]).toBe(`\`${mapped.constructor.name}\``);
      expect(cells[2]).toBe(mapped.message);
    },
  );
});

describe("docs/providers/neo4j.md section 11 states the live fixture and its provenance", () => {
  test("the image and digest are the compose file's and the capture README's", () => {
    const image = /image: (neo4j:[^@\s]+)@(sha256:[0-9a-f]{64})/.exec(COMPOSE);
    expect(image).not.toBeNull();
    const [, tag, digest] = image as RegExpExecArray;
    expect(CAPTURES_README).toContain(digest);
    expect(TESTING).toContain(`\`${tag}\``);
    expect(TESTING).toContain(`\`${digest}\``);
  });

  test("the seed's size is the fixture README's", () => {
    expect(read("docker/neo4j/README.md")).toContain("30 nodes and 40 relationships");
    expect(TESTING).toContain("30 nodes and 40 relationships");
  });
});

describe("the backlog entries the doc cites exist, and the agent one is cited by docs/AGENT.md", () => {
  const cited = [...new Set([...LIMITS.matchAll(/\b([BDU]\d+)\b/g)].map((match) => match[1]))];

  test("the limits section cites at least the six entries the provider filed", () => {
    expect(cited.length).toBeGreaterThanOrEqual(6);
  });

  test.each(cited)("%s is an entry of docs/BACKLOG.md", (id) => {
    expect(BACKLOG).toMatch(new RegExp(`^### ${id}\\. `, "m"));
  });

  test("the B-series entry is cited by docs/AGENT.md", () => {
    const agentEntries = cited.filter((id) => id.startsWith("B"));
    expect(agentEntries.length).toBeGreaterThan(0);
    for (const id of agentEntries) expect(AGENT_DOC).toContain(`**${id}**`);
  });
});

describe("the repository docs name the provider where a reader looks for it", () => {
  test("the provider index has its row, and the fixture table its connection", () => {
    expect(rowOf(PROVIDERS_README, "Neo4j")).toContain("[neo4j.md](./neo4j.md)");
    const fixture = PROVIDERS_README.split("\n").find((line) => line.startsWith("| Neo4j | `neo4j` | localhost |"));
    expect(fixture).toContain(`| ${NEO4J_DEFAULT_PORT} |`);
    expect(fixture).toContain("`password123`");
  });

  test("the seed recipe loads as a seed file, read-only and offered to MCP clients", () => {
    const parsed = SeedConfigSchema.safeParse(parseYAML(yamlBlockOf(RECIPE) ?? ""));
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.data?.connections).toHaveLength(1);
    expect(parsed.data?.connections[0]).toMatchObject({ type: "neo4j", readOnly: true, mcp: true, managed: true });
    expect(DOC).toContain("SEED_CONNECTIONS.md#a-read-only-neo4j-graph");
    // The provider doc's example is the same recipe.
    expect(yamlBlockOf(docSection(DOC, "12.1 A read-only seed") ?? "")).toBe(yamlBlockOf(RECIPE));
  });
});

describe("docs/providers/neo4j.md carries no authoring instruction", () => {
  test("no scratch path, no plan reference and no placeholder note reaches the published doc", () => {
    expect(DOC).not.toContain("$S/");
    expect(DOC).not.toContain("/home/");
    expect(DOC).not.toMatch(/\bSR\d+\b/);
    expect(DOC).not.toContain("TODO");
  });
});
