/**
 * A seed file read in literal mode (SEED_LITERAL_VALUES=true) is written by a platform from data its users control,
 * so a row in it must not sign in with the server's own Google identity just because its password is empty.
 *
 * `managed` defaults to true for a seed row, and BIGQUERY_SERVER_CREDENTIALS / FIRESTORE_SERVER_CREDENTIALS let a
 * managed seed with an empty password use the server's identity (GOOGLE_APPLICATION_CREDENTIALS, then gcloud's ADC
 * file, then the metadata server). With the file in literal mode the empty password is a platform user's choice, not
 * the operator's grant, so the request must be refused before any request reaches Google. With literal mode off the
 * same file is the operator's, and the documented server-identity path answers. A provider opened as the server with
 * the mode off is not served to the same row once the mode is on, because the provider cache key frames the marker.
 *
 * The real POST /api/db/query, operator loader, resolveConnection, factory, BigQuery and Firestore providers and
 * their token sources run here. Only two modules are replaced: the session, and `createNodeTransport` with a fake
 * Google that counts token grants and logs every API request with its `authorization`.
 * `mock.module()` is process-wide, so the runner gives this file its own process.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { NodeRequest, NodeResponse, NodeTransportOptions } from "@/lib/db/http/node-transport";
import { resetCache } from "@/lib/seed";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

type Wire = Record<string, unknown>;

const CAPTURES = join(import.meta.dir, "..", "..", "fixtures", "bigquery", "2026-10-13-eu");
function captured(scenario: string): { status: number; json: Wire } {
  const file = JSON.parse(readFileSync(join(CAPTURES, `${scenario}.json`), "utf8")) as {
    exchanges: { response: { status: number; body: Wire } }[];
  };
  const { status, body } = file.exchanges[0].response;
  return { status, json: body };
}

/** Google as both providers' transports see it: token grants are counted, every API request is logged. */
class FakeGoogle {
  tokensIssued = 0;
  requests: { host: string; method: string; path: string; authorization: string | undefined }[] = [];

  reset(): void {
    this.tokensIssued = 0;
    this.requests = [];
  }

  create(options: NodeTransportOptions) {
    const authorization = options.headers?.authorization;
    return {
      request: async (request: NodeRequest): Promise<NodeResponse> => {
        const url = new URL(request.url);
        const reply = this.route(request, url, request.headers?.authorization ?? authorization);
        return {
          status: reply.status,
          contentType: "application/json",
          retryAfter: null,
          text: JSON.stringify(reply.json),
        };
      },
      close: () => {},
    };
  }

  private route(request: NodeRequest, url: URL, authorization: string | undefined): { status: number; json: Wire } {
    if (url.host === "oauth2.googleapis.com") {
      this.tokensIssued += 1;
      return { status: 200, json: { access_token: `ya29.fake-token-${this.tokensIssued}`, expires_in: 3600 } };
    }
    this.requests.push({ host: url.host, method: request.method, path: url.pathname, authorization });
    if (url.host === "bigquery.googleapis.com") {
      const path = url.pathname.replace("/bigquery/v2/projects/demo-project", "");
      if (request.method === "GET" && path === "/datasets") return captured("datasets-list");
      if (request.method === "POST" && path === "/queries") return captured("select-1");
    }
    if (url.host === "firestore.googleapis.com") {
      if (
        request.method === "GET" &&
        decodeURIComponent(url.pathname) === "/v1/projects/demo-project/databases/(default)"
      ) {
        return { status: 200, json: { name: "projects/demo-project/databases/(default)", type: "FIRESTORE_NATIVE" } };
      }
      if (request.method === "POST" && url.pathname.endsWith(":listCollectionIds")) {
        return { status: 200, json: { collectionIds: ["users"] } };
      }
    }
    return { status: 404, json: { error: { code: 404, message: `no route for ${request.method} ${url.pathname}` } } };
  }
}

const google = new FakeGoogle();
const realNode = { ...(await import("@/lib/db/http/node-transport")) };
mock.module("@/lib/db/http/node-transport", () => ({
  ...realNode,
  createNodeTransport: (options: NodeTransportOptions) => google.create(options),
}));

const ADMIN = { role: "admin", username: "admin" };
// The spread form, not a hand-written stub: only the session is replaced (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: async () => ADMIN,
  readSession: async () => ({ kind: "authenticated", session: ADMIN }),
}));

const { POST } = await import("@/app/api/db/query/route");
const { BIGQUERY_CREDENTIAL_SENTENCES } = await import("@/lib/db/providers/sql/bigquery/credential-policy");
const { FIRESTORE_CREDENTIAL_SENTENCES } = await import("@/lib/db/providers/document/firestore/credential-policy");
const { clearProviderCache } = await import("@/lib/db/factory");

let scratch: string;

async function query(connectionId: string, sql: string): Promise<{ status: number; data: Record<string, unknown> }> {
  clearRateLimitState();
  const res = await POST(createMockRequest("/api/db/query", { method: "POST", body: { connectionId, sql } }) as never);
  return { status: res.status, data: await parseResponseJSON<Record<string, unknown>>(res) };
}

