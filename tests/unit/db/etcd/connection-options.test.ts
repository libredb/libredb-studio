/**
 * The connection to the adapter's options (spec E1, E2, E5, E6, 5.3, 6.1), with no socket: every
 * refusal is raised by the mapping itself, before any client could be built, and none repeats the value
 * it refuses. The client certificates are made here with openssl, from config files written into a
 * temporary directory, and never committed: a subject written into a config file reaches openssl as
 * bytes on every platform, where a non-ASCII `-subj` argument would pass through the Windows command
 * line. The keys are RSA, made by `req -newkey rsa:2048` as the Kafka TLS test makes its own, the form
 * the Windows and macOS runners' openssl already run. The last block runs the mapping under Node, the
 * production runtime, through a bundle, because the error facts say which runtime answered (spec E5,
 * 5.6).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseConfigError } from "@/lib/db/errors";
import { EtcdError } from "@/lib/db/providers/keyvalue/etcd/client";
import {
  buildEtcdConnectionOptions,
  ETCD_DEFAULT_PORT,
  ETCD_IP_SERVER_NAME,
  ETCD_RECEIVE_CAP_BYTES,
  type EtcdConnectionOptions,
  etcdErrorConnection,
} from "@/lib/db/providers/keyvalue/etcd/connection-options";
import { toProviderError } from "@/lib/db/providers/keyvalue/etcd/errors";
import { type DatabaseConnection, TUNNEL_FAR_END, type WithTunnelFarEnd } from "@/lib/types";

// A named placeholder, never a realistic value: a credential in a test fixture is a stand-in.
const TEST_PASSWORD = "password";
/** A stand-in no sentence of the module holds, so a refusal that repeated it would show. */
const SECRET_PROBE = "hunter2";

const CONTEXT = { executionReadOnly: false, queryTimeout: 60_000 };

const base = {
  id: "e",
  name: "e",
  type: "etcd",
  host: "etcd.test",
  port: 2379,
  createdAt: new Date(),
} as unknown as DatabaseConnection;

/** The mapping of a connection as a caller may write it: any JSON value in any field. */
function mapped(connection: unknown, context = CONTEXT): EtcdConnectionOptions {
  return buildEtcdConnectionOptions(connection as DatabaseConnection & WithTunnelFarEnd, context);
}

/** The refusal the mapping raises for this connection, which is a DatabaseConfigError of etcd's. */
function refusalOf(connection: unknown, context = CONTEXT): string {
  let thrown: unknown;
  try {
    mapped(connection, context);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DatabaseConfigError);
  expect(thrown).toMatchObject({ provider: "etcd" });
  return (thrown as DatabaseConfigError).message;
}

/** A connection whose traffic an SSH tunnel carries, as the factory hands it on: the local forward and the far end. */
function tunnelled(farEnd: { host: unknown; port: unknown }, extra: Record<string, unknown> = {}): unknown {
  return {
    ...base,
    host: "127.0.0.1",
    port: 40001,
    sshTunnel: { enabled: true, host: "bastion.test", port: 22, username: "u", authMethod: "password" },
    [TUNNEL_FAR_END]: farEnd,
    ...extra,
  };
}

const HOST_TAKES_NAME_ONLY = "Host takes a name or address only; put the port in Port and choose TLS under SSL / TLS.";
const INVALID_HOST = "Invalid host: expected a hostname, an IPv4 address or an IPv6 address";
const INVALID_PORT = "Invalid port: expected an integer from 1 to 65535";
const CREDENTIAL_NEEDS_TLS =
  "A User or Password needs TLS on etcd: choose an SSL mode under SSL / TLS, or clear them. A plaintext etcd with password authentication cannot be connected.";
const CREDENTIAL_PAIR =
  "A User and a Password go together on etcd: enter both, or clear both to sign in with the client certificate under SSL / TLS or with no credential.";
const CLIENT_PAIR =
  "The Client Certificate and the Client Private Key under SSL / TLS go together: add the missing one, or clear both.";
const CLIENT_CERTIFICATE_NOT_PEM =
  "The Client Certificate under SSL / TLS is not a PEM certificate: paste the certificate issued for this client there, and its key under Client Private Key.";
const TUNNEL_NOT_OPENED =
  "This connection's SSH tunnel is on, but the connection arrived without its tunnel, so etcd was not dialled directly: the tunnel opens only when both Host and Port are set.";
const QUERY_TIMEOUT_RANGE = "Query timeout must be a whole number between 1 and 2147483647 milliseconds.";

