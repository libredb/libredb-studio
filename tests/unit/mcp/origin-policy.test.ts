/**
 * The MCP endpoint's Origin and Host gate (#246). Origin is checked on every method and every
 * bind; Host only when HOSTNAME is a loopback address, which is where DNS rebinding reaches a
 * local server. The allowlists come from the localhost names, the canonical LIBREDB_MCP_URL and
 * ALLOWED_ORIGINS, and never from the request's Host or X-Forwarded-Host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configuredOriginHostnames, resetOriginCheckWarnings } from "@/lib/api/origin-check";
import { MCP_URL_ENV } from "@/lib/mcp/config";
import {
  isLoopbackBind,
  MCP_LOOPBACK_BINDS,
  mcpHostAllowlist,
  mcpOriginAllowlist,
  mcpOriginHostRefusal,
} from "@/lib/mcp/origin-policy";

const MUTATED = ["HOSTNAME", "ALLOWED_ORIGINS", MCP_URL_ENV] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of MUTATED) saved.set(name, process.env[name]);
  process.env.HOSTNAME = "127.0.0.1";
  delete process.env.ALLOWED_ORIGINS;
  delete process.env[MCP_URL_ENV];
  resetOriginCheckWarnings();
});

afterEach(() => {
  for (const name of MUTATED) {
    const value = saved.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function request(headers: Record<string, string>, method = "GET"): Request {
  return new Request("http://localhost:3000/api/mcp", { method, headers });
}

async function refusalBody(refusal: ReturnType<typeof mcpOriginHostRefusal>): Promise<unknown> {
  expect(refusal).not.toBeNull();
  expect(refusal?.response.status).toBe(403);
  return refusal?.response.json();
}

describe("configuredOriginHostnames", () => {
  test("answers ALLOWED_ORIGINS as port-free host names, IPv6 bracketed, ignoring *", () => {
    process.env.ALLOWED_ORIGINS = "https://studio.example:8443, http://[::1]:3000, *, db.internal";
    expect(configuredOriginHostnames()).toEqual(["studio.example", "[::1]", "db.internal"]);
  });

  test("names nothing for an entry that is not a host", () => {
    process.env.ALLOWED_ORIGINS = "https://ok.example, http://[not-a-host";
    expect(configuredOriginHostnames()).toEqual(["ok.example"]);
  });

  test("is empty when ALLOWED_ORIGINS is unset", () => {
    expect(configuredOriginHostnames()).toEqual([]);
  });
});

describe("the loopback bind", () => {
  test("is exactly the three loopback names", () => {
    expect([...MCP_LOOPBACK_BINDS]).toEqual(["127.0.0.1", "::1", "localhost"]);
  });

  test.each(["127.0.0.1", "::1", "localhost", " LOCALHOST "])("%p is a loopback bind", (value) => {
    process.env.HOSTNAME = value;
    expect(isLoopbackBind()).toBe(true);
  });

  test.each(["::", "0.0.0.0", "", "studio.internal"])("%p is not", (value) => {
    process.env.HOSTNAME = value;
    expect(isLoopbackBind()).toBe(false);
  });
});

describe("the allowlists", () => {
  test("are the localhost names alone with no URL and no ALLOWED_ORIGINS", () => {
    expect(mcpOriginAllowlist()).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(mcpHostAllowlist()).toEqual(["localhost", "127.0.0.1", "[::1]"]);
  });

  test("add the canonical URL's host and the ALLOWED_ORIGINS hosts", () => {
    process.env[MCP_URL_ENV] = "https://studio.example/api/mcp";
    process.env.ALLOWED_ORIGINS = "https://proxy.example:8443";
    const expected = ["localhost", "127.0.0.1", "[::1]", "studio.example", "proxy.example"];
    expect(mcpOriginAllowlist()).toEqual(expected);
    expect(mcpHostAllowlist()).toEqual(expected);
  });

  test("ignore an invalid LIBREDB_MCP_URL", () => {
    process.env[MCP_URL_ENV] = "https://studio.example/elsewhere";
    expect(mcpOriginAllowlist()).toEqual(["localhost", "127.0.0.1", "[::1]"]);
  });
});

describe("mcpOriginHostRefusal", () => {
  test("refuses a foreign Origin on a GET with the SDK's body and origin_mismatch", async () => {
    const refusal = mcpOriginHostRefusal(request({ origin: "http://evil.example", host: "localhost:3000" }));
    expect(refusal?.reason).toBe("origin_mismatch");
    expect(await refusalBody(refusal)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Origin: evil.example" },
      id: null,
    });
  });

  test("refuses the opaque null Origin", async () => {
    expect(await refusalBody(mcpOriginHostRefusal(request({ origin: "null", host: "localhost:3000" })))).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid Origin header: null" },
      id: null,
    });
  });

  test("refuses the rebinding shape, a foreign Origin whose Host matches it", async () => {
    const refusal = mcpOriginHostRefusal(request({ origin: "http://evil.example", host: "evil.example" }, "POST"));
    expect(refusal?.reason).toBe("origin_mismatch");
  });

  test("ignores the Origin's port", () => {
    expect(mcpOriginHostRefusal(request({ origin: "http://localhost:5173", host: "localhost:3000" }))).toBeNull();
  });

  const foreignHosts: Record<string, string>[] = [
    { host: "evil.example" },
    { host: "evil.example", "x-forwarded-host": "localhost:3000" },
  ];
  test.each(foreignHosts)(
    "on a loopback bind, refuses a foreign Host with no Origin, whatever X-Forwarded-Host says: %p",
    async (headers) => {
      const refusal = mcpOriginHostRefusal(request(headers, "POST"));
      expect(refusal?.reason).toBe("mcp_host_not_allowed");
      expect(await refusalBody(refusal)).toEqual({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host: evil.example" },
        id: null,
      });
    },
  );

  test("on a loopback bind, refuses a request with no Host", async () => {
    const refusal = mcpOriginHostRefusal(new Request("http://localhost:3000/api/mcp"));
    expect(refusal?.reason).toBe("mcp_host_not_allowed");
    expect(await refusalBody(refusal)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Missing Host header" },
      id: null,
    });
  });

  test.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])("passes Host %p on a loopback bind", (host) => {
    expect(mcpOriginHostRefusal(request({ host }))).toBeNull();
  });

  test("passes the canonical URL's host and an ALLOWED_ORIGINS host with its port", () => {
    process.env[MCP_URL_ENV] = "https://studio.example/api/mcp";
    process.env.ALLOWED_ORIGINS = "https://proxy.example:8443";
    expect(mcpOriginHostRefusal(request({ origin: "https://studio.example", host: "studio.example" }))).toBeNull();
    expect(mcpOriginHostRefusal(request({ host: "proxy.example:8443" }))).toBeNull();
  });

  test("the control: on a non-loopback bind a foreign Host is not this gate's to refuse", () => {
    process.env.HOSTNAME = "::";
    expect(mcpOriginHostRefusal(request({ host: "evil.example" }, "POST"))).toBeNull();
  });
});
