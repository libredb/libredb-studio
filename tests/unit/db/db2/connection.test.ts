/**
 * Where a Db2 connection goes and how (#786): the target, the TLS table, the transport rules that
 * fail closed, and the CA file's life.
 *
 * The TLS table and the hostname behaviour are measured against the TLS listener of the dev
 * container (12.1.0.0, TLS 1.3 through rustls): `verify-ca` with the container's CA connects, and
 * `verify-full` dialled by an address the certificate does not name is refused.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import {
  type CaFileSystem,
  DB2_DEFAULT_PORT,
  NODE_CA_FILE_SYSTEM,
  assertPasswordSendable,
  assertTransport,
  clientOptions,
  openClient,
  resolveTarget,
  writeCaFile,
  type Db2Connection,
} from "@/lib/db/providers/sql/db2/connection";
import type { Db2ClientOptions, Db2Driver } from "@/lib/db/providers/sql/db2/driver";
import { TUNNEL_FAR_END, type SSLMode } from "@/lib/types";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

function connection(overrides: Partial<Db2Connection> = {}): Db2Connection {
  return {
    id: "db2-1",
    name: "Db2",
    type: "db2",
    host: "db2.example.com",
    port: 50001,
    user: "db2inst1",
    password: "secret",
    database: "TESTDB",
    createdAt: new Date(0),
    ssl: { mode: "verify-full", caCert: PEM },
    ...overrides,
  };
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a refusal");
}

describe("resolveTarget", () => {
  test("the structured fields, with the CA kept for a verifying mode", () => {
    expect(resolveTarget(connection())).toEqual({
      host: "db2.example.com",
      port: 50001,
      database: "TESTDB",
      user: "db2inst1",
      password: "secret",
      tls: "verify-full",
      caPem: PEM,
    });
  });

  test("port 50000 when none is given, an empty password when none is given", () => {
    const target = resolveTarget(connection({ port: undefined, password: undefined, ssl: undefined }));
    expect(target.port).toBe(DB2_DEFAULT_PORT);
    expect(target.password).toBe("");
    expect(target).not.toHaveProperty("tls");
  });

  test("a CA is carried only where the mode verifies a chain", () => {
    expect(resolveTarget(connection({ ssl: { mode: "require", caCert: PEM } }))).not.toHaveProperty("caPem");
    expect(resolveTarget(connection({ ssl: { mode: "verify-system", caCert: PEM } }))).not.toHaveProperty("caPem");
    expect(resolveTarget(connection({ ssl: { mode: "verify-ca", caCert: PEM } })).caPem).toBe(PEM);
    expect(resolveTarget(connection({ ssl: { mode: "verify-full" } }))).not.toHaveProperty("caPem");
  });

  // verify-ca turns the host-name check off, so with no CA of its own it would accept any
  // certificate the system trust store chains, for any name, and send the password to it.
  test("verify-ca with no CA certificate is refused", () => {
    for (const overrides of [
      { ssl: { mode: "verify-ca" as SSLMode } },
      { ssl: { mode: "verify-ca" as SSLMode, caCert: "" } },
    ]) {
      const error = refusal(() => resolveTarget(connection(overrides)));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe(
        'TLS mode "verify-ca" checks the certificate against a CA and not the server\'s name, so it needs the ' +
          "server's CA certificate under SSL / TLS; without one, use verify-full or verify-system.",
      );
    }
  });

  test.each([
    [{ host: undefined }, "Host is required for Db2"],
    [{ database: undefined }, "Database name is required for Db2"],
    [{ user: undefined }, "User is required for Db2"],
  ])("%p is refused", (overrides, message) => {
    const error = refusal(() => resolveTarget(connection(overrides)));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(message);
  });

  test("a client certificate or key is refused: db2-node has no client-certificate authentication", () => {
    for (const ssl of [
      { mode: "verify-full" as SSLMode, clientCert: PEM },
      { mode: "verify-full" as SSLMode, clientKey: PEM },
    ]) {
      expect(() => resolveTarget(connection({ ssl }))).toThrow(
        "db2-node 1.0.24 has no client-certificate authentication; remove the client certificate and key from this Db2 connection.",
      );
    }
  });

  describe("a stored connection string", () => {
    test("its fields win over the structured ones", () => {
      const target = resolveTarget(
        connection({
          connectionString: "db2://other:pw@db2.internal:50002/SAMPLE?ssl=true",
          ssl: undefined,
        }),
      );
      expect(target).toEqual({
        host: "db2.internal",
        port: 50002,
        database: "SAMPLE",
        user: "other",
        password: "pw",
        tls: "verify-system",
      });
    });

    test("a field the string leaves out is taken from the connection", () => {
      const target = resolveTarget(
        connection({ connectionString: "db2://db2.internal/SAMPLE?security=SSL", ssl: undefined }),
      );
      expect(target.user).toBe("db2inst1");
      expect(target.password).toBe("secret");
      expect(target.port).toBe(50000);
      expect(target.tls).toBe("verify-system");
    });

    test("one that is not db2:// is refused", () => {
      expect(() => resolveTarget(connection({ connectionString: "postgres://u:p@h/db" }))).toThrow(
        "A Db2 connection string must start with db2://",
      );
      expect(() => resolveTarget(connection({ connectionString: "db2://[bad" }))).toThrow(
        "The Db2 connection string is not a valid URL",
      );
    });

    test("a parameter the provider does not read is refused, never dropped", () => {
      expect(() =>
        resolveTarget(connection({ connectionString: "db2://u:p@h/DB?currentSchema=APP", ssl: undefined })),
      ).toThrow('carries the parameter "currentschema"');
    });

    test("both TLS spellings at once are refused", () => {
      expect(() =>
        resolveTarget(connection({ connectionString: "db2://u:p@h/DB?ssl=true&security=SSL", ssl: undefined })),
      ).toThrow("carries both ssl and security");
    });

    test("a TLS value with no mode is refused", () => {
      expect(() => resolveTarget(connection({ connectionString: "db2://u:p@h/DB?ssl=maybe", ssl: undefined }))).toThrow(
        'TLS parameter "ssl=maybe" names no mode',
      );
    });

    test("TLS that disagrees with SSL / TLS is refused; TLS that agrees is read once", () => {
      expect(() =>
        resolveTarget(connection({ connectionString: "db2://u:p@h/DB?ssl=false", ssl: { mode: "verify-full" } })),
      ).toThrow('asks for TLS mode "verify-full" under SSL / TLS and "disable" in its connection string');
      expect(
        resolveTarget(connection({ connectionString: "db2://u:p@h/DB?ssl=true", ssl: { mode: "verify-system" } })).tls,
      ).toBe("verify-system");
      expect(
        resolveTarget(connection({ connectionString: "db2://u:p@h/DB", ssl: { mode: "verify-ca", caCert: PEM } })).tls,
      ).toBe("verify-ca");
    });

    test("through a tunnel the dial address is the tunnel's local end, never the string's", () => {
      const target = resolveTarget(
        connection({
          host: "127.0.0.1",
          port: 41234,
          connectionString: "db2://u:p@db2.remote.example:50001/SAMPLE",
          [TUNNEL_FAR_END]: { host: "db2.remote.example", port: 50001 },
        }),
      );
      expect(target.host).toBe("127.0.0.1");
      expect(target.port).toBe(41234);
      expect(target.database).toBe("SAMPLE");
      expect(target.user).toBe("u");
    });
  });
});

describe("assertPasswordSendable (K23)", () => {
  // Measured on Db2 12.1.0.0 with db2-node 1.0.22, with and without TLS: the server rejects each of
  // these five as a wrong password, while the IBM CLP signs in with the same password.
  test.each(["!", "[", "]", "^", "|"])("a password holding %s is refused, naming the character", (character) => {
    const config = connection({ password: `Pass${character}word1` });
    const error = refusal(() => assertPasswordSendable(resolveTarget(config)));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toContain(`contains ${character}`);
    expect(error.message).toContain("db2-node 1.0.22");
    expect(error.message).toContain("Change the password");
  });

  test("several such characters are each named once, in the order they appear", () => {
    const error = refusal(() => assertPasswordSendable(resolveTarget(connection({ password: "a|b!c|d" }))));
    expect(error.message).toContain("contains | and !");
  });

  test("a password from the connection string is checked too", () => {
    const config = connection({ connectionString: "db2://db2inst1:Pass%21word@db2.example.com:50001/TESTDB" });
    expect(() => assertPasswordSendable(resolveTarget(config))).toThrow("contains !");
  });

  test("an empty password is sent", () => {
    expect(() => assertPasswordSendable(resolveTarget(connection({ password: "" })))).not.toThrow();
  });

  // The other printable ASCII characters the measurement tried, each accepted by the server.
  test.each(["@", "#", "$", "%", "&", "*", "?", "~", "{", "\\"])("a password holding %s is sent", (character) => {
    const config = connection({ password: `x${character}y` });
    expect(() => assertPasswordSendable(resolveTarget(config))).not.toThrow();
  });

  test("the refusal never quotes the password itself", () => {
    const error = refusal(() => assertPasswordSendable(resolveTarget(connection({ password: "opaque!value" }))));
    expect(error.message).not.toContain("opaque");
  });
});

describe("assertTransport (fail closed)", () => {
  test("no TLS is refused, naming the cleartext password and the opt-in", () => {
    for (const ssl of [undefined, { mode: "disable" as SSLMode }]) {
      const config = connection({ ssl });
      const error = refusal(() => assertTransport(config, resolveTarget(config)));
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toContain("the password is sent to the server in cleartext");
      expect(error.message).toContain("Send the password without TLS");
    }
  });

  test("no TLS with the explicit opt-in is allowed", () => {
    const config = connection({ ssl: undefined, allowInsecureAuth: true });
    expect(() => assertTransport(config, resolveTarget(config))).not.toThrow();
  });

  test.each(["require", "verify-system", "verify-ca", "verify-full"] as SSLMode[])(
    "TLS mode %s needs no opt-in",
    (mode) => {
      const config = connection({ ssl: { mode, caCert: PEM } });
      expect(() => assertTransport(config, resolveTarget(config))).not.toThrow();
    },
  );

  test("a tunnel that was not opened is refused rather than dialled around", () => {
    const config = connection({
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
    });
    expect(() => assertTransport(config, resolveTarget(config))).toThrow("asks for an SSH tunnel and none was opened");
  });

  test("through a tunnel, a mode that checks the server's name is refused", () => {
    for (const mode of ["verify-system", "verify-full"] as SSLMode[]) {
      const config = connection({
        host: "127.0.0.1",
        port: 41234,
        ssl: { mode, caCert: PEM },
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
        [TUNNEL_FAR_END]: { host: "db2.remote.example", port: 50001 },
      });
      expect(() => assertTransport(config, resolveTarget(config))).toThrow(
        `TLS mode "${mode}" checks the server's name, and through an SSH tunnel db2-node 1.0.24 can only check the tunnel's local address rather than db2.remote.example.`,
      );
    }
  });

  test("through a tunnel, verify-ca and require are allowed", () => {
    for (const mode of ["verify-ca", "require"] as SSLMode[]) {
      const config = connection({
        ssl: { mode, caCert: PEM },
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
        [TUNNEL_FAR_END]: { host: "db2.remote.example", port: 50001 },
      });
      expect(() => assertTransport(config, resolveTarget(config))).not.toThrow();
    }
  });
});

describe("clientOptions (M4, M6)", () => {
  const target = (tls?: SSLMode) =>
    resolveTarget(connection({ ssl: tls === undefined ? undefined : { mode: tls, caCert: PEM } }));
  const base = { host: "db2.example.com", port: 50001, database: "TESTDB", user: "db2inst1", password: "secret" };

  test.each([
    [undefined, { ssl: false, securityMechanism: "userPassword" }],
    ["disable", { ssl: false, securityMechanism: "userPassword" }],
    ["require", { ssl: true, rejectUnauthorized: false }],
    ["verify-system", { ssl: true, rejectUnauthorized: true }],
    ["verify-ca", { ssl: true, rejectUnauthorized: true, sslClientHostnameValidation: "OFF", caCert: "/tmp/x/ca.pem" }],
    [
      "verify-full",
      { ssl: true, rejectUnauthorized: true, sslClientHostnameValidation: "Basic", caCert: "/tmp/x/ca.pem" },
    ],
  ] as [SSLMode | undefined, Partial<Db2ClientOptions>][])("mode %p", (mode, tls) => {
    expect(clientOptions(target(mode), "/tmp/x/ca.pem")).toEqual({ ...base, ...tls });
  });

  test("a verifying mode with no CA file passes no caCert", () => {
    expect(clientOptions(target("verify-full"))).not.toHaveProperty("caCert");
  });

  test("never queryTimeout or currentSchema, whatever the connection carries", () => {
    for (const mode of [undefined, "disable", "require", "verify-system", "verify-ca", "verify-full"] as const) {
      const options = clientOptions(
        resolveTarget(
          connection({ ssl: mode === undefined ? undefined : { mode, caCert: PEM }, queryTimeout: 5, schema: "APP" }),
        ),
        "/tmp/ca.pem",
      );
      expect(Object.keys(options)).not.toContain("queryTimeout");
      expect(Object.keys(options)).not.toContain("currentSchema");
    }
  });

  // db2-node 1.0.24 refuses the plaintext mechanism unless it is asked for by name, so the
  // insecure opt-in has to say it; over TLS the driver's default encrypted mechanism is kept.
  test("the plaintext mechanism is named only without TLS, and never over TLS", () => {
    for (const mode of ["require", "verify-system", "verify-ca", "verify-full"] as const) {
      const options = clientOptions(resolveTarget(connection({ ssl: { mode, caCert: PEM } })), "/tmp/ca.pem");
      expect(Object.keys(options)).not.toContain("securityMechanism");
    }
  });
});

/** An in-memory file system that records every call. */
function memoryFs(overrides: Partial<CaFileSystem> = {}) {
  const calls: string[] = [];
  const fs: CaFileSystem = {
    mkdtemp: async (prefix) => {
      calls.push(`mkdtemp ${prefix}`);
      return `${prefix}abc`;
    },
    writeFile: async (path, data, options) => {
      calls.push(`writeFile ${path} ${data.length} ${options.mode.toString(8)}`);
    },
    rm: async (path, options) => {
      calls.push(`rm ${path} ${String(options.recursive)} ${String(options.force)}`);
    },
    ...overrides,
  };
  return { fs, calls };
}

