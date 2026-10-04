/**
 * The `qdrant` credential record (vector-family spec 3.12 and 4.4), over the real row: the dialog's JWT
 * warning, decoded locally with no request, the no-secret refusal, and the provider's own connect() stage. Every
 * token here is minted at test time from a stand-in secret; none is written into a file.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({ logger: { debug, info, warn, error } }));

import {
  CREDENTIAL_WARNINGS,
  type CredentialWarning,
  credentialWarningFor,
  readOnlySeedRefusal,
} from "@/lib/db/credential-warnings";
import { getDBConfig } from "@/lib/db-ui-config";
import { QdrantProvider } from "@/lib/db/providers/vector/qdrant/index";
import { resolveConnectionCredentials } from "@/lib/seed/credential-resolver";
import { SeedConnectionSchema } from "@/lib/seed/types";
import type { DatabaseConnection } from "@/lib/types";

const TEST_PASSWORD = "password";
const TEST_JWT_SECRET = "password-second";
const EXP = 4102444800;
/** A claim value a warning must never repeat. */
const MARKER_SUB = "marker-subject-7f3a";

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An HS256 JWT minted now from the stand-in secret, as the live harness mints its own from the admin key. */
function mint(claims: Record<string, unknown>): string {
  const head = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}`;
  return `${head}.${createHmac("sha256", TEST_JWT_SECRET).update(head).digest("base64url")}`;
}

/**
 * Manage access and no `exp`, minted with a subject chosen so the payload's base64url holds both "-" and "_"
 * and needs padding it does not carry, which a decoder that skips the URL-safe mapping reads wrong.
 */
function mintUrlSafeManageNoExp(): string {
  for (let index = 0; index < 4096; index++) {
    const claims = { access: "m", sub: `?>${"?".repeat(index % 7)}>~${index}` };
    const payload = b64url(claims);
    if (payload.includes("-") && payload.includes("_") && payload.length % 4 !== 0) return mint(claims);
  }
  throw new Error("no subject gave a payload with both URL-safe characters and no padding");
}

const entries = CREDENTIAL_WARNINGS.qdrant ?? [];
const jwtEntry = entries.find((entry): entry is Extract<CredentialWarning, { kind: "jwt" }> => entry.kind === "jwt");
const noSecret = entries.find((entry) => entry.kind === "no-secret");
if (jwtEntry === undefined || noSecret === undefined)
  throw new Error("the qdrant record declares no jwt or no no-secret");

const JWT_SENTENCE = `Credential warning: ${jwtEntry.message}`;
const NO_SECRET_SENTENCE = `Credential warning: ${noSecret.message}`;

describe("the dialog's warning reads the real qdrant record", () => {
  test("DB_UI_CONFIG takes the record by reference", () => {
    expect(getDBConfig("qdrant").credentialWarnings).toBe(CREDENTIAL_WARNINGS.qdrant);
  });

  test("the jwt entry warns on no expiry and on manage or absent access, as vector-family spec 3.12 declares", () => {
    expect(jwtEntry).toMatchObject({ kind: "jwt", noExp: true, access: ["m", "absent"] });
  });

  /** The eleven cases of vector-family spec 3.12, over the real row. */
  const CASES: [string, () => string, string | undefined][] = [
    ["a JWT with manage access and an expiry", () => mint({ access: "m", exp: EXP, sub: MARKER_SUB }), JWT_SENTENCE],
    ["a JWT with no access claim and an expiry", () => mint({ exp: EXP, sub: MARKER_SUB }), JWT_SENTENCE],
    ["a JWT with read access and no expiry", () => mint({ access: "r", sub: MARKER_SUB }), JWT_SENTENCE],
    ["a JWT with read access and an expiry", () => mint({ access: "r", exp: EXP }), undefined],
    [
      "a JWT scoped to one collection, with an expiry",
      () => mint({ access: [{ collection: "docs", access: "r" }], exp: EXP }),
      undefined,
    ],
    ["a JWT whose expiry is not a number", () => mint({ access: "r", exp: "never", sub: MARKER_SUB }), JWT_SENTENCE],
    [
      "a JWT with read access, an expiry and extra claims",
      () => mint({ access: "r", exp: EXP, sub: MARKER_SUB, iat: 0, value_exists: { collection: "docs" } }),
      undefined,
    ],
    ["a JWT with manage access and no expiry in URL-safe base64 with no padding", mintUrlSafeManageNoExp, JWT_SENTENCE],
    ["an opaque API key", () => TEST_PASSWORD, undefined],
    ["a malformed three-part string", () => "not.a-token.at-all", undefined],
    ["an empty key", () => "", undefined],
  ];

  test.each(CASES)("%s", (_label, password, expected) => {
    expect(credentialWarningFor("qdrant", { password: password() })).toBe(expected);
  });

  test("the warning names no claim value and decodes with no request", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const sentence = credentialWarningFor("qdrant", { password: mint({ access: "m", sub: MARKER_SUB }) });
    expect(sentence).toBe(JWT_SENTENCE);
    expect(sentence).not.toContain(MARKER_SUB);
    for (const entry of entries) expect(entry.message).not.toMatch(/"access"|"exp"|\bm\b/);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    fetchSpy.mockRestore();
  });

  test("an empty key gives no dialog warning, since no-secret is the seed refusal's alone", () => {
    expect(credentialWarningFor("qdrant", { password: "" })).toBeUndefined();
    expect(readOnlySeedRefusal("qdrant", { password: "" })).toBe(NO_SECRET_SENTENCE);
    expect(readOnlySeedRefusal("qdrant", {})).toBe(NO_SECRET_SENTENCE);
  });

  test("a JWT refuses nothing at the seed: the jwt entry is the dialog's alone", () => {
    expect(readOnlySeedRefusal("qdrant", { password: mint({ access: "m" }) })).toBeUndefined();
  });
});

/** A client that records the operations it is asked for, answering as an open 1.19.1 server with no collection. */
function openServer() {
  const sent: string[] = [];
  const answer = (text: string) => ({ status: 200, contentType: "application/json", retryAfter: null, text });
  const client = {
    async send(request: { readonly op: string }) {
      sent.push(request.op);
      return request.op === "root"
        ? answer('{"title":"qdrant - vector search engine","version":"1.19.1"}')
        : answer('{"result":{"collections":[]},"status":"ok","time":0.000001}');
    },
    close() {},
  };
  return { createClient: mock(() => client), sent };
}

const connection = (overrides: Partial<DatabaseConnection>): DatabaseConnection =>
  ({
    id: "vectors",
    name: "Vectors",
    type: "qdrant",
    host: "127.0.0.1",
    port: 6333,
    createdAt: new Date(0),
    ...overrides,
  }) as DatabaseConnection;

describe("connect(): the provider's own stage, after resolution (vector-family spec 3.12)", () => {
  test("a resolved read-only seed with no key is refused before any client exists", async () => {
    const { createClient, sent } = openServer();
    const provider = new QdrantProvider(
      connection({ seedId: "vectors", readOnly: true }),
      {},
      {},
      createClient as never,
    );
    await expect(provider.connect()).rejects.toThrow(NO_SECRET_SENTENCE);
    expect(createClient).toHaveBeenCalledTimes(0);
    expect(sent).toEqual([]);
  });

  test("a resolved read-only seed with an empty key is refused the same way", async () => {
    const { createClient } = openServer();
    const provider = new QdrantProvider(
      connection({ seedId: "vectors", readOnly: true, password: "" }),
      {},
      {},
      createClient as never,
    );
    await expect(provider.connect()).rejects.toThrow(NO_SECRET_SENTENCE);
    expect(createClient).toHaveBeenCalledTimes(0);
  });

  test("a user's own connection with no key opens, with exactly GET / and GET /collections", async () => {
    const { createClient, sent } = openServer();
    const provider = new QdrantProvider(connection({}), {}, {}, createClient as never);
    await provider.connect();
    expect(sent).toEqual(["root", "get_collections"]);
    await provider.disconnect();
  });

  test("a read-only seed holding a key opens", async () => {
    const { createClient, sent } = openServer();
    const provider = new QdrantProvider(
      connection({ seedId: "vectors", readOnly: true, password: TEST_PASSWORD }),
      {},
      {},
      createClient as never,
    );
    await provider.connect();
    expect(sent).toEqual(["root", "get_collections"]);
    await provider.disconnect();
  });

  test("a non-empty user is refused naming the field, before any client exists (vector-family spec 4.4)", async () => {
    const { createClient } = openServer();
    const provider = new QdrantProvider(
      connection({ user: "root", password: TEST_PASSWORD }),
      {},
      {},
      createClient as never,
    );
    await expect(provider.connect()).rejects.toThrow(/user/i);
    expect(createClient).toHaveBeenCalledTimes(0);
  });
});

const seed = {
  id: "vectors-read",
  name: "Vectors",
  type: "qdrant",
  host: "qdrant.internal",
  port: 6333,
  roles: ["*"],
  managed: true,
  readOnly: true,
} as const;

function issuesOf(candidate: Record<string, unknown>): [string, string][] {
  const result = SeedConnectionSchema.safeParse(candidate);
  return result.success ? [] : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

function refusedAtLoad(refusal: string): string {
  return `Seed connection "vectors-read": ${refusal} readOnly: true is refused with this credential, because the mode would promise a boundary the server does not keep. Give this connection a credential of its own, or remove readOnly.`;
}

describe("load: the seed file refuses what it shows (vector-family spec 3.12)", () => {
  afterEach(() => {
    delete process.env.QDRANT_SEED_KEY;
  });

  test("a read-only seed with no key, or an empty one, is refused naming the connection and the field", () => {
    expect(issuesOf({ ...seed })).toEqual([["password", refusedAtLoad(NO_SECRET_SENTENCE)]]);
    expect(issuesOf({ ...seed, password: "" })).toEqual([["password", refusedAtLoad(NO_SECRET_SENTENCE)]]);
  });

  test("a read-only seed holding a key loads, and one without readOnly loads with no key", () => {
    expect(issuesOf({ ...seed, password: TEST_PASSWORD })).toEqual([]);
    expect(issuesOf({ ...seed, readOnly: undefined })).toEqual([]);
  });

  test("a ${ENV} reference that resolves to nothing is refused after resolution, by the provider, with zero client calls", async () => {
    process.env.QDRANT_SEED_KEY = "";
    const parsed = SeedConnectionSchema.parse({ ...seed, password: "${QDRANT_SEED_KEY}" });
    const resolved = resolveConnectionCredentials(parsed);
    expect(readOnlySeedRefusal("qdrant", resolved)).toBe(NO_SECRET_SENTENCE);
    const { createClient } = openServer();
    const provider = new QdrantProvider(
      connection({ seedId: resolved.id, readOnly: true, password: resolved.password }),
      {},
      {},
      createClient as never,
    );
    await expect(provider.connect()).rejects.toThrow(NO_SECRET_SENTENCE);
    expect(createClient).toHaveBeenCalledTimes(0);
  });
});
