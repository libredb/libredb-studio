/**
 * The Oxia provider's connection options (SB1-4) and its dial policy over every shard leader (SB1-5.4).
 *
 * Every field refusal is asserted with its exact sentence, and none may name the value it refuses. The builder takes no
 * transport, so no socket can open here. `admitLeaders` is the policy that decides whether a leader may be dialled and
 * sent the token: byte equality with the sent authority, or a listed data server, and nothing else.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  admitLeaders,
  buildOxiaConnectionOptions,
  leaderPlaintextTokenRefusal,
  type OxiaConnectionOptions,
  oxiaEndpointText,
  oxiaErrorConnection,
  oxiaLeaderParser,
  parseDataServers,
  parseLeaderAddress,
} from "@/lib/db/providers/keyvalue/oxia/connection-options";
import { OXIA_RECEIVE_CAP_BYTES, OXIA_TYPE } from "@/lib/db/providers/keyvalue/oxia/constants";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";
import { oxiaConnection } from "../../../helpers/oxia-connection";
import { declareCredentialWarnings, SYNTHETIC_NO_SECRET } from "../../../helpers/synthetic-credential-warnings";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

/** A placeholder bearer token, header {"alg":"none"}, payload {"exp":1791590400}, an empty signature; never a real one. */
const TEST_TOKEN = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"exp":1791590400}').toString("base64url")}.`;
const TEST_TOKEN_EXPIRY = new Date(1791590400 * 1000).toISOString();
const CONTEXT = { executionReadOnly: false, queryTimeout: 30_000 };
const fixtures = loadTlsFixtures();
const TLS = { mode: "verify-full", caCert: fixtures.ca };
const FAR_END = { [TUNNEL_FAR_END]: { host: "oxia.internal", port: 6648 } };
const TUNNEL = { ...FAR_END, host: "127.0.0.1", port: 41000, sshTunnel: { enabled: true } };

type Overrides = Record<string | symbol, unknown>;

function build(overrides: Overrides = {}, context = CONTEXT): OxiaConnectionOptions {
  const config = oxiaConnection(overrides as Partial<DatabaseConnection>) as DatabaseConnection & WithTunnelFarEnd;
  return buildOxiaConnectionOptions(config, context);
}

/** The refusal of `overrides`, which must be Oxia's DatabaseConfigError and must name none of the values it was given. */
function refusal(overrides: Overrides, context = CONTEXT): string {
  let caught: unknown;
  try {
    build(overrides, context);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DatabaseConfigError);
  const error = caught as DatabaseConfigError;
  expect(error.provider as string).toBe("oxia");
  for (const value of Object.values(overrides)) {
    if (typeof value === "string" && value.length > 3) expect(error.message).not.toContain(value);
  }
  return error.message;
}

/** A Data servers text's refusal. */
function dataServersRefusal(text: string): string {
  return refusal({ dataServers: text });
}