describe("writeCaFile", () => {
  test("a private directory and a 0600 ca.pem inside it", async () => {
    const { fs, calls } = memoryFs();
    const written = await writeCaFile(PEM, fs);

    expect(written.dir).toBe(join(tmpdir(), "libredb-db2-abc"));
    expect(written.file).toBe(join(written.dir, "ca.pem"));
    expect(calls).toEqual([
      expect.stringMatching(/^mkdtemp .*libredb-db2-$/),
      `writeFile ${written.file} ${PEM.length} 600`,
    ]);
  });

  test("a failed write removes the directory and raises", async () => {
    const { fs, calls } = memoryFs({
      writeFile: async () => {
        throw new Error("disk full");
      },
    });
    await expect(writeCaFile(PEM, fs)).rejects.toThrow("disk full");
    expect(calls.at(-1)).toMatch(/^rm .*libredb-db2-abc true true$/);
  });

  test("the real file system writes and removes it", async () => {
    const written = await writeCaFile(PEM);
    const { readFile, stat } = await import("node:fs/promises");

    expect(dirname(written.dir)).toBe(tmpdir());
    expect(written.file).toBe(join(written.dir, "ca.pem"));
    expect(await readFile(written.file, "utf8")).toBe(PEM);
    await NODE_CA_FILE_SYSTEM.rm(written.dir, { recursive: true, force: true });
    await expect(stat(written.dir)).rejects.toThrow();
  });

  // Named in the title rather than returned early from the body, the way
  // tests/unit/lib/auth-bootstrap.test.ts does it. On Windows, Node maps the mode to the
  // read-only attribute alone and reports 0o666, so the privacy there is the per-user ACL on
  // the temp directory, which the test above pins as the parent.
  test.skipIf(process.platform === "win32")(
    "the real file system keeps the directory 0700 and the file 0600 (POSIX only: NTFS has no mode bits)",
    async () => {
      const written = await writeCaFile(PEM);
      const { stat } = await import("node:fs/promises");
      try {
        expect((await stat(written.dir)).mode & 0o777).toBe(0o700);
        expect((await stat(written.file)).mode & 0o777).toBe(0o600);
      } finally {
        await NODE_CA_FILE_SYSTEM.rm(written.dir, { recursive: true, force: true });
      }
    },
  );
});

