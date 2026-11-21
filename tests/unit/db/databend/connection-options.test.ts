/**
 * The Databend connection (design 3.2, 3.5, 3.6, 3.12, 3.14, 6.3): the origin and far end, the latch key [X03], the
 * TLS material, the connection headers, the per-request header names, the bounds and the secret forms. Every refusal
 * is a DatabaseConfigError raised before any socket, and none repeats the value it refuses.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getAppVersion } from "@/lib/app-version";
import { tunnelRoute } from "@/lib/db/connection-fingerprint";
import { DatabaseConfigError } from "@/lib/db/errors";
import { authLatchKey } from "@/lib/db/providers/sql/databend/auth-latch";
import {
  buildDatabendConnectionOptions,
  DATABEND_CELL_BUDGET,
  DATABEND_CLOSE_TIMEOUT_MS,
  DATABEND_CONNECTION_SENTENCES,
  DATABEND_DEFAULT_PORT,
  DATABEND_LIMITER_OPTIONS,
  DATABEND_MAX_SOCKETS,
  DATABEND_REQUEST_HEADER_NAMES,
  DATABEND_RESPONSE_CAP_BYTES,
  DATABEND_STATEMENT_BYTES,
  DATABEND_SURFACE_TIMEOUT_MS,
} from "@/lib/db/providers/sql/databend/connection-options";
import { secretForms } from "@/lib/db/utils/server-text";
import { type DatabaseConnection, type SSHTunnelConfig, TUNNEL_FAR_END } from "@/lib/types";
import { setEgressFlag } from "../../../helpers/egress-flag";

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "password";
const QUERY_TIMEOUT = 30_000;
const VERSION = "1.2.3";
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const originalFlag = process.env[FLAG];

afterEach(() => {
  setEgressFlag(originalFlag);
});

const BROWSER_WORDS = ["Mozilla", "Chrome", "Firefox", "Safari", "Edge", "worksheet"];
const C0 = String.fromCharCode(0x0a);
const NUL = String.fromCharCode(0);

const BASTION: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.test",
  port: 22,
  username: "jump",
  authMethod: "password",
  password: "tunnel-password",
};

function connection(overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "Databend",
    type: "databend",
    host: "databend.test",
    user: TEST_USER,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as DatabaseConnection;
}

const build = (overrides: Record<string, unknown> = {}, queryTimeout = QUERY_TIMEOUT) =>
  buildDatabendConnectionOptions(connection(overrides), { queryTimeout, appVersion: VERSION });

function tunnelled(overrides: Record<string, unknown>, farEnd: { host: string; port: number }) {
  return buildDatabendConnectionOptions(
    Object.assign(connection({ sshTunnel: BASTION, ...overrides }), { [TUNNEL_FAR_END]: farEnd }),
    { queryTimeout: QUERY_TIMEOUT, appVersion: VERSION },
  );
}

function refusal(run: () => unknown): DatabaseConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).provider).toBe("databend");
    return error as DatabaseConfigError;
  }
  throw new Error("expected a refusal");
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("refusals before any socket", () => {
  test.each([
    ["a host with a path", { host: "databend.test/admin" }],
    ["a host with userinfo", { host: "a@databend.test" }],
    ["no host", { host: undefined }],
  ])("%s", (_label, overrides) => {
    expect(refusal(() => build(overrides)).message).toContain("Invalid host");
  });

  test.each([
    ["port 0", 0],
    ["port 65536", 65536],
    ["a fractional port", 80.5],
  ])("%s", (_label, port) => {
    expect(refusal(() => build({ port })).message).toContain("Invalid port");
  });

  test("a tunnel far end is validated as the host is", () => {
    expect(refusal(() => tunnelled({ host: "127.0.0.1", port: 41001 }, { host: "a/b", port: 8000 })).message).toContain(
      "Invalid host",
    );
    expect(
      refusal(() => tunnelled({ host: "127.0.0.1", port: 41001 }, { host: "databend.test", port: 0 })).message,
    ).toContain("Invalid port");
  });

  test.each([
    ["absent", undefined],
    ["empty", ""],
  ])("a user that is %s", (_label, user) => {
    expect(refusal(() => build({ user })).message).toBe(DATABEND_CONNECTION_SENTENCES.userRequired);
  });

  test("a user with a colon, which Basic cannot carry", () => {
    expect(refusal(() => build({ user: "a:b" })).message).toBe(DATABEND_CONNECTION_SENTENCES.userColon);
  });

  test.each([
    ["a line feed", C0],
    ["a NUL", NUL],
    ["a carriage return", String.fromCharCode(0x0d)],
  ])("a user with %s, never repeating it", (_label, character) => {
    const error = refusal(() => build({ user: `re${character}ader` }));
    expect(error.message).toBe(DATABEND_CONNECTION_SENTENCES.control("User"));
    expect(error.message).not.toContain("reader");
  });

  test("a password with a C0 control, never repeating it", () => {
    const error = refusal(() => build({ password: `pass${C0}word`, ssl: { mode: "verify-system" } }));
    expect(error.message).toBe(DATABEND_CONNECTION_SENTENCES.control("Password"));
    expect(error.message).not.toContain("pass");
  });

  test.each([
    ["User", { user: "\udc00", password: TEST_PASSWORD }],
    ["User", { user: "\udc00" }],
    ["Password", { password: "pass\ud800" }],
  ] as const)("a %s holding a lone UTF-16 surrogate, never repeating it", (field, fields) => {
    const error = refusal(() => build({ ...fields, ssl: { mode: "verify-system" } }));
    expect(error.message).toBe(DATABEND_CONNECTION_SENTENCES.malformed(field));
    expect(error.message).not.toContain("pass");
  });

  test.each([
    ["a space", "my warehouse"],
    ["a colon", "wh:1"],
    ["a line feed", `wh${C0}`],
    ["a carriage return", `wh${String.fromCharCode(0x0d)}`],
    ["64 characters", "w".repeat(64)],
    ["a dot", "wh.1"],
  ])("a warehouse with %s, never repeating it", (_label, warehouse) => {
    const error = refusal(() => build({ warehouse }));
    expect(error.message).toBe(DATABEND_CONNECTION_SENTENCES.warehouse);
    expect(error.message).not.toContain(warehouse);
  });

  test("plain HTTP to 10.0.0.5 with a password and no consent", () => {
    const error = refusal(() => build({ host: "10.0.0.5", password: TEST_PASSWORD }));
    expect(error.message).toBe(DATABEND_CONNECTION_SENTENCES.plaintext);
    expect(error.message).toBe(
      "This connection would send its password to Databend without TLS, to a host that is not this machine, where anyone on the path can read it. Choose an SSL mode under SSL / TLS, connect through an SSH tunnel, or tick Send the password without TLS to accept that risk for this connection. Nothing was sent.",
    );
  });

  test("allowInsecureAuth other than true is no consent", () => {
    for (const allowInsecureAuth of [false, "true", 1]) {
      expect(refusal(() => build({ host: "10.0.0.5", password: TEST_PASSWORD, allowInsecureAuth })).message).toBe(
        DATABEND_CONNECTION_SENTENCES.plaintext,
      );
    }
  });

  test("a tunnel that is on but did not open", () => {
    expect(refusal(() => build({ sshTunnel: BASTION })).message).toBe(DATABEND_CONNECTION_SENTENCES.tunnelNotOpened);
  });

  test.each([
    ["user", { user: 7 }, "a string"],
    ["password", { password: 7 }, "a string"],
    ["warehouse", { warehouse: 7 }, "a string"],
    ["database", { database: 7 }, "a string"],
    ["sshTunnel", { sshTunnel: "on" }, "an object"],
    ["sshTunnel", { sshTunnel: [] }, "an object"],
    ["sshTunnel.enabled", { sshTunnel: { enabled: "yes" } }, "true or false"],
  ])("a %s of the wrong type is refused by name", (field, overrides, expected) => {
    expect(refusal(() => build(overrides)).message).toBe(DATABEND_CONNECTION_SENTENCES.wrongType(field, expected));
  });

  test.each([0, -1, 1.5, 2_147_483_648])("a query timeout of %p", (queryTimeout) => {
    expect(refusal(() => build({}, queryTimeout)).message).toBe(DATABEND_CONNECTION_SENTENCES.queryTimeout);
  });

  test("an SSL panel the shared reader refuses is refused as Databend's", () => {
    expect(refusal(() => build({ ssl: { mode: "bogus" } })).message).toContain("Invalid ssl.mode");
  });
});

describe("allowed", () => {
  test.each([
    ["loopback", "127.0.0.1"],
    ["::1", "::1"],
    ["localhost", "localhost"],
  ])("plain HTTP with a password to %s", (_label, host) => {
    expect(build({ host, password: TEST_PASSWORD }).tls).toBeNull();
  });

  test("plain HTTP with a password through a tunnel", () => {
    const options = tunnelled(
      { host: "127.0.0.1", port: 41001, password: TEST_PASSWORD },
      { host: "10.0.0.5", port: 8000 },
    );
    expect(options.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 41001 });
    expect(options.endpoint).toEqual({ host: "10.0.0.5", port: 8000 });
  });

  test("plain HTTP with a password and the consent", () => {
    expect(build({ host: "10.0.0.5", password: TEST_PASSWORD, allowInsecureAuth: true }).origin.scheme).toBe("http");
  });

  test("plain HTTP to 10.0.0.5 with an empty password, which sends no secret", () => {
    for (const password of [undefined, null, ""]) {
      const options = build({ host: "10.0.0.5", password });
      expect(options.headers.authorization).toBe(basic(TEST_USER, ""));
      expect(options.hasPassword).toBe(false);
    }
  });

  test("a warehouse of 1 and of 63 letters, digits, hyphens and underscores", () => {
    expect(build({ warehouse: "w" }).warehouse).toBe("w");
    const longest = `Ab0-_${"x".repeat(58)}`;
    expect(build({ warehouse: longest }).warehouse).toBe(longest);
  });

  test("a non-ASCII user and password travel in Basic as UTF-8", () => {
    const options = build({ user: "kullanıcı", password: "şifre", ssl: { mode: "verify-system" } });
    expect(options.headers.authorization).toBe(basic("kullanıcı", "şifre"));
  });

  test("a password with a colon, since Basic splits at the first colon only", () => {
    const options = build({ password: "pass:word", ssl: { mode: "verify-system" } });
    expect(options.headers.authorization).toBe(basic(TEST_USER, "pass:word"));
  });
});

describe("the connection headers (design 3.2, I10, I15)", () => {
  test("are exactly Basic, accept, the user-agent and the client caps, with no warehouse when none is set", () => {
    expect(build({ host: "127.0.0.1", password: TEST_PASSWORD }).headers).toEqual({
      authorization: basic(TEST_USER, TEST_PASSWORD),
      accept: "application/json",
      "user-agent": `libredb-studio/${VERSION}`,
      "x-databend-client-caps": "session_header",
    });
  });

  test("carry the warehouse when it is set", () => {
    expect(build({ warehouse: "compute_1" }).headers["x-databend-warehouse"]).toBe("compute_1");
  });

  test("an empty or null warehouse is none", () => {
    for (const warehouse of ["", null]) {
      const options = build({ warehouse });
      expect(options.warehouse).toBeUndefined();
      expect(Object.keys(options.headers)).not.toContain("x-databend-warehouse");
    }
  });

  test("the user-agent carries no browser word, with or without a version", () => {
    for (const appVersion of [VERSION, null]) {
      const agent = buildDatabendConnectionOptions(connection(), { queryTimeout: QUERY_TIMEOUT, appVersion }).headers[
        "user-agent"
      ];
      for (const word of BROWSER_WORDS) expect(agent.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  test("the user-agent is the bare product when no version is known", () => {
    const options = buildDatabendConnectionOptions(connection(), { queryTimeout: QUERY_TIMEOUT, appVersion: null });
    expect(options.headers["user-agent"]).toBe("libredb-studio");
  });

  test("the version defaults to getAppVersion()", () => {
    const version = getAppVersion();
    const options = buildDatabendConnectionOptions(connection(), { queryTimeout: QUERY_TIMEOUT });
    expect(options.headers["user-agent"]).toBe(version === null ? "libredb-studio" : `libredb-studio/${version}`);
  });

  test("the per-request header names are the closed list of four", () => {
    expect([...DATABEND_REQUEST_HEADER_NAMES]).toEqual([
      "x-databend-session",
      "x-databend-query-id",
      "x-databend-route-hint",
      "x-databend-sticky-node",
    ]);
    expect(build().requestHeaderNames).toBe(DATABEND_REQUEST_HEADER_NAMES);
    for (const name of DATABEND_REQUEST_HEADER_NAMES) expect(Object.keys(build().headers)).not.toContain(name);
  });
});

describe("origin and TLS (design 3.14)", () => {
  test("the default port is 8000, over http", () => {
    expect(DATABEND_DEFAULT_PORT).toBe(8000);
    const options = build();
    expect(options.origin).toEqual({ scheme: "http", host: "databend.test", port: 8000 });
    expect(options.endpoint).toEqual({ host: "databend.test", port: 8000 });
    expect(options.tls).toBeNull();
  });

  test("an SSL mode of disable is http", () => {
    expect(build({ ssl: { mode: "disable" } }).origin.scheme).toBe("http");
  });

  test.each(["require", "verify-system", "verify-ca", "verify-full"])("%s is https with TLS material", (mode) => {
    const options = build({ port: 443, ssl: { mode } });
    expect(options.origin).toEqual({ scheme: "https", host: "databend.test", port: 443 });
    expect(options.tls?.identity).toBe("databend.test");
    expect(options.tls?.rejectUnauthorized).toBe(mode !== "require");
  });

  test("the TLS identity is the tunnel's far end, never the local forward", () => {
    const options = tunnelled(
      { host: "127.0.0.1", port: 41001, ssl: { mode: "verify-full" } },
      { host: "databend.test", port: 443 },
    );
    expect(options.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 41001 });
    expect(options.tls?.identity).toBe("databend.test");
  });

  test("an IPv6 host is dialled in brackets and named without them", () => {
    const options = build({ host: "::1", ssl: { mode: "require" } });
    expect(options.origin.host).toBe("[::1]");
    expect(options.endpoint.host).toBe("::1");
    expect(options.tls?.identity).toBe("::1");
  });
});

describe("the bounds (design 3.12)", () => {
  test("are the design's values", () => {
    expect(DATABEND_MAX_SOCKETS).toBe(3);
    expect(DATABEND_LIMITER_OPTIONS).toEqual({ perProvider: 2, perEngine: 2, queueDepth: 64 });
    expect(DATABEND_RESPONSE_CAP_BYTES).toBe(16 * 1024 * 1024);
    expect(DATABEND_STATEMENT_BYTES).toBe(16 * 1024 * 1024);
    expect(DATABEND_CELL_BUDGET).toBe(250_000);
    expect(DATABEND_SURFACE_TIMEOUT_MS).toBe(10_000);
    expect(DATABEND_CLOSE_TIMEOUT_MS).toBe(5_000);
  });

  test("two statements always leave a socket for a kill", () => {
    expect(DATABEND_MAX_SOCKETS).toBeGreaterThan(DATABEND_LIMITER_OPTIONS.perProvider);
  });

  test("ride on the options, the surface deadline under the query timeout", () => {
    const options = build({}, 30_000);
    expect(options.maxSockets).toBe(DATABEND_MAX_SOCKETS);
    expect(options.responseCapBytes).toBe(DATABEND_RESPONSE_CAP_BYTES);
    expect(options.statementBytes).toBe(DATABEND_STATEMENT_BYTES);
    expect(options.cellBudget).toBe(DATABEND_CELL_BUDGET);
    expect(options.closeTimeoutMs).toBe(DATABEND_CLOSE_TIMEOUT_MS);
    expect(options.callTimeoutMs).toBe(30_000);
    expect(options.surfaceTimeoutMs).toBe(10_000);
    expect(build({}, 4_000).surfaceTimeoutMs).toBe(4_000);
    expect(build({}, 1).callTimeoutMs).toBe(1);
    expect(build({}, 2_147_483_647).callTimeoutMs).toBe(2_147_483_647);
  });
});

describe("user, database and secret forms", () => {
  test("carry the user, the database and whether a password is set", () => {
    const options = build({ password: TEST_PASSWORD, database: "studio_demo", host: "127.0.0.1" });
    expect(options.user).toBe(TEST_USER);
    expect(options.database).toBe("studio_demo");
    expect(options.hasPassword).toBe(true);
    expect(build({ database: "" }).database).toBeUndefined();
  });

  test("secretForms holds the password and user:password, the value Basic encodes", () => {
    const options = build({ password: TEST_PASSWORD, host: "127.0.0.1" });
    expect(options.secretForms).toEqual(secretForms([TEST_PASSWORD, `${TEST_USER}:${TEST_PASSWORD}`]));
    expect(options.secretForms).toContain(Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64"));
  });

  test("secretForms is empty with no password", () => {
    expect(build().secretForms).toEqual([]);
  });
});

describe("the latch key [X03]", () => {
  test("is the framed scheme, far end, empty route, user and password", () => {
    expect(build({ password: TEST_PASSWORD, host: "127.0.0.1", port: 8000 }).latchKey).toBe(
      authLatchKey({
        scheme: "http",
        host: "127.0.0.1",
        port: 8000,
        route: "",
        user: TEST_USER,
        password: TEST_PASSWORD,
      }),
    );
  });

  test("holds no secret", () => {
    const key = build({ password: TEST_PASSWORD, host: "127.0.0.1" }).latchKey;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const form of secretForms([TEST_PASSWORD, `${TEST_USER}:${TEST_PASSWORD}`])) expect(key).not.toContain(form);
  });

  test("is equal through two tunnels to one far end, whatever the local forward", () => {
    const farEnd = { host: "databend.test", port: 8000 };
    const first = tunnelled({ host: "127.0.0.1", port: 41001, password: TEST_PASSWORD }, farEnd);
    const second = tunnelled({ host: "127.0.0.1", port: 41002, password: TEST_PASSWORD }, farEnd);
    expect(first.origin.port).not.toBe(second.origin.port);
    expect(first.latchKey).toBe(second.latchKey);
    expect(first.latchKey).toBe(
      authLatchKey({
        scheme: "http",
        host: "databend.test",
        port: 8000,
        route: tunnelRoute(BASTION),
        user: TEST_USER,
        password: TEST_PASSWORD,
      }),
    );
  });

  test("differs for another bastion route", () => {
    const farEnd = { host: "databend.test", port: 8000 };
    const first = tunnelled({ host: "127.0.0.1", port: 41001 }, farEnd);
    const second = tunnelled(
      { host: "127.0.0.1", port: 41001, sshTunnel: { ...BASTION, host: "bastion2.test" } },
      farEnd,
    );
    expect(first.latchKey).not.toBe(second.latchKey);
  });

  test("differs from the untunnelled connection to the same far end", () => {
    const direct = build({ host: "databend.test", port: 8000 });
    const viaTunnel = tunnelled({ host: "127.0.0.1", port: 41001 }, { host: "databend.test", port: 8000 });
    expect(direct.latchKey).not.toBe(viaTunnel.latchKey);
  });

  test("differs for another scheme", () => {
    expect(build({ port: 443, ssl: { mode: "verify-system" } }).latchKey).not.toBe(build({ port: 443 }).latchKey);
  });

  test("differs for a new password", () => {
    const host = "127.0.0.1";
    expect(build({ host, password: TEST_PASSWORD }).latchKey).not.toBe(build({ host, password: "password2" }).latchKey);
  });

  test.each([
    ["an IPv6 address", ["::1", "[::1]", "0:0:0:0:0:0:0:1", "[0::1]"]],
    ["a host name and its final dot", ["localhost", "localhost.", "LOCALHOST"]],
    ["a remote host name and its final dot", ["db.example.test", "db.example.test."]],
  ])("is one key for %s however it is spelled, while the endpoint keeps each spelling (HASIM-D-6)", (_label, hosts) => {
    const built = hosts.map((host) => build({ host, password: TEST_PASSWORD, allowInsecureAuth: true }));
    expect(new Set(built.map((options) => options.latchKey)).size).toBe(1);
    expect(built.map((options) => options.endpoint.host)).toEqual(
      hosts.map((host) => host.replace(/^\[|\]$/g, "").toLowerCase()),
    );
  });

  test("ignores the warehouse, since the user is locked whatever compute is named", () => {
    expect(build({ warehouse: "a" }).latchKey).toBe(build({ warehouse: "b" }).latchKey);
  });
});
