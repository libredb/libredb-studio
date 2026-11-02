/**
 * What a Qdrant key reaches beyond the collections it is meant to read, from the raw answers 1.19.1 gave in
 * tests/fixtures/qdrant/1.19.1/mcp-scope/ (written by tests/live/qdrant-mcp-boundary.ts), and what Studio withholds
 * from each answer whatever the request said.
 *
 * Two layers, each pinned on its own. The server's grants: a JWT reading one collection lists that collection alone
 * and no alias, not even its own collection's, and is refused another collection's existence, shard layout and aliases
 * 403 whether that collection exists or not; a JWT reading one alias reads its collection through it and lists none;
 * the read-only API key lists every alias the server holds, which is its grant. Studio's projection: a shard layout
 * answers no peer id, and a refusal is worded by its status alone, so a refusal of a collection that exists reads
 * the same as one of a collection that does not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { QdrantAnswer } from "@/lib/db/providers/vector/qdrant/client";
import { answerFailure } from "@/lib/db/providers/vector/qdrant/errors";
import { qdrantAgentFailure, shapeQdrantAgentAnswer } from "@/lib/db/providers/vector/qdrant/metadata-read";
import { readQdrantAgentStatement } from "@/lib/db/providers/vector/qdrant/metadata-request";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";

const SCOPE = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "..",
  "..",
  "..",
  "fixtures",
  "qdrant",
  "1.19.1",
  "mcp-scope",
);
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };

interface ScopeCapture {
  readonly version: string;
  readonly principal: string;
  readonly request: { readonly method: string; readonly path: string };
  readonly status: number;
  readonly body: string;
}

const capture = (name: string): ScopeCapture =>
  JSON.parse(readFileSync(posix.join(SCOPE, `${name}.json`), "utf8")) as ScopeCapture;

const answerOf = (name: string): QdrantAnswer => {
  const { status, body } = capture(name);
  return { status, contentType: "application/json", retryAfter: null, text: body };
};

/** A captured 200 answer as the agent projection reads it. */
function project(name: string) {
  const { request, body } = capture(name);
  const statement = `${request.method} ${request.path}`;
  const reading = readQdrantAgentStatement(statement);
  if (!reading.ok) throw new Error(reading.message);
  return shapeQdrantAgentAnswer({ plan: reading.plan, text: body, executionTime: 1 }, BUDGET, statement);
}

/** The agent's wording of a captured refusal, with the collection the request named written out. */
function refusal(name: string): string {
  const { request } = capture(name);
  const failure = qdrantAgentFailure(answerFailure(answerOf(name)), BUDGET, `${request.method} ${request.path}`);
  if (failure === undefined) throw new Error(`${name} is not a refusal`);
  return failure.message;
}

describe("a JWT reading one collection", () => {
  test("lists that collection alone, and no alias, not even its own collection's", () => {
    expect(project("collections-jwt-collection-read").rows).toEqual([{ collection: "mcp_plain" }]);
    expect(project("aliases-jwt-collection-read").rows).toEqual([]);
    expect(project("collection-aliases-jwt-collection-read").rows).toEqual([]);
  });

  test("is refused another collection's existence, shard layout and aliases by the server", () => {
    for (const name of [
      "other-exists-jwt-collection-read",
      "missing-exists-jwt-collection-read",
      "other-cluster-jwt-collection-read",
      "other-aliases-jwt-collection-read",
    ]) {
      expect({ name, status: capture(name).status }).toEqual({ name, status: 403 });
    }
  });

  test("reads the same refusal for a collection that exists and one that does not, in Studio's words", () => {
    const hit = refusal("other-exists-jwt-collection-read");
    expect(hit).toBe(refusal("missing-exists-jwt-collection-read"));
    expect(hit).not.toContain("Access to collection");
    expect(hit).not.toContain("mcp_other");
  });
});

describe("a JWT reading one alias", () => {
  test("lists no collection, reads its collection's shard layout through the alias, and is refused the collection by name", () => {
    expect(project("collections-jwt-alias-read").rows).toEqual([]);
    expect(project("alias-cluster-jwt-alias-read").rows).toEqual([
      { shard: 0, location: "local", state: "Active", points: 1 },
    ]);
    expect(capture("other-jwt-alias-read").status).toBe(403);
  });
});

describe("the read-only API key", () => {
  test("lists every alias the server holds, which is its grant", () => {
    expect(project("aliases-read-only").rows).toEqual([
      { alias: "mcp_other_alias", collection: "mcp_other" },
      { alias: "mcp_plain_alias", collection: "mcp_plain" },
    ]);
  });

  test("reads another collection's shard layout with no peer id", () => {
    expect(capture("other-cluster-read-only").body).toContain("peer_id");
    const projected = project("other-cluster-read-only");
    expect(projected.rows).toEqual([{ shard: 0, location: "local", state: "Active", points: 1 }]);
    expect(JSON.stringify(projected)).not.toContain("peer");
  });
});

test("every capture records 1.19.1 and the principal's rights, never a key or a token", () => {
  for (const name of ["aliases-read-only", "other-exists-jwt-collection-read", "collections-jwt-alias-read"]) {
    const text = readFileSync(posix.join(SCOPE, `${name}.json`), "utf8");
    expect(capture(name).version).toBe("1.19.1");
    expect(text).not.toContain("eyJ");
    expect(text).not.toContain("api-key");
  }
});
