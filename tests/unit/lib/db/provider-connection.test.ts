/**
 * `providerConnection`, the connection a provider is built from (FND-2, docs/SECURITY.md control 3.41).
 *
 * Core decides and opens the SSH tunnel with the record's tunnel fields, so the provider is handed the record without
 * its `sshTunnel` and with the tunnel's route under `TUNNEL_ROUTE` (slice 5b). The expected routes below are written out
 * by hand, never derived with `tunnelRoute`, so a change to what reaches a provider fails here by name.
 */
import { describe, expect, test } from "bun:test";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { assertTunnelRecordIsPlainData, providerConnection, providerFields } from "@/lib/db/provider-connection";
import type { DatabaseConnection } from "@/lib/db/types";
import {
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
  type DatabaseType,
  LITERAL_SEED_FILE,
  TUNNEL_FAR_END,
  TUNNEL_ROUTE,
  type WithLiteralSeedFile,
  type WithTunnelFarEnd,
  type WithTunnelRoute,
} from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

const TUNNEL_MARKER_ONE = "not-a-real-tunnel-marker-7f3a";
const TUNNEL_MARKER_TWO = "not-a-real-tunnel-marker-91c2";
const TUNNEL_MARKER_THREE = "not-a-real-tunnel-marker-5d0e";
const DATABASE_MARKER = "not-a-real-database-marker-2b6d";
const CLIENT_MARKER = "not-a-real-client-marker-0a9f";
const BASTION_FINGERPRINT = "SHA256:bm90LWEtcmVhbC1iYXN0aW9uLWZpbmdlcnByaW50";

type MarkedConnection = DatabaseConnection & WithTunnelFarEnd & WithLiteralSeedFile & WithTunnelRoute;

/** A PostgreSQL record whose tunnel holds all nine fields, a marker in each secret one. */
function record(overrides: Record<string, unknown> = {}): MarkedConnection {
  return {
    id: "fnd2",
    name: "fnd2",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "app",
    user: "app",
    password: DATABASE_MARKER,
    createdAt: new Date(0),
    ssl: { mode: "verify-full", clientKey: CLIENT_MARKER },
    sshTunnel: {
      enabled: true,
      host: "bastion.example",
      port: 22,
      username: "jump",
      authMethod: "privateKey",
      password: TUNNEL_MARKER_ONE,
      privateKey: TUNNEL_MARKER_TWO,
      passphrase: TUNNEL_MARKER_THREE,
      hostKeyFingerprint: BASTION_FINGERPRINT,
    },
    ...overrides,
  } as MarkedConnection;
}

const PLAIN_DATA_REFUSAL = "A connection must be a plain object of data fields; no provider was built.";

/** `providerConnection` refuses `given` by naming its `sshTunnel`, and quotes none of the tunnel's values. */
function expectTunnelRefused(given: DatabaseConnection): void {
  const refusal = refusalOf(given);
  expect(refusal.message).toBe(
    "The connection's sshTunnel must be a plain object of data fields; no provider was built.",
  );
}

/** `providerConnection` refuses `given` by naming the connection, and quotes none of its values. */
function expectConnectionRefused(given: unknown): void {
  const refusal = refusalOf(given as DatabaseConnection);
  expect(refusal.message).toBe(
    "A connection with an sshTunnel must be a plain object of data fields; no provider was built.",
  );
}

function refusalOf(given: DatabaseConnection): DatabaseConfigError {
  let caught: unknown;
  try {
    providerConnection(given);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DatabaseConfigError);
  const refusal = caught as DatabaseConfigError;
  expect(refusal.message).not.toContain(TUNNEL_MARKER_ONE);
  return refusal;
}

