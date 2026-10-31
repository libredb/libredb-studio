/**
 * Seeds the Firestore emulator that agent-boundary/run.sh started, runs the agent's own reads and every agent-mode
 * surface through the provider, sends every request the agent's closed table refuses raw, and writes what the emulator
 * answered, with a fingerprint of every document before and after, into that run.sh's directory.
 *
 *   bun tests/live/firestore-agent-boundary.ts
 *
 * The environment names the emulator: FIRESTORE_AGENT_PORT (its port on 127.0.0.1), FIRESTORE_AGENT_IMAGE (the image
 * with its digest) and FIRESTORE_AGENT_OUT (the directory to write). The emulator authorizes nothing: every request
 * carries the literal `Bearer owner` the provider sends it, and a request with no authorization at all is answered the
 * same, which the capture records, so the closed table is the whole boundary on it. A production project's viewer
 * role is not measured here: it needs a Google project and a credential, which the owner runs.
 *
 * The refused requests are sent here with fetch, never through the provider: no Studio check stands in front of them,
 * which is the point, since what is measured is what the server does on its own with each one. A refused request is
 * recorded by its HTTP status and by whether its answer carried a seeded marker, never by its body. The writes (a
 * commit and a document PATCH) are sent by this script alone, never by Studio, and the fingerprint shows they act.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore/index";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { type CaptureSink, recordingTransport } from "../helpers/firestore-replay";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const PORT = Number(env("FIRESTORE_AGENT_PORT"));
const IMAGE = env("FIRESTORE_AGENT_IMAGE");
const OUT = env("FIRESTORE_AGENT_OUT");
const PROJECT = "demo-libredb";
const HOST = `127.0.0.1:${PORT}`;
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/%28default%29/documents`;
const DATE = new Date().toISOString().slice(0, 10);

const BUDGET = { maxResultRows: 3, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 } as const;
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };

/** What the seeded documents carry: none may reach an agent answer. */
const MARKERS = { value: "agent-marker-value", field: "agentMarkerField", id: "agent-marker-tenant" } as const;

/** The marker documents, beside docker/firestore/seed.json's: one per kind of stored value. */
const MARKER_DOCS = [
  { path: `tenants/${MARKERS.id}`, fields: { [MARKERS.field]: { stringValue: MARKERS.value } } },
  { path: `tenants/${MARKERS.id}/invoices/i1`, fields: { total: { integerValue: "42" } } },
  { path: "tenants/acme", fields: { plan: { stringValue: MARKERS.value } } },
];

async function call(
  method: string,
  url: string,
  body?: unknown,
  authorization: string | null = "Bearer owner",
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

async function seed(): Promise<void> {
  const seedFile = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../../docker/firestore/seed.json"), "utf8"),
  ) as { documents: { path: string; fields: unknown }[] };
  const writes = [...seedFile.documents, ...MARKER_DOCS].map((doc) => ({
    update: { name: `${ROOT}/${doc.path}`, fields: doc.fields },
  }));
  const seeded = await call("POST", `${BASE}:commit`, { writes });
  if (seeded.status !== 200) throw new Error(`the seed answered ${seeded.status}`);
}

/** Every document in the database by name and update time, hashed: a write moves it, a read never does. */
async function fingerprint(): Promise<{ documents: number; sha256: string }> {
  const answer = await call("POST", `${BASE}:runQuery`, {
    structuredQuery: { from: [{ allDescendants: true }], select: { fields: [{ fieldPath: "__name__" }] } },
  });
  const rows = (JSON.parse(answer.text) as { document?: { name: string; updateTime: string } }[])
    .flatMap((row) => (row.document === undefined ? [] : [`${row.document.name}@${row.document.updateTime}`]))
    .sort();
  return { documents: rows.length, sha256: createHash("sha256").update(rows.join("\n")).digest("hex") };
}

function connection(): DatabaseConnection {
  return {
    id: "agent-boundary",
    name: "Firestore emulator",
    type: "firestore",
    database: PROJECT,
    createdAt: new Date(0),
  };
}

async function opened(execution: ProviderExecutionContext, sink: CaptureSink): Promise<FirestoreProvider> {
  const provider = new FirestoreProvider(connection(), { queryTimeout: 30_000 }, execution, {
    createTransport: recordingTransport(createNodeTransport, sink),
    env: { FIRESTORE_EMULATOR_HOST: HOST },
  });
  await provider.connect();
  return provider;
}

/** A request as the capture records it: method, path with its query, body and status, never a header. */
function requestLines(sink: CaptureSink, from: number): unknown[] {
  return sink.exchanges.slice(from).map(({ request, response }) => {
    const line: Record<string, unknown> = { method: request.method, path: request.path };
    if (request.body !== undefined) line.body = JSON.parse(request.body) as unknown;
    line.status = response.status;
    return line;
  });
}

