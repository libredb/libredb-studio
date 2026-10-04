import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isPlainHttpRequest, requestScheme } from "@/lib/api/request-scheme";
import { resetSecurityConfigWarnings } from "@/lib/security/config";

const MUTATED = ["TRUST_PROXY_HEADERS"] as const;
const snapshot: Record<string, string | undefined> = {};

function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  delete process.env.TRUST_PROXY_HEADERS;
  // readTrustProxyHeaders() latches its unrecognized-value warning in module state shared with
  // every other file in this process.
  resetSecurityConfigWarnings();
});

afterEach(() => {
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSecurityConfigWarnings();
});

describe("requestScheme", () => {
  test("answers the URL's own protocol when no forwarded header is present", () => {
    expect(requestScheme(request("http://studio.example.com/api/admin/discovery"))).toBe("http");
    expect(requestScheme(request("https://studio.example.com/api/admin/discovery"))).toBe("https");
  });

  test("prefers a trusted x-forwarded-proto over the URL", () => {
    expect(requestScheme(request("http://studio.example.com/x", { "x-forwarded-proto": "https" }))).toBe("https");
    expect(requestScheme(request("https://studio.example.com/x", { "x-forwarded-proto": "http" }))).toBe("http");
  });

  test("takes the first entry of a comma list, trimmed and lowercased", () => {
    expect(requestScheme(request("http://studio.example.com/x", { "x-forwarded-proto": " HTTPS , http" }))).toBe(
      "https",
    );
  });

  test("ignores x-forwarded-proto when TRUST_PROXY_HEADERS is false", () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    expect(requestScheme(request("http://studio.example.com/x", { "x-forwarded-proto": "https" }))).toBe("http");
  });

  test("falls back to the URL for a forwarded value that is neither http nor https", () => {
    expect(requestScheme(request("https://studio.example.com/x", { "x-forwarded-proto": "ftp" }))).toBe("https");
    expect(requestScheme(request("https://studio.example.com/x", { "x-forwarded-proto": "" }))).toBe("https");
  });
});

describe("isPlainHttpRequest", () => {
  test("is true for http on a public host taken from the URL", () => {
    expect(isPlainHttpRequest(request("http://studio.example.com/x"))).toBe(true);
  });

  test("is false for https", () => {
    expect(isPlainHttpRequest(request("https://studio.example.com/x"))).toBe(false);
    expect(isPlainHttpRequest(request("http://studio.example.com/x", { "x-forwarded-proto": "https" }))).toBe(false);
  });

  test("is false for http on a loopback host", () => {
    expect(isPlainHttpRequest(request("http://localhost:3000/x"))).toBe(false);
    expect(isPlainHttpRequest(request("http://127.0.0.1:3000/x"))).toBe(false);
    expect(isPlainHttpRequest(request("http://[::1]:3000/x"))).toBe(false);
  });

  test("reads the host header before the URL host", () => {
    expect(isPlainHttpRequest(request("http://localhost:3000/x", { host: "studio.example.com" }))).toBe(true);
    expect(isPlainHttpRequest(request("http://studio.example.com/x", { host: "localhost:3000" }))).toBe(false);
  });

  test("reads a trusted x-forwarded-host before the host header, first entry of a comma list", () => {
    expect(
      isPlainHttpRequest(
        request("http://localhost:3000/x", { host: "localhost:3000", "x-forwarded-host": "studio.example.com, proxy" }),
      ),
    ).toBe(true);
  });

  test("ignores x-forwarded-host when TRUST_PROXY_HEADERS is false", () => {
    process.env.TRUST_PROXY_HEADERS = "false";
    expect(
      isPlainHttpRequest(
        request("http://localhost:3000/x", { host: "localhost:3000", "x-forwarded-host": "studio.example.com" }),
      ),
    ).toBe(false);
  });
});
