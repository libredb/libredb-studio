import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import * as client from "@/lib/openshift-auth/http";
import {
  OPENSHIFT_API_TIMEOUT_MS,
  OPENSHIFT_TOKEN_TIMEOUT_MS,
  openShiftApiCall,
  openShiftApiTrust,
  openShiftTokenFetch,
  openShiftTokenTrust,
} from "@/lib/openshift-auth/http";
import {
  ACCESS_TOKEN,
  closedPort,
  type FakeCluster,
  startFakeCluster,
  TOKEN_PATH,
} from "../../../helpers/openshift-auth/fake-cluster";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const { ca, otherCa } = loadTlsFixtures();
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NODE_USE_ENV_PROXY",
  "NO_PROXY",
  "no_proxy",
];
const SAVED_KEYS = [...PROXY_KEYS, "NODE_EXTRA_CA_CERTS", "OPENSHIFT_API_URL"];

let cluster: FakeCluster;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  saved = Object.fromEntries(SAVED_KEYS.map((key) => [key, process.env[key]]));
  for (const key of [...PROXY_KEYS, "NODE_EXTRA_CA_CERTS"]) delete process.env[key];
  cluster.reset();
  process.env.OPENSHIFT_API_URL = cluster.apiUrl;
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A file of `content` in the cluster's directory, for the CA and NODE_EXTRA_CA_CERTS cases. */
function file(name: string, content: string): string {
  const path = join(cluster.directory, name);
  writeFileSync(path, content);
  return path;
}

const tokenOptions = (body: string | URLSearchParams | Uint8Array = "grant_type=authorization_code") => ({
  method: "POST",
  body,
  headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
  redirect: "manual" as const,
});