/** The agent's statements: the four reads, the edge of each budget, and every refused shape. */
const STATEMENTS = [
  "db.listCollections()",
  `db.doc("tenants/${MARKERS.id}").listCollections()`,
  'db.collection("products").count()',
  'db.collection("orders").count()',
  'db.collectionGroup("orders").count()',
  'db.collection("users/alice/orders").count()',
  'db.doc("users/alice").get()',
  'db.doc("users/nobody").get()',
  'db.collection("users").where("age", ">=", 18).count()',
  'db.collection("users").orderBy("age").startAt(30).count()',
  'db.collection("users").limit(1).count()',
  'db.collection("users").aggregate({ total: AggregateField.sum("age") })',
  'db.collection("users").get()',
  'db.collection("users").listDocuments()',
  'db.getAll(db.doc("users/alice"))',
  'db.collection("users").count().explain()',
  'db.doc("users/alice").set({ admin: true })',
];

async function agentReads(): Promise<{ steps: unknown[]; texts: string[] }> {
  const sink: CaptureSink = { lanes: [], exchanges: [] };
  const provider = await opened(READ_ONLY, sink);
  const steps: unknown[] = [];
  const texts: string[] = [];
  try {
    for (const statement of STATEMENTS) {
      const allowance = new RunReadAllowance(100);
      const budget: ReadOnlyStatementBudget = { ...BUDGET, readAllowance: allowance };
      const from = sink.exchanges.length;
      let answer: unknown;
      try {
        const result = await provider.queryReadOnly(statement, budget);
        answer = { fields: result.fields, rows: result.rows, warnings: result.warnings ?? [] };
      } catch (error) {
        answer = { refused: (error as Error).name, message: (error as Error).message };
      }
      texts.push(JSON.stringify(answer));
      steps.push({ statement, answer, billedReads: allowance.spent(), requests: requestLines(sink, from) });
    }
    // The allowance's edge: one unit left, and a read that needs one, then a read that needs one more.
    const last = new RunReadAllowance(1);
    const from = sink.exchanges.length;
    const first = await provider.queryReadOnly('db.doc("users/alice").listCollections()', {
      ...BUDGET,
      readAllowance: last,
    });
    const second = await provider
      .queryReadOnly('db.doc("users/alice").get()', { ...BUDGET, readAllowance: last })
      .catch((error: Error) => ({ refused: error.name, message: error.message }));
    steps.push({
      statement: "the allowance's last unit, then one read past it",
      answer: { first: first.rows.length, second },
      billedReads: last.spent(),
      requests: requestLines(sink, from),
    });
    texts.push(JSON.stringify(first), JSON.stringify(second));
  } finally {
    await provider.disconnect();
  }
  return { steps, texts };
}

async function surfaces(execution: ProviderExecutionContext): Promise<{ steps: unknown[]; texts: string[] }> {
  const sink: CaptureSink = { lanes: [], exchanges: [] };
  const provider = await opened(execution, sink);
  const allowance = new RunReadAllowance(100);
  const options = { readAllowance: allowance };
  const runs: [string, () => Promise<unknown>][] = [
    ["countObjects, no allowance", () => provider.countObjects([])],
    ["countObjects", () => provider.countObjects([], options)],
    ["listObjects collection", () => provider.listObjects([], "collection", options)],
    ["listObjects document", () => provider.listObjects([], "document", options)],
    ["describeObjects collection", () => provider.describeObjects([], "collection", 50, options)],
    ["describeObject collection", () => provider.describeObject(["users"], "collection")],
    ["readObjectSource document", () => provider.readObjectSource(["users/alice"], "document")],
    ["scanKeysPage", () => provider.scanKeysPage({ cursor: "0", count: 10 })],
    ["query", () => provider.query('db.collection("users").get()')],
    ["getHealth", () => provider.getHealth()],
    ["getOverview", () => provider.getOverview()],
    ["getTableStats", () => provider.getTableStats()],
  ];
  const steps: unknown[] = [];
  const texts: string[] = [];
  try {
    for (const [surface, run] of runs) {
      const from = sink.exchanges.length;
      const spent = allowance.spent();
      let answer: unknown;
      try {
        answer = await run();
      } catch (error) {
        answer = { refused: (error as Error).name, message: (error as Error).message };
      }
      texts.push(JSON.stringify(answer));
      steps.push({ surface, answer, billedReads: allowance.spent() - spent, requests: requestLines(sink, from) });
    }
  } finally {
    await provider.disconnect();
  }
  return { steps, texts };
}