function report(label: string, answer: { status: number; data: Record<string, unknown> }): void {
  console.log(
    `[${label}] status=${answer.status} tokensIssued=${google.tokensIssued} requests=${google.requests.length}` +
      ` error=${JSON.stringify(answer.data.error ?? null)} bearers=${JSON.stringify([...new Set(google.requests.map((r) => r.authorization))])}`,
  );
}

const saved: Record<string, string | undefined> = {};
const ENV = [
  "SEED_CONFIG_PATH",
  "SEED_LITERAL_VALUES",
  "BIGQUERY_SERVER_CREDENTIALS",
  "FIRESTORE_SERVER_CREDENTIALS",
  "FIRESTORE_EMULATOR_HOST",
  "GOOGLE_APPLICATION_CREDENTIALS",
];

beforeAll(() => {
  for (const name of ENV) saved[name] = process.env[name];
  scratch = mkdtempSync(join(tmpdir(), "libredb-literal-seed-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keyFile = join(scratch, "server-key.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      type: "service_account",
      client_email: "studio@demo-project.iam.gserviceaccount.com",
      private_key: privateKey,
    }),
  );
  // What a platform writes for two databases its users created: no `managed` field, the password left empty.
  const seedFile = join(scratch, "seed-connections.json");
  writeFileSync(
    seedFile,
    JSON.stringify({
      version: "1",
      connections: [
        {
          id: "bq",
          name: "Tenant BigQuery",
          type: "bigquery",
          database: "demo-project",
          password: "",
          roles: ["admin"],
        },
        {
          id: "fs",
          name: "Tenant Firestore",
          type: "firestore",
          database: "demo-project",
          password: "",
          roles: ["admin"],
        },
      ],
    }),
  );
  process.env.SEED_CONFIG_PATH = seedFile;
  process.env.BIGQUERY_SERVER_CREDENTIALS = "true";
  process.env.FIRESTORE_SERVER_CREDENTIALS = "true";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
  delete process.env.FIRESTORE_EMULATOR_HOST;
});

afterEach(async () => {
  await clearProviderCache();
  resetCache();
  google.reset();
});

afterAll(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetCache();
  rmSync(scratch, { recursive: true, force: true });
});

const CASES = [
  { provider: "BigQuery", id: "seed:bq", sql: "SELECT 1", optIn: "BIGQUERY_SERVER_CREDENTIALS" },
  { provider: "Firestore", id: "seed:fs", sql: "db.listCollections()", optIn: "FIRESTORE_SERVER_CREDENTIALS" },
] as const;

const SENTENCES: Record<(typeof CASES)[number]["provider"], string> = {
  BigQuery: BIGQUERY_CREDENTIAL_SENTENCES.literalSeedFile,
  Firestore: FIRESTORE_CREDENTIAL_SENTENCES.literalSeedFile,
};

describe("a literal-mode seed row with an empty password", () => {
  test.each(CASES)("$provider, with the opt-in: refused with its sentence, no token and no request", async (c) => {
    process.env.SEED_LITERAL_VALUES = "true";
    const answer = await query(c.id, c.sql);
    report(`${c.provider} literal`, answer);
    expect(answer.data.error).toBe(SENTENCES[c.provider]);
    expect(google.tokensIssued).toBe(0);
    expect(google.requests).toEqual([]);
  });

  test.each(CASES)("$provider, without the opt-in: refused with the same sentence, no request", async (c) => {
    process.env.SEED_LITERAL_VALUES = "true";
    delete process.env[c.optIn];
    try {
      const answer = await query(c.id, c.sql);
      expect(answer.data.error).toBe(SENTENCES[c.provider]);
      expect(google.tokensIssued).toBe(0);
      expect(google.requests).toEqual([]);
    } finally {
      process.env[c.optIn] = "true";
    }
  });

  test.each(CASES)(
    "$provider: a provider opened as the server with the mode off is not served once the mode is on",
    async (c) => {
      delete process.env.SEED_LITERAL_VALUES;
      const before = await query(c.id, c.sql);
      expect(before.status).toBe(200);
      expect(google.tokensIssued).toBe(1);
      const requestsBefore = google.requests.length;

      // The same running process, its provider cache untouched: only the mode changes.
      process.env.SEED_LITERAL_VALUES = "true";
      const after = await query(c.id, c.sql);
      expect(after.data.error).toBe(SENTENCES[c.provider]);
      expect(google.tokensIssued).toBe(1);
      expect(google.requests.length).toBe(requestsBefore);
    },
  );
});

describe("control: the same file with literal mode off is the operator's, and server identity is documented", () => {
  test.each(CASES)("$provider answers with a token granted for the server's key", async (c) => {
    delete process.env.SEED_LITERAL_VALUES;
    const answer = await query(c.id, c.sql);
    report(`${c.provider} control`, answer);
    expect(answer.status).toBe(200);
    expect(google.tokensIssued).toBe(1);
    expect(google.requests.length).toBeGreaterThan(0);
    expect(google.requests.every((r) => r.authorization === "Bearer ya29.fake-token-1")).toBe(true);
  });
});