describe("openShiftApiCall", () => {
  test("an answer carries the status, the content type and the body", async () => {
    cluster.script("/apis/x", { status: 200, body: '{"a":1}', headers: { "content-type": "application/json" } });
    expect(await openShiftApiCall({ method: "GET", path: "/apis/x", maxBytes: 1024 })).toEqual({
      kind: "answer",
      status: 200,
      contentType: "application/json",
      body: '{"a":1}',
    });
    cluster.script("/apis/plain", { status: 204 });
    expect(await openShiftApiCall({ method: "GET", path: "/apis/plain", maxBytes: 1024 })).toEqual({
      kind: "answer",
      status: 204,
      contentType: null,
      body: "",
    });
  });

  test("sends the bearer only when given, a JSON body when given, and keeps the API URL's own path", async () => {
    cluster.script("/prefix/apis/x", { status: 201, body: "{}" });
    process.env.OPENSHIFT_API_URL = `${cluster.apiUrl}/prefix/`;
    await openShiftApiCall({ method: "POST", path: "/apis/x", bearer: ACCESS_TOKEN, json: { a: 1 }, maxBytes: 64 });
    await openShiftApiCall({ method: "GET", path: "/apis/x", maxBytes: 64 });
    const [withBearer, without] = cluster.requests;
    expect(withBearer.path).toBe("/prefix/apis/x");
    expect(withBearer.method).toBe("POST");
    expect(withBearer.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(withBearer.headers["content-type"]).toBe("application/json");
    expect(withBearer.headers.accept).toBe("application/json");
    expect(withBearer.body).toBe('{"a":1}');
    expect(without.headers.authorization).toBeUndefined();
    expect(without.headers["content-type"]).toBeUndefined();
    expect(without.body).toBe("");
  });

  test("fails as ca, with no connection, when the CA file holds no certificate", async () => {
    writeFileSync(cluster.caFile, "not a certificate\n");
    expect(await openShiftApiCall({ method: "GET", path: "/apis/x", maxBytes: 64 })).toEqual({
      kind: "failed",
      reason: "ca",
    });
    expect(cluster.requests).toEqual([]);
  });

  test("fails as tls with a CA file of another CA, and the server sees no request", async () => {
    writeFileSync(cluster.caFile, otherCa);
    const result = await openShiftApiCall({ method: "GET", path: "/apis/x", bearer: ACCESS_TOKEN, maxBytes: 64 });
    expect(result).toEqual({ kind: "failed", reason: "tls" });
    expect(cluster.requests).toEqual([]);
  });

  test("trusts the CA file only: a server the NODE_EXTRA_CA_CERTS CA vouches for fails as tls, with no bearer sent", async () => {
    writeFileSync(cluster.caFile, otherCa);
    process.env.NODE_EXTRA_CA_CERTS = file("extra.crt", ca);
    const result = await openShiftApiCall({ method: "GET", path: "/apis/x", bearer: ACCESS_TOKEN, maxBytes: 64 });
    expect(result).toEqual({ kind: "failed", reason: "tls" });
    expect(cluster.requests).toEqual([]);
    // The token call to the same server trusts the NODE_EXTRA_CA_CERTS file, so it goes through.
    cluster.script(TOKEN_PATH, { status: 200, body: "{}", headers: { "content-type": "application/json" } });
    const response = await openShiftTokenFetch(cluster.issuerOrigin)(
      `${cluster.issuerOrigin}${TOKEN_PATH}`,
      tokenOptions(),
    );
    expect(response.status).toBe(200);
  });

  test("fails as timeout against a server that never answers", async () => {
    cluster.script("/apis/hang", "hang");
    expect(await openShiftApiCall({ method: "GET", path: "/apis/hang", maxBytes: 64, timeoutMs: 50 })).toEqual({
      kind: "failed",
      reason: "timeout",
    });
  });

  test("uses the 2-second deadline when none is given", async () => {
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await openShiftApiCall({ method: "GET", path: "/apis/x", maxBytes: 64 });
      expect(timeout).toHaveBeenCalledWith(OPENSHIFT_API_TIMEOUT_MS);
      expect(OPENSHIFT_API_TIMEOUT_MS).toBe(2000);
    } finally {
      timeout.mockRestore();
    }
  });

  test("fails as network against a closed port", async () => {
    process.env.OPENSHIFT_API_URL = `https://127.0.0.1:${await closedPort()}`;
    expect(await openShiftApiCall({ method: "GET", path: "/apis/x", maxBytes: 64 })).toEqual({
      kind: "failed",
      reason: "network",
    });
  });

  test("fails as network, never throwing, when the request cannot even be built", async () => {
    const result = await openShiftApiCall({ method: "GET", path: "/apis/x", bearer: "a\nb", maxBytes: 64 });
    expect(result).toEqual({ kind: "failed", reason: "network" });
  });

  test("fails as too-large past the size cap", async () => {
    cluster.script("/apis/big", "oversize");
    expect(await openShiftApiCall({ method: "GET", path: "/apis/big", maxBytes: 1024 })).toEqual({
      kind: "failed",
      reason: "too-large",
    });
  });

  test("returns a redirect as an answer and never follows it", async () => {
    cluster.script("/apis/moved", { status: 302, headers: { location: `${cluster.apiUrl}/apis/elsewhere` } });
    const result = await openShiftApiCall({ method: "GET", path: "/apis/moved", maxBytes: 64 });
    expect(result).toMatchObject({ kind: "answer", status: 302 });
    expect(cluster.requests.map((request) => request.path)).toEqual(["/apis/moved"]);
  });
});

describe("trust sets", () => {
  test("the API trust is the CA file's certificates only, or null without one", async () => {
    expect(await openShiftApiTrust()).toEqual([ca.trim()]);
    writeFileSync(cluster.caFile, "no certificate");
    expect(await openShiftApiTrust()).toBeNull();
  });

  test("the token trust is Node's roots plus the CA file, and the NODE_EXTRA_CA_CERTS file when set", async () => {
    expect(await openShiftTokenTrust()).toEqual([...rootCertificates, ca.trim()]);
    const extra = file("extra.crt", otherCa);
    process.env.NODE_EXTRA_CA_CERTS = extra;
    expect(await openShiftTokenTrust()).toEqual([...rootCertificates, otherCa.trim(), ca.trim()]);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(extra);
  });

  test("the token trust is null when either file cannot be read or holds no certificate", async () => {
    process.env.NODE_EXTRA_CA_CERTS = join(cluster.directory, "missing.crt");
    expect(await openShiftTokenTrust()).toBeNull();
    process.env.NODE_EXTRA_CA_CERTS = file("extra.crt", otherCa);
    writeFileSync(cluster.caFile, "");
    expect(await openShiftTokenTrust()).toBeNull();
  });
});

