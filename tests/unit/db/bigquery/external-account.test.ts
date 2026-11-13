import { describe, expect, test } from "bun:test";
import type { NodeRequest, NodeTransport } from "@/lib/db/http/node-transport";
import { createTokenSource, readCredentials, tokenOrigin } from "@/lib/db/providers/sql/bigquery/auth";

const AUDIENCE = "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/polaris";
const STS = "https://sts.googleapis.com/v1/token";

function config(over: Record<string, unknown> = {}, source: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "external_account",
    audience: AUDIENCE,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: STS,
    credential_source: {
      url: "https://adapter.example/subject/alice",
      headers: { authorization: "Bearer adapter-secret" },
      format: { type: "json", subject_token_field_name: "token" },
      ...source,
    },
    ...over,
  });
}

function fakeTransport(answers: { status: number; text: string }[]) {
  const requests: NodeRequest[] = [];
  const transport: NodeTransport = {
    request: async (req) => {
      requests.push(req);
      const next = answers.shift() ?? { status: 500, text: "" };
      return { status: next.status, contentType: "application/json", retryAfter: null, text: next.text };
    },
    close() {},
  };
  return { transport, requests };
}

const signal = new AbortController().signal;
const subject = (token: string) => ({ status: 200, text: JSON.stringify({ token }) });
const sts = (token: string, expires_in?: number) => ({
  status: 200,
  text: JSON.stringify({
    access_token: token,
    expires_in,
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
  }),
});

describe("bigquery external_account credentials", () => {
  test("a url-sourced config is read into the subject source and the exchange", () => {
    const creds = readCredentials(config(), {});
    expect(creds).toEqual({
      type: "external_account",
      audience: AUDIENCE,
      subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      source: {
        url: "https://adapter.example/subject/alice",
        origin: { scheme: "https", host: "adapter.example", port: 443 },
        headers: { authorization: "Bearer adapter-secret" },
        format: { type: "json", field: "token" },
      },
    });
    expect(tokenOrigin(creds)).toEqual({ scheme: "https", host: "sts.googleapis.com", port: 443 });
  });

  test("format defaults to text, headers to none, and an id_token subject is accepted", () => {
    const creds = readCredentials(
      config(
        { subject_token_type: "urn:ietf:params:oauth:token-type:id_token" },
        { headers: undefined, format: undefined },
      ),
      {},
    );
    expect(creds).toMatchObject({
      subjectTokenType: "urn:ietf:params:oauth:token-type:id_token",
      source: { headers: {}, format: { type: "text" } },
    });
  });

  test("plain http is allowed only to this machine, because the subject token is a credential", () => {
    const local = readCredentials(config({}, { url: "http://127.0.0.1:8099/subject" }), {});
    expect(local).toMatchObject({ source: { origin: { scheme: "http", host: "127.0.0.1", port: 8099 } } });
    expect(() => readCredentials(config({}, { url: "http://adapter.svc/subject" }), {})).toThrow(
      "must use https unless it is on this machine",
    );
  });

  test("the exchange goes to Google's STS and nowhere else", () => {
    expect(() => readCredentials(config({ token_url: "https://evil.example/token" }), {})).toThrow(
      "must exchange at https://sts.googleapis.com/v1/token",
    );
    expect(() => readCredentials(config({ token_url: undefined }), {})).toThrow("https://sts.googleapis.com/v1/token");
  });

  test("an audience must name a workload identity pool provider", () => {
    expect(() => readCredentials(config({ audience: undefined }), {})).toThrow("audience");
    expect(() => readCredentials(config({ audience: "my-pool" }), {})).toThrow("//iam.googleapis.com/");
  });

  test("only jwt and id_token subjects are supported", () => {
    expect(() =>
      readCredentials(config({ subject_token_type: "urn:ietf:params:aws:token-type:aws4_request" }), {}),
    ).toThrow("subject_token_type");
  });

  test("impersonation and non-url sources are refused with what to do instead", () => {
    const impersonation = config({
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/x:generateAccessToken",
    });
    expect(() => readCredentials(impersonation, {})).toThrow("grant the federated identity BigQuery access directly");
    for (const source of [
      { url: undefined, file: "/var/run/token" },
      { url: undefined, executable: { command: "/bin/token" } },
      { url: undefined, environment_id: "aws1" },
    ]) {
      expect(() => readCredentials(config({}, source), {})).toThrow("credential_source.url only");
    }
  });

  test("a url that is not http(s), carries credentials, or cannot be parsed is refused without echoing it", () => {
    for (const url of ["ftp://adapter.example/t", "https://user:pw@adapter.example/t", "not a url", 7]) {
      const run = () => readCredentials(config({}, { url }), {});
      expect(run).toThrow("credential_source.url is not a valid http(s) URL");
      expect(run).not.toThrow("pw");
    }
  });

  test("headers must be single-line strings with plain names", () => {
    for (const headers of [{ "bad name": "x" }, { ok: "line\r\nInjected: y" }, { ok: 1 }, ["x"]]) {
      expect(() => readCredentials(config({}, { headers }), {})).toThrow("credential_source.headers");
    }
  });

  test("json format needs the field name, and other formats are refused", () => {
    for (const format of [{ type: "json" }, { type: "json", subject_token_field_name: "" }, { type: "xml" }, "text"]) {
      expect(() => readCredentials(config({}, { format }), {})).toThrow("credential_source.format");
    }
  });
});

