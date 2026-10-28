/**
 * GET /api/auth/oidc/login and the Kubernetes access review's loop guard (docs/SECURITY.md, control 1.12).
 *
 * A tripped retry marker (`access-review-retry=loop`) means a session's groups record went missing again right after
 * the silent sign-in that wrote it. Instead of another round trip, the route answers with the sign-in page and its
 * `oidc_groups_lost` message, which the proxy never redirects onward, deletes the marker so a sign-in by hand tries once
 * more, and audits the refusal. An armed marker, a first miss, goes to the provider as every sign-in does, and so does
 * a tripped one while the review is off.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const mockGenerateAuthUrl = mock(async () => ({
  url: new URL("https://rancher.example.com/oidc/authorize?state=abc"),
  state: { code_verifier: "v", state: "s", nonce: "n" },
}));

mock.module("@/lib/oidc", () => ({
  getOIDCConfig: mock(() => ({
    issuer: "https://rancher.example.com/oidc",
    clientId: "client-test",
    clientSecret: "not-a-real-secret",
    scope: "openid profile groups",
    roleClaim: "",
    adminRoles: ["admin"],
    prompt: "omit",
  })),
  discoverProvider: mock(async () => "mock-config"),
  generateAuthUrl: mockGenerateAuthUrl,
  encryptState: mock(async () => "encrypted-state-token"),
  decryptState: mock(async () => ({})),
  exchangeCode: mock(async () => ({})),
  mapOIDCRole: mock(() => "user"),
  resetDiscoveryCache: mock(() => {}),
  getPublicOrigin: mock((request: Request) => new URL(request.url).origin),
}));

let jar: Record<string, { value: string } | undefined> = {};
const deleted: { name: string; path?: string }[] = [];

mock.module("next/headers", () => ({
  cookies: mock(async () => ({
    get: (name: string) => jar[name],
    set: mock(() => {}),
    delete: (cookie: { name: string; path?: string }) => deleted.push(cookie),
  })),
  headers: mock(async () => ({ get: () => null })),
}));

const { GET } = await import("@/app/api/auth/oidc/login/route");

let log: ReturnType<typeof spyOn>;

beforeEach(() => {
  jar = {};
  deleted.length = 0;
  mockGenerateAuthUrl.mockClear();
  process.env.KUBERNETES_ACCESS_REVIEW = "on";
  log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  delete process.env.KUBERNETES_ACCESS_REVIEW;
});

const signIn = () => GET(new Request("https://studio.example.com/api/auth/oidc/login?next=%2F"));

describe("GET /api/auth/oidc/login with the access review on", () => {
  test("a tripped retry marker shows the sign-in page with oidc_groups_lost, consumes the marker and audits it", async () => {
    jar["access-review-retry"] = { value: "loop" };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://studio.example.com/login?error=oidc_groups_lost");
    expect(deleted).toEqual([{ name: "access-review-retry", path: "/" }]);
    expect(mockGenerateAuthUrl).not.toHaveBeenCalled();
    const audit = (log.mock.calls as unknown[][]).map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(audit).toContainEqual(
      expect.objectContaining({ event: "login_failure", reason: "oidc_groups_lost", actor: "anonymous" }),
    );
  });

  test("an armed marker, the first miss, goes to the provider", async () => {
    jar["access-review-retry"] = { value: "1793174400" };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://rancher.example.com/oidc/authorize?state=abc");
    expect(deleted).toEqual([]);
  });

  test("with the review off, a tripped marker is ignored", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW = "off";
    jar["access-review-retry"] = { value: "loop" };
    const response = await signIn();
    expect(response.headers.get("location")).toBe("https://rancher.example.com/oidc/authorize?state=abc");
  });
});