describe("openShiftTokenFetch", () => {
  test("sends the form body to the issuer and builds a Response from the answer, with the 5-second deadline", async () => {
    cluster.script(TOKEN_PATH, {
      status: 400,
      body: '{"error":"invalid_grant"}',
      headers: { "content-type": "application/json" },
    });
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      const form = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });
      const response = await openShiftTokenFetch(cluster.issuerOrigin)(
        `${cluster.issuerOrigin}${TOKEN_PATH}`,
        tokenOptions(form),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({ error: "invalid_grant" });
      expect(timeout).toHaveBeenCalledWith(OPENSHIFT_TOKEN_TIMEOUT_MS);
      expect(OPENSHIFT_TOKEN_TIMEOUT_MS).toBe(5000);
    } finally {
      timeout.mockRestore();
    }
    const [sent] = cluster.received("oauth");
    expect(sent.method).toBe("POST");
    expect(sent.body).toBe("grant_type=authorization_code&code=abc");
    expect(sent.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("refuses a URL of another origin before anything is sent", async () => {
    const fetcher = openShiftTokenFetch(cluster.issuerOrigin);
    await expect(fetcher(`${cluster.apiUrl}${TOKEN_PATH}`, tokenOptions())).rejects.toThrow("OAuth issuer");
    expect(cluster.requests).toEqual([]);
  });

  test("refuses a body that is neither a string nor a form", async () => {
    const fetcher = openShiftTokenFetch(cluster.issuerOrigin);
    await expect(fetcher(`${cluster.issuerOrigin}${TOKEN_PATH}`, tokenOptions(new Uint8Array([1])))).rejects.toThrow(
      "form",
    );
    expect(cluster.requests).toEqual([]);
  });

  test("throws on a failed call, so openid-client rejects", async () => {
    writeFileSync(cluster.caFile, "no certificate");
    const fetcher = openShiftTokenFetch(cluster.issuerOrigin);
    await expect(fetcher(`${cluster.issuerOrigin}${TOKEN_PATH}`, tokenOptions())).rejects.toMatchObject({
      name: "OpenShiftCallError",
      reason: "ca",
    });
  });
});

describe("no proxy, no global agent, no global fetch", () => {
  test("with the proxy variables set, the proxy sees no connection and every request gets agent: false", async () => {
    process.env.HTTPS_PROXY = cluster.proxy.url;
    process.env.HTTP_PROXY = cluster.proxy.url;
    process.env.https_proxy = cluster.proxy.url;
    process.env.http_proxy = cluster.proxy.url;
    process.env.NODE_USE_ENV_PROXY = "1";
    const request = spyOn(https, "request");
    try {
      cluster.script("/apis/x", { status: 200, body: "{}" });
      cluster.script(TOKEN_PATH, { status: 200, body: "{}" });
      expect(await openShiftApiCall({ method: "GET", path: "/apis/x", maxBytes: 64 })).toMatchObject({ status: 200 });
      const response = await openShiftTokenFetch(cluster.issuerOrigin)(
        `${cluster.issuerOrigin}${TOKEN_PATH}`,
        tokenOptions(),
      );
      expect(response.status).toBe(200);
      expect(request).toHaveBeenCalledTimes(2);
      for (const [options] of request.mock.calls) expect((options as https.RequestOptions).agent).toBe(false);
    } finally {
      request.mockRestore();
    }
    expect(cluster.proxy.connections).toBe(0);
    expect(cluster.requests).toHaveLength(2);
  });

  test("no file under src/lib/openshift-auth calls the global fetch", () => {
    const directory = join(process.cwd(), "src/lib/openshift-auth");
    const offenders = readdirSync(directory).filter((name) =>
      /(^|[^\w.$])fetch\s*\(/.test(readFileSync(join(directory, name), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("the HTTPS call itself is not exported: every outside call goes through the two entry points", () => {
    expect(Object.keys(client).sort()).toEqual([
      "OPENSHIFT_API_TIMEOUT_MS",
      "OPENSHIFT_TOKEN_TIMEOUT_MS",
      "OpenShiftCallError",
      "openShiftApiCall",
      "openShiftApiTrust",
      "openShiftTokenFetch",
      "openShiftTokenTrust",
    ]);
  });
});
