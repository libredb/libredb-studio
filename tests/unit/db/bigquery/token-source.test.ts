import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { type NodeRequest, type NodeTransport, TransportError } from "@/lib/db/http/node-transport";
import { createTokenSource, readCredentials } from "@/lib/db/providers/sql/bigquery/auth";

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
const ok = (token: string, expires_in?: number) => ({
  status: 200,
  text: JSON.stringify({ access_token: token, expires_in }),
});

describe("bigquery readCredentials rejects", () => {
  test("text that is not JSON", () => {
    expect(() => readCredentials("{nope", {})).toThrow("not valid JSON");
  });

  test("text that is neither JSON nor shaped like an access token", () => {
    expect(() => readCredentials("not a token", {})).toThrow("neither a service-account key JSON nor an access token");
    expect(() => readCredentials("short", {})).toThrow("neither");
  });

  test("an unsupported credential type", () => {
    expect(() => readCredentials(JSON.stringify({ type: "impersonated_service_account" }), {})).toThrow(
      '"impersonated_service_account"',
    );
  });

  test("accepts authorized_user ADC", () => {
    const adc = { type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" } as const;
    expect(readCredentials(JSON.stringify(adc), {})).toEqual(adc);
  });
});

describe("bigquery createTokenSource", () => {
  test("service_account posts a signed RS256 jwt-bearer assertion", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const { transport, requests } = fakeTransport([ok("sa-token", 3600)]);
    const creds = { type: "service_account", client_email: "sa@p.iam", private_key: privateKey } as const;
    const token = createTokenSource(creds, transport, () => 1_700_000_000_000);
    expect(await token(signal)).toBe("sa-token");
    const req = requests[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.form?.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = decodeJwt(req.form?.assertion ?? "");
    expect(claims).toMatchObject({
      iss: "sa@p.iam",
      aud: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/bigquery",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
  });

  test("authorized_user posts a refresh_token grant", async () => {
    const { transport, requests } = fakeTransport([ok("user-token")]);
    const creds = { type: "authorized_user", client_id: "id", client_secret: "s", refresh_token: "r" } as const;
    expect(await createTokenSource(creds, transport)(signal)).toBe("user-token");
    expect(requests[0].form).toEqual({
      grant_type: "refresh_token",
      client_id: "id",
      client_secret: "s",
      refresh_token: "r",
    });
  });

  test("metadata GETs the workload token and caches it until a minute before expiry", async () => {
    let clock = 0;
    const { transport, requests } = fakeTransport([ok("m1", 120), ok("m2")]);
    const token = createTokenSource({ type: "metadata", host: "meta:8080" }, transport, () => clock);
    expect(await token(signal)).toBe("m1");
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url).toBe(
      "http://meta:8080/computeMetadata/v1/instance/service-accounts/default/token?scopes=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fbigquery",
    );
    clock = 59_999;
    expect(await token(signal)).toBe("m1");
    expect(requests).toHaveLength(1);
    clock = 60_000;
    expect(await token(signal)).toBe("m2");
    expect(requests).toHaveLength(2);
  });

  test("an error answer reports error_description, then error, then the status", async () => {
    const meta = { type: "metadata", host: "meta" } as const;
    const fail = (status: number, text: string) =>
      createTokenSource(meta, fakeTransport([{ status, text }]).transport)(signal);
    await expect(fail(400, JSON.stringify({ error: "invalid_grant", error_description: "bad key" }))).rejects.toThrow(
      "Google token request failed: bad key",
    );
    await expect(fail(400, JSON.stringify({ error: "invalid_grant" }))).rejects.toThrow("failed: invalid_grant");
    await expect(fail(502, "<html>")).rejects.toThrow("failed: HTTP 502");
    await expect(fail(200, JSON.stringify({ expires_in: 1 }))).rejects.toThrow("failed: HTTP 200");
  });
});

describe("bigquery createTokenSource single flight", () => {
  const meta = { type: "metadata", host: "meta" } as const;

  test("concurrent cold callers share one refresh and one token", async () => {
    const { transport, requests } = fakeTransport([ok("m1", 3600), ok("m2", 3600)]);
    const token = createTokenSource(meta, transport);
    const tokens = await Promise.all([token(signal), token(signal), token(signal)]);
    expect(tokens).toEqual(["m1", "m1", "m1"]);
    expect(requests).toHaveLength(1);
  });

  test("a rejected refresh caches nothing, so the next call retries", async () => {
    const { transport, requests } = fakeTransport([{ status: 500, text: "" }, ok("m2", 3600)]);
    const token = createTokenSource(meta, transport);
    await expect(Promise.all([token(signal), token(signal)])).rejects.toThrow("failed");
    expect(await token(signal)).toBe("m2");
    expect(requests).toHaveLength(2);
  });
});

describe("bigquery createTokenSource caller aborts", () => {
  const meta = { type: "metadata", host: "meta" } as const;
  function heldTransport() {
    const requests: NodeRequest[] = [];
    let answer: (text: string) => void = () => {};
    const transport: NodeTransport = {
      request: (req) => {
        requests.push(req);
        return new Promise((resolve) => {
          answer = (text) => resolve({ status: 200, contentType: "application/json", retryAfter: null, text });
        });
      },
      close() {},
    };
    return { transport, requests, answer: (token: string) => answer(JSON.stringify({ access_token: token })) };
  }

  test("a short caller aborting rejects it at once and does not fail a longer caller", async () => {
    const { transport, requests, answer } = heldTransport();
    const token = createTokenSource(meta, transport);
    const short = new AbortController();
    const long = new AbortController();
    const shortCall = token(short.signal).catch((e) => e);
    const longCall = token(long.signal);
    short.abort();
    const err = await shortCall;
    expect(err).toBeInstanceOf(TransportError);
    expect(err).toMatchObject({ kind: "aborted", message: "The request was cancelled" });
    expect(requests).toHaveLength(1);
    expect(requests[0].signal).not.toBe(short.signal);
    expect(requests[0].signal).not.toBe(long.signal);
    answer("shared");
    expect(await longCall).toBe("shared");
  });

  test("a caller already past its deadline rejects as a timeout", async () => {
    const { transport, answer } = heldTransport();
    const token = createTokenSource(meta, transport);
    const err = await token(AbortSignal.abort(new DOMException("late", "TimeoutError"))).catch((e) => e);
    expect(err).toMatchObject({ kind: "timeout" });
    answer("later");
    expect(await token(signal)).toBe("later");
  });

  test("a settled wait removes its abort listener", async () => {
    const { transport, answer } = heldTransport();
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    const call = createTokenSource(meta, transport)(controller.signal);
    answer("t");
    expect(await call).toBe("t");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("bigquery createTokenSource with an access token", () => {
  test("hands the pasted token back and never calls the token endpoint", async () => {
    const calls: unknown[] = [];
    const transport = {
      request: async (request: unknown) => {
        calls.push(request);
        return { status: 500, contentType: null, retryAfter: null, text: "" };
      },
      close() {},
    };
    const source = createTokenSource(
      { type: "access_token", token: "ya29.pasted-token-value-123" },
      transport,
      () => 0,
    );
    expect(await source(signal)).toBe("ya29.pasted-token-value-123");
    expect(await source(signal)).toBe("ya29.pasted-token-value-123");
    expect(calls).toEqual([]);
  });
});
