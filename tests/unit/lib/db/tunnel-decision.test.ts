/**
 * `decideTunnel`, the one decision core takes about a connection's SSH tunnel (FND-2 slice 5), and the engine record's
 * `grants.sshTunnel` it reads, which for a shipped engine is its legacy row of the grant register.
 *
 * Every expected sentence and every refused engine below is written out by hand, never derived from the module under
 * test, so a change to what core refuses, or to the words it refuses with, fails here by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { decideTunnel as decideWithRecord } from "@/lib/db/tunnel-decision";
import { LEGACY_ENGINES } from "@/lib/provider-host/legacy-adapter/records";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";
import { legacyRegisterTable } from "../../../helpers/legacy-register";

const sshTunnel = legacyRegisterTable("sshTunnel");

const REFUSED_ENGINES: readonly DatabaseType[] = [
  "kafka",
  "rabbitmq",
  "bigquery",
  "snowflake",
  "firestore",
  "snmp",
  "cassandra",
  "couchbase",
  "sqlite",
  "duckdb",
  "libredb",
];

const UNOPENABLE =
  "This connection's SSH tunnel is on, but the connection names no Host and Port for the tunnel to forward to, so no tunnel was opened and nothing was sent. Fill in Host and Port, or turn the tunnel off.";

/** A record of `type` whose tunnel is on and well formed, with a host and a port to forward to. */
function tunnelled(type: DatabaseType = "postgres", tunnel: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "fnd2-s5",
    name: "fnd2-s5",
    type,
    host: "db.internal",
    port: 5432,
    createdAt: new Date(0),
    sshTunnel: {
      enabled: true,
      host: "bastion.example",
      port: 22,
      username: "jump",
      authMethod: "password",
      ...tunnel,
    },
  } as DatabaseConnection;
}

/** `decideTunnel`'s answer for `connection`, read with its engine's legacy record, as the factory reads it. */
function decide(connection: DatabaseConnection): ReturnType<typeof decideWithRecord> {
  return decideWithRecord(connection, LEGACY_ENGINES.get(connection.type) as EngineRecord);
}

/** `decideTunnel`'s answer as one word, `none` or `open`. */
function decideTunnel(connection: DatabaseConnection): "none" | "open" {
  return decide(connection).open ? "open" : "none";
}

/** The `DatabaseConfigError` `decideTunnel` refuses `connection` with. */
function refusalOf(connection: DatabaseConnection): DatabaseConfigError {
  try {
    decideTunnel(connection);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    return error as DatabaseConfigError;
  }
  throw new Error("decideTunnel answered instead of refusing");
}