/** A driver whose client records its options and connects, or fails as told. */
function fakeDriver(connectError?: unknown) {
  const built: Db2ClientOptions[] = [];
  const driver: Db2Driver = {
    Client: class {
      constructor(options: Db2ClientOptions) {
        built.push(options);
      }
      async connect() {
        if (connectError !== undefined) throw connectError;
      }
      async query() {
        return { rows: [], rowCount: 0, columns: [], diagnostics: [] };
      }
      async close() {}
    },
  };
  return { driver, built };
}

describe("openClient", () => {
  test("connects with the CA written to a file and hands back its directory", async () => {
    const { fs, calls } = memoryFs();
    const { driver, built } = fakeDriver();
    const opened = await openClient(connection(), async () => driver, fs);

    expect(opened.caDir).toBe(join(tmpdir(), "libredb-db2-abc"));
    expect(built[0].caCert).toBe(join(tmpdir(), "libredb-db2-abc", "ca.pem"));
    expect(calls).toHaveLength(2);
  });

  test("the insecure opt-in reaches the driver as the plaintext mechanism, named", async () => {
    const { driver, built } = fakeDriver();
    await openClient(connection({ ssl: undefined, allowInsecureAuth: true }), async () => driver, memoryFs().fs);

    expect(built[0]).toMatchObject({ ssl: false, securityMechanism: "userPassword" });
  });

  test("with no CA there is no file and no directory", async () => {
    const { fs, calls } = memoryFs();
    const { driver } = fakeDriver();
    const opened = await openClient(connection({ ssl: { mode: "verify-system" } }), async () => driver, fs);

    expect(opened).not.toHaveProperty("caDir");
    expect(calls).toEqual([]);
  });

  test("a failed connect removes the CA directory and answers Failed to connect to Db2", async () => {
    const { fs, calls } = memoryFs();
    const { driver } = fakeDriver(new Error("TLS handshake failed: invalid peer certificate: NotValidForName"));
    const error = (await openClient(connection(), async () => driver, fs).catch((e: unknown) => e)) as ConnectionError;

    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(
      "Failed to connect to Db2: TLS handshake failed: invalid peer certificate: NotValidForName",
    );
    expect(error.host).toBe("db2.example.com");
    expect(error.port).toBe(50001);
    expect(calls.at(-1)).toMatch(/^rm .*libredb-db2-abc true true$/);
  });

  test("a failure that is not an Error is still reported", async () => {
    const { driver } = fakeDriver("refused");
    await expect(
      openClient(connection({ ssl: undefined, allowInsecureAuth: true }), async () => driver, memoryFs().fs),
    ).rejects.toThrow("Failed to connect to Db2: refused");
  });

  test("the driver's absence keeps its own message", async () => {
    const missing = Object.assign(new Error("Cannot find module 'db2-node'"), { code: "MODULE_NOT_FOUND" });
    const { driver } = fakeDriver(missing);
    await expect(
      openClient(connection({ ssl: { mode: "require" } }), async () => driver, memoryFs().fs),
    ).rejects.toThrow("Db2 is not available in this deployment");
  });

  test("the transport rules run before the driver is even loaded", async () => {
    let loaded = false;
    await expect(
      openClient(
        connection({ ssl: undefined }),
        async () => {
          loaded = true;
          return fakeDriver().driver;
        },
        memoryFs().fs,
      ),
    ).rejects.toThrow(DatabaseConfigError);
    expect(loaded).toBe(false);
  });
});
