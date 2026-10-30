/**
 * WeaviateProvider under the agent read-only profile, through the real REST client and a recording transport, so every
 * request line and body is the one Studio would put on the wire, answered from what 1.40.2 answered the same request
 * (tests/fixtures/weaviate/1.40.2/agent-boundary/): a connection with no key refused before any client is built, the
 * viewer proof at the open and again before every request, the metadata-only answer, every operation outside the
 * metadata table refused before the network, a COLD tenant refused rather than woken, a server refusal worded without
 * the server's words, and the budgets. The operations profile and an editor handle open as before and are refused
 * `queryReadOnly`.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import { WEAVIATE_PROOF_SENTENCES } from "@/lib/db/providers/vector/weaviate/metadata-read";
import { WEAVIATE_AGENT_SENTENCES } from "@/lib/db/providers/vector/weaviate/metadata-request";
import type { WeaviateAnswer } from "@/lib/db/providers/vector/weaviate/client";
import { WeaviateProvider } from "@/lib/db/providers/vector/weaviate/index";
import { createRestWeaviateClient } from "@/lib/db/providers/vector/weaviate/rest-client";
import type { DatabaseConnection, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { agentAnswer, agentCollectionAnswer, agentServer } from "../../../helpers/weaviate-agent";
import { rejection, WEAVIATE_TEST_CONNECTION } from "../../../helpers/weaviate-surface";
import { type RecordedAnswer, recordingWeaviateTransport } from "../../../helpers/weaviate-wire";

const KEY = "not-a-real-key";
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };
const STORED = /stored-|doc-1|tenant-(hot|cold)|0\.4/;

function agentProvider(
  answer: RecordedAnswer,
  execution: ProviderExecutionContext = AGENT,
  connection: Partial<DatabaseConnection> = { password: KEY },
) {
  const wire = recordingWeaviateTransport(answer);
  const provider = new WeaviateProvider(
    { ...WEAVIATE_TEST_CONNECTION, ...connection } as DatabaseConnection,
    {},
    execution,
    (options, routes) => createRestWeaviateClient(options, routes, wire.factory),
  );
  return { provider, wire };
}

const lines = (wire: ReturnType<typeof recordingWeaviateTransport>) => wire.calls.map((call) => call.method);

async function connected(answer: RecordedAnswer = agentServer("viewer")) {
  const made = agentProvider(answer);
  await made.provider.connect();
  made.wire.calls.length = 0;
  return made;
}

describe("the open, under the agent read-only profile", () => {
  test("a connection with no key is refused before any client is built or anything sent", async () => {
    const { provider, wire } = agentProvider(agentServer("viewer"), AGENT, {});
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect((error as Error).message).toBe(WEAVIATE_PROOF_SENTENCES.keyless);
    expect(wire.built).toEqual([]);
    expect(wire.calls).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("a viewer's key: the meta read, then the key's own record, and one Authorization header and no other", async () => {
    const { provider, wire } = agentProvider(agentServer("viewer"));
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(wire.calls).toEqual([
      { method: "GET /v1/meta", args: [null] },
      { method: "GET /v1/users/own-info", args: [null] },
    ]);
    expect(wire.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:8080/v1/meta",
      "http://127.0.0.1:8080/v1/users/own-info",
    ]);
    expect(wire.built).toHaveLength(1);
    expect(wire.built[0].headers).toEqual({ authorization: `Bearer ${KEY}` });
  });

  const refused: readonly [string, string][] = [
    ["root", "create_roles"],
    ["admin", "create_roles"],
    ["widened", "update_data"],
  ];
  for (const [principal, action] of refused) {
    test(`the ${principal} key is refused at the open, and the client is closed`, async () => {
      const { provider, wire } = agentProvider(agentServer(principal, { "GET /v1/meta": agentAnswer("meta-viewer") }));
      const error = await rejection(provider.connect());
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as Error).message).toBe(WEAVIATE_PROOF_SENTENCES.widened(action));
      expect(provider.isConnected()).toBe(false);
      expect(wire.closed()).toBe(1);
    });
  }

  test("a key on a server with RBAC off is refused at the open", async () => {
    const { provider } = agentProvider(
      agentServer("viewer", { "GET /v1/users/own-info": agentAnswer("own-info-keyonly") }),
    );
    const error = await rejection(provider.connect());
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
  });

  test("a transport failure of the proof is worded by the provider's table", async () => {
    const { provider } = agentProvider((request, line) => {
      if (line === "GET /v1/users/own-info") throw new Error("socket closed");
      return agentServer("viewer")(request, line);
    });
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe("The request to Weaviate failed in a way Studio does not recognise.");
  });

  test("the operations profile opens with no key and no proof, and answers no agent request", async () => {
    const { provider, wire } = agentProvider(agentServer("viewer"), OPERATIONS, {});
    await provider.connect();
    expect(lines(wire)).toEqual(["GET /v1/meta"]);
    const error = await rejection(provider.queryReadOnly("GET /v1/meta", BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(lines(wire)).toEqual(["GET /v1/meta"]);
  });

  test("an editor handle answers no agent request either", async () => {
    const { provider, wire } = agentProvider(agentServer("viewer"), {});
    await provider.connect();
    await expect(provider.queryReadOnly("GET /v1/meta", BUDGET)).rejects.toBeInstanceOf(RefusedBeforeSendError);
    expect(lines(wire)).toEqual(["GET /v1/meta"]);
  });
});

describe("one agent request", () => {
  test("the meta read: the key proved again, then the request, its answer projected", async () => {
    const { provider, wire } = await connected();
    const result = await provider.queryReadOnly("GET /v1/meta", BUDGET);
    expect(lines(wire)).toEqual(["GET /v1/users/own-info", "GET /v1/meta"]);
    expect(result.fields).toEqual(["version", "modules"]);
    expect(result.rows).toEqual([{ version: "1.40.2", modules: expect.any(Number) }]);
    expect(result.rowCount).toBe(1);
  });

  const reads: readonly [string, string[], string[]][] = [
    ["GET /v1/schema", ["GET /v1/schema"], ["collection"]],
    ["GET /v1/schema/Note", ["GET /v1/schema/Note"], ["property"]],
    ["GET /v1/schema/Note/shards", ["GET /v1/schema/Note", "GET /v1/schema/Note/shards"], ["shard"]],
    ["GET /v1/schema/Tenanted/tenants", ["GET /v1/schema/Tenanted", "GET /v1/schema/Tenanted/tenants"], ["tenant"]],
    [
      "GET /v1/schema/Tenanted/tenants/hot",
      ["GET /v1/schema/Tenanted", "GET /v1/schema/Tenanted/tenants/hot"],
      ["tenant"],
    ],
    ["GET /v1/aliases", ["GET /v1/aliases"], ["alias"]],
    ["GET /v1/aliases/NotesAlias", ["GET /v1/aliases/NotesAlias"], ["alias"]],
    ["GET /v1/nodes?output=verbose", ["GET /v1/nodes?output=verbose"], ["node", "collection", "shard"]],
    [
      "GET /v1/nodes/Note?output=verbose",
      ["GET /v1/schema/Note", "GET /v1/nodes/Note?output=verbose"],
      ["node", "collection", "shard"],
    ],
    [
      "POST /v1/aggregate/Note {}",
      ["GET /v1/schema/Note", "POST /v1/aggregate/Note"],
      ["collection", "tenant", "count"],
    ],
  ];
  for (const [text, sent, leading] of reads) {
    test(`${text}: exactly ${sent.join(", ")} after the proof, and no stored value in the answer`, async () => {
      const server = agentServer("viewer", {
        "GET /v1/schema/Note": agentCollectionAnswer("Note"),
        "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
      });
      const { provider, wire } = await connected(server);
      const result = await provider.queryReadOnly(text, BUDGET);
      expect(lines(wire)).toEqual(["GET /v1/users/own-info", ...sent]);
      expect(result.fields.slice(0, leading.length)).toEqual(leading);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toMatch(STORED);
    });
  }

  test("the aggregate's body on the wire is the one the console writes, and a count comes back", async () => {
    const { provider, wire } = await connected(
      agentServer("viewer", { "GET /v1/schema/Note": agentCollectionAnswer("Note") }),
    );
    const result = await provider.queryReadOnly('POST /v1/aggregate/Note {"returnMetrics": ["count"]}', BUDGET);
    expect(wire.calls.at(-1)).toEqual({ method: "POST /v1/aggregate/Note", args: ['{"returnMetrics":["count"]}'] });
    expect(result.rows).toEqual([{ collection: "Note", tenant: null, count: 3 }]);
  });

  test("a role widened since the last request is refused at the next one, and the request is not sent", async () => {
    let ownInfo = agentAnswer("own-info-drift-before");
    const { provider, wire } = await connected(agentServer("viewer", { "GET /v1/users/own-info": () => ownInfo }));
    await provider.queryReadOnly("GET /v1/meta", BUDGET);
    ownInfo = agentAnswer("own-info-drift-after");
    wire.calls.length = 0;
    const error = await rejection(provider.queryReadOnly("GET /v1/meta", BUDGET));
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toBe(WEAVIATE_PROOF_SENTENCES.widened("update_data"));
    expect(lines(wire)).toEqual(["GET /v1/users/own-info"]);
    ownInfo = agentAnswer("own-info-viewer");
    await provider.queryReadOnly("GET /v1/meta", BUDGET);
  });

  const beforeTheNetwork: readonly [string, string][] = [
    ["GET /v1/objects?class=Note&include=vector", WEAVIATE_AGENT_SENTENCES.metadataOnly("GET /v1/objects")],
    [
      "GET /v1/objects/Note/00000000-0000-4000-8000-000000000001",
      WEAVIATE_AGENT_SENTENCES.metadataOnly("GET /v1/objects/{collection}/{id}"),
    ],
    [
      'POST /v1/search/Note/bm25 {"query": "stored"}',
      WEAVIATE_AGENT_SENTENCES.metadataOnly("POST /v1/search/{collection}/bm25"),
    ],
    [
      'POST /v1/search/Doc/hybrid {"query": "doc", "alpha": 0}',
      WEAVIATE_AGENT_SENTENCES.metadataOnly("POST /v1/search/{collection}/hybrid"),
    ],
    [
      'POST /v1/search/Note/near-vector {"vector": [0.1, 0.2, 0.3, 0.4]}',
      WEAVIATE_AGENT_SENTENCES.metadataOnly("POST /v1/search/{collection}/near-vector"),
    ],
    [
      'POST /v1/search/Doc/near-object {"id": "00000000-0000-4000-8000-000000000011"}',
      WEAVIATE_AGENT_SENTENCES.metadataOnly("POST /v1/search/{collection}/near-object"),
    ],
    ['POST /v1/aggregate/Note {"groupBy": "body"}', WEAVIATE_AGENT_SENTENCES.aggregateShape("groupBy")],
    [
      'POST /v1/aggregate/Note {"where": {"operator": "Equal", "path": ["body"], "valueText": "stored-body-1"}}',
      WEAVIATE_AGENT_SENTENCES.aggregateShape("where"),
    ],
  ];
  for (const [text, message] of beforeTheNetwork) {
    test(`${text.split(" {")[0]} is refused before the proof or anything else is sent`, async () => {
      const { provider, wire } = await connected();
      const error = await rejection(provider.queryReadOnly(text, BUDGET));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect((error as Error).message).toBe(message);
      expect(wire.calls).toEqual([]);
    });
  }

  const egress = [
    'POST /v1/search/Doc/hybrid {"query": "doc", "alpha": 0.5}',
    'POST /v1/search/Doc/near-text {"query": ["doc"]}',
    'POST /v1/graphql {"query": "{ Get { Doc(nearText: {concepts: [\\"doc\\"]}) { body } } }"}',
    'POST /v1/search/Doc/bm25 {"query": "doc", "singlePrompt": "say {body}"}',
    'POST /v1/search/Doc/bm25 {"query": "doc", "rerank": {"property": "body"}}',
    "POST /v1/objects {}",
    "DELETE /v1/schema/Note",
    "PUT /v1/schema/Tenanted/tenants []",
    "POST /v1/backups/filesystem {}",
    "GET /v1/users/own-info",
  ];
  for (const text of egress) {
    test(`${text.split(" {")[0].split(" [")[0]}, a module call, a write or a route outside the table, sends nothing`, async () => {
      const { provider, wire } = await connected();
      const error = await rejection(provider.queryReadOnly(text, BUDGET));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect(wire.calls).toEqual([]);
    });
  }

  test("a COLD tenant is refused rather than woken: its own record is read, and the count is never sent", async () => {
    const { provider, wire } = await connected(
      agentServer("viewer", {
        "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
        "GET /v1/schema/Tenanted/tenants/cold": agentAnswer("wake-record-before"),
      }),
    );
    const error = await rejection(provider.queryReadOnly('POST /v1/aggregate/Tenanted {"tenant": "cold"}', BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      'The tenant "cold" is COLD. Studio does not activate a tenant by reading it, so nothing was read: set the tenant HOT on the server first.',
    );
    expect(lines(wire)).toEqual([
      "GET /v1/users/own-info",
      "GET /v1/schema/Tenanted",
      "GET /v1/schema/Tenanted/tenants/cold",
    ]);
  });

  test("a COLD tenant's shard read, which wakes it on 1.40.2, is refused the same way", async () => {
    const { provider, wire } = await connected(
      agentServer("viewer", {
        "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
        "GET /v1/schema/Tenanted/tenants/cold": agentAnswer("wake-record-before"),
      }),
    );
    await expect(provider.queryReadOnly("GET /v1/schema/Tenanted/shards?tenant=cold", BUDGET)).rejects.toThrow(
      "is COLD",
    );
    expect(lines(wire)).not.toContain("GET /v1/schema/Tenanted/shards?tenant=cold");
  });

  test("on 1.40.2 a shard read naming no tenant wakes a COLD one, while the node reads do not", () => {
    const status = (name: string) => (JSON.parse(agentAnswer(name).text) as { activityStatus: string }).activityStatus;
    expect(status("wake-record-after-shards-no-tenant")).toBe("HOT");
    expect(agentAnswer("wake-aggregate-no-tenant").status).toBe(422);
    expect(status("wake-record-after-aggregate-no-tenant")).toBe("COLD");
    expect(status("wake-record-after-collection-nodes")).toBe("COLD");
    expect(status("wake-record-after-nodes")).toBe("COLD");
  });

  const tenantless: readonly [string, string][] = [
    ["GET /v1/schema/Tenanted/shards", "(?tenant=...)"],
    ["POST /v1/aggregate/Tenanted {}", '("tenant": "...")'],
  ];
  for (const [text, hint] of tenantless) {
    test(`a multi-tenant collection's ${text.split(" ")[0]} naming no tenant is refused after the collection read alone`, async () => {
      const { provider, wire } = await connected(
        agentServer("viewer", {
          "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
          "GET /v1/schema/Tenanted/shards": agentAnswer("wake-shards-no-tenant"),
          "POST /v1/aggregate/Tenanted": agentAnswer("wake-aggregate-no-tenant"),
        }),
      );
      const error = await rejection(provider.queryReadOnly(text, BUDGET));
      expect((error as Error).message).toContain(
        `The collection "Tenanted" is multi-tenant, so the request needs a tenant ${hint}. Nothing was read`,
      );
      expect(lines(wire)).toEqual(["GET /v1/users/own-info", "GET /v1/schema/Tenanted"]);
    });
  }

  test("a HOT tenant is counted after its record is read", async () => {
    const { provider, wire } = await connected(
      agentServer("viewer", {
        "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
        "POST /v1/aggregate/Tenanted": agentAnswer("wake-aggregate"),
      }),
    );
    const result = await provider.queryReadOnly('POST /v1/aggregate/Tenanted {"tenant": "hot"}', BUDGET);
    expect(lines(wire)).toEqual([
      "GET /v1/users/own-info",
      "GET /v1/schema/Tenanted",
      "GET /v1/schema/Tenanted/tenants/hot",
      "POST /v1/aggregate/Tenanted",
    ]);
    expect(wire.calls.at(-1)?.args).toEqual(['{"tenant":"hot"}']);
    expect(result.rows).toEqual([{ collection: "Tenanted", tenant: "hot", count: 1 }]);
  });

  test("a server refusal is worded without the server's words", async () => {
    const forbidden: WeaviateAnswer = {
      status: 403,
      contentType: "application/json",
      retryAfter: null,
      text: JSON.stringify({ error: [{ message: "rbac: authorization, forbidden action: stored-value-echoed" }] }),
    };
    const { provider } = await connected(agentServer("viewer", { "GET /v1/aliases": forbidden }));
    const error = await rejection(provider.queryReadOnly("GET /v1/aliases", BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "Weaviate answered HTTP 403 (forbidden). The server's own words are not passed on to agent mode, whose answers carry metadata only.",
    );
  });

  test("a stored value where a name stands withholds the whole answer", async () => {
    const smuggled: WeaviateAnswer = {
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: JSON.stringify({ aliases: [{ alias: { value: "stored-secret" }, class: "Note" }] }),
    };
    const { provider } = await connected(agentServer("viewer", { "GET /v1/aliases": smuggled }));
    const error = await rejection(provider.queryReadOnly("GET /v1/aliases", BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).not.toContain("stored-secret");
  });

  test("a transport failure of the request is worded by the provider's table", async () => {
    const { provider } = await connected((request, line) => {
      if (line === "GET /v1/aliases") throw new Error("socket closed");
      return agentServer("viewer")(request, line);
    });
    await expect(provider.queryReadOnly("GET /v1/aliases", BUDGET)).rejects.toThrow(
      "The request to Weaviate failed in a way Studio does not recognise.",
    );
  });

  test("the proof and the request share one deadline: past it, the time budget's refusal", async () => {
    const { provider } = await connected((request, line) => {
      if (line !== "GET /v1/aliases") return agentServer("viewer")(request, line);
      return new Promise<NodeResponse>((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    });
    await expect(provider.queryReadOnly("GET /v1/aliases", { ...BUDGET, statementTimeoutMs: 30 })).rejects.toThrow(
      "Read-only execution exceeded the time budget: no answer within 30ms",
    );
  });

  test("an estimating plan is refused, as is a budget that is no budget", async () => {
    const { provider, wire } = await connected();
    await expect(provider.queryReadOnly("GET /v1/meta", BUDGET, "estimate-plan")).rejects.toThrow(
      "Weaviate composes no estimating plan for the agent",
    );
    await expect(provider.queryReadOnly("GET /v1/meta", { ...BUDGET, maxResultRows: 0 })).rejects.toThrow();
    expect(wire.calls).toEqual([]);
  });

  test("rows past the row budget are refused, never cut", async () => {
    const { provider } = await connected(
      agentServer("viewer", { "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted") }),
    );
    await expect(
      provider.queryReadOnly("GET /v1/schema/Tenanted/tenants", { ...BUDGET, maxResultRows: 1 }),
    ).rejects.toThrow("Read-only execution exceeded the row budget: 2 rows > 1 allowed");
  });

  test("an aggregate on a server with no REST search goes over GraphQL, and the count is projected", async () => {
    const { provider, wire } = await connected(
      agentServer("viewer", {
        "GET /v1/meta": {
          status: 200,
          contentType: "application/json",
          retryAfter: null,
          text: '{"version":"1.37.4"}',
        },
        "GET /v1/schema/Note": agentCollectionAnswer("Note"),
        "POST /v1/graphql": agentAnswer("graphql-viewer"),
      }),
    );
    wire.calls.length = 0;
    const result = await provider.queryReadOnly("POST /v1/aggregate/Note", BUDGET);
    expect(lines(wire)).toEqual(["GET /v1/users/own-info", "GET /v1/schema/Note", "POST /v1/graphql"]);
    expect(result.rows).toEqual([{ collection: "Note", tenant: null, count: 3 }]);
  });
});

describe("no state is kept between agent requests", () => {
  test("a path one request fell back to is not remembered: the next request tries REST first again", async () => {
    const { provider, wire } = await connected(
      agentServer("viewer", {
        "GET /v1/schema/Note": agentCollectionAnswer("Note"),
        "POST /v1/aggregate/Note": {
          status: 404,
          contentType: "application/json",
          retryAfter: null,
          text: JSON.stringify({ code: 404, message: "path /v1/aggregate/Note was not found" }),
        },
        "POST /v1/graphql": agentAnswer("graphql-viewer"),
      }),
    );
    const aggregate = ["GET /v1/users/own-info", "GET /v1/schema/Note", "POST /v1/aggregate/Note", "POST /v1/graphql"];
    await provider.queryReadOnly("POST /v1/aggregate/Note", BUDGET);
    expect(lines(wire)).toEqual(aggregate);
    wire.calls.length = 0;
    const result = await provider.queryReadOnly("POST /v1/aggregate/Note", BUDGET);
    expect(lines(wire)).toEqual(aggregate);
    expect(result.rows).toEqual([{ collection: "Note", tenant: null, count: 3 }]);
  });
});

describe("grounding and catalog reads on the operations profile", () => {
  test("list, describe and count read the schema and counts only, and carry no stored value", async () => {
    const { provider, wire } = agentProvider(
      agentServer("viewer", {
        "GET /v1/schema/Note": agentCollectionAnswer("Note"),
        "GET /v1/schema/Doc": agentCollectionAnswer("Doc"),
        "GET /v1/schema/Tenanted": agentCollectionAnswer("Tenanted"),
        "GET /v1/schema/TenantedManual": agentCollectionAnswer("TenantedManual"),
      }),
      OPERATIONS,
    );
    await provider.connect();
    const outputs = [
      await provider.listObjects([], "collection"),
      await provider.describeObjects([], "collection"),
      await provider.countObjects([]),
    ];
    expect((outputs[0] as unknown[]).map((entry) => (entry as { name: string }).name).sort()).toEqual([
      "Doc",
      "Note",
      "Tenanted",
      "TenantedManual",
    ]);
    expect(JSON.stringify(outputs)).not.toMatch(STORED);
    expect(lines(wire).some((line) => line.startsWith("GET /v1/objects") || line.startsWith("POST /v1/search"))).toBe(
      false,
    );
  });
});
