/**
 * The Qdrant agent read-only profile's own rules (`metadata-read.ts`): the read-only proof, replayed from what 1.19.1
 * answered each principal's two no-op writes (tests/fixtures/qdrant/1.19.1/agent-boundary/), the metadata-only
 * projection of every agent answer, each fed the captured answers and answers that carry a stored value where only a
 * name, a count or a flag may stand, and the agent's wording of a failure.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError, TimeoutError } from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { measureResultBytes } from "@/lib/db/providers/sql/read-only-budget";
import { type QdrantAnswer, QdrantError, type QdrantProbe } from "@/lib/db/providers/vector/qdrant/client";
import type { QdrantAnswered } from "@/lib/db/providers/vector/qdrant/execute";
import {
  keylessAgentRefusal,
  proveQdrantReadOnly,
  QDRANT_METADATA_ONLY,
  QDRANT_PROOF_MAX_COLLECTIONS,
  QDRANT_PROOF_SENTENCES,
  qdrantAgentFailure,
  qdrantProjectionOf,
  type QdrantProofWire,
  readQdrantProbeAnswer,
  readQdrantProofCollections,
  shapeQdrantAgentAnswer,
} from "@/lib/db/providers/vector/qdrant/metadata-read";
import { QDRANT_AGENT_OPS, readQdrantAgentStatement } from "@/lib/db/providers/vector/qdrant/metadata-request";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { agentAnswer, agentCapture } from "../../../helpers/qdrant-agent";

const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };
const STORED = /stored-|written|0\.4/;
const ALIAS: QdrantProbe = { kind: "empty-alias-update" };
const DELETE: QdrantProbe = { kind: "empty-point-delete", collection: "plain" };

function refusal(run: () => unknown): ExecutionProfileError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionProfileError);
    return error as ExecutionProfileError;
  }
  throw new Error("admitted");
}

const json = (value: unknown, status = 200): QdrantAnswer => ({
  status,
  contentType: "application/json",
  retryAfter: null,
  text: JSON.stringify(value),
});

/** An agent request's answer as the provider hands it to the projection. */
function answered(statement: string, text: string): QdrantAnswered {
  const reading = readQdrantAgentStatement(statement);
  if (!reading.ok) throw new Error(reading.message);
  return { plan: reading.plan, text, executionTime: 3 };
}

const shape = (statement: string, text: string, budget = BUDGET) =>
  shapeQdrantAgentAnswer(answered(statement, text), budget, statement);

const fromCapture = (statement: string, capture: string) => shape(statement, agentCapture(capture).body);

const withheld = (statement: string, text: string): QueryError => {
  try {
    shape(statement, text);
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return error as QueryError;
  }
  throw new Error("answered");
};

