/**
 * The catalog of the Qdrant evidence harness (vector-family spec 7.3), held without a server: what it captures, that
 * every request is one of the 17 routes, how a JWT is minted, what a capture records and what stops a run.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  assertNoSecret,
  CAPTURE_GROUPS,
  type CaptureSpec,
  captureProblem,
  captureRecord,
  HARNESS_PREFIX,
  JWT_CLAIMS,
  mintJwt,
  QDRANT_SERVICES,
  qdrantCatalog,
  RATE_COLLECTION,
  redactedHeaders,
  routeCaptures,
  SEEDED_COLLECTIONS,
  STRICT_COLLECTION,
  slowFilter,
} from "../../../live/qdrant-evidence-catalog";
import { QDRANT_ROUTE_FIXTURE } from "../../../helpers/qdrant-routes";

// Named stand-ins, never realistic values.
// The HS256 signing stand-in: named for its role, since the mintJwt test hashes the token it mints on purpose.
const SIGNER = "password";
const TEST_PASSWORD_SECOND = "password-second";
const ROUTES = QDRANT_ROUTE_FIXTURE.routes;
const CATALOG = qdrantCatalog(ROUTES);
const PROVENANCE = { image: "ghcr.io/qdrant/qdrant/qdrant:v1.19.1", digest: "sha256:0", version: "1.19.1" };
const RUN = { date: "2026-10-03T12:00:00.000Z", runtime: "bun 1.4.2", attempts: 1 };
const find = (name: string) => CATALOG.find((spec) => `${spec.service}/${spec.name}` === name) as CaptureSpec;

describe("the catalog", () => {
  test("names 235 captures, each once, in the eight groups", () => {
    const names = CATALOG.map((spec) => `${spec.service}/${spec.name}`);
    expect(names).toHaveLength(235);
    expect(new Set(names).size).toBe(235);
    for (const name of names) expect(name).toMatch(/^qdrant(?:-auth|-tls|-mtls)?\/[a-z0-9_-]+$/);
    expect(
      Object.fromEntries(CAPTURE_GROUPS.map((group) => [group, CATALOG.filter((spec) => spec.group === group).length])),
    ).toEqual({
      routes: 101,
      credentials: 72,
      aliases: 27,
      timeouts: 6,
      strict: 5,
      errors: 7,
      filters: 6,
      tls: 11,
    });
  });

  test("the four services are the compose services, on their loopback ports", () => {
    expect(QDRANT_SERVICES).toEqual({
      qdrant: { port: 6333, container: "libredb-qdrant", tls: false },
      "qdrant-auth": { port: 6343, container: "libredb-qdrant-auth", tls: false },
      "qdrant-tls": { port: 6353, container: "libredb-qdrant-tls", tls: true },
      "qdrant-mtls": { port: 6363, container: "libredb-qdrant-mtls", tls: true },
    });
  });

  test("every request is a GET or a POST on one of the 17 routes: no snapshot, telemetry or write route", () => {
    const templates = ROUTES.map((route) => ({
      op: route.op,
      line: new RegExp(`^${route.method} ${route.path.replace(/\{[a-z_]+\}/g, "[^/?]+")}(?:\\?timeout=\\d+)?$`),
    }));
    for (const spec of CATALOG) {
      const template = templates.find((entry) => entry.op === spec.op);
      expect({ name: spec.name, known: template?.line.test(`${spec.method} ${spec.path}`) }).toEqual({
        name: spec.name,
        known: true,
      });
    }
  });

  test("the 17 routes run on every seeded collection, the scroll of each collection first", () => {
    const routes = routeCaptures(ROUTES);
    for (const collection of SEEDED_COLLECTIONS) {
      const own = routes.filter((spec) => spec.name.endsWith(`-${collection}`));
      expect(own).toHaveLength(14);
      expect(own[0].name).toBe(`scroll-points-${collection}`);
    }
  });

  test("the ids of a collection's own scroll reach its two retrieve routes with their exact digits", () => {
    const routes = routeCaptures(ROUTES, {
      docs: ["0", "42", "9007199254740993"],
      plain: ['"8d8f5313-0adf-5d8a-8c43-b7f7e98405c3"'],
    });
    const named = (name: string) => routes.find((spec) => spec.name === name) as CaptureSpec;
    expect(named("get-points-docs").body).toBe(
      '{"ids":[0,42,9007199254740993],"with_payload":true,"with_vector":true}',
    );
    expect(named("get-point-docs").path).toBe("/collections/docs/points/0");
    expect(named("get-points-plain").body).toBe(
      '{"ids":["8d8f5313-0adf-5d8a-8c43-b7f7e98405c3"],"with_payload":true,"with_vector":true}',
    );
    expect(named("get-point-plain").path).toBe("/collections/plain/points/8d8f5313-0adf-5d8a-8c43-b7f7e98405c3");
    // A collection with no point asks for id 1, and records what the server says.
    expect(named("get-points-scratch").body).toBe('{"ids":[1],"with_payload":true,"with_vector":true}');
    expect(named("get-point-scratch").path).toBe("/collections/scratch/points/1");
  });

  test("the harness's own collections sit under its prefix, and no capture writes anywhere", () => {
    expect(STRICT_COLLECTION.startsWith(HARNESS_PREFIX)).toBe(true);
    expect(RATE_COLLECTION.startsWith(HARNESS_PREFIX)).toBe(true);
    for (const spec of CATALOG.filter((entry) => entry.group === "strict")) expect(spec.path).toContain(HARNESS_PREFIX);
    expect(new Set(CATALOG.map((spec) => spec.method))).toEqual(new Set(["GET", "POST"] as const));
  });

  test("no capture names a model or an options object, a snapshot route, or a key in a URL", () => {
    for (const spec of CATALOG) {
      expect(spec.body ?? "").not.toMatch(/"model"|"options"/);
      expect(spec.path).not.toMatch(/snapshots\/|api[_-]key/);
    }
  });

  test("a slow filter is `count` conditions that match no point", () => {
    expect(JSON.parse(slowFilter(2, "sku"))).toEqual({
      should: [
        { key: "sku", match: { value: "no-such-value-0" } },
        { key: "sku", match: { value: "no-such-value-1" } },
      ],
    });
    const scroll = find("qdrant/timeout-scroll");
    expect((JSON.parse(scroll.body as string) as { filter: { should: unknown[] } }).filter.should).toHaveLength(400);
    expect(find("qdrant/timeout-groups-408")).toMatchObject({ expectStatus: 408, attempts: 24 });
    expect(find("qdrant/timeout-groups-500")).toMatchObject({ expectStatus: 500, attempts: 24 });
  });
});

describe("mintJwt", () => {
  test("is an HS256 token whose signature verifies with the secret, and whose claims decode", () => {
    const token = mintJwt({ access: "r", exp: 1 }, SIGNER);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ access: "r", exp: 1 });
    // The expected token is built here from the known header and claims, so the check never re-signs what it reads.
    const encode = (value: object) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const signed = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ access: "r", exp: 1 })}`;
    expect(token).toBe(`${signed}.${createHmac("sha256", SIGNER).update(signed).digest("base64url")}`);
    expect(mintJwt({ access: "r", exp: 1 }, TEST_PASSWORD_SECOND).split(".")[2]).not.toBe(signature);
  });

  test("the declared claims are the research's, plus the two the alias matrix needs", () => {
    expect(Object.keys(JWT_CLAIMS).sort()).toEqual([
      "jwt-alias-and-collection",
      "jwt-alias-only",
      "jwt-bad-signature",
      "jwt-collection-only",
      "jwt-empty-access",
      "jwt-expired",
      "jwt-global-manage",
      "jwt-global-read",
      "jwt-no-access-claim",
      "jwt-scoped",
    ]);
    expect(JWT_CLAIMS["jwt-no-access-claim"]).toEqual({});
    expect(JWT_CLAIMS["jwt-empty-access"]).toEqual({ access: [] });
    expect((JWT_CLAIMS["jwt-expired"] as { exp: number }).exp).toBeLessThan(Date.now() / 1000);
  });
});

describe("what a capture records, and what stops a run", () => {
  const spec = find("qdrant-auth/jwt-scoped-get-collections");
  const answered = { status: 200, contentType: "application/json", retryAfter: null, bodyBytes: 2, body: "{}" };

  test("the credential header is a placeholder by the credential's kind", () => {
    expect(redactedHeaders("none")).toEqual({});
    expect(redactedHeaders("admin-key")).toEqual({ "api-key": "<api-key>" });
    expect(redactedHeaders("wrong-key")).toEqual({ "api-key": "<api-key>" });
    expect(redactedHeaders("jwt-scoped")).toEqual({ "api-key": "<token>" });
  });

  test("a record holds the provenance, the request with its placeholder, and a pass or a fail", () => {
    const record = captureRecord(spec, PROVENANCE, RUN, answered);
    expect(record.$captured).toEqual({
      engine: "qdrant",
      service: "qdrant-auth",
      ...PROVENANCE,
      date: RUN.date,
      runtime: RUN.runtime,
      surface: "GET /collections with jwt-scoped",
      op: "get_collections",
      credential: "jwt-scoped",
      attempts: 1,
      request: { method: "GET", path: "/collections", headers: { "api-key": "<token>" }, body: null },
    });
    expect(record.outcome).toBe("pass");
    expect(captureRecord(spec, PROVENANCE, RUN, { ...answered, status: 403 }).outcome).toBe("fail");
    expect(
      captureRecord(spec, PROVENANCE, RUN, { error: { code: "ECONNRESET", message: "socket hang up" } }).outcome,
    ).toBe("fail");
  });

  test("a long generated filter is recorded as a note, never as its text", () => {
    const record = captureRecord(find("qdrant/timeout-scroll"), PROVENANCE, RUN, { ...answered, status: 500 });
    expect(record.$captured.request.body).toBe(
      "<a should filter of 400 match.value conditions on sku that match no point>",
    );
    expect(captureRecord(find("qdrant/count-points-docs"), PROVENANCE, RUN, answered).$captured.request.body).toBe(
      '{"exact":true}',
    );
  });

  test("an answer with another status than the capture declares is a problem; an undeclared status never is", () => {
    expect(captureProblem(spec, answered)).toBeNull();
    expect(captureProblem(spec, { ...answered, status: 403, body: "ExpiredSignature" })).toBe(
      "qdrant-auth/jwt-scoped-get-collections: expected HTTP 200, got HTTP 403: ExpiredSignature",
    );
    expect(captureProblem(find("qdrant/facet-plain"), { ...answered, status: 400 })).toBeNull();
    expect(captureProblem(spec, { error: { code: "ECONNREFUSED", message: "connect refused" } })).toBe(
      "qdrant-auth/jwt-scoped-get-collections: no HTTP answer: ECONNREFUSED connect refused",
    );
    expect(captureProblem(spec, { error: { code: null, message: "x" } })).toBe(
      "qdrant-auth/jwt-scoped-get-collections: no HTTP answer:  x",
    );
  });

  test("a capture that must fail before any answer is a problem when the server answers", () => {
    const refused = find("qdrant-tls/tls-no-ca");
    expect(captureProblem(refused, { error: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", message: "x" } })).toBeNull();
    expect(captureProblem(refused, answered)).toBe("qdrant-tls/tls-no-ca: expected no HTTP answer, got HTTP 200");
  });

  test("a file that would hold a key, a JWT, one of its segments or a PEM block is refused by name", () => {
    const token = mintJwt({ access: "r" }, TEST_PASSWORD_SECOND);
    const [, claims, signature] = token.split(".");
    const secrets = [TEST_PASSWORD_SECOND, token];
    expect(() => assertNoSecret("a.json", '{"body":"fine"}', secrets)).not.toThrow();
    for (const text of [`x ${TEST_PASSWORD_SECOND} y`, token, `claims ${claims}`, `signature ${signature}`]) {
      expect(() => assertNoSecret("a.json", text, secrets)).toThrow(
        "a.json would hold a credential this run sent: nothing written",
      );
    }
    expect(() => assertNoSecret("a.json", "-----BEGIN CERTIFICATE-----", [])).toThrow(
      "a.json would hold a key or a certificate",
    );
    expect(() => assertNoSecret("a.json", "anything", [""])).not.toThrow();
  });
});