/** The requests the agent's table refuses, each sent raw: a status, and whether a marker came back. */
const RAW_READS: readonly [string, string, string, unknown][] = [
  ["a document get", "GET", `${BASE}/tenants/${MARKERS.id}`, undefined],
  [
    "a document get with a field mask",
    "GET",
    `${BASE}/tenants/${MARKERS.id}?mask.fieldPaths=${MARKERS.field}`,
    undefined,
  ],
  ["listDocuments", "GET", `${BASE}/tenants?pageSize=10`, undefined],
  ["a batchGet with no mask", "POST", `${BASE}:batchGet`, { documents: [`${ROOT}/tenants/${MARKERS.id}`] }],
  ["a runQuery", "POST", `${BASE}:runQuery`, { structuredQuery: { from: [{ collectionId: "tenants" }] } }],
  [
    "a filtered count",
    "POST",
    `${BASE}:runAggregationQuery`,
    {
      structuredAggregationQuery: {
        structuredQuery: {
          from: [{ collectionId: "tenants" }],
          where: {
            fieldFilter: { field: { fieldPath: MARKERS.field }, op: "EQUAL", value: { stringValue: MARKERS.value } },
          },
        },
        aggregations: [{ alias: "n", count: {} }],
      },
    },
  ],
  [
    "a sum",
    "POST",
    `${BASE}/tenants/${MARKERS.id}:runAggregationQuery`,
    {
      structuredAggregationQuery: {
        structuredQuery: { from: [{ collectionId: "invoices" }] },
        aggregations: [{ alias: "s", sum: { field: { fieldPath: "total" } } }],
      },
    },
  ],
];

async function rawReads(): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [what, method, url, body] of RAW_READS) {
    const owner = await call(method, url, body);
    const anonymous = await call(method, url, body, null);
    out.push({
      what,
      asOwner: {
        status: owner.status,
        carriedMarker:
          owner.text.includes(MARKERS.value) || owner.text.includes(MARKERS.id) || owner.text.includes("42"),
      },
      withNoAuthorization: {
        status: anonymous.status,
        carriedMarker: anonymous.text.includes(MARKERS.value) || anonymous.text.includes(MARKERS.id),
      },
    });
  }
  return out;
}

async function rawWrites(): Promise<unknown[]> {
  const commit = await call(
    "POST",
    `${BASE}:commit`,
    { writes: [{ update: { name: `${ROOT}/raw/written`, fields: { a: { integerValue: "1" } } } }] },
    null,
  );
  const patch = await call("PATCH", `${BASE}/raw/patched`, { fields: { b: { integerValue: "2" } } }, null);
  return [
    { what: "a commit, with no authorization", status: commit.status },
    { what: "a document PATCH, with no authorization", status: patch.status },
  ];
}

async function main(): Promise<void> {
  await seed();
  const before = await fingerprint();
  const reads = await agentReads();
  const agentRead = await surfaces(READ_ONLY);
  const operations = await surfaces(OPERATIONS);
  const afterAgent = await fingerprint();
  const raw = await rawReads();
  const writes = await rawWrites();
  const afterRaw = await fingerprint();
  const texts = [...reads.texts, ...agentRead.texts, ...operations.texts].join("\n");
  const leaks = [MARKERS.value, MARKERS.field, MARKERS.id, "Alice", "Istanbul"].filter((marker) =>
    texts.includes(marker),
  );
  const capture = {
    emulator: { image: IMAGE, component: "cloud-firestore-emulator 1.22.0", project: PROJECT },
    date: DATE,
    budget: BUDGET,
    emulatorAuthorization:
      "The emulator authorizes nothing: every raw read and write below is answered the same with the literal Bearer owner and with no authorization header at all.",
    production:
      "A production project's roles/datastore.viewer is not measured here: it needs a Google project and a credential, which the owner runs.",
    agentReads: reads.steps,
    surfaces: { agentReadOnly: agentRead.steps, operations: operations.steps },
    raw: { reads: raw, writes },
    snapshot: {
      before,
      afterAgent,
      afterRaw,
      agentLeftUnchanged: before.sha256 === afterAgent.sha256,
      rawWritesChangedIt: afterAgent.sha256 !== afterRaw.sha256,
    },
    leaks,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  // A header written into the capture, or a bearer value longer than the emulator's literal one.
  if (/(?:"authorization"\s*:)|(?:Bearer [A-Za-z0-9._-]{20,})/i.test(text)) {
    throw new Error("the capture would hold a credential");
  }
  writeFileSync(path.join(OUT, "boundary.json"), text);
  if (leaks.length > 0) throw new Error(`an agent answer carried a marker: ${leaks.join(", ")}`);
  if (!capture.snapshot.agentLeftUnchanged) throw new Error("an agent read changed the database");
}

await main();
