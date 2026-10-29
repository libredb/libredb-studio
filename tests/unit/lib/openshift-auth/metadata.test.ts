import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as oidc from "openid-client";
import {
  checkOpenShiftMetadata,
  readOpenShiftMetadata,
  resetOpenShiftMetadataCache,
} from "@/lib/openshift-auth/metadata";
import { type FakeCluster, METADATA_PATH, startFakeCluster } from "../../../helpers/openshift-auth/fake-cluster";

let cluster: FakeCluster;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  cluster.reset();
  cluster.useEnv();
  resetOpenShiftMetadataCache();
});

const json = (document: unknown) => ({
  status: 200,
  body: JSON.stringify(document),
  headers: { "content-type": "application/json" },
});

describe("checkOpenShiftMetadata", () => {
  test("the cluster's document passes, reduced to the checked fields", () => {
    expect(checkOpenShiftMetadata(cluster.metadata())).toEqual({
      kind: "ok",
      metadata: {
        issuer: cluster.issuerOrigin,
        authorization_endpoint: `${cluster.issuerOrigin}/oauth/authorize`,
        token_endpoint: `${cluster.issuerOrigin}/oauth/token`,
        code_challenge_methods_supported: ["plain", "S256"],
      },
    });
  });

  test("each check names its field only", () => {
    const base = cluster.metadata();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, issuer: "http://oauth.example.com" }, "issuer"],
      [{ ...base, issuer: "https://user@oauth.example.com" }, "issuer"],
      [{ ...base, issuer: "https://oauth.example.com/?q" }, "issuer"],
      [{ ...base, issuer: 7 }, "issuer"],
      [{ ...base, authorization_endpoint: "https://elsewhere.example.com/oauth/authorize" }, "authorization_endpoint"],
      [
        { ...base, authorization_endpoint: `http://${new URL(cluster.issuerOrigin).host}/oauth/authorize` },
        "authorization_endpoint",
      ],
      [{ ...base, token_endpoint: "https://elsewhere.example.com/oauth/token" }, "token_endpoint"],
      [{ ...base, token_endpoint: undefined }, "token_endpoint"],
      [{ ...base, code_challenge_methods_supported: ["plain"] }, "code_challenge_methods_supported"],
      [{ ...base, code_challenge_methods_supported: "S256" }, "code_challenge_methods_supported"],
    ];
    for (const [document, check] of cases) {
      expect(checkOpenShiftMetadata(document), JSON.stringify(document)).toEqual({ kind: "invalid", check });
    }
  });
});

describe("readOpenShiftMetadata", () => {
  test("reads the document from OPENSHIFT_API_URL, never through openid-client discovery, with no credential", async () => {
    const discovery = spyOn(oidc, "discovery");
    try {
      const reading = await readOpenShiftMetadata();
      expect(reading.kind).toBe("ok");
      expect(discovery).not.toHaveBeenCalled();
    } finally {
      discovery.mockRestore();
    }
    expect(cluster.requests).toHaveLength(1);
    const [request] = cluster.requests;
    expect(request.server).toBe("api");
    expect(request.method).toBe("GET");
    expect(request.path).toBe(METADATA_PATH);
    expect(request.headers.authorization).toBeUndefined();
    const source = readFileSync(join(process.cwd(), "src/lib/openshift-auth/metadata.ts"), "utf8");
    expect(source).not.toMatch(/\bdiscovery\s*\(/);
  });

  test("a 404 means an external OIDC cluster", async () => {
    cluster.script(METADATA_PATH, { status: 404, body: "{}" });
    expect(await readOpenShiftMetadata()).toEqual({ kind: "external-oidc" });
  });

  test("a 500 or a 302 is unreachable with the status, and a transport failure with its class", async () => {
    cluster.script(METADATA_PATH, { status: 500, body: "{}" });
    expect(await readOpenShiftMetadata()).toEqual({ kind: "unreachable", reason: "status", status: 500 });
    cluster.script(METADATA_PATH, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
    expect(await readOpenShiftMetadata()).toEqual({ kind: "unreachable", reason: "status", status: 302 });
    writeFileSync(cluster.caFile, "no certificate");
    expect(await readOpenShiftMetadata()).toEqual({ kind: "unreachable", reason: "ca" });
  });

  test("a body that is not a JSON object is invalid", async () => {
    for (const body of ["not json", "[1,2]", "null", '"text"']) {
      cluster.script(METADATA_PATH, { status: 200, body });
      expect(await readOpenShiftMetadata(), body).toEqual({ kind: "invalid", check: "document" });
    }
    cluster.script(METADATA_PATH, json({ ...cluster.metadata(), code_challenge_methods_supported: [] }));
    expect(await readOpenShiftMetadata()).toEqual({ kind: "invalid", check: "code_challenge_methods_supported" });
  });

  test("a checked document is cached for five minutes; a failure is never cached", async () => {
    cluster.script(METADATA_PATH, { status: 500, body: "{}" });
    await readOpenShiftMetadata(1_000);
    cluster.script(METADATA_PATH, () => undefined);
    const first = await readOpenShiftMetadata(2_000);
    expect(first.kind).toBe("ok");
    expect(cluster.requests).toHaveLength(2);
    expect(await readOpenShiftMetadata(2_000 + 299_999)).toEqual(first);
    expect(cluster.requests).toHaveLength(2);
    expect((await readOpenShiftMetadata(2_000 + 300_000)).kind).toBe("ok");
    expect(cluster.requests).toHaveLength(3);
  });

  test("the cache is kept per API URL", async () => {
    await readOpenShiftMetadata(1_000);
    process.env.OPENSHIFT_API_URL = `${cluster.apiUrl}/`;
    await readOpenShiftMetadata(1_000);
    expect(cluster.requests).toHaveLength(1);
    process.env.OPENSHIFT_API_URL = `${cluster.apiUrl}/prefix`;
    cluster.script(`/prefix${METADATA_PATH}`, json(cluster.metadata()));
    expect((await readOpenShiftMetadata(1_000)).kind).toBe("ok");
    expect(cluster.requests).toHaveLength(2);
  });
});
