/**
 * No provider dials past an SSH tunnel it was not given (FND-2 slice 5, docs/SECURITY.md control 3.46).
 *
 * Core opens a connection's tunnel before it builds the provider, and hands the provider the tunnel's far end under
 * `TUNNEL_FAR_END`, which only core sets. A connection whose tunnel is on and which carries no far end therefore had no
 * tunnel opened for it, and `host` and `port` are the database's own: a provider built from it would reach its server
 * past the tunnel the connection asked for. Before this slice, 16 engines did exactly that when an embedder of
 * `@libredb/studio/providers` built and connected one with `createDatabaseProvider`.
 *
 * This census builds every shipped type-id through the real `createDatabaseProvider` from such a record, pointed at a
 * local TCP listener, and holds that each is refused at build, before any provider exists: the listener counts no
 * connection. Every expected sentence is written out by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { SHIPPED_DATABASE_TYPES, SSH_TUNNEL_REFUSAL } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseConnection } from "@/lib/db/types";
import { TUNNEL_FAR_END, type DatabaseType, type SSHTunnelConfig, type WithTunnelFarEnd } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

const NOT_OPENED =
  "This connection's SSH tunnel is on and no tunnel was opened for it, so no provider was built and nothing was sent: build the provider inside withOneShotTunnel, or get it from getOrCreateProvider, which open the tunnel first.";
const FAR_END_WITHOUT_TUNNEL =
  "A tunnel's far end was handed over for a connection whose SSH tunnel is not on, so no provider was built.";

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

let listener: Server;
let listenerPort = 0;
let connectionsSeen = 0;

beforeAll(async () => {
  listener = createServer((socket) => {
    connectionsSeen += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  listenerPort = (listener.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => listener.close(() => resolve()));
});

function tunnel(enabled: boolean): SSHTunnelConfig {
  return {
    enabled,
    host: "bastion.example",
    port: 22,
    username: "jump",
    authMethod: "password",
    password: crypto.randomUUID(),
  };
}

/** A record whose tunnel is on and was not opened: `host` and `port` are the database's own, here the listener. */
function unopened(type: DatabaseType): DatabaseConnection {
  return { ...CENSUS_CONNECTION[type], host: "127.0.0.1", port: listenerPort, sshTunnel: tunnel(true) };
}

/** The record as `tunnelledConnection` hands it on once core opened the tunnel. */
function opened(type: DatabaseType): DatabaseConnection & WithTunnelFarEnd {
  return {
    ...CENSUS_CONNECTION[type],
    host: "127.0.0.1",
    port: listenerPort,
    sshTunnel: tunnel(true),
    [TUNNEL_FAR_END]: { host: "db.internal", port: 5432 },
  };
}

/** The `DatabaseConfigError` `createDatabaseProvider` refuses `record` with. */
async function buildRefusal(record: DatabaseConnection): Promise<DatabaseConfigError> {
  let refusal: unknown;
  try {
    await createDatabaseProvider(record);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(DatabaseConfigError);
  return refusal as DatabaseConfigError;
}

describe("no provider dials past an SSH tunnel it was not given (FND-2 slice 5)", () => {
  test.each([...SHIPPED_DATABASE_TYPES])(
    "%s: createDatabaseProvider refuses a tunnel that is on and was not opened, and nothing reaches the database",
    async (type) => {
      const refusal = await buildRefusal(unopened(type));
      expect(refusal.message).toBe(REFUSED_ENGINES.includes(type) ? (SSH_TUNNEL_REFUSAL[type] as string) : NOT_OPENED);
      expect(refusal.provider).toBe(type);
      expect(connectionsSeen).toBe(0);
    },
  );

  test.each([...SHIPPED_DATABASE_TYPES])("%s: a provider is built when core opened the tunnel", async (type) => {
    if (REFUSED_ENGINES.includes(type)) {
      expect((await buildRefusal(opened(type))).message).toBe(SSH_TUNNEL_REFUSAL[type] as string);
      return;
    }
    const provider = await createDatabaseProvider(opened(type));
    expect(provider.isConnected()).toBe(false);
    expect(connectionsSeen).toBe(0);
  });

  test.each([...SHIPPED_DATABASE_TYPES])("%s: a far end without a tunnel is refused", async (type) => {
    const off: DatabaseConnection & WithTunnelFarEnd = {
      ...CENSUS_CONNECTION[type],
      sshTunnel: tunnel(false),
      [TUNNEL_FAR_END]: { host: "db.internal", port: 5432 },
    };
    expect((await buildRefusal(off)).message).toBe(FAR_END_WITHOUT_TUNNEL);
    const absent: DatabaseConnection & WithTunnelFarEnd = { ...off, sshTunnel: undefined };
    expect((await buildRefusal(absent)).message).toBe(FAR_END_WITHOUT_TUNNEL);
  });

  test("the census refuses the engines the row refuses, written out here", () => {
    expect(SHIPPED_DATABASE_TYPES.filter((type) => SSH_TUNNEL_REFUSAL[type] !== null).sort()).toEqual(
      [...REFUSED_ENGINES].sort(),
    );
    expect(connectionsSeen).toBe(0);
  });
});
