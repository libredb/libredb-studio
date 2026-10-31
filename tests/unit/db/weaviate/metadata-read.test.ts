/**
 * The Weaviate agent read-only profile's own rules (`metadata-read.ts`): the viewer proof, replayed from what 1.40.2
 * answered each principal's `GET /v1/users/own-info` (tests/fixtures/weaviate/1.40.2/agent-boundary/), the metadata-only
 * projection of every agent answer, each fed the captured answers and answers that carry a stored value where only a
 * name, a count or a flag may stand, and the agent's wording of a failure.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  keylessAgentRefusal,
  proveWeaviateViewer,
  readWeaviateViewerProof,
  shapeWeaviateAgentAnswer,
  WEAVIATE_METADATA_ONLY,
  WEAVIATE_OWN_INFO_REQUEST,
  WEAVIATE_PROOF_SENTENCES,
  WEAVIATE_VIEWER_ACTIONS,
  weaviateAgentFailure,
  weaviateProjectionOf,
} from "@/lib/db/providers/vector/weaviate/metadata-read";
import { measureResultBytes } from "@/lib/db/providers/sql/read-only-budget";
import { readWeaviateAgentStatement } from "@/lib/db/providers/vector/weaviate/metadata-request";
import { type WeaviateAnswer, WeaviateError } from "@/lib/db/providers/vector/weaviate/client";
import type { WeaviateAnswered } from "@/lib/db/providers/vector/weaviate/execute";
import type { WeaviatePlan } from "@/lib/db/providers/vector/weaviate/request";
import type { WeaviatePath } from "@/lib/db/providers/vector/weaviate/versions";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { agentAnswer, agentCapture, agentCollectionAnswer } from "../../../helpers/weaviate-agent";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };
const SECRET = "stored-";

function refusal(run: () => void): ExecutionProfileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionProfileError);
    return error as ExecutionProfileError;
  }
  throw new Error("admitted");
}

const json = (value: unknown, status = 200): WeaviateAnswer => ({
  status,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify(value),
});

describe("the viewer proof, from what 1.40.2 answered", () => {
  test("the built-in viewer role is proved: every action it holds is one of the twelve it is measured with", () => {
    expect(() => readWeaviateViewerProof(agentAnswer("own-info-viewer"))).not.toThrow();
    const viewer = JSON.parse(agentCapture("own-info-viewer").body) as {
      roles: { name: string; permissions: { action: string }[] }[];
    };
    expect(viewer.roles.map((role) => role.name)).toEqual(["viewer"]);
    expect(new Set(viewer.roles[0].permissions.map((permission) => permission.action))).toEqual(
      new Set(WEAVIATE_VIEWER_ACTIONS),
    );
    expect([...WEAVIATE_VIEWER_ACTIONS].every((action) => action.startsWith("read_"))).toBe(true);
  });

  const refused: readonly [string, string, string][] = [
    ["own-info-root", "PROFILE_PRIVILEGES_TOO_BROAD", WEAVIATE_PROOF_SENTENCES.widened("create_roles")],
    ["own-info-admin", "PROFILE_PRIVILEGES_TOO_BROAD", WEAVIATE_PROOF_SENTENCES.widened("create_roles")],
    ["own-info-widened", "PROFILE_PRIVILEGES_TOO_BROAD", WEAVIATE_PROOF_SENTENCES.widened("update_data")],
    ["own-info-drift-after", "PROFILE_PRIVILEGES_TOO_BROAD", WEAVIATE_PROOF_SENTENCES.widened("update_data")],
    ["own-info-keyonly", "PROFILE_SERVER_UNENFORCED", WEAVIATE_PROOF_SENTENCES.rbacOff],
    ["own-info-anonymous", "PROFILE_UNSUPPORTED_TARGET", WEAVIATE_PROOF_SENTENCES.status(401)],
    ["own-info-anonymous-open", "PROFILE_UNSUPPORTED_TARGET", WEAVIATE_PROOF_SENTENCES.status(401)],
  ];
  for (const [name, code, message] of refused) {
    test(`${name} is refused`, () => {
      const error = refusal(() => readWeaviateViewerProof(agentAnswer(name)));
      expect(error.reasonCode).toBe(code as ExecutionProfileError["reasonCode"]);
      expect(error.message).toBe(message);
    });
  }

  test("a role widened between two reads: the first read proves, the second refuses", () => {
    expect(() => readWeaviateViewerProof(agentAnswer("own-info-drift-before"))).not.toThrow();
    expect(() => readWeaviateViewerProof(agentAnswer("own-info-drift-after"))).toThrow(ExecutionProfileError);
  });

  const viewer = (over: Record<string, unknown>) =>
    json({
      username: "agent",
      groups: null,
      roles: [{ name: "viewer", permissions: [{ action: "read_data" }] }],
      ...over,
    });
  const unreadable: readonly [string, WeaviateAnswer][] = [
    ["a body that is not JSON", { status: 200, contentType: "text/plain", retryAfter: null, text: "ok" }],
    ["a list", json([])],
    ["roles that are not a list", viewer({ roles: { viewer: true } })],
    ["a role that is not an object", viewer({ roles: ["viewer"] })],
    ["a role with no permission list", viewer({ roles: [{ name: "viewer" }] })],
    ["a permission that is not an object", viewer({ roles: [{ name: "v", permissions: ["read_data"] }] })],
    ["an action that is not text", viewer({ roles: [{ name: "v", permissions: [{ action: 7 }] }] })],
    ["groups that are not a list", viewer({ groups: "admins" })],
  ];
  for (const [what, answer] of unreadable) {
    test(`${what} is unread, and refuses`, () => {
      const error = refusal(() => readWeaviateViewerProof(answer));
      expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
      expect(error.message).toBe(WEAVIATE_PROOF_SENTENCES.unreadable);
    });
  }

  test("roles absent, as RBAC off may answer, refuses as the server not enforcing", () => {
    expect(refusal(() => readWeaviateViewerProof(json({ username: "x" }))).reasonCode).toBe(
      "PROFILE_SERVER_UNENFORCED",
    );
  });

  test("no role at all refuses", () => {
    expect(refusal(() => readWeaviateViewerProof(viewer({ roles: [] }))).message).toBe(WEAVIATE_PROOF_SENTENCES.noRole);
  });

  test("an OIDC group, whose roles the answer does not list, refuses; an empty group list does not", () => {
    expect(refusal(() => readWeaviateViewerProof(viewer({ groups: ["readers"] }))).message).toBe(
      WEAVIATE_PROOF_SENTENCES.groups,
    );
    expect(() => readWeaviateViewerProof(viewer({ groups: [] }))).not.toThrow();
    expect(() => readWeaviateViewerProof(viewer({ groups: undefined }))).not.toThrow();
  });

  test("an action Studio does not know is refused without being shown", () => {
    const answer = viewer({ roles: [{ name: "v", permissions: [{ action: "Stored-Value <x>" }] }] });
    const error = refusal(() => readWeaviateViewerProof(answer));
    expect(error.message).toBe(WEAVIATE_PROOF_SENTENCES.unknownAction);
    expect(error.message).not.toContain("Stored-Value");
  });

  test("a second role that writes refuses, whatever the first holds", () => {
    const answer = viewer({
      roles: [
        { name: "viewer", permissions: [{ action: "read_data" }] },
        { name: "writer", permissions: [{ action: "read_data" }, { action: "create_data" }] },
      ],
    });
    expect(refusal(() => readWeaviateViewerProof(answer)).message).toBe(
      WEAVIATE_PROOF_SENTENCES.widened("create_data"),
    );
  });

  test("a status other than 200 refuses, naming the status only", () => {
    const answer = json({ error: [{ message: "stored-value" }] }, 403);
    const error = refusal(() => readWeaviateViewerProof(answer));
    expect(error.message).toBe(WEAVIATE_PROOF_SENTENCES.status(403));
  });

  test("the proof sends the key's own record, with nothing the caller chose", async () => {
    const sent: unknown[] = [];
    const signal = new AbortController().signal;
    await proveWeaviateViewer(async (request, read) => {
      sent.push(request, read);
      return agentAnswer("own-info-viewer");
    }, signal);
    expect(sent).toEqual([{ op: "own_info", params: {}, query: {} }, signal]);
    expect(WEAVIATE_OWN_INFO_REQUEST).toEqual({ op: "own_info", params: {}, query: {} });
    expect(Object.isFrozen(WEAVIATE_OWN_INFO_REQUEST)).toBe(true);
  });

  test("a connection with no key is refused as a server that cannot say who reads", () => {
    const error = keylessAgentRefusal();
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(WEAVIATE_PROOF_SENTENCES.keyless);
  });
});

function planOf(text: string): WeaviatePlan {
  const reading = readWeaviateAgentStatement(text);
  if (!reading.ok) throw new Error(reading.message);
  return reading.plan;
}

function answered(text: string, answer: WeaviateAnswer | string, path: WeaviatePath | null = null): WeaviateAnswered {
  return {
    plan: planOf(text),
    text: typeof answer === "string" ? answer : answer.text,
    path,
    executionTime: 7,
  };
}

const shape = (text: string, answer: WeaviateAnswer | string, path: WeaviatePath | null = null) =>
  shapeWeaviateAgentAnswer(answered(text, answer, path), BUDGET, text);

describe("the metadata-only projections, over what 1.40.2 answered a viewer", () => {
  test("the meta read: the version and how many modules, never a module's settings or the host name", () => {
    const result = shape("GET /v1/meta", agentAnswer("meta-viewer"));
    expect(result.fields).toEqual(["version", "modules"]);
    expect(result.rows).toEqual([{ version: "1.40.2", modules: expect.any(Number) }]);
    expect(result.rows[0].modules as number).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("hostname");
    expect(result.executionTime).toBe(7);
  });

  test("the schema: one row per collection, no description, module setting or base URL", () => {
    const result = shape("GET /v1/schema", agentAnswer("schema-viewer"));
    expect(result.fields).toEqual([
      "collection",
      "vectorizer",
      "properties",
      "named_vectors",
      "multi_tenant",
      "auto_tenant_activation",
      "replication_factor",
    ]);
    const byName = Object.fromEntries(result.rows.map((row) => [row.collection, row]));
    expect(byName.Note).toEqual({
      collection: "Note",
      vectorizer: "none",
      properties: 3,
      named_vectors: 0,
      multi_tenant: false,
      auto_tenant_activation: false,
      replication_factor: 1,
    });
    expect(byName.Doc.vectorizer).toBe("text2vec-openai");
    expect(byName.Tenanted).toMatchObject({ multi_tenant: true, auto_tenant_activation: true });
    expect(byName.TenantedManual).toMatchObject({ multi_tenant: true, auto_tenant_activation: false });
    expect(JSON.stringify(result)).not.toContain("egress");
  });

  test("an empty schema answers no row", () => {
    expect(shape("GET /v1/schema", json({ classes: null })).rows).toEqual([]);
    expect(shape("GET /v1/schema", json({})).rows).toEqual([]);
  });

  test("one collection: one row per property, nested ones as parent.child, a property named objectCount a name", () => {
    const result = shape("GET /v1/schema/Note", agentCollectionAnswer("Note"));
    expect(result.fields).toEqual(["property", "data_type", "tokenization", "filterable", "searchable"]);
    expect(result.rows.map((row) => [row.property, row.data_type])).toEqual([
      ["body", "text"],
      ["objectCount", "text"],
      ["meta", "object"],
      ["meta.name", "text"],
    ]);
    expect(result.rows[0]).toEqual({
      property: "body",
      data_type: "text",
      tokenization: "word",
      filterable: true,
      searchable: true,
    });
  });

  test("shards, tenants, one tenant, aliases and one alias", () => {
    expect(shape("GET /v1/schema/Note/shards", agentAnswer("shards-viewer")).rows).toEqual([
      { shard: expect.any(String), status: "READY", vector_queue_size: 0 },
    ]);
    const tenants = shape("GET /v1/schema/Tenanted/tenants", agentAnswer("tenants-viewer")).rows;
    expect(tenants).toHaveLength(2);
    expect(tenants).toEqual(
      expect.arrayContaining([
        { tenant: "hot", status: "HOT" },
        { tenant: "cold", status: "COLD" },
      ]),
    );
    expect(shape("GET /v1/schema/Tenanted/tenants/hot", agentAnswer("tenant-viewer")).rows).toEqual([
      { tenant: "hot", status: "HOT" },
    ]);
    expect(shape("GET /v1/aliases", agentAnswer("aliases-viewer")).rows).toEqual([
      { alias: "NotesAlias", collection: "Note" },
    ]);
    expect(shape("GET /v1/aliases/NotesAlias", agentAnswer("alias-viewer")).rows).toEqual([
      { alias: "NotesAlias", collection: "Note" },
    ]);
  });

  test("nodes: one row per node, and per shard where the read asks for verbose output", () => {
    const minimal = JSON.parse(agentCapture("nodes-viewer").body) as { nodes: Record<string, unknown>[] };
    const nodes = shape("GET /v1/nodes", json({ nodes: minimal.nodes.map(({ shards: _shards, ...node }) => node) }));
    expect(nodes.fields).toEqual(["node", "status", "version", "objects", "shards"]);
    expect(nodes.rows).toEqual([{ node: "node1", status: "HEALTHY", version: "1.40.2", objects: 0, shards: 4 }]);
    const verbose = shape("GET /v1/nodes/Note?output=verbose", agentAnswer("collection-nodes-viewer"));
    expect(verbose.fields).toEqual(["node", "collection", "shard", "objects", "vector_indexing_status", "loaded"]);
    expect(verbose.rows).toEqual([
      {
        node: "node1",
        collection: "Note",
        shard: expect.any(String),
        objects: 0,
        vector_indexing_status: "READY",
        loaded: true,
      },
    ]);
    expect(shape("GET /v1/nodes?output=verbose", json({ nodes: [{ name: "n" }] })).rows).toEqual([]);
  });

  test("an aggregate: the collection, the tenant and the count, over REST and over GraphQL", () => {
    expect(shape("POST /v1/aggregate/Note", agentAnswer("aggregate-viewer"), "rest").rows).toEqual([
      { collection: "Note", tenant: null, count: 3 },
    ]);
    expect(shape('POST /v1/aggregate/Tenanted {"tenant": "hot"}', agentAnswer("wake-aggregate"), "rest").rows).toEqual([
      { collection: "Tenanted", tenant: "hot", count: 1 },
    ]);
    expect(shape("POST /v1/aggregate/Note", agentAnswer("graphql-viewer"), "graphql").rows).toEqual([
      { collection: "Note", tenant: null, count: 3 },
    ]);
  });

  test("which projection each agent operation takes", () => {
    expect(weaviateProjectionOf(planOf("GET /v1/schema/Tenanted/tenants/hot"))).toBe("tenants");
    expect(weaviateProjectionOf(planOf("GET /v1/aliases/A"))).toBe("aliases");
    expect(weaviateProjectionOf(planOf("GET /v1/nodes"))).toBe("nodes");
    expect(weaviateProjectionOf(planOf("GET /v1/nodes/Note?output=verbose"))).toBe("node-shards");
    expect(weaviateProjectionOf(planOf("GET /v1/schema"))).toBe("schema");
  });

  test("the capability states every projection, column by column", () => {
    expect(Object.keys(WEAVIATE_METADATA_ONLY)).toEqual([
      "meta",
      "schema",
      "collection",
      "shards",
      "tenants",
      "aliases",
      "nodes",
      "node-shards",
      "aggregate",
    ]);
    expect(WEAVIATE_METADATA_ONLY.aggregate).toEqual([
      { column: "collection", kind: "name" },
      { column: "tenant", kind: "name" },
      { column: "count", kind: "count" },
    ]);
  });
});

describe("a stored value reaches no row, column name or nested cell", () => {
  const withheld = (text: string, answer: WeaviateAnswer, path: WeaviatePath | null = null) => {
    let thrown: unknown;
    try {
      shape(text, answer, path);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(QueryError);
    expect((thrown as Error).message).not.toContain(SECRET);
    return (thrown as Error).message;
  };

  test("extra keys a server adds beside the facts are dropped, whatever they are named", () => {
    const result = shape(
      "GET /v1/schema",
      json({
        classes: [
          {
            class: "Note",
            description: "stored-description",
            moduleConfig: { "text2vec-openai": { baseURL: "http://stored-host" } },
            properties: [{ name: "body", description: "stored-property-description" }],
            "stored-key": "stored-value",
          },
        ],
      }),
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.fields).not.toContain("stored-key");
  });

  test("a value smuggled into a name as an object, a list or a number withholds the answer", () => {
    expect(withheld("GET /v1/schema", json({ classes: [{ class: { value: "stored-x" } }] }))).toContain('"collection"');
    expect(withheld("GET /v1/schema", json({ classes: [{ class: "Note", vectorizer: ["stored-x"] }] }))).toContain(
      '"vectorizer"',
    );
    expect(withheld("GET /v1/schema/Tenanted/tenants", json([{ name: "t", activityStatus: { v: "stored-x" } }])));
  });

  test("a count that holds text, a vector or a nested object withholds the answer", () => {
    withheld("POST /v1/aggregate/Note", json({ count: "stored-value" }), "rest");
    withheld("POST /v1/aggregate/Note", json({ count: [0.1, 0.2, 0.3] }), "rest");
    withheld("POST /v1/aggregate/Note", json({ count: { stored: "stored-value" } }), "rest");
    withheld("GET /v1/nodes", json({ nodes: [{ name: "n", status: "HEALTHY", stats: { objectCount: "stored-v" } }] }));
  });

  test("a name past one line withholds the answer: a stored text block is not a name", () => {
    withheld("GET /v1/aliases", json({ aliases: [{ alias: "a\nstored-value", class: "Note" }] }));
  });

  test("a nested property definition that is not an object, or nests past 32 levels, withholds the answer", () => {
    withheld(
      "GET /v1/schema/Note",
      json({ class: "Note", properties: [{ name: "a", nestedProperties: ["stored-x"] }] }),
    );
    withheld("GET /v1/schema/Note", json({ class: "Note", properties: [{ name: 7 }] }));
    let deep: Record<string, unknown> = { name: "leaf", dataType: ["text"] };
    for (let level = 0; level < 33; level += 1)
      deep = { name: `l${level}`, dataType: ["object"], nestedProperties: [deep] };
    withheld("GET /v1/schema/Note", json({ class: "Note", properties: [deep] }));
    withheld("GET /v1/schema/Note", json({ class: "Note", properties: [{ name: "a", dataType: [{ v: "stored" }] }] }));
  });

  const shapes: readonly [string, WeaviateAnswer, WeaviatePath | null][] = [
    ["GET /v1/meta", { status: 200, contentType: null, retryAfter: null, text: "stored-text" }, null],
    ["GET /v1/meta", json(["stored-x"]), null],
    ["GET /v1/schema/Note/shards", json({ shards: "stored-x" }), null],
    ["GET /v1/aliases", json({ aliases: "stored-x" }), null],
    ["GET /v1/nodes", json({ nodes: [["stored-x"]] }), null],
    ["POST /v1/aggregate/Note", json([{ count: 1 }]), "rest"],
    ["POST /v1/aggregate/Note", json({ data: { Aggregate: { Note: [] } } }), "graphql"],
    ["POST /v1/aggregate/Note", json({ data: { Aggregate: { Note: [{}, {}] } } }), "graphql"],
  ];
  for (const [text, answer, path] of shapes) {
    test(`an answer to ${text} in a shape Studio does not read is withheld (${answer.text.slice(0, 30)})`, () => {
      expect(withheld(text, answer, path)).toBe(
        "Weaviate's answer is not in the shape Studio reads for this request, so it was withheld from agent mode.",
      );
    });
  }

  test("a vector in the aggregate GraphQL answer's count place withholds it", () => {
    withheld(
      "POST /v1/aggregate/Note",
      json({ data: { Aggregate: { Note: [{ meta: { count: [0.1, 0.2] } }] } } }),
      "graphql",
    );
  });
});

describe("the budgets", () => {
  test("rows past the row budget are refused, never cut", () => {
    expect(() =>
      shapeWeaviateAgentAnswer(
        answered("GET /v1/schema/Tenanted/tenants", agentAnswer("tenants-viewer")),
        {
          ...BUDGET,
          maxResultRows: 1,
        },
        "GET /v1/schema/Tenanted/tenants",
      ),
    ).toThrow("Read-only execution exceeded the row budget: 2 rows > 1 allowed");
  });

  test("bytes past the byte budget are refused, never cut", () => {
    expect(() =>
      shapeWeaviateAgentAnswer(
        answered("GET /v1/schema/Tenanted/tenants", agentAnswer("tenants-viewer")),
        {
          ...BUDGET,
          maxResultBytes: 10,
        },
        "GET /v1/schema/Tenanted/tenants",
      ),
    ).toThrow(/^Read-only execution exceeded the byte budget: \d+ bytes > 10 allowed$/);
  });

  test("an answer of exactly the byte budget is kept, and one byte less refuses it", () => {
    const text = "GET /v1/schema/Tenanted/tenants";
    const shaped = (maxResultBytes: number) =>
      shapeWeaviateAgentAnswer(answered(text, agentAnswer("tenants-viewer")), { ...BUDGET, maxResultBytes }, text);
    const bytes = measureResultBytes(shaped(BUDGET.maxResultBytes).rows);
    expect(shaped(bytes).rowCount).toBe(2);
    expect(() => shaped(bytes - 1)).toThrow(
      `Read-only execution exceeded the byte budget: ${bytes} bytes > ${bytes - 1} allowed`,
    );
  });
});

describe("the agent's wording of a failure", () => {
  test("a server refusal is its status and category, never the server's words", () => {
    const error = weaviateAgentFailure(new WeaviateError("forbidden", "stored-value in a message", 403), BUDGET, "s");
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toBe(
      "Weaviate answered HTTP 403 (forbidden). The server's own words are not passed on to agent mode, whose answers carry metadata only.",
    );
  });

  test("a transport timeout and a deadline are the time budget's refusal", () => {
    expect(weaviateAgentFailure(new TransportError("timeout", "late"), BUDGET, "s")?.message).toBe(
      "Read-only execution exceeded the time budget: no answer within 5000ms",
    );
    expect(weaviateAgentFailure(new TimeoutError("late"), BUDGET, "s")?.message).toBe(
      "Read-only execution exceeded the time budget: no answer within 5000ms",
    );
  });

  test("anything else is left to the provider's own table", () => {
    expect(weaviateAgentFailure(new TransportError("network", "reset"), BUDGET, "s")).toBeUndefined();
    expect(weaviateAgentFailure(new Error("x"), BUDGET, "s")).toBeUndefined();
  });
});