describe("providerConnection, the connection a provider is built from (FND-2)", () => {
  test("hands a provider no sshTunnel, and the tunnel's route under core's marker, with the tunnel on and opened", () => {
    const farEnd = { host: "db.internal", port: 5432 };
    const projected: MarkedConnection = providerConnection(
      record({ host: "127.0.0.1", port: 40000, [TUNNEL_FAR_END]: farEnd }),
    );
    expect(Object.hasOwn(projected, "sshTunnel")).toBe(false);
    expect(projected[TUNNEL_ROUTE]).toBe("4:true15:bastion.example2:224:jump");
    expect(projected[TUNNEL_FAR_END]).toBe(farEnd);
    expect(projected.host).toBe("127.0.0.1");
    expect(projected.port).toBe(40000);
  });

  test("hands a provider no sshTunnel, and the tunnel's route under core's marker, with the tunnel off", () => {
    const projected: MarkedConnection = providerConnection(
      record({
        sshTunnel: {
          enabled: false,
          host: "bastion.example",
          port: 22,
          username: "jump",
          authMethod: "password",
          password: crypto.randomUUID(),
        },
      }),
    );
    expect(Object.hasOwn(projected, "sshTunnel")).toBe(false);
    expect(projected[TUNNEL_ROUTE]).toBe("5:false15:bastion.example2:224:jump");
    expect(Object.getOwnPropertySymbols(projected)).toEqual([TUNNEL_ROUTE]);
  });

  test("the route marker is a symbol no caller can name, and does not survive JSON, so no stored or posted connection carries one", () => {
    expect(typeof TUNNEL_ROUTE).toBe("symbol");
    expect(Symbol.keyFor(TUNNEL_ROUTE)).toBeUndefined();
    const projected: MarkedConnection = providerConnection(record());
    const parsed = JSON.parse(JSON.stringify(projected)) as MarkedConnection;
    expect(Object.getOwnPropertySymbols(parsed)).toEqual([]);
    expect(parsed[TUNNEL_ROUTE]).toBeUndefined();
  });

  test("replaces a route marker the caller set with the route of its own tunnel", () => {
    const projected: MarkedConnection = providerConnection(
      record({ [TUNNEL_ROUTE]: "4:true16:bastion.internal2:224:jump" }),
    );
    expect(projected[TUNNEL_ROUTE]).toBe("4:true15:bastion.example2:224:jump");
  });

  test.each([[undefined], [null]])(
    "hands on a record whose sshTunnel is %p as a copy of its received fields",
    (sshTunnel) => {
      const given = record({ sshTunnel });
      const projected = providerConnection(given);
      expect(projected).not.toBe(given);
      expect(Object.keys(projected).sort()).toEqual(
        ["id", "name", "type", "host", "port", "database", "user", "password", "ssl"].sort(),
      );
      expect(Object.getOwnPropertySymbols(projected)).toEqual([]);
    },
  );

  test.each([
    ["a string", "on"],
    ["a number", 5],
    ["a boolean", true],
    ["an array", [{ enabled: true, host: "bastion.example", port: 22, password: TUNNEL_MARKER_ONE }]],
    ["a function", () => TUNNEL_MARKER_ONE],
  ])("refuses by name a record whose sshTunnel is %s, never quoting it", (_case, sshTunnel) => {
    expectTunnelRefused(record({ sshTunnel }));
  });

  test("refuses a tunnel whose public field is an accessor: a copy drops a prototype getter and reads an own one once", () => {
    class Tunnel {
      host = "bastion.example";
      port = 22;
      username = "jump";
      password = TUNNEL_MARKER_ONE;
      get enabled(): boolean {
        return true;
      }
    }
    expectTunnelRefused(record({ sshTunnel: new Tunnel() }));
    const ownGetter = { host: "bastion.example", password: TUNNEL_MARKER_ONE };
    Object.defineProperty(ownGetter, "enabled", { get: () => true, enumerable: true });
    expectTunnelRefused(record({ sshTunnel: ownGetter }));
  });

  test("refuses a tunnel with a field that is not enumerable", () => {
    const tunnel = { enabled: true, host: "bastion.example", password: TUNNEL_MARKER_ONE };
    Object.defineProperty(tunnel, "port", { value: 22, enumerable: false });
    expectTunnelRefused(record({ sshTunnel: tunnel }));
  });

  test("accepts a tunnel with no prototype and frames its route", () => {
    const tunnel = Object.assign(Object.create(null) as Record<string, unknown>, {
      enabled: true,
      host: "bastion.example",
      port: 22,
      username: "jump",
      authMethod: "password",
      password: crypto.randomUUID(),
    });
    const projected: MarkedConnection = providerConnection(record({ sshTunnel: tunnel }));
    expect(projected[TUNNEL_ROUTE]).toBe("4:true15:bastion.example2:224:jump");
  });

  test("refuses a record with a tunnel whose own fields a copy would drop, and refuses it without one too", () => {
    // A copy loses a prototype getter, so `readOnly` would reach the provider as undefined.
    class Connection {
      id = "fnd2";
      name = "fnd2";
      type = "etcd" as const;
      host = "etcd.internal";
      port = 2379;
      createdAt = new Date(0);
      sshTunnel: unknown;
      constructor(sshTunnel: unknown) {
        this.sshTunnel = sshTunnel;
      }
      get readOnly(): boolean {
        return true;
      }
    }
    expectConnectionRefused(new Connection({ enabled: false, host: "bastion.example", password: TUNNEL_MARKER_ONE }));
    const withoutTunnel = new Connection(undefined) as unknown as DatabaseConnection;
    expect(() => providerConnection(withoutTunnel)).toThrow(PLAIN_DATA_REFUSAL);

    const hidden = record();
    Object.defineProperty(hidden, "readOnly", { value: true, enumerable: false });
    expectConnectionRefused(hidden);

    const accessor = record();
    Object.defineProperty(accessor, "readOnly", { get: () => true, enumerable: true });
    expectConnectionRefused(accessor);
  });

  test("assertTunnelRecordIsPlainData passes a record without a tunnel whatever its shape, and refuses as providerConnection does", () => {
    class Connection {
      type = "postgres" as const;
      sshTunnel: unknown;
      constructor(sshTunnel: unknown) {
        this.sshTunnel = sshTunnel;
      }
    }
    expect(() =>
      assertTunnelRecordIsPlainData(new Connection(undefined) as unknown as DatabaseConnection),
    ).not.toThrow();
    expect(() => assertTunnelRecordIsPlainData(new Connection(null) as unknown as DatabaseConnection)).not.toThrow();
    expect(() => assertTunnelRecordIsPlainData(record())).not.toThrow();
    expect(() => assertTunnelRecordIsPlainData(record({ sshTunnel: "on" }))).toThrow(
      "The connection's sshTunnel must be a plain object of data fields; no provider was built.",
    );
    expect(() =>
      assertTunnelRecordIsPlainData(new Connection({ enabled: true }) as unknown as DatabaseConnection),
    ).toThrow("A connection with an sshTunnel must be a plain object of data fields; no provider was built.");
  });

  test("accepts a frozen record and a record with no prototype", () => {
    const frozen = Object.freeze(record());
    expect(Object.hasOwn(providerConnection(frozen), "sshTunnel")).toBe(false);
    const bare = Object.assign(Object.create(null) as MarkedConnection, record());
    expect(providerConnection(bare).password).toBe(DATABASE_MARKER);
  });

  test("keeps the far end and the literal seed marker beside the route", () => {
    const farEnd = { host: "db.internal", port: 5432 };
    const marked = record({ host: "127.0.0.1", port: 40000, [TUNNEL_FAR_END]: farEnd, [LITERAL_SEED_FILE]: true });
    const projected: MarkedConnection = providerConnection(marked);
    expect(projected[TUNNEL_FAR_END]).toBe(farEnd);
    expect(projected[LITERAL_SEED_FILE]).toBe(true);
    expect(projected[TUNNEL_ROUTE]).toBe("4:true15:bastion.example2:224:jump");

    const unmarked: MarkedConnection = providerConnection(record());
    expect(Object.getOwnPropertySymbols(unmarked)).toEqual([TUNNEL_ROUTE]);
  });

  test("never writes to the caller's record", () => {
    const given = record();
    const tunnelBefore = given.sshTunnel;
    const snapshot = structuredClone({ ...given, sshTunnel: { ...given.sshTunnel } });
    const projected = providerConnection(given);
    expect(projected).not.toBe(given);
    expect(Object.hasOwn(projected, "sshTunnel")).toBe(false);
    expect(given.sshTunnel).toBe(tunnelBefore);
    const after: Record<string, unknown> = { ...given };
    expect(after).toEqual(snapshot);
    expect(given.sshTunnel?.password).toBe(TUNNEL_MARKER_ONE);
    expect(given.sshTunnel?.privateKey).toBe(TUNNEL_MARKER_TWO);
    expect(given.sshTunnel?.passphrase).toBe(TUNNEL_MARKER_THREE);
  });

  test("keeps every received field, the database password and the TLS client key included, and drops the agent credential", () => {
    const given = record({ agentUser: "agent_ro", agentPassword: crypto.randomUUID() });
    const projected = providerConnection(given);
    // With the route marker taken off, the copy is the record's received fields: the tunnel, the agent credential and
    // `createdAt` are not among PostgreSQL's.
    const restored: Record<string | symbol, unknown> = { ...projected };
    delete restored[TUNNEL_ROUTE];
    expect(Object.getOwnPropertySymbols(restored)).toEqual([]);
    const { sshTunnel: _tunnel, agentUser: _user, agentPassword: _password, createdAt: _created, ...received } = given;
    expect(restored).toEqual(received);
    expect(projected.password).toBe(DATABASE_MARKER);
    expect(projected.ssl).toBe(given.ssl);
    expect(projected.ssl?.clientKey).toBe(CLIENT_MARKER);
  });

  test.each([
    [
      "on, with its far end",
      record({ host: "127.0.0.1", port: 40000, [TUNNEL_FAR_END]: { host: "db.internal", port: 5432 } }),
      "4:true15:bastion.example2:224:jump",
    ],
    [
      "off, with its fields filled",
      record({
        sshTunnel: {
          enabled: false,
          host: "bastion.example",
          port: 22,
          username: "jump",
          authMethod: "password",
          password: TUNNEL_MARKER_ONE,
        },
      }),
      "5:false15:bastion.example2:224:jump",
    ],
    ["absent", record({ sshTunnel: undefined }), undefined],
  ])(
    "frames the same seal as the record, and the route under core's marker, with the tunnel %s",
    async (_case, given, route) => {
      const projected: MarkedConnection = providerConnection(given);
      expect(await connectionFingerprint(projected)).toBe(await connectionFingerprint(given));
      expect(projected[TUNNEL_ROUTE]).toBe(route);
    },
  );
  test("hands a provider only its engine's received fields and core's markers", () => {
    for (const type of ["postgres", "kafka", "opcua", "sqlite"] as const) {
      const given: Record<string | symbol, unknown> = {
        ...CENSUS_CONNECTION[type],
        agentUser: "agent_ro",
        agentPassword: crypto.randomUUID(),
        color: "red",
        environment: "production",
        group: "team",
        skipObjectScan: true,
        schema: "other",
        registerMap: "{}",
      };
      const projected = providerConnection(given as unknown as DatabaseConnection);
      const received: readonly string[] = providerFields(type);
      expect({ type, extra: Object.keys(projected).filter((key) => !received.includes(key)) }).toEqual({
        type,
        extra: [],
      });
      for (const key of Object.keys(projected)) expect(Reflect.get(projected, key)).toBe(given[key]);
    }
  });

  test("keeps an absent received field absent, and a received field the record holds as undefined as it is", () => {
    const projected = providerConnection(record({ sshTunnel: undefined, database: undefined }));
    expect(Object.hasOwn(projected, "queryTimeout")).toBe(false);
    expect(Object.hasOwn(projected, "readOnly")).toBe(false);
    expect(Object.hasOwn(projected, "database")).toBe(true);
    expect(projected.database).toBeUndefined();
  });

  test("drops a caller's symbol key that is not a core marker, and a caller's admitted-file markers", () => {
    const embedder = Symbol("embedder");
    const farEnd = { host: "db.internal", port: 5432 };
    const given = {
      ...record({ host: "127.0.0.1", port: 40000, [TUNNEL_FAR_END]: farEnd, [LITERAL_SEED_FILE]: true }),
      [embedder]: crypto.randomUUID(),
      [ADMITTED_FILE]: "/caller/file",
      [ADMITTED_HOST_PATHS]: { clientCertificatePath: "/caller/cert" },
    };
    const projected: MarkedConnection = providerConnection(given);
    expect(Object.getOwnPropertySymbols(projected).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [LITERAL_SEED_FILE, TUNNEL_FAR_END, TUNNEL_ROUTE].sort((a, b) => String(a).localeCompare(String(b))),
    );
    expect(projected[TUNNEL_FAR_END]).toBe(farEnd);

    const callerRouted: MarkedConnection = { ...given, sshTunnel: undefined, [TUNNEL_ROUTE]: "caller-route" };
    const untunnelled = providerConnection(callerRouted);
    expect(Object.getOwnPropertySymbols(untunnelled).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(
      [LITERAL_SEED_FILE, TUNNEL_FAR_END].sort((a, b) => String(a).localeCompare(String(b))),
    );
  });

  test("refuses a record that is not plain data, with or without a tunnel, quoting no value", () => {
    const marker = crypto.randomUUID();
    class Connection {
      id = "fnd2";
      name = "fnd2";
      type = "postgres" as const;
      password = marker;
    }
    const inherited = Object.assign(Object.create({ readOnly: true }) as object, record({ sshTunnel: undefined }));
    const accessor = record({ sshTunnel: undefined });
    Object.defineProperty(accessor, "password", { get: () => marker, enumerable: true });
    const hidden = record({ sshTunnel: null });
    Object.defineProperty(hidden, "readOnly", { value: true, enumerable: false });
    for (const given of [new Connection(), inherited, accessor, hidden]) {
      let caught: unknown;
      try {
        providerConnection(given as DatabaseConnection);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatabaseConfigError);
      expect((caught as Error).message).toBe(PLAIN_DATA_REFUSAL);
      expect((caught as Error).message).not.toContain(marker);
    }
  });

  test.each([
    ["postgres", "schema"],
    ["trino", "serviceName"],
    ["redis", "serviceName"],
    ["etcd", "database"],
  ] as const)(
    "the seal framed on the provider's copy equals the one framed on providerConnection of the record, for a %s record with %s, which its engine does not receive",
    async (type: DatabaseType, field) => {
      expect(providerFields(type)).not.toContain(field);
      const given = { ...CENSUS_CONNECTION[type], [field]: "elsewhere" } as DatabaseConnection;
      const provider = await createDatabaseProvider(given);
      expect(await connectionFingerprint(provider.config)).toBe(await connectionFingerprint(providerConnection(given)));
      // The field is framed by the seal, so a frame of the record itself would differ from the provider's.
      expect(await connectionFingerprint(given)).not.toBe(await connectionFingerprint(provider.config));
    },
  );
});