/** A JWT-shaped token whose payload is `payload`, base64url encoded. */
const tokenWithPayload = (payload: string) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(payload, "utf8").toString("base64url")}.`;

const shapeSentence = (ordinal: string) =>
  `Each Data servers entry must be host:port with a port, separated by commas or spaces: the ${ordinal} entry is not.`;

const PLAINTEXT_ENDPOINT =
  'This connection would send its token without TLS to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or, if authentication is off on this server, clear the token. Or tick "Send the password without TLS", which then also covers every address under Data servers.';

let undo: (() => void) | undefined;
afterEach(() => {
  undo?.();
  undo = undefined;
});

describe("fields read in order, with every refusal (SB1-4.2)", () => {
  test("1. the tunnel: on without its far end, and not an object", () => {
    expect(refusal({ sshTunnel: { enabled: true } })).toBe(
      "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so Oxia was not dialled directly: the tunnel opens only when both Host and Port are set.",
    );
    expect(refusal({ sshTunnel: "x" })).toBe("The connection's sshTunnel must be an object; nothing was sent.");
  });

  test("2. the host: a pasted endpoint, and a host that is not one", () => {
    const nameOnly = "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.";
    expect(refusal({ host: "oxia.example:6648" })).toBe(nameOnly);
    expect(refusal({ host: "http://oxia.example" })).toBe(nameOnly);
    expect(refusal({ host: "bad host!" })).toBe(
      "Invalid host: expected a hostname, an IPv4 address or an IPv6 address",
    );
  });

  test("2. under a tunnel, the far end's host and port are validated too", () => {
    expect(refusal({ ...TUNNEL, [TUNNEL_FAR_END]: { host: "bad host!", port: 6648 } })).toBe(
      "Invalid host: expected a hostname, an IPv4 address or an IPv6 address",
    );
    expect(refusal({ ...TUNNEL, [TUNNEL_FAR_END]: { host: "oxia.internal", port: 0 } })).toBe(
      "Invalid port: expected an integer from 1 to 65535",
    );
  });

  test("3. the port: absent is 6648, digits are read, out of range is refused", () => {
    expect(build({ port: undefined }).endpoint.port).toBe(6648);
    expect(build({ port: "06648" }).endpoint.port).toBe(6648);
    for (const port of [0, 70000]) {
      expect(refusal({ port })).toBe("Invalid port: expected an integer from 1 to 65535");
    }
  });

  test("4. the user: Oxia has none", () => {
    expect(refusal({ user: "root" })).toBe("Oxia has no user name: clear User. A bearer token goes under Token.");
    expect(build({ user: "" }).token).toBeUndefined();
    expect(build({ user: null }).token).toBeUndefined();
    expect(refusal({ user: 5 })).toBe("The connection's user must be a string; nothing was sent.");
  });

  test("5. the token: absent, null and empty are none; a bearer token is kept exactly; any other character is refused", () => {
    for (const password of [undefined, null, ""]) {
      const options = build({ password });
      expect(options.token).toBeUndefined();
      expect(options.secretForms).toEqual([]);
    }
    const options = build({ password: TEST_TOKEN });
    expect(options.token).toBe(TEST_TOKEN);
    expect(options.secretForms).toEqual(secretForms([TEST_TOKEN]));
    const sentence =
      "The Token holds a character a bearer token cannot carry: only letters, digits and . _ ~ + / = - are allowed, with no space, tab or line break. Paste the token again; nothing was sent.";
    for (const character of [" ", "\t", "\n", '"', "ü"]) {
      expect(refusal({ password: `${TEST_TOKEN}${character}x` })).toBe(sentence);
    }
    expect(refusal({ password: ` ${TEST_TOKEN}` })).toBe(sentence);
  });

  test("6. the namespace: empty is default, anything else exactly as typed, within the bound", () => {
    for (const database of [undefined, null, ""]) expect(build({ database }).namespace).toBe("default");
    expect(build({ database: "Tenant" }).namespace).toBe("Tenant");
    expect(build({ database: " x " }).namespace).toBe(" x ");
    expect(build({ database: "a".repeat(300) }).namespace).toBe("a".repeat(300));
    expect(build({ database: "ü".repeat(150) }).namespace).toBe("ü".repeat(150));
    const sentence =
      "The Namespace must be at most 300 bytes of text with no control characters; empty means default. Nothing was sent.";
    for (const database of ["a".repeat(301), "ü".repeat(151), "a\u0007b", "a\u007fb", "a\uD800b"]) {
      expect(refusal({ database })).toBe(sentence);
    }
    expect(refusal({ database: 5 })).toBe("The connection's database must be a string; nothing was sent.");
  });

  test("6. the connection is not modified (F7)", () => {
    const config = oxiaConnection({ database: "" });
    buildOxiaConnectionOptions(config, CONTEXT);
    expect(config.database).toBe("");
  });

  test("7. TLS: disable and no panel are plaintext; a verifying panel names the host; an IP host is overridden", () => {
    for (const ssl of [undefined, { mode: "disable" }]) {
      const options = build({ ssl });
      expect(options.tlsMaterial).toBeUndefined();
      expect(options.tls).toBeUndefined();
    }
    const named = build({ host: "oxia.example", ssl: TLS });
    expect(named.tlsMaterial?.mode).toBe("verify-full");
    expect(named.tls?.identity).toBe("oxia.example");
    expect(named.tls?.serverNameOverride).toBe("oxia.example");
    const ip = build({ host: "127.0.0.1", ssl: TLS });
    expect(ip.tls?.identityIsIp).toBe(true);
    expect(ip.tls?.serverNameOverride).toBe("oxia.invalid");
    expect(refusal({ ssl: { mode: "verify-full", caCert: "not a certificate" } })).toBe(
      "The CA Certificate under SSL / TLS is not one or more PEM certificates: paste the certificate of the CA that issued Oxia's server certificate there.",
    );
  });

  test("8. allowInsecureAuth: absent is false, true is true, anything else is refused", () => {
    expect(build().allowInsecureAuth).toBe(false);
    expect(build({ allowInsecureAuth: true }).allowInsecureAuth).toBe(true);
    expect(refusal({ allowInsecureAuth: "yes" })).toBe(
      "The connection's allowInsecureAuth must be true or false; nothing was sent.",
    );
  });

  test("9. Data servers: not text is refused, empty is no entries", () => {
    expect(refusal({ dataServers: 5 })).toBe("The connection's dataServers must be a string; nothing was sent.");
    expect(build({ dataServers: "" }).dataServers).toEqual([]);
    expect(build({ dataServers: "a.example:6648" }).dataServers).toEqual([{ host: "a.example", port: 6648 }]);
  });

  test("10. a tunnel with Data servers is refused, also with consent", () => {
    const sentence =
      "Data servers cannot be used with an SSH tunnel: the tunnel carries one address, and Studio would dial the data servers directly, outside it. Clear Data servers, or turn the tunnel off.";
    expect(refusal({ ...TUNNEL, dataServers: "a.example:6648" })).toBe(sentence);
    expect(refusal({ ...TUNNEL, dataServers: "a.example:6648", allowInsecureAuth: true })).toBe(sentence);
  });

  test("11. a token without TLS to a host that is not this machine is refused, unless something makes it safe", () => {
    expect(refusal({ host: "oxia.example", password: TEST_TOKEN })).toBe(PLAINTEXT_ENDPOINT);
    expect(build({ host: "oxia.example", password: TEST_TOKEN, allowInsecureAuth: true }).token).toBe(TEST_TOKEN);
    expect(build({ host: "oxia.example", password: TEST_TOKEN, ssl: TLS }).token).toBe(TEST_TOKEN);
    expect(build({ host: "localhost", password: TEST_TOKEN }).token).toBe(TEST_TOKEN);
    expect(build({ host: "127.0.0.1", password: TEST_TOKEN }).token).toBe(TEST_TOKEN);
    expect(build({ ...TUNNEL, password: TEST_TOKEN }).token).toBe(TEST_TOKEN);
    expect(build({ host: "oxia.example" }).token).toBeUndefined();
  });

  test("12. read-only: the connection's, a seed's, the execution profile's; not a boolean is refused", () => {
    expect(build({ readOnly: true }).readOnly).toBe("connection");
    expect(build({ readOnly: true, seedId: "s1" }).readOnly).toBe("seed");
    expect(build({}, { ...CONTEXT, executionReadOnly: true }).readOnly).toBe("execution-profile");
    expect(build().readOnly).toBeUndefined();
    for (const readOnly of ["yes", null]) expect(refusal({ readOnly })).toBe("readOnly must be true or false.");
  });

  test("13. the seed stage refuses a read-only seed whose credential is declared unsafe", () => {
    undo = declareCredentialWarnings(OXIA_TYPE, [SYNTHETIC_NO_SECRET]);
    expect(refusal({ readOnly: true, seedId: "s1" })).toBe(
      `Credential warning: ${SYNTHETIC_NO_SECRET.message} This read-only seed connection is refused with this credential, because the mode would promise a boundary the server does not keep; nothing was sent.`,
    );
    expect(build({ readOnly: true, seedId: "s1", host: "localhost", password: TEST_TOKEN }).readOnly).toBe("seed");
  });

  test("14. the query timeout", () => {
    for (const queryTimeout of [0, 1.5, 2147483648]) {
      expect(refusal({}, { ...CONTEXT, queryTimeout })).toBe(
        "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
      );
    }
    expect(build({}, { ...CONTEXT, queryTimeout: 2147483647 }).callTimeoutMs).toBe(2147483647);
  });

  test("15. no refusal names the value it refuses", () => {
    // refusal() asserts it on every call of this describe; here on the values a user is most likely to paste.
    for (const overrides of [
      { host: "secret-host.example:6648" },
      { user: "secret-user" },
      { password: "secret token" },
      { database: "secret\u0007namespace" },
      { dataServers: "secret.example" },
      { dataServers: "*.secret.example:6648" },
      { dataServers: "secret.example.:6648" },
    ]) {
      refusal(overrides);
    }
  });

  test("16. the order of the checks", () => {
    const wrong: Overrides = {
      sshTunnel: { enabled: true },
      host: "bad host!",
      port: 0,
      user: "root",
      password: "a b",
      database: "a\u0007b",
      ssl: { mode: "verify-full", caCert: "not a certificate" },
      allowInsecureAuth: "yes",
      dataServers: "nope",
      readOnly: "yes",
    };
    const steps: ReadonlyArray<readonly [Overrides, string]> = [
      [{ sshTunnel: undefined }, "This connection's SSH tunnel is on"],
      [{ host: "oxia.example" }, "Invalid host"],
      [{ port: 6648 }, "Invalid port"],
      [{ user: undefined }, "Oxia has no user name"],
      [{ password: TEST_TOKEN }, "The Token holds a character"],
      [{ database: undefined }, "The Namespace must be"],
      [{ ssl: undefined }, "The CA Certificate under SSL / TLS"],
      [{ allowInsecureAuth: false }, "The connection's allowInsecureAuth"],
      [{ dataServers: undefined }, "Each Data servers entry"],
      [{ allowInsecureAuth: true }, "This connection would send its token"],
      [{ readOnly: undefined }, "readOnly must be"],
    ];
    const context = { ...CONTEXT, queryTimeout: 0 };
    const current: Overrides = { ...wrong };
    for (const [fix, expected] of steps) {
      expect(refusal(current, context).startsWith(expected)).toBe(true);
      Object.assign(current, fix);
    }
    expect(refusal(current, context)).toBe(
      "Query timeout must be a whole number between 1 and 2147483647 milliseconds.",
    );
    expect(build(current).token).toBe(TEST_TOKEN);
  });
});

describe("the authority rule (SB1-4.7)", () => {
  const cases: ReadonlyArray<readonly [Overrides, string, string]> = [
    [{ host: "127.0.0.1", port: undefined }, "dns:127.0.0.1:6648", "127.0.0.1:6648"],
    [{ host: "LOCALHOST", port: undefined }, "dns:localhost:6648", "localhost:6648"],
    [{ host: "[::1]", port: 7000 }, "dns:[::1]:7000", "[::1]:7000"],
    [{ host: "[FD00:0::1]", port: undefined }, "dns:[fd00:0::1]:6648", "[fd00:0::1]:6648"],
  ];

  test("the target and the sent authority from validated parts, the port always written", () => {
    for (const [overrides, target, authority] of cases) {
      const options = build(overrides);
      expect(options.target).toBe(target);
      expect(options.sentAuthority).toBe(authority);
      expect(options.sentAuthority).toBe(options.target.slice("dns:".length));
      expect(options.tunnelled).toBe(false);
    }
  });

  test("an IPv6 endpoint is compressed, while the target keeps the validated text", () => {
    const options = build({ host: "[FD00:0::1]", port: undefined });
    expect(options.endpoint.host).toBe("[fd00::1]");
    expect(oxiaEndpointText(options)).toBe("[fd00::1]:6648");
  });

  test("under a tunnel the target is the local forward and the endpoint the far end", () => {
    const options = build(TUNNEL);
    expect(options.target).toBe("dns:127.0.0.1:41000");
    expect(options.sentAuthority).toBe("127.0.0.1:41000");
    expect(options.endpoint).toEqual({ host: "oxia.internal", port: 6648 });
    expect(options.tunnelled).toBe(true);
    expect(oxiaEndpointText(options)).toBe("oxia.internal:6648");
    expect(build({ ...TUNNEL, ssl: TLS }).tls?.identity).toBe("oxia.internal");
  });
});

describe("parseDataServers (SB1-4.6)", () => {
  test("entries split on commas and white space, in order; nothing is no entries", () => {
    expect(parseDataServers("a.example:6648, b.example:6649\nc.example:1")).toEqual([
      { host: "a.example", port: 6648 },
      { host: "b.example", port: 6649 },
      { host: "c.example", port: 1 },
    ]);
    expect(parseDataServers(" ,, ")).toEqual([]);
  });

  test("canonical forms: IPv6 compressed, the port as a number, the host lower case, duplicates dropped", () => {
    expect(parseDataServers("[FD00:0::1]:6648, [fd00::1]:6648")).toEqual([{ host: "[fd00::1]", port: 6648 }]);
    expect(parseDataServers("a.example:06648")).toEqual([{ host: "a.example", port: 6648 }]);
    expect(parseDataServers("A.EXAMPLE:1")).toEqual([{ host: "a.example", port: 1 }]);
    expect(parseDataServers("a.example:1 b.example:2 a.example:1")).toEqual([
      { host: "a.example", port: 1 },
      { host: "b.example", port: 2 },
    ]);
  });

  test("the shape sentence names the entry's position, never its text", () => {
    expect(dataServersRefusal("x.example:1, nope, y.example:2")).toBe(shapeSentence("2nd"));
    const ordinals: ReadonlyArray<readonly [number, string]> = [
      [1, "1st"],
      [2, "2nd"],
      [3, "3rd"],
      [4, "4th"],
      [11, "11th"],
      [12, "12th"],
      [13, "13th"],
      [21, "21st"],
      [22, "22nd"],
      [23, "23rd"],
      [101, "101st"],
    ];
    for (const [position, ordinal] of ordinals) {
      const text = [...Array.from({ length: position - 1 }, () => "a.example:1"), "nope"].join(",");
      expect(dataServersRefusal(text)).toBe(shapeSentence(ordinal));
    }
  });

  test("every entry that is not host:port is the shape sentence", () => {
    for (const entry of [
      "a.example",
      "a.example:",
      "a.example:0",
      "a.example:x",
      "bad!:1",
      "fd00::1:6648",
      "[fd00::1]",
    ]) {
      expect(dataServersRefusal(`ok.example:1 ${entry}`)).toBe(shapeSentence("2nd"));
    }
  });

  test("a wildcard and a trailing dot have their own sentences", () => {
    expect(dataServersRefusal("*.example:6648")).toBe(
      "Data servers entries name exact addresses: a wildcard (*) is not accepted, because it would match any service a tenant can create, and the token would follow.",
    );
    expect(dataServersRefusal("a.example.:6648")).toBe(
      "Data servers entries must not end the host with a dot: write the name without the final dot.",
    );
  });

  test("64 distinct entries pass; 65 are refused; 65 with two duplicates pass", () => {
    const entries = (count: number) => Array.from({ length: count }, (_, i) => `n${i}.example:6648`);
    expect(parseDataServers(entries(64).join(","))).toHaveLength(64);
    expect(dataServersRefusal(entries(65).join(","))).toBe(
      "Data servers holds more than 64 addresses; list only the cluster's data servers.",
    );
    expect(parseDataServers([...entries(63), "n0.example:6648", "n1.example:6648"].join(","))).toHaveLength(63);
    expect(parseDataServers([...entries(64), "n0.example:6648"].join(","))).toHaveLength(64);
  });
});

describe("parseLeaderAddress (SB1-4.6)", () => {
  test("a leader in any spelling to its canonical form", () => {
    expect(parseLeaderAddress("oxia-0.oxia.svc:6648")).toEqual({ host: "oxia-0.oxia.svc", port: 6648 });
    expect(parseLeaderAddress("OXIA:6648")).toEqual({ host: "oxia", port: 6648 });
    expect(parseLeaderAddress("[FD00:0::1]:6648")).toEqual({ host: "[fd00::1]", port: 6648 });
  });

  test("undefined for anything that is not host:port within 300 bytes", () => {
    for (const raw of ["http://x:1", "unix:/x", "host:0", "host:99999", "host", "*.x:1", "x.:1", ""]) {
      expect(parseLeaderAddress(raw)).toBeUndefined();
    }
    const over = `${"a".repeat(296)}:6648`;
    expect(Buffer.byteLength(over)).toBe(301);
    expect(parseLeaderAddress(over)).toBeUndefined();
  });

  test("the longest leader a host name allows parses", () => {
    // validateHost bounds a name at 253 characters, so no valid leader reaches 300 bytes.
    const host = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
    expect(host).toHaveLength(253);
    expect(parseLeaderAddress(`${host}:65535`)).toEqual({ host, port: 65535 });
  });
});

describe("admitLeaders: the dial policy over every leader (SB1-5.4)", () => {
  const base = build({ host: "oxia.example", password: TEST_TOKEN, ssl: TLS });

  test("a leader byte-equal to the sent authority is the bootstrap", () => {
    const answer = admitLeaders(base, ["oxia.example:6648"]);
    expect([...answer.admitted]).toEqual([
      ["oxia.example:6648", { host: "oxia.example", port: 6648, address: "oxia.example:6648", bootstrap: true }],
    ]);
    expect(answer.refusal).toBeUndefined();
  });

  test("a sent authority no leader parse accepts is still the bootstrap when byte-equal", () => {
    // Host accepts a trailing dot, which parseLeaderAddress refuses; byte equality alone decides the bootstrap.
    const dotted = build({ host: "oxia.example.", ssl: TLS });
    expect(dotted.sentAuthority).toBe("oxia.example.:6648");
    const answer = admitLeaders(dotted, ["oxia.example.:6648"]);
    expect([...answer.admitted]).toEqual([
      ["oxia.example.:6648", { host: "oxia.example.", port: 6648, address: "oxia.example.:6648", bootstrap: true }],
    ]);
    expect(answer.refusal).toBeUndefined();
    const ipv6 = build({ host: "[FD00:0::1]", port: 7000 });
    expect(admitLeaders(ipv6, ["[fd00:0::1]:7000"]).admitted.get("[fd00:0::1]:7000")).toEqual({
      host: "[fd00::1]",
      port: 7000,
      address: "[fd00::1]:7000",
      bootstrap: true,
    });
  });

  test("oxiaLeaderParser: the sent authority, byte for byte, is its own endpoint; every other leader is parsed", () => {
    // The snapshot check (routing.ts) parses every leader with the parser it is given, so a Host with a trailing dot,
    // which no leader parse accepts, reaches rule 1 only through this parser.
    const dotted = build({ host: "oxia.example.", ssl: TLS });
    const parse = oxiaLeaderParser(dotted);
    expect(parseLeaderAddress("oxia.example.:6648")).toBeUndefined();
    expect(parse("oxia.example.:6648")).toEqual({ host: "oxia.example.", port: 6648 });
    expect(parse("other.example.:6648")).toBeUndefined();
    expect(parse("OXIA-0.example:7000")).toEqual(parseLeaderAddress("OXIA-0.example:7000"));
    expect(parse("not an address")).toBeUndefined();
    const ipv6 = oxiaLeaderParser(build({ host: "[FD00:0::1]", port: 7000 }));
    expect(ipv6("[fd00:0::1]:7000")).toEqual({ host: "[fd00::1]", port: 7000 });
  });

  test("no case folding and no alias", () => {
    for (const leader of ["OXIA.example:6648", "oxia.example.:6648", "oxia.example:06648"]) {
      const answer = admitLeaders(base, [leader]);
      expect(answer.admitted.size).toBe(0);
      expect(answer.refusal).toBeDefined();
    }
  });

  test("a listed data server is admitted, not as the bootstrap", () => {
    const options = build({ host: "oxia.example", password: TEST_TOKEN, ssl: TLS, dataServers: "oxia-1.example:6648" });
    const answer = admitLeaders(options, ["oxia.example:6648", "oxia-1.example:6648", "oxia-1.example:6648"]);
    expect([...answer.admitted.keys()]).toEqual(["oxia.example:6648", "oxia-1.example:6648"]);
    expect(answer.admitted.get("oxia-1.example:6648")).toEqual({
      host: "oxia-1.example",
      port: 6648,
      address: "oxia-1.example:6648",
      bootstrap: false,
    });
    expect(answer.refusal).toBeUndefined();
  });

  test("a listed data server in another spelling is admitted by its parsed form", () => {
    const upper = build({ host: "oxia.example", ssl: TLS, dataServers: "OXIA-1.example:6648" });
    expect(admitLeaders(upper, ["oxia-1.example:6648"]).admitted.has("oxia-1.example:6648")).toBe(true);
    const ipv6 = build({ host: "oxia.example", ssl: TLS, dataServers: "[fd00::1]:6648" });
    const answer = admitLeaders(ipv6, ["[FD00:0::1]:6648"]);
    expect(answer.admitted.get("[FD00:0::1]:6648")?.address).toBe("[fd00::1]:6648");
    expect(answer.refusal).toBeUndefined();
  });

  test("(a) a loopback endpoint and a leader on another host", () => {
    const sentence = (authority: string) =>
      `This connection reaches Oxia through a port-forward or tunnel at ${authority}, but the cluster sends clients to oxia-0.oxia.svc:6648 for its shards, which this machine cannot be assumed to reach. Run Studio where oxia-0.oxia.svc:6648 resolves and is reachable; the Oxia provider doc shows the hosts-file and per-pod port-forward workaround.`;
    expect(admitLeaders(build({ host: "localhost" }), ["oxia-0.oxia.svc:6648"]).refusal).toBe(
      sentence("localhost:6648"),
    );
    expect(admitLeaders(build(TUNNEL), ["oxia-0.oxia.svc:6648"]).refusal).toBe(sentence("127.0.0.1:41000"));
  });

  test("(a) names the first refused leader on another host, and an unparsed one by what it is not", () => {
    const local = build({ host: "localhost" });
    expect(admitLeaders(local, ["localhost:6649", "oxia-0.oxia.svc:6648"]).refusal).toContain(
      "sends clients to oxia-0.oxia.svc:6648 for its shards",
    );
    expect(admitLeaders(local, ["not an address"]).refusal).toContain(
      "sends clients to an address that is not host:port for its shards",
    );
  });

  test("(a) under a tunnel for every refused leader, the far end's own host included: Data servers cannot be set there", () => {
    // Studio reaches only the local forward, and a tunnel refuses Data servers, so (b) and (c) would offer a remedy
    // the builder then refuses; the far end's host on its own port or another is as unreachable as any other host.
    const tunnelled = build(TUNNEL);
    for (const leader of ["oxia.internal:6648", "oxia.internal:6649"]) {
      expect(admitLeaders(tunnelled, [leader]).refusal).toBe(
        `This connection reaches Oxia through a port-forward or tunnel at 127.0.0.1:41000, but the cluster sends clients to ${leader} for its shards, which this machine cannot be assumed to reach. Run Studio where ${leader} resolves and is reachable; the Oxia provider doc shows the hosts-file and per-pod port-forward workaround.`,
      );
    }
    expect(admitLeaders(tunnelled, ["not an address"]).refusal).toContain(
      "sends clients to an address that is not host:port for its shards",
    );
  });

  test("(b) one refused leader on the endpoint's port under another host spelling", () => {
    expect(admitLeaders(base, ["oxia-0:6648"]).refusal).toBe(
      "This server calls itself oxia-0:6648: type oxia-0 in Host, or add oxia-0:6648 to Data servers.",
    );
  });

  test("(b) one refused loopback leader on a loopback endpoint's port: that name is this machine too (ruling R35)", () => {
    // Host 127.0.0.1 against a server that calls itself localhost:6648: typing localhost in Host connects.
    expect(admitLeaders(build({ host: "127.0.0.1" }), ["localhost:6648"]).refusal).toBe(
      "This server calls itself localhost:6648: type localhost in Host, or add localhost:6648 to Data servers.",
    );
    // Another port, a second refused leader, or a tunnel keeps (a): only the forward is reachable there.
    expect(admitLeaders(build({ host: "127.0.0.1" }), ["localhost:6649"]).refusal).toStartWith(
      "This connection reaches Oxia through a port-forward or tunnel at 127.0.0.1:6648",
    );
    expect(admitLeaders(build({ host: "127.0.0.1" }), ["localhost:6648", "127.0.0.2:6648"]).refusal).toStartWith(
      "This connection reaches Oxia through a port-forward or tunnel at 127.0.0.1:6648",
    );
    expect(admitLeaders(build(TUNNEL), ["localhost:6648"]).refusal).toStartWith(
      "This connection reaches Oxia through a port-forward or tunnel at 127.0.0.1:41000",
    );
  });

  test("(c) otherwise, every refused address listed in shard order", () => {
    const listed =
      "The cluster sends clients to data servers this connection does not list: b.example:7000, a.example:7000. Studio dials only the endpoint and the addresses under Data servers, and sends the token to no other. To allow them, list under Data servers these addresses and every other data server of the cluster: b.example:7000, a.example:7000";
    expect(admitLeaders(base, ["b.example:7000", "a.example:7000", "b.example:7000"]).refusal).toBe(listed);
    const withUnparsed = admitLeaders(base, ["b.example:7000", "not an address", "a.example:7000"]).refusal;
    expect(withUnparsed).toBe(
      `${listed} One shard's leader is an address that is not host:port, which Studio never dials.`,
    );
    expect(withUnparsed).not.toContain("not an address");
    expect(admitLeaders(base, ["oxia-0:7000"]).refusal).toStartWith(
      "The cluster sends clients to data servers this connection does not list: oxia-0:7000.",
    );
  });

  test("64 refused leaders are listed in full; 65 are refused outright", () => {
    const leaders = (count: number) => Array.from({ length: count }, (_, i) => `n${i}.example:7000`);
    const full = leaders(64).join(", ");
    expect(admitLeaders(base, leaders(64)).refusal).toBe(
      `The cluster sends clients to data servers this connection does not list: ${full}. Studio dials only the endpoint and the addresses under Data servers, and sends the token to no other. To allow them, list under Data servers these addresses and every other data server of the cluster: ${full}`,
    );
    const outright = admitLeaders(base, leaders(65)).refusal;
    expect(outright).toBe(
      "The cluster sends clients to 65 data servers this connection does not list, more than the 64 that Data servers can hold, so Studio cannot reach this namespace's shards and nothing was read.",
    );
    expect(outright).not.toContain(".example");
  });

  test("the plaintext rule per leader (SB1-4.5)", () => {
    const leaders = ["localhost:6648", "oxia-1.example:6648"];
    const plain = { host: "localhost", password: TEST_TOKEN, dataServers: "oxia-1.example:6648" };
    const answer = admitLeaders(build(plain), leaders);
    expect(answer.refusal).toBe(leaderPlaintextTokenRefusal("oxia-1.example:6648"));
    expect(answer.admitted.size).toBe(2);
    expect(admitLeaders(build({ ...plain, allowInsecureAuth: true }), leaders).refusal).toBeUndefined();
    expect(admitLeaders(build({ ...plain, ssl: TLS }), leaders).refusal).toBeUndefined();
    expect(admitLeaders(build({ ...plain, password: undefined }), leaders).refusal).toBeUndefined();
    const loopback = build({ ...plain, dataServers: "127.0.0.2:6648" });
    expect(admitLeaders(loopback, ["localhost:6648", "127.0.0.2:6648"]).refusal).toBeUndefined();
  });

  test("a refused leader is reported before a plaintext leader", () => {
    const options = build({ host: "localhost", password: TEST_TOKEN, dataServers: "oxia-1.example:6648" });
    const answer = admitLeaders(options, ["oxia-1.example:6648", "other.example:7000"]);
    expect(answer.refusal).toStartWith(
      "This connection reaches Oxia through a port-forward or tunnel at localhost:6648, but the cluster sends clients to other.example:7000",
    );
  });

  test("the decision is pure", () => {
    const options = build({ host: "oxia.example", ssl: TLS, dataServers: "oxia-1.example:6648" });
    const before = JSON.stringify(options);
    const leaders = ["oxia.example:6648", "oxia-1.example:6648", "b.example:7000"];
    expect(admitLeaders(options, leaders)).toEqual(admitLeaders(options, leaders));
    expect(JSON.stringify(options)).toBe(before);
  });
});