describe("decideTunnel, the one decision core takes about a record's SSH tunnel (FND-2 slice 5)", () => {
  test("answers none for a connection without a tunnel object", () => {
    const without = { ...tunnelled(), sshTunnel: undefined };
    expect(decideTunnel(without)).toBe("none");
    expect(decideTunnel({ ...without, sshTunnel: null } as unknown as DatabaseConnection)).toBe("none");
  });

  test("answers none for a tunnel that is off, on every engine", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      for (const enabled of [false, null, undefined]) {
        expect(decideTunnel(tunnelled(type, { enabled }))).toBe("none");
        expect(decideTunnel({ ...tunnelled(type, { enabled }), host: undefined, port: undefined })).toBe("none");
      }
    }
  });

  test("answers open for a well-formed tunnel that is on, with a host and a port", () => {
    const connection = tunnelled();
    expect(decide(connection)).toEqual({
      open: true,
      tunnel: connection.sshTunnel!,
      host: "db.internal",
      port: 5432,
    });
    // The record's own tunnel, secrets included, is what core dials with.
    expect((decide(connection) as { tunnel: unknown }).tunnel).toBe(connection.sshTunnel);
    expect(decideTunnel(tunnelled("postgres", { authMethod: "privateKey", port: 65535 }))).toBe("open");
    expect(decideTunnel(tunnelled("postgres", { port: 1 }))).toBe("open");
  });

  test.each([["yes"], [1], [{}], [0], ["true"]])("refuses an enabled of %p by name", (enabled) => {
    const refusal = refusalOf(tunnelled("postgres", { enabled }));
    expect(refusal.message).toBe("The connection's sshTunnel.enabled must be true or false; nothing was sent.");
    expect(refusal.provider).toBe("postgres");
  });

  test.each([
    ["host", { enabled: false, host: undefined }, "The connection's sshTunnel.host must be text; nothing was sent."],
    [
      "host",
      { enabled: undefined, host: undefined, username: undefined },
      "The connection's sshTunnel.host must be text; nothing was sent.",
    ],
    ["host", { enabled: false, host: 7 }, "The connection's sshTunnel.host must be text; nothing was sent."],
    ["username", { username: 7 }, "The connection's sshTunnel.username must be text; nothing was sent."],
    [
      "username",
      { enabled: false, username: undefined },
      "The connection's sshTunnel.username must be text; nothing was sent.",
    ],
    [
      "host",
      { host: "" },
      "The connection's sshTunnel.host must be the bastion's host name or address; nothing was sent.",
    ],
    [
      "port",
      { port: "22" },
      "The connection's sshTunnel.port must be a whole number from 1 to 65535; nothing was sent.",
    ],
    ["port", { port: 0 }, "The connection's sshTunnel.port must be a whole number from 1 to 65535; nothing was sent."],
    [
      "port",
      { port: 70000 },
      "The connection's sshTunnel.port must be a whole number from 1 to 65535; nothing was sent.",
    ],
    [
      "port",
      { port: 2.5 },
      "The connection's sshTunnel.port must be a whole number from 1 to 65535; nothing was sent.",
    ],
    [
      "port",
      { port: null },
      "The connection's sshTunnel.port must be a whole number from 1 to 65535; nothing was sent.",
    ],
    [
      "authMethod",
      { authMethod: "key" },
      "The connection's sshTunnel.authMethod must be password or privateKey; nothing was sent.",
    ],
    [
      "authMethod",
      { authMethod: undefined },
      "The connection's sshTunnel.authMethod must be password or privateKey; nothing was sent.",
    ],
  ])("refuses a tunnel whose %s is malformed (%p) by name", (_field, tunnel, sentence) => {
    expect(refusalOf(tunnelled("postgres", tunnel)).message).toBe(sentence);
  });

  test("a tunnel that is off is not checked past the fields its route frames", () => {
    expect(decideTunnel(tunnelled("postgres", { enabled: false, port: "22", authMethod: "key" }))).toBe("none");
    expect(decideTunnel(tunnelled("postgres", { enabled: false, host: "" }))).toBe("none");
  });

  test("dials the bastion's 22 when the tunnel names no port", () => {
    expect(decideTunnel(tunnelled("postgres", { port: undefined }))).toBe("open");
  });

  test("refuses a tunnel that is on and names no host or port to forward to", () => {
    expect(refusalOf({ ...tunnelled(), port: undefined }).message).toBe(UNOPENABLE);
    expect(refusalOf({ ...tunnelled(), host: undefined }).message).toBe(UNOPENABLE);
    expect(refusalOf({ ...tunnelled(), host: "" }).message).toBe(UNOPENABLE);
    const fromString = { ...tunnelled("mongodb"), host: undefined, port: undefined, connectionString: "mongodb://x" };
    expect(refusalOf(fromString).message).toBe(UNOPENABLE);
    expect(refusalOf(fromString).provider).toBe("mongodb");
  });

  test("refuses a tunnel that is not plain data first, as slice 1 does", () => {
    const tunnel = Object.create({ enabled: "yes" }) as Record<string, unknown>;
    const refusal = refusalOf({ ...tunnelled(), sshTunnel: tunnel } as unknown as DatabaseConnection);
    expect(refusal.message).toBe(
      "The connection's sshTunnel must be a plain object of data fields; no provider was built.",
    );
  });

  test("a malformed tunnel is refused before the engine's row, and the row before an unopenable record", () => {
    expect(refusalOf(tunnelled("kafka", { enabled: "yes" })).message).toBe(
      "The connection's sshTunnel.enabled must be true or false; nothing was sent.",
    );
    expect(refusalOf({ ...tunnelled("kafka"), host: undefined, port: undefined }).message).toBe(
      "Kafka does not run through an SSH tunnel: the tunnel forwards one address, and a Kafka client reads from every broker the cluster advertises, at the address the broker advertises. Connect to the brokers directly.",
    );
  });

  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: a tunnel that is on is refused exactly when its row names a reason",
    (type) => {
      if (REFUSED_ENGINES.includes(type)) {
        const refusal = refusalOf(tunnelled(type));
        expect(refusal.message).toBe(sshTunnel[type] as string);
        expect(refusal.provider).toBe(type);
      } else {
        expect(decideTunnel(tunnelled(type))).toBe("open");
      }
    },
  );

  test("the row refuses kafka, rabbitmq, bigquery, snowflake, firestore, snmp, cassandra, couchbase, sqlite, duckdb and libredb", () => {
    const refused = SHIPPED_DATABASE_TYPES.filter((type) => sshTunnel[type] !== null);
    expect([...refused].sort()).toEqual([...REFUSED_ENGINES].sort());
  });

  test("each refused engine's sentence is written out here as users read it", () => {
    expect(sshTunnel).toMatchObject({
      kafka:
        "Kafka does not run through an SSH tunnel: the tunnel forwards one address, and a Kafka client reads from every broker the cluster advertises, at the address the broker advertises. Connect to the brokers directly.",
      rabbitmq:
        "RabbitMQ connections cannot use an SSH tunnel: one tunnel carries one port, and the management API and AMQP use two.",
      cassandra:
        "Apache Cassandra does not run through an SSH tunnel: the tunnel forwards one address, and the driver reaches every other node of the ring at the address that node advertises. Connect to the cluster directly, or turn the tunnel off.",
      couchbase:
        "Couchbase does not run through an SSH tunnel: the tunnel forwards one port, and queries go to the query service, on another port, at the address the cluster's node map advertises. Turn the tunnel off.",
      bigquery:
        "BigQuery does not run through an SSH tunnel: every request goes over HTTPS to Google's API hosts, and a tunnel forwards one address of the several the provider reaches. Turn the tunnel off.",
      firestore:
        "Firestore does not run through an SSH tunnel: every request goes over TLS to Google's API hosts, and a tunnel forwards one address of the several the provider reaches. Turn the tunnel off.",
      snowflake:
        "Snowflake does not run through an SSH tunnel: the driver reaches the account's Snowflake hosts over HTTPS, and a tunnel forwards one address. Turn the tunnel off.",
      snmp: "SNMP does not run through an SSH tunnel: the tunnel forwards TCP, and SNMP reads travel as UDP datagrams. Turn the tunnel off.",
      sqlite:
        "SQLite opens a file on the Studio server, so there is no address for an SSH tunnel to forward to. Turn the tunnel off: edit the connection and save it again.",
      duckdb:
        "DuckDB opens a file on the Studio server, so there is no address for an SSH tunnel to forward to. Turn the tunnel off: edit the connection and save it again.",
      libredb:
        "LibreDB opens a file on the Studio server, so there is no address for an SSH tunnel to forward to. Turn the tunnel off: edit the connection and save it again.",
    });
  });

  test("no refusal quotes a value", () => {
    const marker = () => `marker-${crypto.randomUUID()}`;
    const cases: DatabaseConnection[] = [
      tunnelled("postgres", { enabled: marker() }),
      tunnelled("postgres", { port: marker(), host: marker(), username: marker(), password: marker() }),
      tunnelled("postgres", { authMethod: marker(), privateKey: marker(), passphrase: marker() }),
      { ...tunnelled("postgres", { host: marker(), username: marker() }), port: undefined },
      tunnelled("kafka", { host: marker(), username: marker(), password: marker() }),
    ];
    for (const connection of cases) {
      const values = Object.values(connection.sshTunnel as unknown as Record<string, unknown>).filter(
        (value): value is string => typeof value === "string" && value.startsWith("marker-"),
      );
      expect(values.length).toBeGreaterThan(0);
      const message = refusalOf(connection).message;
      for (const value of values) expect(message).not.toContain(value);
    }
  });

  test("never writes to the record", () => {
    const connection = tunnelled();
    const frozen = Object.freeze({ ...connection, sshTunnel: Object.freeze({ ...connection.sshTunnel }) });
    expect(decideTunnel(frozen as DatabaseConnection)).toBe("open");
    const before = JSON.stringify(connection);
    decideTunnel(connection);
    expect(JSON.stringify(connection)).toBe(before);
  });

  test("docs/providers/README.md names exactly the engines the row refuses", () => {
    const readme = readFileSync(join(import.meta.dir, "../../../../docs/providers/README.md"), "utf8");
    const lead = "Studio refuses a connection whose SSH tunnel is on, before it dials anything, for each engine below";
    const start = readme.indexOf(lead);
    expect(start).toBeGreaterThan(-1);
    const end = readme.indexOf("\n\n", start);
    // Each bullet opens with the type-ids it covers, in backticks and separated by commas, before its colon.
    const listed = [...readme.slice(start, end).matchAll(/^- ((?:`[a-z0-9]+`(?:, )?)+):/gm)].flatMap((match) =>
      [...match[1].matchAll(/`([a-z0-9]+)`/g)].map((id) => id[1]),
    );
    expect([...listed].sort()).toEqual([...REFUSED_ENGINES].sort());
  });
});
