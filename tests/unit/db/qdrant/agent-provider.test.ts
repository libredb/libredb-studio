/**
 * QdrantProvider under the agent read-only profile, through the real REST client and a recording transport, so every
 * request line, URL and body is the one Studio would put on the wire, answered from what 1.19.1 answered the same
 * request (tests/fixtures/qdrant/1.19.1/agent-boundary/): a connection with no key refused before any client is built,
 * the read-only proof at the open and again before every request, the metadata-only answer, every route outside the
 * metadata table refused before the network, a server refusal worded without the server's words, and the budgets.
 * The operations profile and an editor handle open as before and are refused `queryReadOnly`.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import type { QdrantAnswer } from "@/lib/db/providers/vector/qdrant/client";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { QDRANT_PROOF_SENTENCES } from "@/lib/db/providers/vector/qdrant/metadata-read";
import { QDRANT_AGENT_SENTENCES } from "@/lib/db/providers/vector/qdrant/metadata-request";
import { createRestQdrantClient } from "@/lib/db/providers/vector/qdrant/rest-client";
import type { DatabaseConnection, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import { agentAnswer, agentServer } from "../../../helpers/qdrant-agent";
import { type RecordedAnswer, recordingQdrantTransport } from "../../../helpers/qdrant-transport";

const KEY = "not-a-real-key";
const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };
const STORED = /stored-|written|0\.4/;
const ORIGIN = "http://127.0.0.1:6333";

const CONNECTION: DatabaseConnection = {
  id: "qdrant-agent",
  name: "Qdrant",
  type: "qdrant",
  host: "127.0.0.1",
  port: 6333,
  createdAt: new Date(0),
};

/** The read-only key's server: `docs` was never sent an empty delete by the probe, so it answers as `other` did. */
const readOnly = (overrides: Readonly<Record<string, QdrantAnswer | (() => QdrantAnswer)>> = {}) =>
  agentServer("read-only", {
    "POST /collections/docs/points/delete": agentAnswer("proof-delete-other-read-only"),
    ...overrides,
  });

/** The proof's request lines for the read-only key, which lists three collections. */
const PROOF = [
  "POST /collections/aliases",
  "GET /collections",
  "POST /collections/docs/points/delete",
  "POST /collections/other/points/delete",
  "POST /collections/plain/points/delete",
];

function agentProvider(
  answer: RecordedAnswer,
  execution: ProviderExecutionContext = AGENT,
  connection: Partial<DatabaseConnection> = { password: KEY },
) {
  const wire = recordingQdrantTransport(answer);
  const provider = new QdrantProvider({ ...CONNECTION, ...connection }, {}, execution, (options, routes) =>
    createRestQdrantClient(options, routes, wire.factory),
  );
  return { provider, wire };
}

const lines = (wire: ReturnType<typeof recordingQdrantTransport>) => wire.calls.map((call) => call.method);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("resolved");
}

async function connected(answer: RecordedAnswer = readOnly()) {
  const made = agentProvider(answer);
  await made.provider.connect();
  made.wire.calls.length = 0;
  made.wire.requests.length = 0;
  return made;
}

