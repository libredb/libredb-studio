/**
 * No provider receives the SSH tunnel (FND-2, docs/SECURITY.md control 3.41).
 *
 * Studio opens the tunnel itself, with the record's tunnel password, private key and passphrase, and builds the provider
 * from the tunnel's outcome: the local endpoint in `host` and `port`, the far end under `TUNNEL_FAR_END` and the route
 * under `TUNNEL_ROUTE`. A provider therefore has no use for the tunnel's configuration, and the published
 * `createDatabaseProvider` used to hand it on all the same, at `provider.config.sshTunnel`, first with every credential
 * and then with the readable fields (slice 5b took the field out).
 *
 * This census builds every shipped type-id through the real `createDatabaseProvider`, the function an embedder of
 * `@libredb/studio/providers` calls, from a record whose three tunnel secret fields hold markers, and walks the whole
 * provider for them. Two records per id: one whose tunnel is switched off and still carries its credentials, as a stored
 * connection does, and one shaped as the factory hands a tunnelled connection on. Nothing connects: each build is a
 * dynamic import and a constructor (`tests/helpers/census-connection.ts`).
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES, SSH_TUNNEL_REFUSAL } from "@/lib/db/compatibility";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { createDatabaseProvider } from "@/lib/db/factory";
import { providerConnection } from "@/lib/db/provider-connection";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";
import { SSH_TUNNEL_FIELDS } from "@/lib/storage/secret-fields";
import {
  LITERAL_SEED_FILE,
  TUNNEL_FAR_END,
  TUNNEL_ROUTE,
  type DatabaseType,
  type SSHTunnelConfig,
  type WithLiteralSeedFile,
  type WithTunnelFarEnd,
  type WithTunnelRoute,
} from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";
import { markersReachableFrom } from "../helpers/reachable-markers";

const TUNNEL_MARKER_ONE = "not-a-real-tunnel-marker-7f3a";
const TUNNEL_MARKER_TWO = "not-a-real-tunnel-marker-91c2";
const TUNNEL_MARKER_THREE = "not-a-real-tunnel-marker-5d0e";
const MARKERS = [TUNNEL_MARKER_ONE, TUNNEL_MARKER_TWO, TUNNEL_MARKER_THREE];
const BASTION_FINGERPRINT = "SHA256:bm90LWEtcmVhbC1iYXN0aW9uLWZpbmdlcnByaW50";
const FAR_END = { host: "db.internal", port: 5432 };
const TAKES_A_TUNNEL = SHIPPED_DATABASE_TYPES.filter((type) => SSH_TUNNEL_REFUSAL[type] === null);

/** A tunnel with every field filled, a marker in each field the classification calls secret, and one unclassified key. */
function tunnelWithMarkers(enabled: boolean): SSHTunnelConfig & { unclassified: string } {
  return {
    enabled,
    host: "bastion.example",
    port: 22,
    username: "jump",
    authMethod: "privateKey",
    password: TUNNEL_MARKER_ONE,
    privateKey: TUNNEL_MARKER_TWO,
    passphrase: TUNNEL_MARKER_THREE,
    hostKeyFingerprint: BASTION_FINGERPRINT,
    unclassified: "dropped",
  };
}

/** The route a provider must carry under `TUNNEL_ROUTE`, written out by hand rather than derived with `tunnelRoute`. */
function expectedRoute(enabled: boolean): string {
  return enabled ? "4:true15:bastion.example2:224:jump" : "5:false15:bastion.example2:224:jump";
}

/** A stored connection: its tunnel switched off, its credentials still in the record, a literal seed file's marker. */
function storedRecord(type: DatabaseType): MarkedConnection {
  const record: MarkedConnection = {
    ...CENSUS_CONNECTION[type],
    sshTunnel: tunnelWithMarkers(false),
    [LITERAL_SEED_FILE]: true,
  };
  return record;
}

/** The record as `tunnelledConnection` hands it on: the local endpoint, the far end, the tunnel switched on. */
function tunnelledRecord(type: DatabaseType): MarkedConnection {
  const record: MarkedConnection = {
    ...CENSUS_CONNECTION[type],
    host: "127.0.0.1",
    port: 40000,
    sshTunnel: tunnelWithMarkers(true),
    [TUNNEL_FAR_END]: FAR_END,
    [LITERAL_SEED_FILE]: true,
  };
  return record;
}

type MarkedConnection = DatabaseConnection & WithTunnelFarEnd & WithLiteralSeedFile & WithTunnelRoute;

/** The provider's connection, typed with the core-only markers it may carry. */
const configOf = (provider: DatabaseProvider): MarkedConnection => provider.config;

