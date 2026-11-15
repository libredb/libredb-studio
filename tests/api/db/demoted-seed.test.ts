/**
 * A seed demoted from `managed: true` to `managed: false`, end to end, the way an operator and a user meet it.
 *
 * `managed: true` is the operator's grant that lets a keyless BigQuery seed sign in as the server
 * (`BIGQUERY_SERVER_CREDENTIALS=true`); rewriting the seed file with `managed: false` withdraws it. The seed file is
 * read again once the operator loader's cache is older than SEED_CACHE_TTL_MS, so after that the same connection id
 * must be refused the server's identity, and a provider opened under the grant must not be served to it.
 *
 * The real POST /api/db/query, operator loader, resolveConnection, factory, BigQuery provider and token source run
 * here. Only two modules are replaced: the session, and `createNodeTransport` with a fake Google that counts token
 * grants and logs every API request with its `authorization`, so the log shows which provider answered.
 * `mock.module()` is process-wide, so the runner gives this file its own process.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
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

/** Google as BigQuery's transport sees it: token grants are counted, every API request is logged with its bearer. */
class FakeGoogle {
  tokensIssued = 0;
  requests: { method: string; path: string; authorization: string | undefined }[] = [];

  create(options: NodeTransportOptions) {
    const authorization = options.headers.authorization;
    return {
      request: async (request: NodeRequest): Promise<NodeResponse> => {
        const reply = this.route(request, new URL(request.url), authorization);
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
    const path = url.pathname.replace("/bigquery/v2/projects/demo-project", "");
    this.requests.push({ method: request.method, path, authorization });
    if (request.method === "GET" && path === "/datasets") return captured("datasets-list");
    if (request.method === "POST" && path === "/queries") return captured("select-1");
    return { status: 404, json: { error: { code: 404, message: `no route for ${request.method} ${path}` } } };
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
const { GET: listManaged } = await import("@/app/api/connections/managed/route");

/** Short, so the test waits past it; the reload it runs is the one the 60-second default runs. */
const SEED_TTL_MS = 50;

let scratch: string;
let seedFile: string;

function writeSeed(managed: boolean): void {
  writeFileSync(
    seedFile,
    JSON.stringify({
      version: "1",
      connections: [
        { id: "bq", name: "Demo BigQuery", type: "bigquery", database: "demo-project", managed, roles: ["admin"] },
      ],
    }),
  );
}

async function query(): Promise<{ status: number; data: Record<string, unknown> }> {
  clearRateLimitState();
  const res = await POST(
    createMockRequest("/api/db/query", { method: "POST", body: { connectionId: "seed:bq", sql: "SELECT 1" } }) as never,
  );
  return { status: res.status, data: await parseResponseJSON<Record<string, unknown>>(res) };
}

const saved: Record<string, string | undefined> = {};
const ENV = ["SEED_CONFIG_PATH", "SEED_CACHE_TTL_MS", "BIGQUERY_SERVER_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS"];

beforeAll(() => {
  for (const name of ENV) saved[name] = process.env[name];
  scratch = mkdtempSync(join(tmpdir(), "libredb-demoted-seed-"));
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
  seedFile = join(scratch, "seed-connections.json");
  process.env.SEED_CONFIG_PATH = seedFile;
  process.env.SEED_CACHE_TTL_MS = String(SEED_TTL_MS);
  process.env.BIGQUERY_SERVER_CREDENTIALS = "true";
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyFile;
  resetCache();
});

afterAll(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetCache();
  rmSync(scratch, { recursive: true, force: true });
});

describe("a BigQuery seed demoted from managed: true to managed: false", () => {
  test("is refused the server's identity on the next request, and the provider opened under the grant is not served", async () => {
    // (a) and (b): the operator grants server identity; a provider signed in as the server is now cached.
    writeSeed(true);
    const first = await query();
    expect(first.status).toBe(200);
    expect(google.tokensIssued).toBe(1);
    expect(google.requests.length).toBeGreaterThan(0);
    expect(google.requests.every((r) => r.authorization === "Bearer ya29.fake-token-1")).toBe(true);
    const requestsUnderGrant = google.requests.length;

    // (c): the operator withdraws the grant; the reload has taken once the managed list says so.
    writeSeed(false);
    await Bun.sleep(SEED_TTL_MS * 3);
    const listed = await listManaged();
    expect(listed.status).toBe(200);
    const body = await parseResponseJSON<{ connections: { id: string; managed: boolean }[] }>(listed);
    expect(body.connections.find((c) => c.id === "seed:bq")?.managed).toBe(false);

    // (d): the same request on the same connection id.
    const second = await query();
    // Refused before any transport is built: no request reaches Google and no token is granted.
    expect(google.requests.slice(requestsUnderGrant)).toEqual([]);
    expect(google.tokensIssued).toBe(1);
    expect(second.status).not.toBe(200);
    expect(String(second.data.error)).toContain(
      "BigQuery needs a service-account key or an access token in the password field",
    );
  });
});