describe("bigquery external_account token source", () => {
  const creds = () => readCredentials(config(), {});

  test("fetches the subject token, exchanges it at STS for a BigQuery-scoped token, and caches it", async () => {
    let clock = 0;
    const subjectLane = fakeTransport([subject("subject-1"), subject("subject-2")]);
    const stsLane = fakeTransport([sts("google-1", 120), sts("google-2", 3600)]);
    const token = createTokenSource(creds(), stsLane.transport, () => clock, subjectLane.transport);
    expect(await token(signal)).toBe("google-1");
    expect(subjectLane.requests[0]).toMatchObject({ method: "GET", url: "https://adapter.example/subject/alice" });
    expect(stsLane.requests[0]).toMatchObject({ method: "POST", url: STS });
    expect(stsLane.requests[0].form).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: AUDIENCE,
      scope: "https://www.googleapis.com/auth/bigquery",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "subject-1",
    });
    clock = 59_999;
    expect(await token(signal)).toBe("google-1");
    expect(subjectLane.requests).toHaveLength(1);
    clock = 60_000;
    expect(await token(signal)).toBe("google-2");
    expect(subjectLane.requests).toHaveLength(2);
    expect(stsLane.requests[1].form?.subject_token).toBe("subject-2");
  });

  test("a text subject is the trimmed body", async () => {
    const text = readCredentials(config({}, { format: { type: "text" } }), {});
    const subjectLane = fakeTransport([{ status: 200, text: "  plain-subject\n" }]);
    const stsLane = fakeTransport([sts("google", 3600)]);
    expect(await createTokenSource(text, stsLane.transport, () => 0, subjectLane.transport)(signal)).toBe("google");
    expect(stsLane.requests[0].form?.subject_token).toBe("plain-subject");
  });

  test("a refused or unusable subject answer fails before STS, and never repeats the body", async () => {
    for (const answer of [
      { status: 401, text: "secret-ish body" },
      { status: 200, text: "{not json" },
      { status: 200, text: JSON.stringify({ other: "x" }) },
      { status: 200, text: JSON.stringify({ token: "" }) },
    ]) {
      const stsLane = fakeTransport([]);
      const run = createTokenSource(creds(), stsLane.transport, () => 0, fakeTransport([answer]).transport)(signal);
      await expect(run).rejects.toThrow("Subject token request failed");
      expect(String(await run.catch((e: Error) => e.message))).not.toContain("secret-ish");
      expect(stsLane.requests).toHaveLength(0);
    }
  });

  test("an STS refusal reports Google's error_description", async () => {
    const stsLane = fakeTransport([
      { status: 400, text: JSON.stringify({ error: "invalid_grant", error_description: "audience mismatch" }) },
    ]);
    const run = createTokenSource(creds(), stsLane.transport, () => 0, fakeTransport([subject("s")]).transport);
    await expect(run(signal)).rejects.toThrow("Google token request failed: audience mismatch");
  });

  test("an external_account source without a subject transport is a programming error", () => {
    expect(() => createTokenSource(creds(), fakeTransport([]).transport)).toThrow("subject token transport");
  });
});