describe("the read-only proof, from what 1.19.1 answered", () => {
  test("every read-only principal is refused both no-op writes", () => {
    for (const principal of ["read-only", "jwt-read", "jwt-collection-read"]) {
      expect(() => readQdrantProbeAnswer(agentAnswer(`proof-alias-${principal}`), ALIAS)).not.toThrow();
      expect(() => readQdrantProbeAnswer(agentAnswer(`proof-delete-plain-${principal}`), DELETE)).not.toThrow();
    }
  });

  for (const principal of ["full", "jwt-manage", "jwt-no-access", "open-anonymous", "open-key"]) {
    test(`${principal}: the empty alias update is answered, so the key writes and is refused`, () => {
      const error = refusal(() => readQdrantProbeAnswer(agentAnswer(`proof-alias-${principal}`), ALIAS));
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(QDRANT_PROOF_SENTENCES.writes);
    });
  }

  test("a JWT that writes one collection passes the alias probe and is refused at that collection's empty delete", () => {
    expect(() => readQdrantProbeAnswer(agentAnswer("proof-alias-jwt-collection-write"), ALIAS)).not.toThrow();
    const error = refusal(() => readQdrantProbeAnswer(agentAnswer("proof-delete-plain-jwt-collection-write"), DELETE));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(QDRANT_PROOF_SENTENCES.writesCollection);
  });

  test("an empty delete answered 200 refuses the same way", () => {
    const error = refusal(() => readQdrantProbeAnswer(json({ result: {} }), DELETE));
    expect(error.message).toBe(QDRANT_PROOF_SENTENCES.writesCollection);
  });

  test("no key on a keyed server is answered 401 and refused naming the status and the step only", () => {
    const alias = refusal(() => readQdrantProbeAnswer(agentAnswer("proof-alias-anonymous"), ALIAS));
    expect(alias.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(alias.message).toBe(QDRANT_PROOF_SENTENCES.status(401, "an empty alias update"));
    const remove = refusal(() => readQdrantProbeAnswer(agentAnswer("proof-delete-plain-anonymous"), DELETE));
    expect(remove.message).toBe(QDRANT_PROOF_SENTENCES.status(401, "an empty point delete"));
  });

  test("an alias update answered 400, or a delete answered 404 or 500, is not a refusal and refuses the key", () => {
    for (const [answer, probe] of [
      [json({}, 400), ALIAS],
      [json({}, 404), DELETE],
      [json({}, 500), DELETE],
    ] as const) {
      expect(refusal(() => readQdrantProbeAnswer(answer, probe)).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    }
  });

  test("a connection with no key is refused as a server that cannot refuse a write for it", () => {
    const error = keylessAgentRefusal();
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(QDRANT_PROOF_SENTENCES.keyless);
  });
});

/** A key in a JWT's shape carrying `claims`; its header and signature are not real, which the claim check never reads. */
const jwtKey = (claims: unknown): string =>
  `not-a-real-header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.not-a-real-signature`;

/** A proof wire that records what it was sent and answers like the read-only key's server. */
function recordingWire(key: string) {
  const sent: string[] = [];
  const wire: QdrantProofWire = {
    key,
    probe: async (probe: QdrantProbe) => {
      sent.push(probe.kind === "empty-alias-update" ? "alias" : `delete ${probe.collection}`);
      return json({}, 403);
    },
    listCollections: async () => {
      sent.push("list");
      return json({ result: { collections: [] } });
    },
  };
  return { wire, sent };
}

describe("a JWT's own claims", () => {
  for (const [what, claims] of [
    ["access r", { access: "r" }],
    ["access r on each collection it names", { access: [{ collection: "plain", access: "r" }] }],
    ["an empty list of collections", { access: [] }],
    ["access r with every claim beside it Studio reads", { access: "r", exp: 1, iat: 1, nbf: 1, sub: "s" }],
    ["access r bound to a point that exists", { access: "r", value_exists: { collection: "plain", matches: [] } }],
  ] as const) {
    test(`${what}: admitted, and the server's two no-op writes are still sent`, async () => {
      const { wire, sent } = recordingWire(jwtKey(claims));
      await proveQdrantReadOnly(wire, new AbortController().signal);
      expect(sent).toEqual(["alias", "list"]);
    });
  }

  for (const [what, claims] of [
    [
      "rw on an alias, which lists nothing and passes both no-op writes",
      { access: [{ collection: "plain_alias", access: "rw" }] },
    ],
    ["rw on a name nothing has yet", { access: [{ collection: "future", access: "rw" }] }],
    [
      "r on one collection and rw on another",
      {
        access: [
          { collection: "plain", access: "r" },
          { collection: "other", access: "rw" },
        ],
      },
    ],
    ["access m", { access: "m" }],
    ["access rw", { access: "rw" }],
    ["no access claim", {}],
    [
      "an access entry with a key Studio does not read",
      { access: [{ collection: "plain", access: "r", payload: {} }] },
    ],
    ["an access entry with no collection", { access: [{ access: "r" }] }],
    ["an access entry whose collection is not a name", { access: [{ collection: 1, access: "r" }] }],
    ["an access entry that is not an object", { access: ["r"] }],
    ["an access claim that is an object", { access: { collection: "plain", access: "r" } }],
    ["a claim Studio does not read", { access: "r", role: "admin" }],
  ] as const) {
    test(`${what}: refused before anything is sent`, async () => {
      const { wire, sent } = recordingWire(jwtKey(claims));
      const error = await proveQdrantReadOnly(wire, new AbortController().signal).then(
        () => {
          throw new Error("admitted");
        },
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(ExecutionProfileError);
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect((error as Error).message).toBe(QDRANT_PROOF_SENTENCES.claims);
      expect(sent).toEqual([]);
    });
  }

  for (const [what, key] of [
    ["an opaque key", "not-a-real-key"],
    ["a key with three parts whose middle is not JSON", "not.a-real.key"],
    ["a key with three parts whose middle is JSON but no object", `a.${Buffer.from("[1]").toString("base64url")}.b`],
  ] as const) {
    test(`${what} has no claims to read, and is left to the server's two no-op writes`, async () => {
      const { wire, sent } = recordingWire(key);
      await proveQdrantReadOnly(wire, new AbortController().signal);
      expect(sent).toEqual(["alias", "list"]);
    });
  }
});

describe("the collections the proof checks", () => {
  test("are the ones the key lists: all three for the read-only key, its own for a collection-scoped JWT", () => {
    expect(readQdrantProofCollections(agentAnswer("collections-read-only"))).toEqual(["docs", "other", "plain"]);
    expect(readQdrantProofCollections(agentAnswer("collections-jwt-collection-write"))).toEqual(["plain"]);
  });

  test(`more than ${QDRANT_PROOF_MAX_COLLECTIONS} refuses; exactly that many does not`, () => {
    const list = (count: number) =>
      json({ result: { collections: Array.from({ length: count }, (_, index) => ({ name: `c${index}` })) } });
    expect(readQdrantProofCollections(list(QDRANT_PROOF_MAX_COLLECTIONS))).toHaveLength(QDRANT_PROOF_MAX_COLLECTIONS);
    const error = refusal(() => readQdrantProofCollections(list(QDRANT_PROOF_MAX_COLLECTIONS + 1)));
    expect(error.message).toBe(QDRANT_PROOF_SENTENCES.tooMany(QDRANT_PROOF_MAX_COLLECTIONS + 1));
  });

  test("a list answered other than 200 refuses naming the status", () => {
    const error = refusal(() => readQdrantProofCollections(agentAnswer("collections-anonymous")));
    expect(error.message).toBe(QDRANT_PROOF_SENTENCES.status(401, "the list of collections"));
  });

  for (const [what, text] of [
    ["not JSON", "<html>"],
    ["no result", "{}"],
    ["a result that is a list", '{"result":[]}'],
    ["collections that is not a list", '{"result":{"collections":{}}}'],
    ["a collection with no name", '{"result":{"collections":[{}]}}'],
    ["a collection that is not an object", '{"result":{"collections":["plain"]}}'],
  ]) {
    test(`a list in a shape Studio does not read refuses: ${what}`, () => {
      const error = refusal(() =>
        readQdrantProofCollections({ status: 200, contentType: "application/json", retryAfter: null, text }),
      );
      expect(error.message).toBe(QDRANT_PROOF_SENTENCES.unreadable);
    });
  }
});

describe("the proof's order", () => {
  test("the alias update, the list, then one empty delete per listed collection; a refusal stops it", async () => {
    const sent: string[] = [];
    const signal = new AbortController().signal;
    const wire = (deleteAnswer: (collection: string) => QdrantAnswer) => ({
      key: "not-a-real-key",
      probe: async (probe: QdrantProbe) => {
        sent.push(probe.kind === "empty-alias-update" ? "alias" : `delete ${probe.collection}`);
        return probe.kind === "empty-alias-update" ? json({}, 403) : deleteAnswer(probe.collection);
      },
      listCollections: async () => {
        sent.push("list");
        return agentAnswer("collections-read-only");
      },
    });
    await proveQdrantReadOnly(
      wire(() => json({}, 403)),
      signal,
    );
    expect(sent).toEqual(["alias", "list", "delete docs", "delete other", "delete plain"]);
    sent.length = 0;
    await expect(
      proveQdrantReadOnly(
        wire((collection) => json({}, collection === "other" ? 400 : 403)),
        signal,
      ),
    ).rejects.toBeInstanceOf(ExecutionProfileError);
    expect(sent).toEqual(["alias", "list", "delete docs", "delete other"]);
  });

  test("an alias update the server answers stops the proof before anything else is sent", async () => {
    const sent: string[] = [];
    await expect(
      proveQdrantReadOnly(
        {
          key: "not-a-real-key",
          probe: async () => {
            sent.push("alias");
            return agentAnswer("proof-alias-full");
          },
          listCollections: async () => {
            sent.push("list");
            return agentAnswer("collections-full");
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(QDRANT_PROOF_SENTENCES.writes);
    expect(sent).toEqual(["alias"]);
  });
});

describe("the metadata-only projections, from what a read-only key read", () => {
  test("the version: the version and the commit, never the title", () => {
    expect(fromCapture("GET /", "root-read-only")).toEqual({
      fields: ["version", "commit"],
      rows: [{ version: "1.19.1", commit: "6ab21cac18ebb6f4ae29102c7f8f5cc11affd5de" }],
      rowCount: 1,
      executionTime: 3,
    });
  });

  test("the collection list: one row per collection", () => {
    expect(fromCapture("GET /collections", "collections-read-only").rows).toEqual([
      { collection: "docs" },
      { collection: "other" },
      { collection: "plain" },
    ]);
  });

  test("one collection: its own row, then its vector and its payload index, no configuration value beside them", () => {
    const result = fromCapture("GET /collections/plain", "collection-read-only");
    expect(result.fields).toEqual([
      "name",
      "kind",
      "status",
      "type",
      "size",
      "points",
      "indexed_vectors",
      "segments",
      "shards",
      "replication_factor",
      "optimizer_status",
    ]);
    const empty = Object.fromEntries(result.fields.map((field) => [field, null]));
    expect(result.rows).toEqual([
      {
        ...empty,
        name: "plain",
        kind: "collection",
        status: "green",
        points: 3,
        indexed_vectors: 0,
        segments: 2,
        shards: 1,
        replication_factor: 1,
        optimizer_status: "ok",
      },
      { ...empty, kind: "vector", type: "Dot", size: 4 },
      { ...empty, name: "city", kind: "payload_index", type: "keyword", points: 3 },
    ]);
  });

  test("named and sparse vectors and a nested payload index are rows of their own, by name", () => {
    const rows = fromCapture("GET /collections/docs", "collection-docs-read-only").rows;
    expect(rows.map((row) => [row.name, row.kind, row.type, row.size, row.points])).toEqual([
      ["docs", "collection", null, null, 2],
      ["text", "vector", "Cosine", 4, null],
      ["keywords", "sparse_vector", null, null, null],
      ["meta.name", "payload_index", "keyword", null, 2],
    ]);
  });

  test("a named vector called size is a named vector, not the collection's one unnamed vector", () => {
    const text = JSON.stringify({
      result: {
        status: "green",
        points_count: 1,
        config: {
          params: { vectors: { size: { size: 2, distance: "Dot" }, other: { size: 3, distance: "Cosine" } } },
        },
        payload_schema: {},
      },
    });
    expect(shape("GET /collections/plain", text).rows.map((row) => [row.name, row.kind, row.type, row.size])).toEqual([
      ["plain", "collection", null, null],
      ["size", "vector", "Dot", 2],
      ["other", "vector", "Cosine", 3],
    ]);
  });

  test("its existence, the alias lists, a count and the shard layout", () => {
    expect(fromCapture("GET /collections/plain/exists", "exists-read-only").rows).toEqual([
      { collection: "plain", exists: true },
    ]);
    expect(fromCapture("GET /aliases", "aliases-read-only").rows).toEqual([
      { alias: "plain_alias", collection: "plain" },
    ]);
    expect(fromCapture("GET /collections/plain/aliases", "collection-aliases-read-only").rows).toEqual([
      { alias: "plain_alias", collection: "plain" },
    ]);
    expect(fromCapture("POST /collections/plain/points/count", "count-read-only").rows).toEqual([
      { collection: "plain", count: 3 },
    ]);
    expect(fromCapture("GET /collections/plain/cluster", "cluster-read-only").rows).toEqual([
      { shard: 0, location: "local", state: "Active", points: 3 },
    ]);
  });

  test("a remote shard is a row too, with no point count", () => {
    const text = JSON.stringify({
      result: { local_shards: [], remote_shards: [{ shard_id: 1, peer_id: 7, state: "Active" }] },
    });
    expect(shape("GET /collections/plain/cluster", text).rows).toEqual([
      { shard: 1, location: "remote", state: "Active", points: null },
    ]);
  });

  test("a collection with no vector and no payload index answers its own row alone", () => {
    const text = JSON.stringify({
      result: { status: "green", points_count: 0, segments_count: 1, config: { params: { vectors: {} } } },
    });
    expect(shape("GET /collections/empty", text).rows.map((row) => row.kind)).toEqual(["collection"]);
    const bare = JSON.stringify({ result: { status: "green" } });
    expect(shape("GET /collections/empty", bare).rows.map((row) => row.kind)).toEqual(["collection"]);
  });

  test("an optimizer error is answered as error, never its text", () => {
    const text = JSON.stringify({
      result: { status: "red", optimizer_status: { error: "stored-secret in a failed segment" } },
    });
    const rows = shape("GET /collections/plain", text).rows;
    expect(rows[0].optimizer_status).toBe("error");
    expect(JSON.stringify(rows)).not.toContain("stored-");
  });

  test("which projection each agent route takes, and that no other route has one", () => {
    expect([...QDRANT_AGENT_OPS].map(qdrantProjectionOf)).toEqual([
      "version",
      "collections",
      "collection",
      "exists",
      "aliases",
      "aliases",
      "count",
      "cluster",
    ]);
    expect(() => qdrantProjectionOf("scroll_points")).toThrow("No metadata projection reads a scroll_points answer");
  });

  test("the capability states every projection, column by column", () => {
    expect(Object.keys(QDRANT_METADATA_ONLY)).toEqual([
      "version",
      "collections",
      "collection",
      "exists",
      "aliases",
      "count",
      "cluster",
    ]);
    expect(QDRANT_METADATA_ONLY.count).toEqual([
      { column: "collection", kind: "name" },
      { column: "count", kind: "count" },
    ]);
    expect(QDRANT_METADATA_ONLY.cluster).toEqual([
      { column: "shard", kind: "count" },
      { column: "location", kind: "name" },
      { column: "state", kind: "name" },
      { column: "points", kind: "count" },
    ]);
    expect(QDRANT_METADATA_ONLY.collection.map((column) => column.kind)).toEqual([
      "name",
      "name",
      "name",
      "name",
      "count",
      "count",
      "count",
      "count",
      "count",
      "count",
      "name",
    ]);
  });
});

describe("a stored value where only a name, a count or a flag may stand", () => {
  test("extra keys a server adds beside the facts are dropped, whatever they are named", () => {
    const collection = JSON.parse(agentCapture("collection-read-only").body) as { result: Record<string, unknown> };
    collection.result.payload = { city: "stored-city-1" };
    (collection.result.config as Record<string, unknown>).stored = "stored-config";
    const rows = shape("GET /collections/plain", JSON.stringify(collection)).rows;
    expect(JSON.stringify(rows)).not.toMatch(STORED);
    const root = { title: "stored-title", version: "1.19.1", vector: [0.4] };
    expect(JSON.stringify(shape("GET /", JSON.stringify(root)).rows)).not.toMatch(STORED);
    const cluster = {
      result: { local_shards: [{ shard_id: 0, state: "Active", shard_key: "stored-key" }], remote_shards: [] },
    };
    expect(JSON.stringify(shape("GET /collections/plain/cluster", JSON.stringify(cluster)).rows)).not.toMatch(STORED);
  });

  const smuggled: readonly [string, string, string][] = [
    [
      "GET /collections",
      JSON.stringify({ result: { collections: [{ name: { city: "stored-city-1" } }] } }),
      "collection",
    ],
    ["GET /collections", JSON.stringify({ result: { collections: [{ name: ["stored-city-1"] }] } }), "collection"],
    ["GET /collections", JSON.stringify({ result: { collections: [{ name: 4 }] } }), "collection"],
    ["GET /collections", JSON.stringify({ result: { collections: [{ name: "stored\ncity" }] } }), "collection"],
    [
      "GET /collections/plain",
      JSON.stringify({ result: { status: "green", payload_schema: { "stored line": { data_type: "keyword" } } } }),
      "name",
    ],
    [
      "GET /collections/plain",
      JSON.stringify({ result: { status: "green", payload_schema: { city: { data_type: { stored: "x" } } } } }),
      "type",
    ],
    [
      "GET /collections/plain",
      JSON.stringify({ result: { status: "green", config: { params: { vectors: { text: { size: [0.4, 0.2] } } } } } }),
      "size",
    ],
    ["GET /collections/plain", JSON.stringify({ result: { status: "green", points_count: "stored-3" } }), "points"],
    ["GET /collections/plain", JSON.stringify({ result: { status: { stored: 1 } } }), "status"],
    ["GET /collections/plain", JSON.stringify({ result: { optimizer_status: ["stored"] } }), "optimizer_status"],
    ["GET /collections/plain/exists", JSON.stringify({ result: { exists: "stored-yes" } }), "exists"],
    ["POST /collections/plain/points/count", JSON.stringify({ result: { count: -1 } }), "count"],
    ["POST /collections/plain/points/count", JSON.stringify({ result: { count: 1.5 } }), "count"],
    [
      "GET /aliases",
      JSON.stringify({ result: { aliases: [{ alias_name: "a", collection_name: "x".repeat(513) }] } }),
      "collection",
    ],
    ["GET /", JSON.stringify({ version: [0.4] }), "version"],
  ];
  for (const [statement, text, column] of smuggled) {
    test(`${statement}: a value in ${column}'s place withholds the whole answer, naming the column only`, () => {
      const error = withheld(statement, text);
      expect(error.message).toContain(JSON.stringify(column));
      expect(error.message).not.toMatch(STORED);
    });
  }

  const unread: readonly [string, string][] = [
    ["GET /", "not json"],
    ["GET /", "[]"],
    ["GET /collections", "{}"],
    ["GET /collections", '{"result":{"collections":[1]}}'],
    ["GET /collections/plain", '{"result":[]}'],
    ["GET /collections/plain", '{"result":{"config":{"params":[]}}}'],
    ["GET /collections/plain", '{"result":{"payload_schema":{"city":"keyword"}}}'],
    ["GET /collections/plain", '{"result":{"config":{"params":{"sparse_vectors":["stored"]}}}}'],
    ["GET /collections/plain/cluster", '{"result":{"local_shards":{}}}'],
    ["GET /aliases", '{"result":{}}'],
  ];
  for (const [statement, text] of unread) {
    test(`an answer to ${statement} in a shape Studio does not read is withheld (${text.slice(0, 30)})`, () => {
      const error = withheld(statement, text);
      expect(error.message).toBe(
        "Qdrant's answer is not in the shape Studio reads for this request, so it was withheld from agent mode.",
      );
    });
  }

  test("an error that is not the projection's own is not reworded", () => {
    const plan = answered("GET /", "{}");
    const throwing = {
      ...plan,
      text: "{}",
      plan: { ...plan.plan, route: { ...plan.plan.route, op: "scroll_points" } },
    };
    expect(() => shapeQdrantAgentAnswer(throwing as QdrantAnswered, BUDGET, "GET /")).toThrow(
      "No metadata projection reads a scroll_points answer",
    );
  });
});

describe("the budgets", () => {
  const list = JSON.stringify({ result: { collections: [{ name: "a" }, { name: "b" }, { name: "c" }] } });

  test("rows past the row budget are refused, never cut", () => {
    const error = (() => {
      try {
        shape("GET /collections", list, { ...BUDGET, maxResultRows: 2 });
      } catch (caught) {
        return caught as QueryError;
      }
      throw new Error("answered");
    })();
    expect(error.message).toContain("3 rows");
    expect(shape("GET /collections", list, { ...BUDGET, maxResultRows: 3 }).rowCount).toBe(3);
  });

  test("an answer of exactly the byte budget is kept, and one byte less refuses it", () => {
    const bytes = measureResultBytes([{ collection: "a" }, { collection: "b" }, { collection: "c" }]);
    expect(shape("GET /collections", list, { ...BUDGET, maxResultBytes: bytes }).rowCount).toBe(3);
    expect(() => shape("GET /collections", list, { ...BUDGET, maxResultBytes: bytes - 1 })).toThrow(QueryError);
  });
});

describe("the agent's wording of a failure", () => {
  const STATEMENT = "GET /collections/other";

  test("a server refusal is its status and category, never the server's words", () => {
    const error = qdrantAgentFailure(
      new QdrantError("forbidden", "Forbidden: Access to collection stored-secret is required", 403),
      BUDGET,
      STATEMENT,
    );
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toBe(
      "Qdrant answered HTTP 403 (forbidden). The server's own words are not passed on to agent mode, whose answers carry metadata only.",
    );
  });

  test("a transport timeout and a deadline are the time budget's refusal", () => {
    for (const error of [new TransportError("timeout", "slow"), new TimeoutError("late")]) {
      expect(qdrantAgentFailure(error, BUDGET, STATEMENT)?.message).toBe(
        "Read-only execution exceeded the time budget: no answer within 5000ms",
      );
    }
  });

  test("anything else is left to the provider's own table", () => {
    expect(qdrantAgentFailure(new TransportError("unreachable", "down"), BUDGET, STATEMENT)).toBeUndefined();
    expect(qdrantAgentFailure(new Error("other"), BUDGET, STATEMENT)).toBeUndefined();
  });
});
