import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseConfigError } from "@/lib/db/errors";
import { httpOrigin, httpOriginWithCoreDecision } from "@/lib/db/http/endpoint";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { forgetEgressDecision, INVALID_EGRESS_SETTING } from "@/lib/db/egress-decision";
import {
  assertPublicDnsAnswers,
  assertPublicLiteralHost,
  BLOCKED_HOST,
  EGRESS_DECISION_MISSING,
  guardedNodeOptions,
  httpTransportFetch,
  LOOPBACK_NETWORKS,
  linkLocalRefusingLookup,
  publicAddressLookup,
  requireEgressDecision,
  socketEgress,
} from "@/lib/db/http/egress-policy";
import { nodeRequestJson } from "@/lib/db/providers/document/couchbase/http-transport";
import { ALLOWS_PRIVATE_HOSTS, BLOCKS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { setEgressFlag } from "../../../helpers/egress-flag";

const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const original = process.env[flag];
afterEach(() => {
  setEgressFlag(original);
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
  ])("refuses %s before building a request with a blocking decision", (_label, host) => {
    expect(() => httpOrigin("http", host, 8080, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
    try {
      httpOrigin("http", host, 8080, BLOCKS_PRIVATE_HOSTS);
    } catch (error) {
      expect((error as Error).message).not.toContain(host);
    }
  });

  test("keeps public literals and hostnames available with a blocking decision", () => {
    expect(httpOrigin("https", "8.8.8.8", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("8.8.8.8");
    expect(httpOrigin("https", "168.63.129.16", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("168.63.129.16");
    expect(httpOrigin("https", "2606:4700:4700::1111", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("[2606:4700:4700::1111]");
    expect(httpOrigin("https", "db.example.com", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("db.example.com");
  });

  test("leaves local connections enabled with an allowing decision", () => {
    expect(httpOrigin("http", "127.0.0.1", 8080, ALLOWS_PRIVATE_HOSTS).host).toBe("127.0.0.1");
    expect(httpOrigin("http", "[::1]", 8080, ALLOWS_PRIVATE_HOSTS).host).toBe("[::1]");
  });

  test("an invalid setting cannot silently disable the guard of the interim reader httpOriginWithCoreDecision", () => {
    setEgressFlag("tru");
    let failure: unknown;
    try {
      httpOriginWithCoreDecision("http", "8.8.8.8", 8080);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toBe(INVALID_EGRESS_SETTING);
  });

  test("refuses mixed DNS answers, mapped IPv4, and an empty result", () => {
    expect(() => assertPublicDnsAnswers([{ address: "8.8.8.8", family: 4 }])).not.toThrow();
    expect(() =>
      assertPublicDnsAnswers([
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    ).toThrow(DatabaseConfigError);
    expect(() => assertPublicDnsAnswers([{ address: "::ffff:7f00:1", family: 6 }])).toThrow(DatabaseConfigError);
    expect(() => assertPublicDnsAnswers([{ address: "fd00::1", family: 6 }])).toThrow(DatabaseConfigError);
    expect(() => assertPublicDnsAnswers([])).toThrow(DatabaseConfigError);
  });

  test("passes the validating lookup to a fresh socket", () => {
    expect(guardedNodeOptions("db.example.com", BLOCKS_PRIVATE_HOSTS)).toEqual({
      lookup: publicAddressLookup,
      agent: false,
    });
    expect(() => guardedNodeOptions("[::1]", BLOCKS_PRIVATE_HOSTS)).toThrow(DatabaseConfigError);
  });

  test("guards the custom TLS request path too", () => {
    expect(() =>
      nodeRequestJson(
        // A loopback literal the blocking decision refuses: were the guard to decide otherwise, the dial would fail at
        // once on this machine instead of reaching the cloud metadata address.
        "https://127.0.0.1:1/query/service",
        { method: "GET", headers: {} },
        { rejectUnauthorized: true },
        BLOCKS_PRIVATE_HOSTS,
      ),
    ).toThrow(DatabaseConfigError);
  });

  test("does not send either literal or DNS-alias loopback requests", async () => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      expect(() => httpTransportFetch(`http://127.0.0.1:${port}/api/v1/query`, {}, BLOCKS_PRIVATE_HOSTS)).toThrow(
        DatabaseConfigError,
      );
      await expect(
        httpTransportFetch(`http://localhost:${port}/api/v1/query`, {}, BLOCKS_PRIVATE_HOSTS),
      ).rejects.toThrow();
      expect(hits).toBe(0);
      const reached = await httpTransportFetch(`http://127.0.0.1:${port}/api/v1/query`, {}, ALLOWS_PRIVATE_HOSTS);
      expect(await reached.text()).toBe("reached");
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

describe("LOOPBACK_NETWORKS", () => {
  /** Two addresses inside each row, so a row that is listed and not consumed by the blocked list fails here. */
  const PROBES: Record<string, readonly string[]> = {
    "127.0.0.0": ["127.0.0.1", "127.255.255.254"],
    "::1": ["[::1]", "0:0:0:0:0:0:0:1"],
  };

  test("are exactly the IPv4 and IPv6 loopback networks", () => {
    expect(LOOPBACK_NETWORKS).toEqual([
      ["127.0.0.0", 8, "ipv4"],
      ["::1", 128, "ipv6"],
    ]);
    expect(LOOPBACK_NETWORKS.map(([network]) => network)).toEqual(Object.keys(PROBES));
  });

  test("the blocked list refuses an address inside every row", () => {
    for (const [network] of LOOPBACK_NETWORKS) {
      for (const host of PROBES[network]) {
        expect(() => httpOrigin("http", host, 8080, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
      }
    }
  });
});

describe("the decision the interim readers read (FND-2 slice 2a)", () => {
  test("the interim readers keep the decision the process took: a value written after the first guarded call moves nothing until the decision is forgotten", () => {
    // An allowing decision, so the origin never refuses and the transport's own check is the subject.
    const origin = httpOrigin("http", "127.0.0.1", 8080, ALLOWS_PRIVATE_HOSTS);
    const build = () => createNodeTransport({ origin, tls: null, maxSockets: 1, headers: {} });
    setEgressFlag("true");
    // The interim reader of the origins slice 2b-3b converts.
    expect(() => httpOriginWithCoreDecision("http", "127.0.0.1", 8080)).toThrow(BLOCKED_HOST);
    expect(build).toThrow(BLOCKED_HOST);
    // A direct write, not the helper, on purpose: the process decided at its first read, so the write moves nothing.
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "false";
    expect(() => httpOriginWithCoreDecision("http", "127.0.0.1", 8080)).toThrow(BLOCKED_HOST);
    // The other interim reader, the node transport, until slice 2b-4 hands it the decision too.
    expect(build).toThrow(BLOCKED_HOST);
    forgetEgressDecision();
    expect(httpOriginWithCoreDecision("http", "127.0.0.1", 8080).host).toBe("127.0.0.1");
    build().close();
  });
});

describe("the guard decides by the decision it is handed (FND-2 slice 2b)", () => {
  test("assertPublicLiteralHost, guardedNodeOptions and httpTransportFetch refuse 127.0.0.1 with a blocking decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset", () => {
    setEgressFlag(undefined);
    expect(() => assertPublicLiteralHost("127.0.0.1", BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
    expect(() => guardedNodeOptions("[::1]", BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
    // Thrown synchronously, before any socket: the literal check runs before the request is built.
    expect(() => httpTransportFetch("http://127.0.0.1:9/", {}, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
  });

  test("and let it through with an allowing decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is true", async () => {
    setEgressFlag("true");
    expect(() => assertPublicLiteralHost("127.0.0.1", ALLOWS_PRIVATE_HOSTS)).not.toThrow();
    expect(guardedNodeOptions("127.0.0.1", ALLOWS_PRIVATE_HOSTS)).toEqual({});
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      response.end("reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const reached = await httpTransportFetch(`http://127.0.0.1:${port}/`, {}, ALLOWS_PRIVATE_HOSTS);
      expect(await reached.text()).toBe("reached");
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  test("httpOrigin refuses 127.0.0.1 and [::1] with a blocking decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset, and keeps a public literal and a name", () => {
    setEgressFlag(undefined);
    expect(() => httpOrigin("http", "127.0.0.1", 8080, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
    expect(() => httpOrigin("http", "[::1]", 8080, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
    expect(httpOrigin("https", "8.8.8.8", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("8.8.8.8");
    expect(httpOrigin("https", "2606:4700:4700::1111", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("[2606:4700:4700::1111]");
    expect(httpOrigin("https", "db.example.com", 443, BLOCKS_PRIVATE_HOSTS).host).toBe("db.example.com");
  });

  test("httpOrigin lets 127.0.0.1 through with an allowing decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is true", () => {
    setEgressFlag("true");
    expect(httpOrigin("http", "127.0.0.1", 8080, ALLOWS_PRIVATE_HOSTS).host).toBe("127.0.0.1");
  });

  test("socketEgress refuses 127.0.0.1 with a blocking decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is unset", () => {
    setEgressFlag(undefined);
    expect(() => socketEgress("127.0.0.1", { refusesLinkLocal: false }, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
    expect(() => socketEgress("127.0.0.1", { refusesLinkLocal: true }, BLOCKS_PRIVATE_HOSTS)).toThrow(BLOCKED_HOST);
  });

  test("socketEgress lets 127.0.0.1 through with an allowing decision while DB_HTTP_BLOCK_PRIVATE_HOSTS is true", () => {
    setEgressFlag("true");
    expect(socketEgress("127.0.0.1", { refusesLinkLocal: false }, ALLOWS_PRIVATE_HOSTS)).toBeUndefined();
    expect(socketEgress("127.0.0.1", { refusesLinkLocal: true }, ALLOWS_PRIVATE_HOSTS)).toBe(linkLocalRefusingLookup);
  });

  test("requireEgressDecision answers the decision it is given", () => {
    expect(requireEgressDecision(BLOCKS_PRIVATE_HOSTS)).toBe(BLOCKS_PRIVATE_HOSTS);
    expect(requireEgressDecision(ALLOWS_PRIVATE_HOSTS)).toBe(ALLOWS_PRIVATE_HOSTS);
  });

  test("requireEgressDecision refuses an absent decision by name", () => {
    let failure: unknown;
    try {
      requireEgressDecision(undefined);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toBe(EGRESS_DECISION_MISSING);
  });
});