const dir = mkdtempSync(join(tmpdir(), "etcd-connection-options-"));
const at = (file: string) => join(dir, file);
const read = (file: string) => readFileSync(at(file), "utf8");

/** The config OPENSSL_CONF names for every command, so no platform default is read. */
const OPENSSL_CONFIG = "openssl.cnf";

function openssl(...args: string[]): void {
  const run = Bun.spawnSync(["openssl", ...args], {
    cwd: dir,
    env: { ...process.env, OPENSSL_CONF: at(OPENSSL_CONFIG) },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`openssl ${args.join(" ")} failed: ${run.stderr.toString()}`);
}

/** A self-signed client certificate and its key, for a subject written one attribute per line in openssl's config syntax. */
function clientCertificate(name: string, subject: readonly string[]): void {
  writeFileSync(
    at(`${name}.cnf`),
    ["[req]", "prompt = no", "distinguished_name = dn", "[dn]", ...subject, ""].join("\n"),
  );
  openssl(
    "req",
    "-config",
    `${name}.cnf`,
    "-utf8",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.crt`,
  );
}

/** A TLS panel carrying the named certificate and its key. */
function withCertificate(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { mode: "verify-full", clientCert: read(`${name}.crt`), clientKey: read(`${name}.key`), ...extra };
}

beforeAll(() => {
  if (Bun.which("openssl") === null) {
    throw new Error(
      "No openssl on PATH: this file makes its client certificates at test time, and none are committed; install OpenSSL",
    );
  }
  writeFileSync(at(OPENSSL_CONFIG), "[req]\ndistinguished_name = dn\n[dn]\n");
  clientCertificate("reader", ["CN = etcd-reader"]);
  clientCertificate("no-name", ["O = LibreDB"]);
  clientCertificate("two-names", ["O = LibreDB", "0.CN = first", "1.CN = second"]);
  // openssl's config syntax: `\\` is one backslash and `\#` a hash that starts no comment.
  clientCertificate("escaped", [String.raw`CN = a,b+c=d\\e<f>g;h\#i`]);
  clientCertificate("turkish", ["CN = kullanıcı-é"]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("E1: the endpoint is exactly what it claims", () => {
  test("a plain connection maps to the dns: target, the endpoint, no TLS, no credential, the timeout and the cap", () => {
    expect(mapped(base)).toStrictEqual({
      target: "dns:etcd.test:2379",
      endpoint: { host: "etcd.test", port: 2379 },
      auth: { kind: "none" },
      callTimeoutMs: 60_000,
      receiveCapBytes: ETCD_RECEIVE_CAP_BYTES,
    });
  });

  test("the receive cap starts at 16 MiB, KE4's starting value until Task 22 measures it", () => {
    expect(ETCD_RECEIVE_CAP_BYTES).toBe(16 * 1024 * 1024);
  });

  test("an absent or null port is etcd's client port, 2379", () => {
    expect(ETCD_DEFAULT_PORT).toBe(2379);
    expect(mapped({ ...base, port: undefined }).target).toBe("dns:etcd.test:2379");
    expect(mapped({ ...base, port: null }).endpoint).toEqual({ host: "etcd.test", port: 2379 });
  });

  test("a port written as digits is read as its number, as the shared validator reads it", () => {
    expect(mapped({ ...base, port: "12379" }).target).toBe("dns:etcd.test:12379");
  });

  test.each([
    ["::1", "dns:[::1]:2379", "::1"],
    ["[::1]", "dns:[::1]:2379", "::1"],
    ["::1:2379", "dns:[::1:2379]:2379", "::1:2379"],
    ["FE80::1", "dns:[fe80::1]:2379", "fe80::1"],
    ["unix", "dns:unix:2379", "unix"],
    ["dns", "dns:dns:2379", "dns"],
    ["ipv4", "dns:ipv4:2379", "ipv4"],
    ["ipv6", "dns:ipv6:2379", "ipv6"],
    ["Etcd.Test", "dns:etcd.test:2379", "etcd.test"],
    ["10.0.0.5", "dns:10.0.0.5:2379", "10.0.0.5"],
  ])(
    "host %s is the target %s, an IPv6 literal kept in brackets, and the endpoint %s",
    (host, target, endpointHost) => {
      const options = mapped({ ...base, host });
      expect(options.target).toBe(target);
      expect(options.endpoint).toEqual({ host: endpointHost, port: 2379 });
    },
  );

  test.each([
    "etcd:2379",
    "10.0.0.5:2379",
    "[::1]:2379",
    "[::1",
    "https://10.0.0.5:2379",
    "http://etcd.test",
    "dns://etcd",
  ])(
    "host %s carries a scheme, a port or a colon that is not an IPv6 literal's: E1's sentence, which never repeats it",
    (host) => {
      const message = refusalOf({ ...base, host });
      expect(message).toBe(HOST_TAKES_NAME_ONLY);
      expect(message).not.toContain(host);
    },
  );

  test.each([
    ["a slash", "etcd/x"],
    ["an at sign", "u@etcd.test"],
    ["a percent sign", "a%25b"],
    ["a zone", "::1%lo"],
    ["another zone", "fe80::1%eth0"],
    ["a space", "etcd test"],
    ["a leading space", " etcd.test"],
    ["a newline", "etcd.test\n"],
    ["nothing", ""],
  ])("host with %s is refused by the shared validator, which never repeats it", (_label, host) => {
    const message = refusalOf({ ...base, host });
    expect(message).toBe(INVALID_HOST);
    if (host.trim() !== "") expect(message).not.toContain(host.trim());
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 2379],
    ["an array", ["etcd.test"]],
  ])("a host that is %s is refused by the shared validator", (_label, host) => {
    expect(refusalOf({ ...base, host })).toBe(INVALID_HOST);
  });

  test.each([0, 65_536, 70_000, -1, 1.5, Number.NaN, "2379x", "", true])("port %p is refused", (port) => {
    expect(refusalOf({ ...base, port })).toBe(INVALID_PORT);
  });

  test("the address is refused before the TLS panel, the credentials, the mode and the timeout are read", () => {
    // Each of these is refused by its own rule when the address passes.
    const rest = { ssl: "on", user: 1, password: TEST_PASSWORD, readOnly: "yes" };
    expect(refusalOf({ ...base, host: "etcd:2379", ...rest }, { ...CONTEXT, queryTimeout: 0 })).toBe(
      HOST_TAKES_NAME_ONLY,
    );
    expect(refusalOf({ ...base, port: 0, ...rest }, { ...CONTEXT, queryTimeout: 0 })).toBe(INVALID_PORT);
  });
});

describe("E3 and E5: a tunnel carries the connection to its far end", () => {
  test("the target is the local forward, and the endpoint and the TLS identity are the far end", () => {
    const options = mapped(tunnelled({ host: "etcd.test", port: 2379 }, { ssl: { mode: "verify-full" } }));
    expect(options.target).toBe("dns:127.0.0.1:40001");
    expect(options.endpoint).toEqual({ host: "etcd.test", port: 2379 });
    expect(options.tls).toMatchObject({ identity: "etcd.test", identityIsIp: false, serverNameOverride: "etcd.test" });
  });

  test("an IP far end is an IP identity, overridden with the fixed name, and the dial target never names it", () => {
    const options = mapped(tunnelled({ host: "10.0.0.5", port: 2379 }, { ssl: { mode: "verify-full" } }));
    expect(options.tls).toMatchObject({ identity: "10.0.0.5", identityIsIp: true, serverNameOverride: "etcd.invalid" });
    expect(options.target).toBe("dns:127.0.0.1:40001");
  });

  test("an IPv6 far end is a bare IP identity, however the far end writes it", () => {
    for (const host of ["fd00::5", "[fd00::5]", "FD00::5"]) {
      const options = mapped(tunnelled({ host, port: 2379 }, { ssl: { mode: "verify-full" } }));
      expect(options.endpoint).toEqual({ host: "fd00::5", port: 2379 });
      expect(options.tls).toMatchObject({
        identity: "fd00::5",
        identityIsIp: true,
        serverNameOverride: "etcd.invalid",
      });
      expect(options.target).toBe("dns:127.0.0.1:40001");
    }
  });

  test("the far end passes the same checks as a host: E1's sentence, the shared validators", () => {
    expect(refusalOf(tunnelled({ host: "etcd:2379", port: 2379 }))).toBe(HOST_TAKES_NAME_ONLY);
    expect(refusalOf(tunnelled({ host: "etcd/x", port: 2379 }))).toBe(INVALID_HOST);
    expect(refusalOf(tunnelled({ host: "etcd.test", port: 0 }))).toBe(INVALID_PORT);
    expect(mapped(tunnelled({ host: "Etcd.Test", port: 2379 })).endpoint).toEqual({ host: "etcd.test", port: 2379 });
  });

  test("a tunnel that is on but arrived without its far end is refused, so etcd is never dialled past it", () => {
    const tunnelOn = {
      ...base,
      sshTunnel: { enabled: true, host: "bastion.test", port: 22, username: "u", authMethod: "password" },
    };
    expect(refusalOf(tunnelOn)).toBe(TUNNEL_NOT_OPENED);
    expect(mapped({ ...tunnelOn, sshTunnel: { ...tunnelOn.sshTunnel, enabled: false } }).target).toBe(
      "dns:etcd.test:2379",
    );
    expect(mapped({ ...base, sshTunnel: null }).target).toBe("dns:etcd.test:2379");
  });

  test.each([
    [
      "a tunnel that is not an object",
      { sshTunnel: "on" },
      "The connection's sshTunnel must be an object; nothing was sent",
    ],
    ["a tunnel that is an array", { sshTunnel: [] }, "The connection's sshTunnel must be an object; nothing was sent"],
    [
      "an enabled flag that is not a boolean",
      { sshTunnel: { enabled: "true" } },
      "The connection's sshTunnel.enabled must be true or false; nothing was sent",
    ],
  ])("%s is refused naming the field", (_label, extra, message) => {
    expect(refusalOf({ ...base, ...extra })).toBe(message);
  });
});

describe("E5: the TLS modes, by one exhaustive table", () => {
  test("disable, an absent panel and a null one are plaintext", () => {
    expect(mapped({ ...base, ssl: { mode: "disable" } }).tls).toBeUndefined();
    expect(Object.hasOwn(mapped(base), "tls")).toBe(false);
    expect(Object.hasOwn(mapped({ ...base, ssl: null }), "tls")).toBe(false);
  });

  test.each([
    ["require", false],
    ["verify-system", true],
    ["verify-ca", true],
    ["verify-full", true],
  ] as const)("%s opens TLS, verify %p, with the identity always set as the override", (mode, verify) => {
    expect(mapped({ ...base, ssl: { mode } }).tls).toStrictEqual({
      mode,
      verify,
      identity: "etcd.test",
      identityIsIp: false,
      serverNameOverride: "etcd.test",
    });
  });

  test("a panel with no mode, or a null one, verifies as verify-full, which a seed file may write", () => {
    for (const ssl of [{}, { mode: null }]) {
      expect(mapped({ ...base, ssl }).tls).toMatchObject({ mode: "verify-full", verify: true });
    }
  });

  test("rejectUnauthorized decides in both directions, and null reads as absent", () => {
    const verifyOf = (ssl: Record<string, unknown>) => mapped({ ...base, ssl }).tls?.verify;
    expect(verifyOf({ mode: "require", rejectUnauthorized: true })).toBe(true);
    expect(verifyOf({ mode: "verify-full", rejectUnauthorized: false })).toBe(false);
    expect(verifyOf({ mode: "verify-system", rejectUnauthorized: false })).toBe(false);
    expect(verifyOf({ mode: "require", rejectUnauthorized: null })).toBe(false);
  });

  test("the pasted CA is carried as configured in every TLS mode, and an empty one is absent: the runtime's roots", () => {
    for (const mode of ["require", "verify-system", "verify-ca", "verify-full"]) {
      expect(mapped({ ...base, ssl: { mode, caCert: "CA PEM" } }).tls?.ca).toBe("CA PEM");
      expect(Object.hasOwn(mapped({ ...base, ssl: { mode, caCert: "" } }).tls ?? {}, "ca")).toBe(false);
    }
  });

  test.each([
    ["10.0.0.5", "10.0.0.5"],
    ["::1", "::1"],
    ["[::1]", "::1"],
  ])(
    "an IP host %s is the identity %s, overridden with the fixed name that is not an IP, in require too",
    (host, identity) => {
      expect(ETCD_IP_SERVER_NAME).toBe("etcd.invalid");
      for (const mode of ["require", "verify-full"]) {
        expect(mapped({ ...base, host, ssl: { mode } }).tls).toMatchObject({
          identity,
          identityIsIp: true,
          serverNameOverride: ETCD_IP_SERVER_NAME,
        });
      }
    },
  );

  test.each([
    ["a panel that is a string", { ssl: "on" }, "ssl", "an object"],
    ["a panel that is an array", { ssl: ["verify-full"] }, "ssl", "an object"],
    [
      "a mode SSLMode does not name",
      { ssl: { mode: "prefer" } },
      "ssl.mode",
      "disable, require, verify-system, verify-ca or verify-full",
    ],
    [
      "a mode that is an Object.prototype member",
      { ssl: { mode: "toString" } },
      "ssl.mode",
      "disable, require, verify-system, verify-ca or verify-full",
    ],
    [
      "a mode that is a number",
      { ssl: { mode: 1 } },
      "ssl.mode",
      "disable, require, verify-system, verify-ca or verify-full",
    ],
    [
      // A property lookup reads ["require"] as the key "require", which would open TLS that verifies nothing.
      "a mode that is an array holding a mode",
      { ssl: { mode: ["require"] } },
      "ssl.mode",
      "disable, require, verify-system, verify-ca or verify-full",
    ],
    ["a CA that is a number", { ssl: { mode: "verify-full", caCert: 41 } }, "ssl.caCert", "a string"],
    [
      "a client certificate that is a boolean",
      { ssl: { mode: "verify-full", clientCert: true } },
      "ssl.clientCert",
      "a string",
    ],
    [
      "a client key that is an object",
      { ssl: { mode: "verify-full", clientKey: { pem: "k" } } },
      "ssl.clientKey",
      "a string",
    ],
    [
      "a rejectUnauthorized that is text",
      { ssl: { mode: "verify-full", rejectUnauthorized: "false" } },
      "ssl.rejectUnauthorized",
      "true or false",
    ],
    ["a malformed field under disable", { ssl: { mode: "disable", caCert: 41 } }, "ssl.caCert", "a string"],
  ])("the panel is checked whole: %s is refused naming the field", (_label, extra, field, expected) => {
    expect(refusalOf({ ...base, ...extra })).toBe(`The connection's ${field} must be ${expected}; nothing was sent`);
  });

  test("a refused mode is never repeated", () => {
    expect(refusalOf({ ...base, ssl: { mode: "hunter2" } })).not.toContain("hunter2");
  });

  test("a client certificate and its key go together, in every TLS mode", () => {
    for (const mode of ["require", "verify-full"]) {
      expect(refusalOf({ ...base, ssl: { mode, clientCert: read("reader.crt") } })).toBe(CLIENT_PAIR);
      expect(refusalOf({ ...base, ssl: { mode, clientKey: read("reader.key") } })).toBe(CLIENT_PAIR);
    }
    // Plaintext reads no TLS material at all.
    expect(mapped({ ...base, ssl: { mode: "disable", clientCert: read("reader.crt") } }).auth).toEqual({
      kind: "none",
    });
  });
});

describe("E2: credentials are validated, never echoed, and never sent in the clear", () => {
  const TLS_ON = { mode: "verify-full" };

  test("a user and a password over TLS are the password mode, and the user is the principal", () => {
    const options = mapped({ ...base, ssl: TLS_ON, user: "reader", password: TEST_PASSWORD });
    expect(options.auth).toEqual({ kind: "password", user: "reader", password: TEST_PASSWORD });
    expect(options.principal).toEqual({ name: "reader", via: "password" });
  });

  test("a user and a password with ssl: {} are not refused: a panel with no mode is a verifying TLS channel", () => {
    expect(mapped({ ...base, ssl: {}, user: "reader", password: TEST_PASSWORD }).auth.kind).toBe("password");
  });

  test.each([
    ["a password, ssl absent (the dialog's TLS-off shape)", { user: "reader", password: SECRET_PROBE }],
    ["a password, ssl null", { user: "reader", password: SECRET_PROBE, ssl: null }],
    ["a password, ssl.mode disable", { user: "reader", password: SECRET_PROBE, ssl: { mode: "disable" } }],
    ["a password alone, ssl absent", { password: SECRET_PROBE }],
    ["a user alone, ssl absent", { user: "reader" }],
  ])("%s is refused with E2's sentence, naming both fields", (_label, extra) => {
    const message = refusalOf({ ...base, ...extra });
    expect(message).toBe(CREDENTIAL_NEEDS_TLS);
    expect(message).not.toContain(SECRET_PROBE);
    expect(message).not.toContain("reader");
  });

  test("an SSH tunnel does not stand in for TLS: a user and a password through one still need an SSL mode", () => {
    const credential = { user: "reader", password: SECRET_PROBE };
    expect(refusalOf(tunnelled({ host: "etcd.test", port: 2379 }, credential))).toBe(CREDENTIAL_NEEDS_TLS);
    // The control: the same tunnelled connection with no credential is a plaintext channel.
    expect(mapped(tunnelled({ host: "etcd.test", port: 2379 })).auth).toEqual({ kind: "none" });
  });

  test("the dialog's empty user and password, and null ones, are no credential: plaintext, no refusal", () => {
    for (const credential of [
      { user: "", password: "" },
      { user: null, password: null },
    ]) {
      const options = mapped({ ...base, ...credential });
      expect(options.auth).toEqual({ kind: "none" });
      expect(Object.hasOwn(options, "principal")).toBe(false);
      expect(Object.hasOwn(options, "tls")).toBe(false);
    }
  });

  test("over TLS, a user or a password alone is refused, since no step of the connect sequence would use it", () => {
    expect(refusalOf({ ...base, ssl: TLS_ON, user: "reader" })).toBe(CREDENTIAL_PAIR);
    expect(refusalOf({ ...base, ssl: TLS_ON, password: TEST_PASSWORD })).toBe(CREDENTIAL_PAIR);
    expect(refusalOf({ ...base, ssl: withCertificate("reader"), user: "reader" })).toBe(CREDENTIAL_PAIR);
  });

  test.each(
    (["user", "password"] as const).flatMap((field) =>
      [
        ["a number", 1001, "1001"],
        ["a boolean", true, "true"],
        ["an array", ["reader"], "reader"],
        ["an object", { name: "reader" }, "reader"],
      ].map(([label, value, shown]) => [field, label, value, shown] as const),
    ),
  )("a %s that is %s is refused naming the field and never the value", (field, _label, value, shown) => {
    const message = refusalOf({ ...base, ssl: TLS_ON, user: "someone", password: TEST_PASSWORD, [field]: value });
    expect(message).toBe(`The connection's ${field} must be a string; nothing was sent`);
    expect(message).not.toContain(String(shown));
  });

  test("CR, LF or NUL in either field is refused before any other credential rule, and neither value nor any log line repeats it", () => {
    const logged = [spyOn(console, "error"), spyOn(console, "warn"), spyOn(console, "log")];
    for (const spy of logged) spy.mockImplementation(() => {});
    try {
      for (const password of ["abc\n", "a\rb", "a\0b"]) {
        // Over no TLS too: the value is refused by its own rule before E2's needs-TLS rule reads it.
        for (const ssl of [TLS_ON, undefined]) {
          const message = refusalOf({ ...base, ssl, user: "reader", password });
          expect(message).toBe(
            "The connection's password holds a line break or a NUL character; remove it. Nothing was sent",
          );
          expect(message).not.toContain(password);
        }
      }
      const message = refusalOf({ ...base, ssl: TLS_ON, user: "reader\n", password: TEST_PASSWORD });
      expect(message).toBe("The connection's user holds a line break or a NUL character; remove it. Nothing was sent");
      expect(message).not.toContain("reader");
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });

  test("a password of spaces is a password, never trimmed or read as blank", () => {
    expect(mapped({ ...base, ssl: TLS_ON, user: "reader", password: "  " }).auth).toEqual({
      kind: "password",
      user: "reader",
      password: "  ",
    });
  });
});

describe("6.1 and 4.7: the client certificate, and the Common Name etcd reads as the user", () => {
  test("a client certificate with no password is the certificate mode, its Common Name the principal", () => {
    const options = mapped({ ...base, ssl: withCertificate("reader") });
    expect(options.auth).toEqual({ kind: "certificate" });
    expect(options.principal).toEqual({ name: "etcd-reader", via: "certificate" });
    expect(options.tls?.clientCertificate).toEqual({ cert: read("reader.crt"), key: read("reader.key") });
  });

  test("with a user and a password as well, etcd authenticates the password, so the user is the principal", () => {
    const options = mapped({ ...base, ssl: withCertificate("reader"), user: "root", password: TEST_PASSWORD });
    expect(options.auth).toEqual({ kind: "password", user: "root", password: TEST_PASSWORD });
    expect(options.principal).toEqual({ name: "root", via: "password" });
    expect(options.tls?.clientCertificate?.cert).toBe(read("reader.crt"));
  });

  test("a certificate that names no Common Name leaves the principal absent", () => {
    const options = mapped({ ...base, ssl: withCertificate("no-name") });
    expect(options.auth).toEqual({ kind: "certificate" });
    expect(Object.hasOwn(options, "principal")).toBe(false);
  });

  test("two Common Names read as the last, the one Go's pkix.Name keeps and etcd reads", () => {
    expect(mapped({ ...base, ssl: withCertificate("two-names") }).principal).toEqual({
      name: "second",
      via: "certificate",
    });
  });

  test("a Common Name holding RFC 2253 specials is read as its bytes, never in the escaped form subject prints", () => {
    const name = String.raw`a,b+c=d\e<f>g;h#i`;
    expect(mapped({ ...base, ssl: withCertificate("escaped") }).principal).toEqual({ name, via: "certificate" });
    // The reason the legacy object is read: `subject` escapes the same name.
    expect(new X509Certificate(read("escaped.crt")).subject).not.toBe(`CN=${name}`);
  });

  test("a UTF-8 Common Name is read as its text", () => {
    expect(mapped({ ...base, ssl: withCertificate("turkish") }).principal?.name).toBe("kullanıcı-é");
  });

  test("the certificate the dialog does not draw in require is still read, the dialog-wide defect spec 6.1 files", () => {
    expect(mapped({ ...base, ssl: withCertificate("reader", { mode: "require" }) }).principal).toEqual({
      name: "etcd-reader",
      via: "certificate",
    });
  });

  test("a Client Certificate that is not a PEM certificate is refused in words, whatever the mode reads, and never repeated", () => {
    const key = read("reader.key");
    for (const clientCert of ["not a certificate", key]) {
      for (const credential of [{}, { user: "root", password: TEST_PASSWORD }]) {
        const message = refusalOf({ ...base, ssl: { mode: "verify-full", clientCert, clientKey: key }, ...credential });
        expect(message).toBe(CLIENT_CERTIFICATE_NOT_PEM);
        expect(message).not.toContain("not a certificate");
        expect(message).not.toContain(key.split("\n")[1]);
      }
    }
  });
});

describe("E6: where a read-only mode was set", () => {
  test("a seed's readOnly, told by its seedId", () => {
    expect(mapped({ ...base, readOnly: true, seedId: "prod-etcd" }).readOnly).toBe("seed");
  });

  test("a connection of the user's own, with no seedId or an empty one", () => {
    expect(mapped({ ...base, readOnly: true }).readOnly).toBe("connection");
    expect(mapped({ ...base, readOnly: true, seedId: "" }).readOnly).toBe("connection");
    expect(mapped({ ...base, readOnly: true, seedId: null }).readOnly).toBe("connection");
  });

  test("an execution profile, when only the provider was opened read-only", () => {
    const profile = { ...CONTEXT, executionReadOnly: true };
    expect(mapped(base, profile).readOnly).toBe("execution-profile");
    expect(mapped({ ...base, readOnly: false }, profile).readOnly).toBe("execution-profile");
  });

  test("when the connection's mode and a profile's both hold, the connection's sentence is the one given", () => {
    const profile = { ...CONTEXT, executionReadOnly: true };
    expect(mapped({ ...base, readOnly: true, seedId: "prod-etcd" }, profile).readOnly).toBe("seed");
    expect(mapped({ ...base, readOnly: true }, profile).readOnly).toBe("connection");
  });

  test("a read-write connection carries no mode", () => {
    expect(Object.hasOwn(mapped({ ...base, readOnly: false }), "readOnly")).toBe(false);
    expect(Object.hasOwn(mapped(base), "readOnly")).toBe(false);
  });

  test.each([
    ["text", "true"],
    ["a number", 1],
    ["null", null],
  ])("a readOnly that is %s is refused, as the factory refuses it, never read as read-write", (_label, readOnly) => {
    expect(refusalOf({ ...base, readOnly })).toBe("readOnly must be true or false.");
  });

  test("a seedId that is not text is refused naming the field when the mode reads it", () => {
    expect(refusalOf({ ...base, readOnly: true, seedId: 7 })).toBe(
      "The connection's seedId must be a string; nothing was sent",
    );
  });
});

describe("5.3: the query timeout is the deadline on every call", () => {
  test.each([1, 60_000, 2_147_483_647])("%p ms is the call timeout", (queryTimeout) => {
    expect(mapped(base, { ...CONTEXT, queryTimeout }).callTimeoutMs).toBe(queryTimeout);
  });

  test.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, "60000"])(
    "%p is refused with the dialog's own sentence, since Node's timers fire at once past the bound",
    (queryTimeout) => {
      expect(refusalOf(base, { ...CONTEXT, queryTimeout: queryTimeout as number })).toBe(QUERY_TIMEOUT_RANGE);
    },
  );
});

describe("etcdErrorConnection: the facts errors.ts words its sentences with (C9)", () => {
  test("plaintext: the endpoint, no TLS, Bun's runtime flag, the cap and the timeout", () => {
    const facts = etcdErrorConnection(mapped(base, { ...CONTEXT, queryTimeout: 5000 }));
    expect(facts).toStrictEqual({
      host: "etcd.test",
      port: 2379,
      runtimeReportsTlsCause: false,
      receiveCapBytes: ETCD_RECEIVE_CAP_BYTES,
      timeoutMs: 5000,
    });
  });

  test("the cap and the timeout are the ones the options it is given carry", () => {
    const options = { ...mapped(base), receiveCapBytes: 4096, callTimeoutMs: 7 };
    expect(etcdErrorConnection(options)).toMatchObject({ receiveCapBytes: 4096, timeoutMs: 7 });
  });

  test("TLS: the identity the certificate is checked against, the IP itself for an IP identity, and whether a client certificate is configured", () => {
    expect(etcdErrorConnection(mapped({ ...base, ssl: { mode: "verify-full" } })).tls).toEqual({
      serverName: "etcd.test",
      clientCertificate: false,
    });
    expect(etcdErrorConnection(mapped({ ...base, host: "10.0.0.5", ssl: withCertificate("reader") })).tls).toEqual({
      serverName: "10.0.0.5",
      clientCertificate: true,
    });
  });

  test("through a tunnel, the sentences name the far end and never the local forward", () => {
    const facts = etcdErrorConnection(mapped(tunnelled({ host: "etcd.test", port: 2379 })));
    expect(facts).toMatchObject({ host: "etcd.test", port: 2379 });
    const error = toProviderError(new EtcdError("not-connected", "No connection established"), {
      command: "get",
      write: false,
      connection: facts,
    });
    expect(error.message).toContain("at etcd.test:2379");
    expect(error.message).not.toContain("127.0.0.1");
  });

  test("an IPv6 endpoint is bare here, and errors.ts writes it in brackets", () => {
    const facts = etcdErrorConnection(mapped({ ...base, host: "[::1]" }));
    expect(facts.host).toBe("::1");
    const error = toProviderError(new EtcdError("not-connected", "No connection established"), {
      command: "get",
      write: false,
      connection: facts,
    });
    expect(error.message).toContain("at [::1]:2379");
  });
});

describe("under Node, the production runtime (spec E5, 5.6)", () => {
  test("etcdErrorConnection says Node reports a TLS failure's cause, and every other fact is the one Bun computes", async () => {
    const node = Bun.which("node");
    if (node === null) {
      throw new Error(
        "No node on PATH: this test runs the mapping under Node, the production runtime; install Node 24 or later",
      );
    }
    // The module is TypeScript with `@/` imports, which Node does not load, so the child runs a bundle
    // of it, imported by its file URL, the one spelling of a path every platform's Node reads.
    const source = join(import.meta.dir, "..", "..", "..", "..", "src", "lib", "db", "providers", "keyvalue", "etcd");
    const build = await Bun.build({
      entrypoints: [join(source, "connection-options.ts")],
      target: "node",
      format: "esm",
      outdir: at("under-node"),
    });
    expect({ success: build.success, logs: build.logs.map(String) }).toMatchObject({ success: true });
    const connection = { ...base, ssl: { mode: "verify-full" } };
    writeFileSync(
      at("under-node.mjs"),
      [
        `const { buildEtcdConnectionOptions, etcdErrorConnection } = await import(${JSON.stringify(pathToFileURL(build.outputs[0].path).href)});`,
        `const options = buildEtcdConnectionOptions(${JSON.stringify(connection)}, { executionReadOnly: false, queryTimeout: 60000 });`,
        'process.stdout.write(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", facts: etcdErrorConnection(options) }));',
        "",
      ].join("\n"),
    );
    // A synchronous spawn holds this process, so the child carries its own bound.
    const run = Bun.spawnSync([node, at("under-node.mjs")], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    // Compared whole, so a child that failed, or ran out of time, shows its stderr.
    expect({
      exitCode: run.exitCode,
      timedOut: run.exitedDueToTimeout === true,
      stderr: run.stderr.toString(),
    }).toMatchObject({ exitCode: 0, timedOut: false });
    const inBun = etcdErrorConnection(mapped(connection));
    expect(inBun.runtimeReportsTlsCause).toBe(false);
    expect(JSON.parse(run.stdout.toString())).toEqual({
      runtime: "node",
      facts: { ...inBun, runtimeReportsTlsCause: true },
    });
  }, 60_000);
});
