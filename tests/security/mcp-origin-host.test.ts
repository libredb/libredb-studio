/**
 * DNS rebinding and cross-origin requests against /api/mcp (#246).
 *
 * Origin is validated on every method, GET included, which checkOrigin exempts; Host is validated
 * on a loopback bind. Both answers are the SDK's own 403, audited like checkOrigin's refusal.
 * Driven through the real proxy() here; the route's half, reached with the proxy bypassed, is
 * below it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as route from "@/app/api/mcp/route";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { proxy } from "@/proxy";
import { pinMcpTestEnvironment } from "../helpers/mcp-fixtures";
import { routeServe } from "../helpers/mcp-harness";
import { useMcpChannel } from "../helpers/mcp-token";
import { originHostRequest, permissionDeniedLines } from "./helpers/mcp-requests";

pinMcpTestEnvironment();

let restoreChannel: () => void = () => {};
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  clearRateLimitState();
  for (const name of ["HOSTNAME", "ALLOWED_ORIGINS"]) saved.set(name, process.env[name]);
  process.env.HOSTNAME = "127.0.0.1";
  delete process.env.ALLOWED_ORIGINS;
  restoreChannel = useMcpChannel();
});

afterEach(() => {
  restoreChannel();
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearRateLimitState();
});

const sdk403 = async (response: Response, message: string) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
};

describe("through proxy(), Origin on every method", () => {
  test("a GET from a foreign Origin gets the SDK's 403: the check checkOrigin does not make", async () => {
    await sdk403(
      await proxy(originHostRequest("GET", { origin: "http://evil.example", host: "localhost:3000" })),
      "Invalid Origin: evil.example",
    );
  });

  test("a GET with the opaque null Origin gets 403", async () => {
    await sdk403(
      await proxy(originHostRequest("GET", { origin: "null", host: "localhost:3000" })),
      "Invalid Origin header: null",
    );
  });

  test("a POST in the rebinding shape, Origin and Host both the attacker's, gets the SDK's 403", async () => {
    await sdk403(
      await proxy(
        originHostRequest("POST", {
          origin: "http://evil.example",
          host: "evil.example",
          "content-type": "application/json",
        }),
      ),
      "Invalid Origin: evil.example",
    );
  });

  test.each(["POST", "DELETE"])(
    "a %s from a foreign Origin to our own Host gets checkOrigin's ORIGIN_MISMATCH",
    async (method) => {
      const response = await proxy(
        originHostRequest(method, { origin: "http://evil.example", host: "localhost:3000" }),
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("ORIGIN_MISMATCH");
    },
  );

  test("a body-less DELETE carrying neither Origin nor JSON content gets checkOrigin's ORIGIN_MISMATCH", async () => {
    const response = await proxy(originHostRequest("DELETE", { host: "localhost:3000" }));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ORIGIN_MISMATCH");
  });

  test("a GET without Origin reaches the identity step", async () => {
    expect((await proxy(originHostRequest("GET", { host: "localhost:3000" }))).status).toBe(401);
  });

  test("the canonical URL's own Origin and Host pass both Origin checks", async () => {
    restoreChannel();
    restoreChannel = useMcpChannel({ url: "https://studio.example/api/mcp" });
    expect(
      (await proxy(originHostRequest("GET", { origin: "https://studio.example", host: "studio.example" }))).status,
    ).toBe(401);
  });

  test("with LIBREDB_MCP_URL unset, a localhost Origin passes and another host's does not", async () => {
    restoreChannel();
    restoreChannel = useMcpChannel({ url: null });
    expect(
      (await proxy(originHostRequest("GET", { origin: "http://localhost:5173", host: "localhost:3000" }))).status,
    ).toBe(401);
    expect(
      (await proxy(originHostRequest("GET", { origin: "https://studio.example", host: "localhost:3000" }))).status,
    ).toBe(403);
  });
});

describe("through proxy(), Host on a loopback bind", () => {
  test("a POST with no Origin and a foreign Host gets the SDK's 403, whatever X-Forwarded-Host says", async () => {
    const extras: Record<string, string>[] = [{}, { "x-forwarded-host": "localhost:3000" }];
    for (const extra of extras) {
      await sdk403(
        await proxy(originHostRequest("POST", { host: "evil.example", "content-type": "application/json", ...extra })),
        "Invalid Host: evil.example",
      );
    }
  });

  test.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])("Host %p passes", async (host) => {
    expect((await proxy(originHostRequest("GET", { host }))).status).toBe(401);
  });

  test("the canonical URL's host and an ALLOWED_ORIGINS host with its port pass", async () => {
    restoreChannel();
    restoreChannel = useMcpChannel({ url: "https://studio.example/api/mcp" });
    process.env.ALLOWED_ORIGINS = "https://proxy.example:8443";
    expect((await proxy(originHostRequest("GET", { host: "studio.example" }))).status).toBe(401);
    expect((await proxy(originHostRequest("GET", { host: "proxy.example:8443" }))).status).toBe(401);
  });

  test("a request with no Host gets 403", async () => {
    await sdk403(await proxy(originHostRequest("GET", {})), "Missing Host header");
  });

  test("the control: on a non-loopback bind a foreign Host reaches the identity step", async () => {
    process.env.HOSTNAME = "::";
    expect((await proxy(originHostRequest("GET", { host: "evil.example" }))).status).toBe(401);
  });
});

describe("through proxy(), the two new 403s are audited", () => {
  test("the Origin 403 writes origin_mismatch and the Host 403 writes mcp_host_not_allowed, metered", async () => {
    process.env.RATE_LIMIT_ANON_MAX = "1";
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await proxy(originHostRequest("GET", { origin: "http://evil.example", host: "localhost:3000" }));
      await proxy(originHostRequest("GET", { host: "evil.example" }));
      for (let i = 0; i < 5; i += 1) await proxy(originHostRequest("GET", { host: "evil.example" }));
      expect(permissionDeniedLines(spy).map((line) => line.reason)).toEqual([
        "origin_mismatch",
        "mcp_host_not_allowed",
      ]);
    } finally {
      spy.mockRestore();
      delete process.env.RATE_LIMIT_ANON_MAX;
    }
  });

  test("a throwing sink leaves the Origin 403 and the Host 403 unchanged, and each failure is logged", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await sdk403(
        await proxy(originHostRequest("GET", { origin: "http://evil.example", host: "localhost:3000" })),
        "Invalid Origin: evil.example",
      );
      await sdk403(await proxy(originHostRequest("GET", { host: "evil.example" })), "Invalid Host: evil.example");
      expect(errorLog).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });
});

describe("at the route, called directly so the proxy is bypassed", () => {
  test("the foreign-Origin GET, the rebinding POST, the foreign Host POST and the Host-less GET get the proxy's 403s and lines", async () => {
    const cases: Array<[method: "GET" | "POST", headers: Record<string, string>, message: string, reason: string]> = [
      [
        "GET",
        { origin: "http://evil.example", host: "localhost:3000" },
        "Invalid Origin: evil.example",
        "origin_mismatch",
      ],
      [
        "POST",
        { origin: "http://evil.example", host: "evil.example", "content-type": "application/json" },
        "Invalid Origin: evil.example",
        "origin_mismatch",
      ],
      [
        "POST",
        { host: "evil.example", "content-type": "application/json" },
        "Invalid Host: evil.example",
        "mcp_host_not_allowed",
      ],
      ["GET", {}, "Missing Host header", "mcp_host_not_allowed"],
    ];
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const [method, headers, message] of cases) {
        await sdk403(await routeServe(route)(originHostRequest(method, headers)), message);
      }
      expect(permissionDeniedLines(spy).map((line) => line.reason)).toEqual(cases.map(([, , , reason]) => reason));
    } finally {
      spy.mockRestore();
    }
  });

  test("with a matching Origin and Host the route reaches its identity step", async () => {
    expect(
      (await route.GET(originHostRequest("GET", { origin: "http://localhost:5173", host: "localhost:3000" }))).status,
    ).toBe(401);
  });
});
