import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { openShiftCallbackUrl } from "@/lib/openshift-auth/config";
import { exchangeOpenShiftCode, grantedScopeAccepted, openShiftAuthorizationUrl } from "@/lib/openshift-auth/flow";
import { checkOpenShiftMetadata, type OpenShiftServerMetadata } from "@/lib/openshift-auth/metadata";
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  closedPort,
  type FakeCluster,
  startFakeCluster,
  TOKEN_PATH,
} from "../../../helpers/openshift-auth/fake-cluster";

let cluster: FakeCluster;
let metadata: OpenShiftServerMetadata;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  cluster.reset();
  cluster.useEnv();
  const checked = checkOpenShiftMetadata(cluster.metadata());
  if (checked.kind !== "ok") throw new Error("the fake cluster's metadata must pass");
  metadata = checked.metadata;
});

/** One sign-in up to the token answer: the authorize URL, the person's approval, the exchange. */
async function signIn(returnTo: string | null = null) {
  const { url, state } = await openShiftAuthorizationUrl(metadata, returnTo);
  const params = cluster.authorize(url);
  return { url, state, params, outcome: await exchangeOpenShiftCode(metadata, params, state) };
}

describe("openShiftAuthorizationUrl", () => {
  test("asks for exactly the code flow with PKCE S256, the pinned scope and the public redirect URI", async () => {
    const { url, state } = await openShiftAuthorizationUrl(metadata, "/sql");
    expect(`${url.origin}${url.pathname}`).toBe(`${cluster.issuerOrigin}/oauth/authorize`);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("https://studio.apps.example.com/api/auth/openshift/callback");
    expect(url.searchParams.get("scope")).toBe("user:info user:check-access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(state.state);
    expect(state.return_to).toBe("/sql");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.has("nonce")).toBe(false);
    const { state: noReturn } = await openShiftAuthorizationUrl(metadata, null);
    expect("return_to" in noReturn).toBe(false);
    expect(noReturn.state).not.toBe(state.state);
    expect(noReturn.code_verifier).not.toBe(state.code_verifier);
  });
});