/** Everything the census holds of one provider built from `record`. */
async function expectBuiltWithoutTunnelSecrets(record: MarkedConnection, enabled: boolean): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(record);
  expect(markersReachableFrom(provider, MARKERS)).toEqual([]);
  expect(Object.hasOwn(provider.config, "sshTunnel")).toBe(false);
  expect(configOf(provider)[TUNNEL_ROUTE]).toBe(expectedRoute(enabled));
  expect(configOf(provider)[LITERAL_SEED_FILE]).toBe(true);
  // The seal the edit plan frames, with the route from core's marker, is the one the edit routes frame on
  // `providerConnection` of the record (FND-2 slice 6).
  expect(await connectionFingerprint(provider.config)).toBe(await connectionFingerprint(providerConnection(record)));
  // The caller's record keeps its credentials: core dials the tunnel with them.
  expect(record.sshTunnel?.password).toBe(TUNNEL_MARKER_ONE);
  expect(record.sshTunnel?.privateKey).toBe(TUNNEL_MARKER_TWO);
  expect(record.sshTunnel?.passphrase).toBe(TUNNEL_MARKER_THREE);
  return provider;
}

describe("no provider receives the SSH tunnel: it gets the route under core's marker and never sshTunnel (FND-2 slice 5)", () => {
  test.each(SHIPPED_DATABASE_TYPES)(
    "%s built from a stored connection whose tunnel is switched off holds no sshTunnel, and the off route under core's marker",
    async (type) => {
      const provider = await expectBuiltWithoutTunnelSecrets(storedRecord(type), false);
      expect(configOf(provider)[TUNNEL_FAR_END]).toBeUndefined();
    },
  );

  // Only the engines that take a tunnel: core refuses a tunnel that is on for the others before any build
  // (SSH_TUNNEL_REFUSAL, tests/security/provider-tunnel-decisions.test.ts), so no provider of theirs is ever built
  // from a tunnelled connection.
  test.each(TAKES_A_TUNNEL)(
    "%s built as the factory builds a tunnelled connection holds no sshTunnel, and the route under core's marker",
    async (type) => {
      const provider = await expectBuiltWithoutTunnelSecrets(tunnelledRecord(type), true);
      expect(configOf(provider)[TUNNEL_FAR_END]).toEqual(FAR_END);
      expect(provider.config.host).toBe("127.0.0.1");
      expect(provider.config.port).toBe(40000);
    },
  );

  // Neither shape opens a tunnel in core, which reads its `enabled` as absent, so a provider built from it would connect
  // straight to the record's own address; the array would also carry its password to the provider.
  const notPlainTunnels: ReadonlyArray<[string, unknown]> = [
    ["a string", "on"],
    ["an array", [tunnelWithMarkers(true)]],
  ];
  test.each(SHIPPED_DATABASE_TYPES.flatMap((type) => notPlainTunnels.map(([shape, value]) => [type, shape, value])))(
    "%s is refused by name, with nothing built, when its sshTunnel is %s",
    async (type, _shape, sshTunnel) => {
      const record = { ...CENSUS_CONNECTION[type as DatabaseType], sshTunnel } as unknown as DatabaseConnection;
      await expect(createDatabaseProvider(record)).rejects.toThrow(
        "The connection's sshTunnel must be a plain object of data fields; no provider was built.",
      );
    },
  );

  test("a tunnel whose enabled is a getter is refused rather than built without it", async () => {
    class Tunnel {
      host = "bastion.example";
      port = 22;
      username = "jump";
      password = TUNNEL_MARKER_ONE;
      get enabled(): boolean {
        return true;
      }
    }
    const record = { ...CENSUS_CONNECTION.kafka, sshTunnel: new Tunnel() } as unknown as DatabaseConnection;
    await expect(createDatabaseProvider(record)).rejects.toThrow(
      "The connection's sshTunnel must be a plain object of data fields; no provider was built.",
    );
  });

  test("a connection whose readOnly a copy would drop is refused rather than built writable", async () => {
    const record: DatabaseConnection = { ...CENSUS_CONNECTION.etcd, sshTunnel: tunnelWithMarkers(false) };
    Object.defineProperty(record, "readOnly", { value: true, enumerable: false });
    await expect(createDatabaseProvider(record)).rejects.toThrow(
      "A connection with an sshTunnel must be a plain object of data fields; no provider was built.",
    );
  });

  test("the census plants a marker in every field the classification calls secret", () => {
    // A fourth secret tunnel field fails here until the census plants a marker for it, so the walk above can never pass
    // by not looking for one.
    const secret = Object.keys(SSH_TUNNEL_FIELDS).filter(
      (field) => SSH_TUNNEL_FIELDS[field as keyof typeof SSH_TUNNEL_FIELDS] === "secret",
    );
    expect(secret.sort()).toEqual(["passphrase", "password", "privateKey"]);
    const planted = tunnelWithMarkers(true);
    expect(secret.map((field) => Reflect.get(planted, field)).sort()).toEqual([...MARKERS].sort());
  });
});
