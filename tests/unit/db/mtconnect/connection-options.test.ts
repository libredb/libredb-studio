/**
 * The connection's address as the provider dials it: the scheme and TLS material from the SSL / TLS
 * panel, and the path prefix from the dialog's Path prefix field (MT-S6, MT-S7).
 *
 * Both fields are offered by the dialog (`connectionFields` and the SSL / TLS panel in
 * `src/lib/db-ui-config.ts`), so a value the provider ignores is a value the reader typed for nothing.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { mtconnectEndpoint, readPathPrefix } from "@/lib/db/providers/industrial/mtconnect/connection-options";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";

const connection = (
  extra: Partial<DatabaseConnection> & WithTunnelFarEnd = {},
): DatabaseConnection & WithTunnelFarEnd =>
  ({ id: "mtc", name: "mtc", type: "mtconnect", host: "agent.example", port: 5000, ...extra }) as DatabaseConnection &
    WithTunnelFarEnd;

describe("the path prefix", () => {
  test("an empty field and a bare slash both mean no prefix", () => {
    expect(readPathPrefix(undefined)).toBe("");
    expect(readPathPrefix("")).toBe("");
    expect(readPathPrefix("/")).toBe("");
  });

  test("a prefix is kept as written, without a trailing slash", () => {
    expect(readPathPrefix("/mtc")).toBe("/mtc");
    expect(readPathPrefix("/mtc/")).toBe("/mtc");
    expect(readPathPrefix("/plant/agent-1")).toBe("/plant/agent-1");
  });

  test.each([
    ["mtc", "begin with /"],
    ["/mtc?x=1", "a path and nothing else"],
    ["/mtc#top", "a path and nothing else"],
    ["/m%20c", "a path and nothing else"],
    ["/m c", "a path and nothing else"],
    ["/a//b", "empty, . or .. segment"],
    ["/a/./b", "empty, . or .. segment"],
    ["/a/../b", "empty, . or .. segment"],
  ])("%p is refused before any request", (value, sentence) => {
    expect(() => readPathPrefix(value)).toThrow(DatabaseConfigError);
    expect(() => readPathPrefix(value)).toThrow(sentence);
  });

  test("a value that is not text is refused", () => {
    expect(() => readPathPrefix(5000)).toThrow(DatabaseConfigError);
  });
});

describe("the scheme follows the SSL / TLS panel", () => {
  test("no panel dials http with no TLS material", () => {
    const endpoint = mtconnectEndpoint(connection());
    expect(endpoint.origin).toEqual({ scheme: "http", host: "agent.example", port: 5000 });
    expect(endpoint.tls).toBeNull();
    expect(endpoint.pathPrefix).toBe("");
  });

  test("the disable mode dials http too", () => {
    const endpoint = mtconnectEndpoint(connection({ ssl: { mode: "disable" } }));
    expect(endpoint.origin.scheme).toBe("http");
    expect(endpoint.tls).toBeNull();
  });

  test("require dials https and does not verify, as the mode says", () => {
    const endpoint = mtconnectEndpoint(connection({ ssl: { mode: "require" } }));
    expect(endpoint.origin.scheme).toBe("https");
    expect(endpoint.tls?.rejectUnauthorized).toBe(false);
    expect(endpoint.tls?.identity).toBe("agent.example");
  });

  test("verify-full carries the panel's CA and verifies against the host", () => {
    const endpoint = mtconnectEndpoint(connection({ ssl: { mode: "verify-full", caCert: CA_PLACEHOLDER } }));
    expect(endpoint.origin.scheme).toBe("https");
    expect(endpoint.tls?.rejectUnauthorized).toBe(true);
    expect(endpoint.tls?.ca?.toString("utf8")).toBe(CA_PLACEHOLDER);
    expect(endpoint.tls?.identity).toBe("agent.example");
  });

  test("through an SSH tunnel the certificate is checked against the far end, not the local forward", () => {
    const endpoint = mtconnectEndpoint(
      connection({
        host: "127.0.0.1",
        port: 40123,
        ssl: { mode: "verify-full" },
        sshTunnel: { enabled: true } as DatabaseConnection["sshTunnel"],
        [TUNNEL_FAR_END]: { host: "agent.plant.internal", port: 5000 },
      }),
    );
    expect(endpoint.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 40123 });
    expect(endpoint.tls?.identity).toBe("agent.plant.internal");
  });

  test("the path prefix travels with the address", () => {
    expect(mtconnectEndpoint(connection({ apiPath: "/mtc/" })).pathPrefix).toBe("/mtc");
  });
});

/** Only its presence on the material is asserted; no handshake reads it here. */
const CA_PLACEHOLDER = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
