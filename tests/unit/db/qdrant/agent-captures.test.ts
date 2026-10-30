/**
 * What a Qdrant 1.19.1 server answers each principal an agent connection could carry, as
 * tests/fixtures/qdrant/1.19.1/agent-boundary/run.sh recorded it: the facts the agent read-only proof and the agent
 * request reader are built on, each held here against the capture that shows it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { agentCapture, agentCaptureNames, QDRANT_AGENT_CAPTURES } from "../../../helpers/qdrant-agent";

const IMAGE =
  "ghcr.io/qdrant/qdrant/qdrant:v1.19.1@sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822";
const DIGEST = "808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822";

const errorOf = (name: string): string =>
  (JSON.parse(agentCapture(name).body) as { status: { error: string } }).status.error;
const countOf = (name: string): number =>
  (JSON.parse(agentCapture(name).body) as { result: { count: number } }).result.count;

describe("the captures on disk", () => {
  test("every capture records the pinned image, Qdrant 1.19.1, its date, its principal and its request", () => {
    const names = agentCaptureNames();
    expect(names.length).toBeGreaterThan(100);
    for (const name of names) {
      const capture = agentCapture(name);
      expect({ name, version: capture.version, image: capture.image }).toEqual({
        name,
        version: "1.19.1",
        image: IMAGE,
      });
      expect(capture.name).toBe(`agent-boundary/${name}`);
      expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(capture.principal).toMatch(/^[a-z-]+: \S/);
      expect(["api-key", "none"]).toContain(capture.request.auth);
    }
  });

  test("no capture holds a key or a JWT, and run.sh generates every one per run", () => {
    for (const name of agentCaptureNames()) {
      const text = readFileSync(posix.join(QDRANT_AGENT_CAPTURES, `${name}.json`), "utf8")
        .split(DIGEST)
        .join("");
      expect({ name, key: /\b[0-9a-f]{64}\b/.test(text) }).toEqual({ name, key: false });
      expect({ name, jwt: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(text) }).toEqual({ name, jwt: false });
    }
    const script = readFileSync(posix.join(QDRANT_AGENT_CAPTURES, "run.sh"), "utf8");
    expect(script).toContain('full="$(openssl rand -hex 32)"');
    expect(script).toContain('readonly_key="$(openssl rand -hex 32)"');
    expect(script).toContain(IMAGE);
  });
});

describe("the read-only proof's two no-op writes", () => {
  test("an empty alias update is refused 403 to every read-only principal and answered 200 to every writer", () => {
    for (const principal of ["read-only", "jwt-read", "jwt-collection-read", "jwt-collection-write"]) {
      expect({ principal, status: agentCapture(`proof-alias-${principal}`).status }).toEqual({
        principal,
        status: 403,
      });
    }
    for (const principal of ["full", "jwt-manage", "jwt-no-access", "open-anonymous", "open-key"]) {
      expect({ principal, status: agentCapture(`proof-alias-${principal}`).status }).toEqual({
        principal,
        status: 200,
      });
    }
    expect(agentCapture("proof-alias-anonymous").status).toBe(401);
  });

  test("so a JWT that writes one collection passes the alias probe, and only an empty point delete tells it apart", () => {
    expect(errorOf("proof-alias-jwt-collection-write")).toBe("Forbidden: Global access is required");
    expect(errorOf("proof-alias-jwt-collection-read")).toBe("Forbidden: Global access is required");
    expect(agentCapture("proof-delete-plain-jwt-collection-write").status).toBe(400);
    expect(errorOf("proof-delete-plain-jwt-collection-write")).toBe("Bad request: Empty update request");
    expect(agentCapture("proof-delete-plain-jwt-collection-read").status).toBe(403);
    expect(errorOf("proof-delete-plain-jwt-collection-read")).toBe(
      "Forbidden: Write access to collection plain is required",
    );
  });

  test("the empty delete is checked for access before it is read, and changes nothing for a writer", () => {
    for (const principal of ["read-only", "jwt-read"]) {
      for (const collection of ["plain", "other"]) {
        expect(agentCapture(`proof-delete-${collection}-${principal}`).status).toBe(403);
      }
    }
    for (const principal of ["full", "jwt-manage", "jwt-no-access", "open-anonymous", "open-key"]) {
      expect(errorOf(`proof-delete-plain-${principal}`)).toBe("Bad request: Empty update request");
    }
  });

  test("a collection-scoped JWT lists only its own collections, so the proof reaches every one it can write", () => {
    expect(JSON.parse(agentCapture("collections-jwt-collection-write").body).result).toEqual({
      collections: [{ name: "plain" }],
    });
    expect(JSON.parse(agentCapture("collections-read-only").body).result.collections).toHaveLength(3);
  });

  test("a server with no key configured answers every request, with or without a key: it has no boundary", () => {
    expect(agentCapture("collections-open-anonymous").status).toBe(200);
    expect(agentCapture("proof-alias-open-key").status).toBe(200);
  });
});

describe("a read-only principal's writes", () => {
  const WRITES = [
    "write-upsert",
    "write-delete-points",
    "write-set-payload",
    "write-snapshot",
    "write-storage-snapshot",
    "write-optimizers",
    "write-cluster",
    "write-create-collection",
    "write-delete-collection",
    "write-alias",
    "write-index",
  ];

  test("every write, snapshot, optimizer change and cluster change is refused 403", () => {
    for (const principal of ["read-only", "jwt-read", "jwt-collection-read"]) {
      for (const write of WRITES) {
        expect({ write, principal, status: agentCapture(`${write}-${principal}`).status }).toEqual({
          write,
          principal,
          status: 403,
        });
      }
    }
  });

  test("and nothing changed, where the API key's and a collection rw JWT's same upsert each add a point", () => {
    expect(countOf("write-count-before-full")).toBe(3);
    expect(countOf("write-count-after-refused-full")).toBe(3);
    expect(JSON.parse(agentCapture("write-state-collections-after-full").body).result.collections).toHaveLength(3);
    expect(JSON.parse(agentCapture("write-state-aliases-after-full").body).result.aliases).toEqual([
      { alias_name: "plain_alias", collection_name: "plain" },
    ]);
    expect(
      Object.keys(JSON.parse(agentCapture("write-state-collection-after-full").body).result.payload_schema),
    ).toEqual(["city"]);
    expect(agentCapture("write-upsert-full").status).toBe(200);
    expect(countOf("write-count-after-full-full")).toBe(4);
    expect(agentCapture("write-upsert-jwt-collection-write").status).toBe(200);
    expect(countOf("write-count-after-collection-write-full")).toBe(5);
    expect(countOf("write-count-restored-full")).toBe(3);
  });

  test("a collection-scoped read JWT is refused another collection's reads", () => {
    expect(errorOf("collection-other-jwt-collection-read")).toBe("Forbidden: Access to collection other is required");
    expect(agentCapture("count-other-jwt-collection-read").status).toBe(403);
  });
});

describe("a read-only key's query with an inference object", () => {
  test("calls the configured inference address, and a plain vector query does not", () => {
    for (const name of ["inference-document", "inference-image", "inference-object", "inference-prefetch"]) {
      const capture = agentCapture(`${name}-read-only`);
      expect({ name, status: capture.status, egress: capture.egressRequests }).toEqual({
        name,
        status: 500,
        egress: 1,
      });
    }
    const plain = agentCapture("inference-none-read-only");
    expect({ status: plain.status, egress: plain.egressRequests }).toEqual({ status: 200, egress: 0 });
  });
});

describe("what a read-only key reads", () => {
  test("the point reads, the searches and the facet answer stored payloads", () => {
    for (const name of ["points", "point", "scroll", "facet", "query", "query-groups"]) {
      const capture = agentCapture(`${name}-read-only`);
      expect({ name, status: capture.status, stored: capture.body.includes("stored-city-") }).toEqual({
        name,
        status: 200,
        stored: true,
      });
    }
  });

  test("the metadata reads answer no stored value", () => {
    for (const name of [
      "root",
      "collections",
      "collection",
      "exists",
      "aliases",
      "collection-aliases",
      "count",
      "cluster",
    ]) {
      const capture = agentCapture(`${name}-read-only`);
      expect({ name, status: capture.status, stored: capture.body.includes("stored-") }).toEqual({
        name,
        status: 200,
        stored: false,
      });
    }
  });
});
