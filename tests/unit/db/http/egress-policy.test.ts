import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { httpOrigin } from "@/lib/db/http/endpoint";
import {
  assertPublicDnsAnswers,
  guardedNodeOptions,
  httpTransportFetch,
  publicAddressLookup,
} from "@/lib/db/http/egress-policy";
import { nodeRequestJson } from "@/lib/db/providers/document/couchbase/http-transport";

const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[flag];
afterEach(() => {
  if (original === undefined) delete process.env[flag];
  else process.env[flag] = original;
});

describe("opt-in HTTP database destination policy", () => {
  test.each([
    ["loopback", "127.0.0.1"],
    ["other loopback", "127.4.5.6"],
    ["unspecified", "0.0.0.0"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.31.255.254"],
    ["private 192.168/16", "192.168.1.1"],
    ["link-local metadata", "169.254.169.254"],
    ["IPv6 loopback", "[::1]"],
    ["IPv6 unique-local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["6to4 tunnel", "2002::1"],
    ["NAT64 tunnel", "64:ff9b::a00:1"],
    ["internal SRv6 range", "5f00::1"],
    ["IPv6 benchmark range", "2001:2::1"],
  ])("refuses %s before building a request", (_label, host) => {
    process.env[flag] = "true";
    expect(() => httpOrigin("http", host, 8080)).toThrow(DatabaseConfigError);
    try {
      httpOrigin("http", host, 8080);
    } catch (error) {
      expect((error as Error).message).not.toContain(host);
    }
  });

  test("keeps public literals and hostnames available in guarded mode", () => {
    process.env[flag] = "1";
    expect(httpOrigin("https", "8.8.8.8", 443).host).toBe("8.8.8.8");
    expect(httpOrigin("https", "2606:4700:4700::1111", 443).host).toBe("[2606:4700:4700::1111]");
    expect(httpOrigin("https", "db.example.com", 443).host).toBe("db.example.com");
  });

  test("leaves local connections enabled by default and with an explicit false", () => {
    delete process.env[flag];
    expect(httpOrigin("http", "127.0.0.1", 8080).host).toBe("127.0.0.1");
    process.env[flag] = "false";
    expect(httpOrigin("http", "[::1]", 8080).host).toBe("[::1]");
  });

  test("an invalid setting cannot silently disable the guard", () => {
    process.env[flag] = "tru";
    expect(() => httpOrigin("http", "8.8.8.8", 8080)).toThrow(DatabaseConfigError);
  });

  test("refuses mixed DNS answers, mapped IPv4, and an empty result", () => {
    expect(() => assertPublicDnsAnswers([{ address: "8.8.8.8", family: 4 }])).not.toThrow();
    expect(() => assertPublicDnsAnswers([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }])).toThrow(DatabaseConfigError);
    expect(() => assertPublicDnsAnswers([{ address: "::ffff:7f00:1", family: 6 }])).toThrow(DatabaseConfigError);
    expect(() => assertPublicDnsAnswers([{ address: "fd00::1", family: 6 }])).toThrow(DatabaseConfigError);
    expect(() => assertPublicDnsAnswers([])).toThrow(DatabaseConfigError);
  });

  test("passes the validating lookup to a fresh socket", () => {
    process.env[flag] = "on";
    expect(guardedNodeOptions("db.example.com")).toEqual({ lookup: publicAddressLookup, agent: false });
    expect(() => guardedNodeOptions("[::1]")).toThrow(DatabaseConfigError);
  });

  test("guards the custom TLS request path too", () => {
    process.env[flag] = "true";
    expect(() => nodeRequestJson(
      "https://169.254.169.254/query/service",
      { method: "GET", headers: {} },
      { rejectUnauthorized: true },
    )).toThrow(DatabaseConfigError);
  });

  test("does not send either literal or DNS-alias loopback requests", async () => {
    process.env[flag] = "true";
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(() => httpTransportFetch(`http://127.0.0.1:${port}/api/v1/query`)).toThrow(DatabaseConfigError);
      await expect(httpTransportFetch(`http://localhost:${port}/api/v1/query`)).rejects.toThrow();
      expect(hits).toBe(0);
      process.env[flag] = "false";
      expect(await (await httpTransportFetch(`http://127.0.0.1:${port}/api/v1/query`)).text()).toBe("reached");
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