describe("the exported sentences and views", () => {
  test("leaderPlaintextTokenRefusal names the data server and no tunnel", () => {
    const sentence = leaderPlaintextTokenRefusal("oxia-1.example:6648");
    expect(sentence).toBe(
      'This connection would send its token without TLS to the data server oxia-1.example:6648, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, or, if authentication is off on this server, clear the token. Or tick "Send the password without TLS", which then also covers every address under Data servers.',
    );
    expect(sentence).not.toContain("SSH tunnel");
  });

  test("oxiaEndpointText", () => {
    expect(oxiaEndpointText(build({ host: "[FD00:0::1]", port: undefined }))).toBe("[fd00::1]:6648");
    expect(oxiaEndpointText(build({ host: "LOCALHOST", port: undefined }))).toBe("localhost:6648");
    expect(oxiaEndpointText(build(TUNNEL))).toBe("oxia.internal:6648");
  });

  test("oxiaErrorConnection", () => {
    const options = build({
      host: "localhost",
      password: TEST_TOKEN,
      dataServers: "oxia-1.example:6648",
      ssl: { ...TLS, clientCert: fixtures.client.cert, clientKey: fixtures.client.key },
    });
    expect(oxiaErrorConnection(options)).toEqual({
      host: "localhost",
      port: 6648,
      sentAuthority: "localhost:6648",
      loopback: true,
      tunnelled: false,
      tls: { serverName: "localhost", clientCertificate: true },
      runtimeReportsTlsCause: false,
      receiveCapBytes: OXIA_RECEIVE_CAP_BYTES,
      timeoutMs: 30_000,
      namespace: "default",
      tokenExpiry: TEST_TOKEN_EXPIRY,
      listsDataServers: true,
    });
    expect(oxiaErrorConnection(build({ host: "oxia.example", ssl: TLS }))).toMatchObject({
      loopback: false,
      tls: { serverName: "oxia.example", clientCertificate: false },
      listsDataServers: false,
    });
    expect(oxiaErrorConnection(build()).tls).toBeUndefined();
  });

  test("tokenExpiry is absent unless the payload is JSON with a whole exp", () => {
    for (const password of [
      tokenWithPayload("not json"),
      tokenWithPayload('{"sub":"x"}'),
      tokenWithPayload('{"exp":1.5}'),
      tokenWithPayload("null"),
      "abc",
    ]) {
      expect("tokenExpiry" in oxiaErrorConnection(build({ password }))).toBe(false);
    }
    expect("tokenExpiry" in oxiaErrorConnection(build())).toBe(false);
  });

  test("receiveCapBytes is the cap on every built options object", () => {
    for (const overrides of [{}, { ssl: TLS }, TUNNEL, { dataServers: "a.example:1" }]) {
      expect(build(overrides).receiveCapBytes).toBe(OXIA_RECEIVE_CAP_BYTES);
    }
  });
});