describe("exchangeOpenShiftCode", () => {
  test("exchanges the code with the verifier, the public redirect URI and the client secret in the body", async () => {
    const { url, outcome } = await signIn();
    expect(outcome).toEqual({ kind: "token", accessToken: ACCESS_TOKEN, expiresIn: 31536000 });
    const [sent] = cluster.received("oauth");
    expect(sent.path).toBe(TOKEN_PATH);
    expect(sent.headers.authorization).toBeUndefined();
    const form = new URLSearchParams(sent.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(openShiftCallbackUrl());
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    // The fake token endpoint refused nothing, and the challenge is the S256 of the verifier sent (PKCE).
    const verifier = form.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge") ?? "",
    );
    // The API server saw nothing: the token call goes to the OAuth server only.
    expect(cluster.received("api")).toEqual([]);
  });

  test("reads the client secret at each exchange, so a rotated token file is used at once", async () => {
    expect((await signIn()).outcome.kind).toBe("token");
    cluster.setClientSecret("client-secret-not-a-real-token-2");
    expect((await signIn()).outcome.kind).toBe("token");
    const secrets = cluster.received("oauth").map((request) => new URLSearchParams(request.body).get("client_secret"));
    expect(secrets).toEqual([CLIENT_SECRET, "client-secret-not-a-real-token-2"]);
  });

  test("a granted scope other than the pin is refused, with its class", async () => {
    const cases: [string | undefined, unknown][] = [
      ["user:check-access user:info", "token"],
      [undefined, "token"],
      ["user:info", { kind: "scope", granted: "narrower" }],
      ["user:check-access", { kind: "scope", granted: "narrower" }],
      ["", { kind: "scope", granted: "narrower" }],
      ["user:info user:check-access user:full", { kind: "scope", granted: "wider" }],
      ["user:full", { kind: "scope", granted: "other" }],
      ["user:info  user:check-access", { kind: "scope", granted: "other" }],
    ];
    for (const [scope, expected] of cases) {
      cluster.reset();
      const answer: Record<string, unknown> = { ...cluster.tokenAnswer };
      if (scope === undefined) delete answer.scope;
      else answer.scope = scope;
      cluster.tokenAnswer = answer;
      const { outcome } = await signIn();
      if (expected === "token") expect(outcome.kind, String(scope)).toBe("token");
      else expect(outcome, String(scope)).toEqual(expected as never);
    }
  });

  test("expires_in 0 or absent means no expiry of its own; a fraction is floored; a negative one is malformed", async () => {
    const cases: [unknown, unknown][] = [
      [0, { kind: "token", accessToken: ACCESS_TOKEN, expiresIn: null }],
      [undefined, { kind: "token", accessToken: ACCESS_TOKEN, expiresIn: null }],
      [3600.7, { kind: "token", accessToken: ACCESS_TOKEN, expiresIn: 3600 }],
      [-1, { kind: "failed", reason: "malformed" }],
    ];
    for (const [expiresIn, expected] of cases) {
      cluster.reset();
      const answer: Record<string, unknown> = { ...cluster.tokenAnswer, expires_in: expiresIn };
      if (expiresIn === undefined) delete answer.expires_in;
      cluster.tokenAnswer = answer;
      expect((await signIn()).outcome, String(expiresIn)).toEqual(expected as never);
    }
  });

  test("a token type other than Bearer, or an access token outside the printable set or bound, is malformed", async () => {
    for (const change of [{ token_type: "mac" }, { access_token: "a b" }, { access_token: "x".repeat(4097) }]) {
      cluster.reset();
      cluster.tokenAnswer = { ...cluster.tokenAnswer, ...change };
      expect((await signIn()).outcome, JSON.stringify(change).slice(0, 40)).toEqual({
        kind: "failed",
        reason: "malformed",
      });
    }
  });

  test("a refused code is rejected; a 5xx, a 3xx or a transport failure is unreachable", async () => {
    const { url, state } = await openShiftAuthorizationUrl(metadata, null);
    const params = cluster.authorize(url);
    expect(
      await exchangeOpenShiftCode(metadata, params, { ...state, code_verifier: `${state.code_verifier}x` }),
    ).toEqual({
      kind: "failed",
      reason: "rejected",
    });
    const answers: { status: number; body?: string; headers?: Record<string, string> }[] = [
      { status: 500, body: '{"error":"server_error"}', headers: { "content-type": "application/json" } },
      { status: 503, body: "unavailable" },
      { status: 302, headers: { location: "https://elsewhere.example.com/" } },
    ];
    for (const answer of answers) {
      cluster.reset();
      cluster.script(TOKEN_PATH, answer);
      expect((await signIn()).outcome, String(answer.status)).toEqual({ kind: "failed", reason: "unreachable" });
    }
    cluster.reset();
    writeFileSync(cluster.caFile, "no certificate");
    expect((await signIn()).outcome).toEqual({ kind: "failed", reason: "unreachable" });
  });

  test("an OAuth server nobody answers on is unreachable", async () => {
    const origin = `https://localhost:${await closedPort()}`;
    const closed = { ...metadata, issuer: origin, token_endpoint: `${origin}/oauth/token` };
    const { url, state } = await openShiftAuthorizationUrl(metadata, null);
    expect(await exchangeOpenShiftCode(closed, cluster.authorize(url), state)).toEqual({
      kind: "failed",
      reason: "unreachable",
    });
  });

  test("a 200 that is not a token answer is malformed", async () => {
    cluster.script(TOKEN_PATH, { status: 200, body: "<html></html>", headers: { "content-type": "text/html" } });
    expect((await signIn()).outcome).toEqual({ kind: "failed", reason: "malformed" });
  });

  test("an unreadable, empty or unset client secret file is a configuration failure, and nothing is sent", async () => {
    writeFileSync(cluster.tokenFile, "");
    expect((await signIn()).outcome).toEqual({ kind: "failed", reason: "config" });
    process.env.OPENSHIFT_OAUTH_TOKEN_FILE = `${cluster.directory}/missing-token`;
    expect((await signIn()).outcome).toEqual({ kind: "failed", reason: "config" });
    delete process.env.OPENSHIFT_OAUTH_TOKEN_FILE;
    expect((await signIn()).outcome).toEqual({ kind: "failed", reason: "config" });
    expect(cluster.received("oauth")).toEqual([]);
  });

  test("a refresh token is left out of the outcome, and an ID token fails the exchange as malformed", async () => {
    cluster.tokenAnswer = { ...cluster.tokenAnswer, refresh_token: "sha256~not-a-real-token-refresh" };
    const withRefresh = (await signIn()).outcome;
    expect(withRefresh).toEqual({ kind: "token", accessToken: ACCESS_TOKEN, expiresIn: 31536000 });
    expect(JSON.stringify(withRefresh)).not.toContain("refresh");
    cluster.reset();
    cluster.tokenAnswer = { ...cluster.tokenAnswer, id_token: "not-a-real.id-token.value" };
    const withIdToken = (await signIn()).outcome;
    expect(withIdToken).toEqual({ kind: "failed", reason: "malformed" });
    expect(JSON.stringify(withIdToken)).not.toContain("id-token");
  });
});

describe("grantedScopeAccepted", () => {
  test("accepts the two scopes once each in any order, or no scope at all", () => {
    expect(grantedScopeAccepted(undefined)).toBe(true);
    expect(grantedScopeAccepted("user:info user:check-access")).toBe(true);
    expect(grantedScopeAccepted("user:check-access user:info")).toBe(true);
  });

  test("refuses anything else", () => {
    for (const scope of [
      "",
      "user:info",
      "user:info user:info",
      "user:info user:check-access user:info",
      "user:info  user:check-access",
      " user:info user:check-access",
      "user:info user:check-access user:full",
      null,
      5,
      ["user:info", "user:check-access"],
    ]) {
      expect(grantedScopeAccepted(scope), JSON.stringify(scope)).toBe(false);
    }
  });
});
