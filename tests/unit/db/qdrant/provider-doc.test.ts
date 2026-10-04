/**
 * `docs/providers/qdrant.md`, `docs/SECURITY.md` and `docs/SEED_CONNECTIONS.md` quote sentences and numbers the
 * code owns (vector-family spec 8.3 gate 1 and 4.4), the shape of `tests/unit/db/etcd/provider-doc.test.ts`.
 *
 * A value copied into prose is true only until the code moves, so every bound, label, route, refusal and warning
 * the doc quotes is read back from the module that owns it, every stated limit is pinned in the doc and in the
 * security page, the open-server clause included, and the public inference statement is held word for word in
 * both places it is written.
 */
import { describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_EXECUTION_ENGINES } from "@/lib/agent/engine-support";
import { DB_UI_CONFIG } from "@/lib/db-ui-config";
import { MCP_EXPOSABLE, READ_ONLY_ENFORCED } from "@/lib/db/compatibility";
import { CREDENTIAL_WARNINGS, credentialWarningFor } from "@/lib/db/credential-warnings";
import { QDRANT_DEFAULT_PORT } from "@/lib/db/providers/vector/qdrant/connection-options";
import { type QdrantClientFactory, QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import {
  QDRANT_BOUNDS,
  QDRANT_CONSOLE,
  QDRANT_GATES,
  QDRANT_KEYS,
  QDRANT_ROUTES,
  type QdrantRoute,
} from "@/lib/db/providers/vector/qdrant/routes";
import { QDRANT_SAMPLE_POINTS } from "@/lib/db/providers/vector/qdrant/sample";
import { QDRANT_TESTED_VERSION } from "@/lib/db/providers/vector/qdrant/versions";
import type { DatabaseConnection } from "@/lib/types";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const TEST_PASSWORD = "password";
const TEST_JWT_SECRET = "password-second";
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const DOC = read("docs/providers/qdrant.md");
const SECURITY = read("docs/SECURITY.md");
const SEEDS = read("docs/SEED_CONNECTIONS.md");
const QDRANT: DatabaseConnection = {
  id: "qdrant-doc",
  name: "Qdrant",
  type: "qdrant",
  host: "qdrant.internal",
  port: 6333,
  createdAt: new Date(0),
};
const labels = new QdrantProvider(QDRANT).getLabels();
const n = (value: number): string => value.toLocaleString("en-US");
/** Prose is one sentence per line, so a sentence that spans lines is compared with its line breaks read as spaces. */
const flat = (text: string): string => text.replace(/\s*\n\s*/g, " ");

/** The public inference statement of the vector-family spec, word for word. */
const INFERENCE_STATEMENT =
  "Studio refuses every Qdrant inference object (a text, image or object input with a model) except the local BM25 model, in every release. A request with such an input makes the Qdrant server call an inference service that the operator configured, passing the input, any request header ending in -api-key and the caller's identity; some hosted models are billed; and a statement could carry a third-party API key into query history. Studio never sends these inputs, so the console cannot trigger that path.";

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

/** A route's request line as the doc and the console write it: the method, then the path under the prefix. */
const requestLine = (route: QdrantRoute): string => `${route.method} ${QDRANT_CONSOLE.pathPrefix}${route.template}`;

const ticked = (keys: readonly string[]): string => keys.map((key) => `\`${key}\``).join(", ");

/** The route table's row for one route: its request line, its query keys, and its body's keys, required first. */
function routeRow(route: QdrantRoute): string {
  const query = Object.keys(route.query);
  let body = "none";
  if (route.schema === "QueryRequestBatch") {
    body = `required: ${ticked(QDRANT_KEYS.QueryRequestBatch.required)}, each a query body`;
  } else if (route.schema !== null) {
    const schema: { readonly keys: readonly string[]; readonly required: readonly string[] } =
      QDRANT_KEYS[route.schema];
    const rest = schema.keys.filter((key) => !schema.required.includes(key)).sort();
    body =
      route.body === "required"
        ? `required: ${ticked(schema.required)}; also ${ticked(rest)}`
        : `optional: ${ticked(rest)}`;
  }
  return `| \`${requestLine(route)}\` | ${query.length === 0 ? "none" : ticked(query)} | ${body} |`;
}

function mint(claims: Record<string, unknown>): string {
  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}`;
  return `${head}.${createHmac("sha256", TEST_JWT_SECRET).update(head).digest("base64url")}`;
}

async function plaintextRefusal(): Promise<string> {
  const createClient = mock(() => {
    throw new Error("no client may be built");
  });
  const provider = new QdrantProvider(
    { ...QDRANT, host: "qdrant.example.com", password: TEST_PASSWORD },
    {},
    {},
    createClient as unknown as QdrantClientFactory,
  );
  try {
    await provider.connect();
  } catch (error) {
    expect(createClient).toHaveBeenCalledTimes(0);
    return (error as Error).message;
  }
  throw new Error("expected the plaintext refusal");
}

/** One fragment per stated limit, in the order the spec lists them, and the key guidance of spec 6.2. */
const LIMIT_FRAGMENTS: readonly string[] = [
  "Vectors and payloads reach query history and saved queries",
  "Any read credential can download whole snapshots and read the server's telemetry outside Studio.",
  "A collection-scoped token with write access can delete a named vector from every point of its collection outside Studio.",
  "The Qdrant server logs every request's path and query string, so collection names appear in its log.",
  "A stopped query runs on the server until its server timeout, and an exact count runs past it until it completes.",
  "any user who knows a run's id can cancel it",
  "Studio cannot tell what an opaque key can do",
  "A Qdrant server without `service.api_key`, its default, accepts any key or none",
  "Prefer a read-only or collection-scoped key, or a JWT with an expiry.",
  "The server's own egress, its inference calls and its snapshot recovery included, is outside the HTTP egress guard.",
  "TLS mode `require` sends the API key to an unverified peer.",
  "An empty tree is what a scoped token, an alias-only token and an empty server all produce.",
  "A vendor address pasted into the connection-string box instead of the Host box still selects ClickHouse.",
  "Studio withholds only the forms it sends.",
];

describe("docs/providers/qdrant.md quotes what the code says", () => {
  test("the version claim names the tested version, and an older server's note", () => {
    expect(DOC).toContain(
      `Tested against Qdrant ${QDRANT_TESTED_VERSION} on Node 24.14.0, Node 26.10.0 and Bun 1.4.2; an older server connects and is not tested.`,
    );
  });

  test("the version gates are the table's, every key and the version it needs", () => {
    const gates = sectionOf(DOC, "### 4.8 Server versions");
    const documented = gates.split("\n").filter((line) => /^\| (`|the |formula )/.test(line));
    const needs = new Map<string, string>();
    for (const gate of Object.values(QDRANT_GATES)) needs.set(gate.key, gate.needs);
    const read = new Map<string, string>();
    for (const line of documented) {
      const [keyCell, needsCell] = line.slice(2, -2).split(" | ");
      const formula = /^formula `(\w+)`, `(\w+)`, `(\w+)`$/.exec(keyCell);
      if (formula) for (const name of formula.slice(1)) read.set(`formula ${name}`, needsCell);
      else read.set(keyCell.replace(/^the `(\w+)` condition$/, "$1").replaceAll("`", ""), needsCell);
    }
    expect(read).toEqual(needs);
  });

  test("the public inference statement is section 3.2's, word for word", () => {
    expect(flat(sectionOf(DOC, "### 3.2 No server-side inference, in any release"))).toContain(INFERENCE_STATEMENT);
  });

  test("the request language is the generated statementLanguage, word for word", () => {
    expect(sectionOf(DOC, "### 5.1 The request")).toContain(`\`\`\`text\n${labels.statementLanguage}\n\`\`\``);
  });

  test("the route table is the console's, every route, its query keys and its body, and nothing else", () => {
    const table = sectionOf(DOC, "### 5.2 The routes");
    const documented = table.split("\n").filter((line) => /^\| `(GET|POST) /.test(line));
    expect(documented).toEqual(QDRANT_ROUTES.map(routeRow));
  });

  test("the field rows are the dialog's hints, and the port is the provider's default", () => {
    const fields = sectionOf(DOC, "### 4.1 Configuration fields");
    const hints = DB_UI_CONFIG.qdrant.fieldHints ?? {};
    expect(rowOf(fields, "Host")).toBe(`| Host | ${hints.host} |`);
    expect(rowOf(fields, "API key or JWT")).toBe(`| API key or JWT | ${hints.password} |`);
    expect(rowOf(fields, "Port")).toContain(`\`${QDRANT_DEFAULT_PORT}\` by default`);
    expect(DB_UI_CONFIG.qdrant.fieldLabels?.password).toBe("API key or JWT");
  });

  test("the credential warnings are the record's sentences, read by reference", () => {
    const auth = sectionOf(DOC, "### 4.2 Authentication");
    expect(auth).toContain(`> ${credentialWarningFor("qdrant", { password: mint({ access: "m" }) })}`);
    const noSecret = CREDENTIAL_WARNINGS.qdrant?.find((entry) => entry.kind === "no-secret");
    expect(auth).toContain(`> Credential warning: ${noSecret?.message}`);
  });

  test("the plaintext refusal is the provider's, with its three ways out", async () => {
    const sentence = await plaintextRefusal();
    expect(sectionOf(DOC, "### 4.6 A key needs TLS off this machine")).toContain(`> ${sentence}`);
    for (const exit of ["SSL / TLS", "SSH tunnel", "clear the"]) expect(sentence).toContain(exit);
  });

  test("every bound the doc quotes is the number the code enforces", () => {
    const bounds = sectionOf(DOC, "### 5.7 Bounds");
    expect(rowOf(bounds, "Console text and parser")).toContain(
      `${n(QDRANT_CONSOLE.maxTextBytes)} bytes of UTF-8; depth ${QDRANT_CONSOLE.maxDepth}, ${n(QDRANT_CONSOLE.maxNodes)} nodes, ${n(QDRANT_CONSOLE.maxNumericLeaves)} numeric leaves, ${n(QDRANT_CONSOLE.maxScalarLeaves)} scalar leaves`,
    );
    expect(rowOf(bounds, "Rows")).toContain(`at most ${n(QDRANT_BOUNDS.maxRows)}`);
    expect(rowOf(bounds, "Batch and prefetch")).toContain(
      `at most ${QDRANT_BOUNDS.maxBatchSearches} searches; prefetch at most ${QDRANT_BOUNDS.maxPrefetchDepth} deep, ${QDRANT_BOUNDS.maxPrefetchPerList} entries per list and ${QDRANT_BOUNDS.maxPrefetchNodes} prefetch nodes`,
    );
    expect(rowOf(bounds, "Candidates")).toContain(`at most ${n(QDRANT_BOUNDS.maxCandidates)}`);
    expect(rowOf(bounds, "Candidates")).toContain(
      `\`hnsw_ef\` at most ${n(QDRANT_BOUNDS.maxHnswEf)}, oversampling at most ${QDRANT_BOUNDS.maxOversampling.toFixed(1)}, MMR's \`candidates_limit\` at most ${n(QDRANT_BOUNDS.maxMmrCandidates)}`,
    );
    expect(rowOf(bounds, "Facet")).toContain(`at most ${n(QDRANT_BOUNDS.maxFacetLimit)}`);
    expect(rowOf(bounds, "Filter")).toContain(
      `${n(QDRANT_BOUNDS.maxFilterBytes)} bytes; at most ${QDRANT_BOUNDS.maxFilterConditions} conditions; \`nested\` at most ${QDRANT_BOUNDS.maxNestedLevels} deep; \`match.any\`, \`match.except\` and \`has_id\` lists at most ${n(QDRANT_BOUNDS.maxFilterListEntries)} entries`,
    );
    expect(rowOf(bounds, "Formula")).toContain(
      `at most ${QDRANT_BOUNDS.maxFormulaDepth} deep and ${QDRANT_BOUNDS.maxFormulaNodes} nodes`,
    );
    expect(rowOf(bounds, "Vectors")).toContain(
      `a dense size from 1 to ${n(QDRANT_BOUNDS.maxDenseSize)}; a multivector's rows times size below ${n(QDRANT_BOUNDS.maxMultivectorElements + 1)}`,
    );
    expect(rowOf(bounds, "Transport cap")).toContain(`${n(QDRANT_BOUNDS.transportCapBytes)} bytes`);
    expect(rowOf(bounds, "Result budget")).toContain(`${n(QDRANT_BOUNDS.resultBudgetBytes)} bytes`);
    expect(rowOf(bounds, "String values")).toContain(`${n(QDRANT_BOUNDS.stringCellUnits)} UTF-16 code units`);
    expect(rowOf(bounds, "Payload sample")).toContain(`${n(QDRANT_SAMPLE_POINTS)} points`);
    expect(rowOf(bounds, "In flight")).toContain(
      `${QDRANT_BOUNDS.perProvider} requests per connection and ${QDRANT_BOUNDS.perEngine} per server in this process, with a queue of ${QDRANT_BOUNDS.queueDepth}`,
    );
  });

  test("the deadlines and the request defaults are the bounds the code sends", () => {
    const time = flat(sectionOf(DOC, "### 5.8 Time, cancellation and the confirmation gate"));
    expect(time).toContain(
      `${QDRANT_BOUNDS.metadataDeadlineMs / 1000} seconds for a metadata route and ${QDRANT_BOUNDS.pointReadDeadlineMs / 1000} for a point read or query`,
    );
    expect(flat(sectionOf(DOC, "### 5.3 Request rules"))).toContain(
      `sent as ${QDRANT_BOUNDS.defaultLimit}, and on query groups as ${QDRANT_BOUNDS.defaultLimit} with \`group_size\` ${QDRANT_BOUNDS.defaultGroupSize}`,
    );
  });

  test("the monitoring labels are the provider's", () => {
    const monitoring = sectionOf(DOC, "## 7. Monitoring & health");
    expect(monitoring).toContain(`\n${labels.tableStatsCaption}\n`);
    expect(labels.tableStatsCaption).toContain(`The first ${QDRANT_BOUNDS.tablesPanelCollections} collections.`);
    expect(monitoring).toContain(`> ${labels.slowQueriesEmptyState}`);
    expect(monitoring).toContain(`> ${labels.sessionsEmptyState}`);
  });

  test("machine access and the read-only mode are what the records say", () => {
    expect(MCP_EXPOSABLE.qdrant).toBe(true);
    expect(READ_ONLY_ENFORCED.qdrant).toBe(true);
    expect(AGENT_EXECUTION_ENGINES).not.toContain("qdrant");
    const machine = sectionOf(DOC, "### 3.5 Machine access");
    expect(machine).toContain("(`mcp: true`)");
    expect(machine).toContain("agent execution and MCP `run_read_query` refuse Qdrant");
  });

  test("the doc keeps every sentence of the stated limits, the open-server clause included", () => {
    const limits = flat(sectionOf(DOC, "## 13. Known limitations"));
    for (const fragment of LIMIT_FRAGMENTS) expect(limits).toContain(fragment);
    expect(flat(sectionOf(DOC, "### 3.4 The read-only mode"))).toContain(LIMIT_FRAGMENTS[7]);
  });

  test("the object edit section the edit census asks of an abstainer is there", () => {
    expect(DOC).toMatch(/^#{1,6} .*Object edit \(#789\)/m);
  });

  test("the doc carries no em dash and no en dash", () => {
    expect(DOC).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("docs/SECURITY.md states Qdrant's control, its limits and its plaintext rule", () => {
  test("note 3.11 is the public inference statement, word for word", () => {
    const start = SECURITY.indexOf("**3.11.**");
    expect(start).toBeGreaterThan(-1);
    const note = SECURITY.slice(start, SECURITY.indexOf("\n\n", start));
    expect(flat(note)).toBe(`**3.11.** ${INFERENCE_STATEMENT}`);
  });

  const bullet = bulletOf(SECURITY, "**Qdrant is reached over a REST client of Studio's own.**");

  test.each([...LIMIT_FRAGMENTS])("the Qdrant bullet keeps: %s", (fragment) => {
    expect(flat(bullet)).toContain(fragment);
  });

  test("the plaintext rule and row 3.8 name Qdrant", () => {
    expect(bullet).toContain(
      "A Qdrant API key or JWT over no TLS is refused unless the host is a loopback address or `localhost`, or an SSH tunnel carries the connection.",
    );
    expect(SECURITY).toContain("etcd's, Neo4j's, Milvus's and Qdrant's providers keep the mode today");
  });
});

describe("docs/SEED_CONNECTIONS.md names the Qdrant refusal", () => {
  test("Qdrant is a type the file takes, and its no-key refusal is stated", () => {
    expect(SEEDS).toContain("`neo4j`, `milvus`, `qdrant`");
    expect(SEEDS).toContain(
      "Qdrant declares the second: a read-only Qdrant seed with no key is refused, because a Qdrant server without a key accepts any key or none ([providers/qdrant.md](providers/qdrant.md), section 4.2).",
    );
    expect(SEEDS).toContain("load refuses what the file shows; resolution refuses the rest");
  });
});
