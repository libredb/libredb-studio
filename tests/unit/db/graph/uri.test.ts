/**
 * Bolt endpoint from a saved connection (Neo4j provider spec 3.3, revisions SR12 and SR13)
 *
 * The host, port and TLS panel become one bolt-family URI and, for a custom CA, the
 * PEM text the transport trusts. The host and port go through the shared validators,
 * the URI is parsed back and must name the same host and port, and the routing
 * `neo4j` schemes never appear (E7). Client certificates and a verifying TLS mode
 * through an SSH tunnel are refused with a configuration error.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { boltEndpointOf } from "@/lib/db/graph/bolt/uri";
import { type SSLConfig, TUNNEL_FAR_END, type TunnelFarEnd } from "@/lib/types";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

function endpoint(host: unknown, port?: unknown, ssl?: unknown) {
  return boltEndpointOf({ host, port, ssl } as Parameters<typeof boltEndpointOf>[0], 7687);
}

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    return error as DatabaseConfigError;
  }
  throw new Error("expected a DatabaseConfigError");
}

describe("host and port", () => {
  test("a hostname and the default port", () => {
    expect(endpoint("graph.example.com")).toEqual({ uri: "bolt://graph.example.com:7687" });
  });

  test("an explicit port, as a number or a string of digits", () => {
    expect(endpoint("127.0.0.1", 17687).uri).toBe("bolt://127.0.0.1:17687");
    expect(endpoint("127.0.0.1", "17687").uri).toBe("bolt://127.0.0.1:17687");
  });

  test("a null port reads as the default", () => {
    expect(endpoint("db", null).uri).toBe("bolt://db:7687");
  });

  test("a host is lower-cased as a URL holds it", () => {
    expect(endpoint("Graph.Example.COM").uri).toBe("bolt://graph.example.com:7687");
  });

  test("an IPv6 literal, bare or bracketed, is bracketed in the URI", () => {
    expect(endpoint("::1").uri).toBe("bolt://[::1]:7687");
    expect(endpoint("[::1]", 7000).uri).toBe("bolt://[::1]:7000");
  });

  test("an IPv6 literal is written in the form the URL parser reads back", () => {
    expect(endpoint("0:0:0:0:0:0:0:1").uri).toBe("bolt://[::1]:7687");
  });

  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["a scheme", "bolt://db"],
    ["a path", "db/admin"],
    ["whitespace", "db host"],
    ["not a string", 42],
  ])("a host with %s is refused naming the field", (_, host) => {
    expect(refusal(() => endpoint(host)).message).toMatch(/^Invalid host/);
  });

  test("userinfo in the host is refused, and the value is not repeated", () => {
    const error = refusal(() => endpoint("neo4j:secret@db"));
    expect(error.message).toMatch(/^Invalid host/);
    expect(error.message).toContain("user and password fields");
    expect(error.message).not.toContain("secret");
  });

  test.each([0, 65536, 1.5, "7687x", -1])("port %p is refused naming the field", (port) => {
    expect(refusal(() => endpoint("db", port)).message).toMatch(/^Invalid port/);
  });
});

describe("TLS panel", () => {
  const cases: Array<[string, Partial<SSLConfig> | undefined | null, string, string | undefined]> = [
    ["no panel", undefined, "bolt", undefined],
    ["a null panel", null, "bolt", undefined],
    ["disable", { mode: "disable" }, "bolt", undefined],
    ["require", { mode: "require" }, "bolt+ssc", undefined],
    ["require with verification off", { mode: "require", rejectUnauthorized: false }, "bolt+ssc", undefined],
    ["require with verification on", { mode: "require", rejectUnauthorized: true }, "bolt+s", undefined],
    ["verify-system", { mode: "verify-system" }, "bolt+s", undefined],
    ["verify-ca with a CA", { mode: "verify-ca", caCert: PEM }, "bolt+s", PEM],
    ["verify-full with a CA", { mode: "verify-full", caCert: PEM }, "bolt+s", PEM],
    ["verify-ca without a CA", { mode: "verify-ca" }, "bolt+s", undefined],
    ["verify-full with an empty CA", { mode: "verify-full", caCert: "" }, "bolt+s", undefined],
    ["verify-full with verification off", { mode: "verify-full", rejectUnauthorized: false }, "bolt+s", undefined],
    ["a panel with no mode", { caCert: PEM }, "bolt+s", undefined],
  ];

  test.each(cases)("%s", (_, ssl, scheme, pem) => {
    const result = endpoint("db", 7687, ssl);
    expect(result.uri).toBe(`${scheme}://db:7687`);
    expect(result.trustedCertificatePem).toBe(pem);
    expect("trustedCertificatePem" in result).toBe(pem !== undefined);
  });

  test("a CA certificate is ignored unless the mode verifies against it", () => {
    expect(endpoint("db", 7687, { mode: "require", caCert: PEM })).toEqual({ uri: "bolt+ssc://db:7687" });
    expect(endpoint("db", 7687, { mode: "verify-system", caCert: PEM })).toEqual({ uri: "bolt+s://db:7687" });
  });

  test.each([
    ["clientCert", { mode: "verify-full", clientCert: "cert" }],
    ["clientKey", { mode: "require", clientKey: "key" }],
    ["clientCert on a disabled panel", { mode: "disable", clientCert: "cert" }],
  ])("a %s is refused: client certificates are not supported", (_, ssl) => {
    const error = refusal(() => endpoint("db", 7687, ssl));
    expect(error.message).toContain("client certificates are not supported for Neo4j");
  });

  test("empty client certificate fields read as absent", () => {
    expect(endpoint("db", 7687, { mode: "require", clientCert: "", clientKey: "" }).uri).toBe("bolt+ssc://db:7687");
  });

  test.each([
    ["an unknown mode", { mode: "prefer" }],
    ["a mode that is not a string", { mode: 1 }],
  ])("%s is refused naming ssl.mode", (_, ssl) => {
    expect(refusal(() => endpoint("db", 7687, ssl)).message).toContain("ssl.mode");
  });

  test.each([
    ["a panel that is not an object", "require", "ssl"],
    ["a panel that is an array", [], "ssl"],
    ["a CA that is not a string", { mode: "verify-ca", caCert: 1 }, "ssl.caCert"],
    ["a client certificate that is not a string", { mode: "require", clientCert: true }, "ssl.clientCert"],
    ["a client key that is not a string", { mode: "require", clientKey: {} }, "ssl.clientKey"],
    [
      "a verification flag that is not a boolean",
      { mode: "require", rejectUnauthorized: "yes" },
      "ssl.rejectUnauthorized",
    ],
  ])("%s is refused naming the field", (_, ssl, field) => {
    expect(refusal(() => endpoint("db", 7687, ssl)).message).toContain(field);
  });

  test("never a routing neo4j scheme", () => {
    for (const [, ssl] of cases) {
      expect(endpoint("db", 7687, ssl).uri).toMatch(/^bolt(\+s|\+ssc)?:\/\//);
    }
  });
});

describe("SSH tunnel", () => {
  const farEnd: TunnelFarEnd = { host: "graph.internal", port: 7687 };

  function tunnelled(ssl: Partial<SSLConfig> | undefined) {
    return boltEndpointOf({ host: "127.0.0.1", port: 40000, ssl: ssl as SSLConfig, [TUNNEL_FAR_END]: farEnd }, 7687);
  }

  test("a verifying TLS mode through a tunnel is refused, naming the alternatives", () => {
    for (const ssl of [
      { mode: "verify-system" },
      { mode: "verify-full", caCert: PEM },
      { mode: "require", rejectUnauthorized: true },
    ] as const) {
      const error = refusal(() => tunnelled(ssl));
      expect(error.message).toContain("through an SSH tunnel is not supported for Neo4j");
      expect(error.message).toContain("require");
      expect(error.message).toContain("without the tunnel");
    }
  });

  test("plain and self-signed TLS go through a tunnel", () => {
    expect(tunnelled(undefined).uri).toBe("bolt://127.0.0.1:40000");
    expect(tunnelled({ mode: "require" }).uri).toBe("bolt+ssc://127.0.0.1:40000");
  });
});
