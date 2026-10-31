/**
 * The structural closed table of Firestore's agent path: the agent modules reach the server only through
 * `FirestoreAgentClient`, whose members are three kinds of metadata request, and every request an agent-mode handle
 * sends, on any surface and for any statement, is one of the closed agent table's full requests: a collection id
 * listing, a whole-collection count with `upTo` and nothing narrowing it, or a batchGet of one document whose mask names
 * no field. The connect probe is the database resource, which reads no document.
 *
 * Both directions are proven: the real sources and the real handle pass, and a planted call, import or request fails
 * by name.
 */
// oxlint-disable no-await-in-loop -- each statement runs after the one before, so each request is one statement's.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { FIRESTORE_AGENT_CLIENT_MEMBERS } from "@/lib/db/providers/document/firestore/agent-client";
import { FirestoreProvider } from "@/lib/db/providers/document/firestore";
import { RunReadAllowance } from "@/lib/db/read-allowance";
import type { ProviderExecutionContext } from "@/lib/db/types";
import { fakeSeams, jsonAnswer } from "../../../helpers/firestore-seams";
import {
  firestoreConnection,
  isProbe,
  PROVIDER_DOCS,
  requestsOf,
  type SentWireRequest,
  type WireHandler,
  wire,
} from "../../../helpers/firestore-provider";

const ROOT = posix.join(import.meta.dir.replaceAll("\\", "/"), "..", "..", "..", "..");
const DIR = "src/lib/db/providers/document/firestore";
const AGENT_MODULES = ["agent-metadata-read.ts", "agent-surface.ts", "agent-statement.ts"] as const;

/** What the agent modules may import from the agent client module: its type, its call and Studio's own wording. */
const CLIENT_IMPORTS: ReadonlySet<string> = new Set([
  "FirestoreAgentClient",
  "FirestoreAgentCall",
  "isStudioWorded",
  "studioWorded",
]);

/** Each import of `./agent-client` or `./transport` an agent module names, and every `client.<member>(` call. */
function findings(file: string, source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']\.\/agent-client["']/g)) {
    for (const name of match[1].split(",").map((part) => part.replace(/^\s*type\s+/, "").trim())) {
      if (name !== "" && !CLIENT_IMPORTS.has(name)) found.push(`${file} imports ${name} from the agent client module`);
    }
  }
  for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']\.\/transport["']/g)) {
    for (const name of match[1].split(",").map((part) => part.replace(/^\s*type\s+/, "").trim())) {
      if (name !== "" && name !== "FIRESTORE_TRANSPORT_SENTENCES")
        found.push(`${file} imports ${name} from the transport module`);
    }
  }
  for (const match of source.matchAll(/\bclient\.(\w+)\s*\(/g)) {
    if (!(FIRESTORE_AGENT_CLIENT_MEMBERS as readonly string[]).includes(match[1]))
      found.push(`${file} calls client.${match[1]}, which the agent client does not hold`);
  }
  for (const name of [
    "buildRequest",
    "createFirestoreClient",
    "executeStatement",
    "scanFirestoreLevel",
    "readFirestoreSource",
    "describeFirestoreObject",
  ]) {
    if (new RegExp(`\\b${name}\\b`).test(source)) found.push(`${file} names ${name}`);
  }
  return found;
}

const DOCUMENTS = "/v1/projects/demo-studio/databases/%28default%29/documents";

/**
 * The closed agent table as full requests, each anchored at both ends: the path, the query (none) and the whole body.
 * A parent document's path is any run of percent-encoded segments; a document name in a batchGet is this database's.
 */