describe("the open, under the agent read-only profile", () => {
  test("a connection with no key is refused before any client is built or anything sent", async () => {
    const { provider, wire } = agentProvider(readOnly(), AGENT, {});
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect((error as Error).message).toBe(QDRANT_PROOF_SENTENCES.keyless);
    expect(wire.built).toEqual([]);
    expect(wire.calls).toEqual([]);
    expect(provider.isConnected()).toBe(false);
  });

  test("the read-only key: the two connect reads, then the proof, on one api-key header and no other", async () => {
    const { provider, wire } = agentProvider(readOnly());
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    expect(wire.requests.map(({ method, url, body }) => ({ method, url, body: body ?? null }))).toEqual([
      { method: "GET", url: `${ORIGIN}/`, body: null },
      { method: "GET", url: `${ORIGIN}/collections`, body: null },
      { method: "POST", url: `${ORIGIN}/collections/aliases`, body: '{"actions":[]}' },
      { method: "GET", url: `${ORIGIN}/collections`, body: null },
      { method: "POST", url: `${ORIGIN}/collections/docs/points/delete`, body: '{"points":[]}' },
      { method: "POST", url: `${ORIGIN}/collections/other/points/delete`, body: '{"points":[]}' },
      { method: "POST", url: `${ORIGIN}/collections/plain/points/delete`, body: '{"points":[]}' },
    ]);
    expect(wire.built).toHaveLength(1);
    expect(wire.built[0].headers).toEqual({ "api-key": KEY });
  });

  test("a JWT whose access is r on one collection proves that collection alone", async () => {
    const { provider, wire } = agentProvider(agentServer("jwt-collection-read"));
    await provider.connect();
    expect(lines(wire).slice(2)).toEqual([
      "POST /collections/aliases",
      "GET /collections",
      "POST /collections/plain/points/delete",
    ]);
  });

  for (const principal of ["full", "jwt-manage", "jwt-no-access", "open-key"]) {
    test(`${principal}: refused at the open by the alias update it was answered, and the client is closed`, async () => {
      const { provider, wire } = agentProvider(
        agentServer(principal, {
          "GET /": agentAnswer("root-read-only"),
          "GET /collections": agentAnswer("collections-read-only"),
        }),
      );
      const error = await rejection(provider.connect());
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect((error as Error).message).toBe(QDRANT_PROOF_SENTENCES.writes);
      expect(lines(wire).at(-1)).toBe("POST /collections/aliases");
      expect(provider.isConnected()).toBe(false);
      expect(wire.closed()).toBe(1);
    });
  }

  test("a JWT that writes one collection is refused at that collection's empty delete", async () => {
    const { provider, wire } = agentProvider(
      agentServer("jwt-collection-write", {
        "GET /": agentAnswer("root-read-only"),
        "POST /collections/aliases": agentAnswer("proof-alias-jwt-collection-write"),
      }),
    );
    const error = await rejection(provider.connect());
    expect((error as Error).message).toBe(QDRANT_PROOF_SENTENCES.writesCollection);
    expect(lines(wire).at(-1)).toBe("POST /collections/plain/points/delete");
  });

  test("a transport failure of the proof is worded by the provider's table", async () => {
    const { provider } = agentProvider((request, line) => {
      if (line === "POST /collections/aliases") throw new Error("socket closed");
      return readOnly()(request, line);
    });
    const error = await rejection(provider.connect());
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe("The request to Qdrant failed in a way Studio does not recognise.");
  });

  test("the operations profile opens with no key and no proof, and answers no agent request", async () => {
    const { provider, wire } = agentProvider(
      agentServer("open-anonymous", { "GET /": agentAnswer("root-read-only") }),
      OPERATIONS,
      {},
    );
    await provider.connect();
    expect(lines(wire)).toEqual(["GET /", "GET /collections"]);
    const error = await rejection(provider.queryReadOnly("GET /collections", BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect((error as Error).message).toBe(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(lines(wire)).toEqual(["GET /", "GET /collections"]);
  });

  test("an editor handle answers no agent request either", async () => {
    const { provider, wire } = agentProvider(readOnly(), {});
    await provider.connect();
    await expect(provider.queryReadOnly("GET /collections", BUDGET)).rejects.toBeInstanceOf(RefusedBeforeSendError);
    expect(lines(wire)).toEqual(["GET /", "GET /collections"]);
  });
});

describe("one agent request", () => {
  test("the collection list: the key proved again, then the request, its answer projected", async () => {
    const { provider, wire } = await connected();
    const result = await provider.queryReadOnly("GET /collections", BUDGET);
    expect(lines(wire)).toEqual([...PROOF, "GET /collections"]);
    expect(result.fields).toEqual(["collection"]);
    expect(result.rows).toEqual([{ collection: "docs" }, { collection: "other" }, { collection: "plain" }]);
    expect(result.rowCount).toBe(3);
  });

  const reads: readonly [string, string, string[]][] = [
    ["GET /", `${ORIGIN}/`, ["version", "commit"]],
    ["GET /collections/plain", `${ORIGIN}/collections/plain`, ["name", "kind", "status"]],
    ["GET /collections/plain/exists", `${ORIGIN}/collections/plain/exists`, ["collection", "exists"]],
    ["GET /aliases", `${ORIGIN}/aliases`, ["alias", "collection"]],
    ["GET /collections/plain/aliases", `${ORIGIN}/collections/plain/aliases`, ["alias", "collection"]],
    ["GET /collections/plain/cluster", `${ORIGIN}/collections/plain/cluster`, ["shard", "location", "state"]],
  ];
  for (const [text, url, leading] of reads) {
    test(`${text}: exactly ${url} after the proof, and no stored value in the answer`, async () => {
      const { provider, wire } = await connected();
      const result = await provider.queryReadOnly(text, BUDGET);
      expect(lines(wire).slice(0, PROOF.length)).toEqual(PROOF);
      expect(wire.requests.slice(PROOF.length).map(({ method, url: sent, body }) => [method, sent, body])).toEqual([
        ["GET", url, undefined],
      ]);
      expect(result.fields.slice(0, leading.length)).toEqual(leading);
      expect(result.rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toMatch(STORED);
    });
  }

  test("a count: the console's own URL with its timeout and the body with exact written in, and a count comes back", async () => {
    const { provider, wire } = await connected();
    const result = await provider.queryReadOnly("POST /collections/plain/points/count", BUDGET);
    const sent = wire.requests.slice(PROOF.length);
    expect(sent.map(({ method, url, body }) => [method, url, body])).toEqual([
      ["POST", `${ORIGIN}/collections/plain/points/count?timeout=4`, '{"exact":true}'],
    ]);
    expect(result.rows).toEqual([{ collection: "plain", count: 3 }]);
  });

  test("a collection the key can write that appears after the open is refused at the next request, which is not sent", async () => {
    let collections = agentAnswer("collections-read-only");
    const { provider, wire } = await connected(
      readOnly({
        "GET /collections": () => collections,
        "POST /collections/fresh/points/delete": agentAnswer("proof-delete-plain-jwt-collection-write"),
      }),
    );
    await provider.queryReadOnly("GET /", BUDGET);
    collections = {
      ...collections,
      text: JSON.stringify({ result: { collections: [{ name: "plain" }, { name: "fresh" }] } }),
    };
    wire.calls.length = 0;
    const error = await rejection(provider.queryReadOnly("GET /", BUDGET));
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as Error).message).toBe(QDRANT_PROOF_SENTENCES.writesCollection);
    expect(lines(wire)).toEqual([
      "POST /collections/aliases",
      "GET /collections",
      "POST /collections/plain/points/delete",
      "POST /collections/fresh/points/delete",
    ]);
  });

  test("a key the server stops refusing writes from is refused at the next request; no verdict is kept", async () => {
    let alias = agentAnswer("proof-alias-read-only");
    const { provider, wire } = await connected(readOnly({ "POST /collections/aliases": () => alias }));
    await provider.queryReadOnly("GET /", BUDGET);
    await provider.queryReadOnly("GET /", BUDGET);
    expect(lines(wire).filter((line) => line === "POST /collections/aliases")).toHaveLength(2);
    alias = agentAnswer("proof-alias-full");
    wire.calls.length = 0;
    const error = await rejection(provider.queryReadOnly("GET /", BUDGET));
    expect((error as Error).message).toBe(QDRANT_PROOF_SENTENCES.writes);
    expect(lines(wire)).toEqual(["POST /collections/aliases"]);
  });

  const refused: readonly [string, string][] = [
    ['POST /collections/plain/points {"ids": [1], "with_payload": true, "with_vector": true}', "metadata-only"],
    ["GET /collections/plain/points/1", "metadata-only"],
    ['POST /collections/plain/points/scroll {"limit": 3, "with_payload": true}', "metadata-only"],
    ['POST /collections/plain/facet {"key": "city"}', "metadata-only"],
    ['POST /collections/plain/points/query {"query": [0.1, 0.2, 0.3, 0.4], "with_payload": true}', "metadata-only"],
    ['POST /collections/plain/points/query {"query": {"text": "stored text", "model": "m"}}', "inference"],
    [
      'POST /collections/plain/points/query {"query": {"image": "http://example.invalid/x.png", "model": "m"}}',
      "inference",
    ],
    ['POST /collections/plain/points/query {"query": {"object": {"a": 1}, "model": "m"}}', "inference"],
    ['POST /collections/plain/points/query/batch {"searches": [{"query": [0.1, 0.2, 0.3, 0.4]}]}', "metadata-only"],
    [
      'POST /collections/plain/points/query/groups {"query": [0.1, 0.2, 0.3, 0.4], "group_by": "city"}',
      "metadata-only",
    ],
    ["GET /collections/plain/optimizations", "metadata-only"],
    ["GET /collections/plain/snapshots", "metadata-only"],
    ['POST /collections/plain/points/count {"filter": {"must": [{"key": "city", "match": {"value": "x"}}]}}', "count"],
    ["PUT /collections/plain/points", "grammar"],
    ["POST /collections/plain/snapshots", "grammar"],
    ['PATCH /collections/plain {"optimizers_config": {"indexing_threshold": 100}}', "grammar"],
    ["POST /collections/plain/cluster", "grammar"],
    ["POST /collections/aliases", "grammar"],
    ["DELETE /collections/plain", "grammar"],
    ["GET /cluster", "grammar"],
    ["GET /telemetry", "grammar"],
    ["GET /metrics", "grammar"],
  ];
  for (const [text, why] of refused) {
    test(`${text.split(" {")[0]} (${why}) is refused before the proof or anything else is sent`, async () => {
      const { provider, wire } = await connected();
      const error = await rejection(provider.queryReadOnly(text, BUDGET));
      expect(error).toBeInstanceOf(RefusedBeforeSendError);
      expect((error as Error).message).not.toMatch(STORED);
      expect(wire.calls).toEqual([]);
    });
  }

  test("a point read is refused by its route template, in the agent's own sentence", async () => {
    const { provider } = await connected();
    await expect(provider.queryReadOnly("GET /collections/plain/points/1", BUDGET)).rejects.toThrow(
      QDRANT_AGENT_SENTENCES.metadataOnly("GET /collections/{collection_name}/points/{id}"),
    );
  });

  test("a collection-scoped JWT reading another collection: the server's refusal, worded without its words", async () => {
    const { provider } = await connected(agentServer("jwt-collection-read"));
    const error = await rejection(provider.queryReadOnly("GET /collections/other", BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "Qdrant answered HTTP 403 (forbidden). The server's own words are not passed on to agent mode, whose answers carry metadata only.",
    );
  });

  test("a stored value where a name stands withholds the whole answer", async () => {
    const smuggled: QdrantAnswer = {
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: JSON.stringify({
        result: { aliases: [{ alias_name: { value: "stored-secret" }, collection_name: "plain" }] },
      }),
    };
    const { provider } = await connected(readOnly({ "GET /aliases": smuggled }));
    const error = await rejection(provider.queryReadOnly("GET /aliases", BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).not.toContain("stored-secret");
  });

  test("a transport failure of the request is worded by the provider's table", async () => {
    const { provider } = await connected((request, line) => {
      if (line === "GET /aliases") throw new Error("socket closed");
      return readOnly()(request, line);
    });
    await expect(provider.queryReadOnly("GET /aliases", BUDGET)).rejects.toThrow(
      "The request to Qdrant failed in a way Studio does not recognise.",
    );
  });

  test("the proof and the request share one deadline: past it, the time budget's refusal", async () => {
    for (const slow of ["POST /collections/aliases", "GET /aliases"]) {
      let opened = false;
      // oxlint-disable-next-line no-await-in-loop -- each slow line on a provider of its own, one after another.
      const { provider } = await connected((request, line) => {
        if (!opened || line !== slow || request.signal === undefined) return readOnly()(request, line);
        const signal = request.signal;
        return new Promise<NodeResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      opened = true;
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const error = await rejection(provider.queryReadOnly("GET /aliases", { ...BUDGET, statementTimeoutMs: 30 }));
      expect({ slow, message: (error as Error).message }).toEqual({
        slow,
        message: "Read-only execution exceeded the time budget: no answer within 30ms",
      });
    }
  });

  test("an estimating plan is refused, as is a budget that is no budget", async () => {
    const { provider, wire } = await connected();
    await expect(provider.queryReadOnly("GET /", BUDGET, "estimate-plan")).rejects.toThrow(
      "Qdrant composes no estimating plan for the agent",
    );
    await expect(provider.queryReadOnly("GET /", { ...BUDGET, maxResultRows: 0 })).rejects.toThrow();
    expect(wire.calls).toEqual([]);
  });

  test("rows past the row budget are refused, never cut", async () => {
    const { provider } = await connected();
    await expect(provider.queryReadOnly("GET /collections", { ...BUDGET, maxResultRows: 2 })).rejects.toThrow(
      "Read-only execution exceeded the row budget: 3 rows > 2 allowed",
    );
  });
});

describe("grounding and catalog reads on the operations profile", () => {
  test("list, describe and count read collection definitions only, never a point, and carry no stored value", async () => {
    const { provider, wire } = agentProvider(
      readOnly({
        "GET /collections/docs": agentAnswer("collection-docs-read-only"),
        "GET /collections/other": agentAnswer("collection-read-only"),
      }),
      OPERATIONS,
    );
    await provider.connect();
    const outputs = [
      await provider.listObjects([], "collection"),
      await provider.describeObjects([], "collection"),
      await provider.countObjects([]),
    ];
    expect(JSON.stringify(outputs)).not.toMatch(STORED);
    expect(lines(wire).some((line) => /\/points|\/facet/.test(line))).toBe(false);
  });
});