const SEGMENT = "[A-Za-z0-9._~%-]+";
function inTheTable(request: SentWireRequest): boolean {
  if (isProbe(request)) return [...request.query.keys()].length === 0 && request.body === undefined;
  if (request.method !== "POST" || [...request.query.keys()].length > 0) return false;
  const body = JSON.stringify(request.body);
  const parent = `^${DOCUMENTS}(?:/${SEGMENT}/${SEGMENT})*`;
  if (new RegExp(`${parent}:listCollectionIds$`).test(request.path))
    return /^\{"pageSize":\d+(?:,"pageToken":"[^"]+")?\}$/.test(body);
  if (new RegExp(`${parent}:runAggregationQuery$`).test(request.path))
    return /^\{"structuredAggregationQuery":\{"structuredQuery":\{"from":\[\{"collectionId":"[^"]+"(?:,"allDescendants":true)?\}\]\},"aggregations":\[\{"alias":"count","count":\{"upTo":"\d+"\}\}\]\}\}$/.test(
      body,
    );
  if (request.path === `${DOCUMENTS}:batchGet`)
    return new RegExp(
      `^\\{"documents":\\["${PROVIDER_DOCS.replace(/[()]/g, "\\$&")}/[^"]+"\\],"mask":\\{"fieldPaths":\\[\\]\\}\\}$`,
    ).test(body);
  return false;
}

const outsideTheTable = (requests: readonly SentWireRequest[]) => requests.filter((request) => !inTheTable(request));

describe("the agent modules' reach", () => {
  test.each(AGENT_MODULES)("%s reaches the server only through the agent client's members", (file) => {
    expect(findings(file, readFileSync(posix.join(ROOT, DIR, file), "utf8"))).toEqual([]);
  });

  test.each([
    [
      'import { createFirestoreAgentClient } from "./agent-client";',
      "agent-surface.ts imports createFirestoreAgentClient from the agent client module",
    ],
    [
      'import type { FirestoreClient } from "./transport";',
      "agent-surface.ts imports FirestoreClient from the transport module",
    ],
    [
      "await client.send(request, options);",
      "agent-surface.ts calls client.send, which the agent client does not hold",
    ],
    ['import { buildRequest } from "./requests";', "agent-surface.ts names buildRequest"],
    ['import { executeStatement } from "./console/execute";', "agent-surface.ts names executeStatement"],
  ])("a planted %p fails by name", (planted, finding) => {
    expect(findings("agent-surface.ts", planted)).toContain(finding);
  });

  test("the provider hands the agent's reads the agent client alone", () => {
    const index = readFileSync(posix.join(ROOT, DIR, "index.ts"), "utf8");
    const calls = [
      ...index.matchAll(/\b(runFirestoreAgentRead|agentCountObjects|agentListObjects|agentDescribeObjects)\(([^,]+),/g),
    ];
    expect(calls.length).toBe(4);
    for (const call of calls) expect(["session.agentClient", "client"], call[0]).toContain(call[2].trim());
    expect(index).toContain("agentClient: createFirestoreAgentClient(client)");
  });
});

/** A server that answers every request shape with a document carrying a marker, so a leak would be seen. */
const SERVER: WireHandler = (request) => {
  if (isProbe(request))
    return jsonAnswer({ name: "projects/demo-studio/databases/(default)", type: "FIRESTORE_NATIVE" });
  if (request.path.endsWith(":listCollectionIds")) return jsonAnswer({ collectionIds: ["users"] });
  if (request.path.endsWith(":runAggregationQuery"))
    return jsonAnswer([{ result: { aggregateFields: { count: { integerValue: "1" } } } }]);
  if (request.path.endsWith(":batchGet"))
    return jsonAnswer([{ found: { name: `${PROVIDER_DOCS}/users/alice`, fields: { m: { stringValue: "marker" } } } }]);
  return jsonAnswer([{ document: { name: `${PROVIDER_DOCS}/users/alice`, fields: { m: { stringValue: "marker" } } } }]);
};

/** Statements an attacker would write, every one of which must send nothing or only a request of the table. */
const STATEMENTS = [
  "db.listCollections()",
  'db.doc("users/alice").listCollections()',
  'db.collection("users").count()',
  'db.collectionGroup("orders").count()',
  'db.collection("users/alice/orders").count()',
  'db.doc("users/alice").get()',
  'db.doc("users/%2e%2e").get()',
  'db.doc("users/a%2Fb").get()',
  'db.doc("users/..").get()',
  'db.doc("users/a\\u0000b").get()',
  'db.collection("users").get()',
  'db.collection("users").select().get()',
  'db.collection("users").limit(1)',
  'db.collection("users").listDocuments()',
  'db.getAll(db.doc("users/alice"))',
  'db.collection("users").where("m", "==", "marker").count()',
  'db.collection("users").orderBy("m").count()',
  'db.collection("users").orderBy("m").startAt("a").count()',
  'db.collection("users").offset(1).count()',
  'db.collection("users").limit(1).count()',
  'db.collection("users").select("m").count()',
  'db.collectionGroup("orders").where("m", "==", 1).count()',
  'db.collection("users").aggregate({ s: AggregateField.sum("m") })',
  'db.collection("users").aggregate({ a: AggregateField.average("m") })',
  'db.collection("users").findNearest({ vectorField: "e", queryVector: [1], limit: 1, distanceMeasure: "COSINE" })',
  'db.collection("users").count().explain({ analyze: true })',
  'db.collection("users").explain()',
  'db.collection("users").doc("alice").set({ admin: true })',
  'db.collection("users").doc("alice").delete()',
  'db.runTransaction(async (t) => t.get(db.doc("users/alice")))',
];

describe("every request an agent-mode handle sends", () => {
  test.each([
    ["the agent read-only profile", { readOnly: true, sendsStatements: true }],
    ["the agent operations profile", { readOnly: true }],
  ] as const)("on %s is a request of the closed agent table", async (_name, execution: ProviderExecutionContext) => {
    const seams = fakeSeams({ answer: wire(SERVER) });
    const firestore = new FirestoreProvider(firestoreConnection(), { queryTimeout: 30_000 }, execution, seams);
    await firestore.connect();
    const budget = {
      statementTimeoutMs: 5_000,
      maxResultRows: 100,
      maxResultBytes: 1_000_000,
      readAllowance: new RunReadAllowance(1_000),
    };
    const answers: unknown[] = [];
    for (const statement of STATEMENTS) {
      answers.push(await firestore.queryReadOnly(statement, budget).catch((error: Error) => error.message));
      answers.push(await firestore.query(statement).catch((error: Error) => error.message));
    }
    const options = { readAllowance: budget.readAllowance };
    answers.push(await firestore.countObjects([], options).catch((error: Error) => error.message));
    answers.push(await firestore.listObjects([], "collection", options).catch((error: Error) => error.message));
    answers.push(await firestore.listObjects([], "document", options).catch((error: Error) => error.message));
    answers.push(await firestore.describeObjects([], "collection", 10, options).catch((error: Error) => error.message));
    answers.push(await firestore.describeObject(["users"], "collection").catch((error: Error) => error.message));
    answers.push(await firestore.readObjectSource(["users/alice"], "document").catch((error: Error) => error.message));
    answers.push(await firestore.scanKeysPage({ cursor: "0", count: 10 }).catch((error: Error) => error.message));
    answers.push(await firestore.getHealth().catch((error: Error) => error.message));
    answers.push(await firestore.getOverview().catch((error: Error) => error.message));
    const sent = requestsOf(seams);
    expect(sent.length).toBeGreaterThan(1);
    expect(outsideTheTable(sent)).toEqual([]);
    expect(JSON.stringify(answers)).not.toContain("marker");
    expect(JSON.stringify(answers)).not.toContain("alice");
  });

  test("a request outside the table is seen", () => {
    const post = (path: string, body: unknown): SentWireRequest => ({
      lane: "api",
      method: "POST",
      path,
      query: new URLSearchParams(),
      body,
      authorization: undefined,
    });
    expect(
      outsideTheTable([
        post(`${DOCUMENTS}:runQuery`, { structuredQuery: { from: [{ collectionId: "users" }] } }),
        post(`${DOCUMENTS}:batchGet`, { documents: [`${PROVIDER_DOCS}/users/alice`] }),
        post(`${DOCUMENTS}:batchGet`, { documents: [`${PROVIDER_DOCS}/users/alice`], mask: { fieldPaths: ["m"] } }),
        post(`${DOCUMENTS}:runAggregationQuery`, {
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId: "users" }], where: { fieldFilter: {} } },
            aggregations: [{ alias: "count", count: { upTo: "2" } }],
          },
        }),
        post(`${DOCUMENTS}:runAggregationQuery`, {
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId: "users" }] },
            aggregations: [{ alias: "count", sum: { field: { fieldPath: "m" } } }],
          },
        }),
        post(`${DOCUMENTS}:runAggregationQuery`, {
          structuredAggregationQuery: {
            structuredQuery: { from: [{ collectionId: "users" }] },
            aggregations: [{ alias: "count", count: {} }],
          },
        }),
        post(`${DOCUMENTS}:commit`, { writes: [] }),
        { ...post(`${DOCUMENTS}/users/alice`, undefined), method: "GET" },
        { ...post(`${DOCUMENTS}/users`, undefined), method: "GET" },
      ]),
    ).toHaveLength(9);
  });
});
