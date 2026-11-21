/**
 * No provider holds the SSH tunnel's secret fields (FND-2, docs/SECURITY.md control 3.41).
 *
 * Studio opens the tunnel itself, with the record's tunnel password, private key and passphrase, and builds the provider
 * from the tunnel's outcome: the local endpoint in `host` and `port` and the far end under `TUNNEL_FAR_END`. A provider
 * therefore has no use for a tunnel credential, and the published `createDatabaseProvider` used to hand every one of them
 * on all the same, at `provider.config.sshTunnel`.
 *
 * This census builds every shipped type-id through the real `createDatabaseProvider`, the function an embedder of
 * `@libredb/studio/providers` calls, from a record whose three tunnel secret fields hold markers, and walks the whole
 * provider for them. Two records per id: one whose tunnel is switched off and still carries its credentials, as a stored
 * connection does, and one shaped as the factory hands a tunnelled connection on. Nothing connects: each build is a
 * dynamic import and a constructor (`tests/helpers/census-connection.ts`).
 */
import { describe, expect, test } from "bun:test";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { connectionFingerprint, tunnelRoute } from "@/lib/db/connection-fingerprint";
import { createDatabaseProvider } from "@/lib/db/factory";
import type { DatabaseConnection, DatabaseProvider } from "@/lib/db/types";
import { SSH_TUNNEL_FIELDS } from "@/lib/storage/secret-fields";
import {
  LITERAL_SEED_FILE,
  TUNNEL_FAR_END,
  type DatabaseType,
  type SSHTunnelConfig,
  type WithLiteralSeedFile,
  type WithTunnelFarEnd,
} from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";

const TUNNEL_MARKER_ONE = "not-a-real-tunnel-marker-7f3a";
const TUNNEL_MARKER_TWO = "not-a-real-tunnel-marker-91c2";
const TUNNEL_MARKER_THREE = "not-a-real-tunnel-marker-5d0e";
const MARKERS = [TUNNEL_MARKER_ONE, TUNNEL_MARKER_TWO, TUNNEL_MARKER_THREE];
const BASTION_FINGERPRINT = "SHA256:bm90LWEtcmVhbC1iYXN0aW9uLWZpbmdlcnByaW50";
const FAR_END = { host: "db.internal", port: 5432 };

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

/** What a provider's `sshTunnel` must be, written out by hand rather than derived from the classification. */
function expectedProviderTunnel(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    host: "bastion.example",
    port: 22,
    username: "jump",
    authMethod: "privateKey",
    hostKeyFingerprint: BASTION_FINGERPRINT,
  };
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

/**
 * The property path of every place a marker is reachable from `root`.
 *
 * It walks own data properties, string and symbol keyed, through their descriptors so that no getter runs; the keys and
 * values of a Map and the values of a Set; and the bytes of a typed array or DataView read as latin1. A visited set stops
 * it at a cycle.
 */
function markersReachableFrom(root: unknown): string[] {
  const hits: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (MARKERS.some((marker) => value.includes(marker))) hits.push(path);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (ArrayBuffer.isView(value)) {
      const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("latin1");
      if (MARKERS.some((marker) => text.includes(marker))) hits.push(`${path} (bytes)`);
      return;
    }
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        visit(key, `${path} (map key)`);
        visit(entry, `${path} (map value)`);
      }
    }
    if (value instanceof Set) {
      for (const entry of value) visit(entry, `${path} (set value)`);
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) visit(descriptor.value, `${path}.${String(key)}`);
    }
  };
  visit(root, "provider");
  return hits;
}

type MarkedConnection = DatabaseConnection & WithTunnelFarEnd & WithLiteralSeedFile;

/** The provider's connection, typed with the two core-only markers a spread carries. */
const configOf = (provider: DatabaseProvider): MarkedConnection => provider.config;

/** Everything the census holds of one provider built from `record`. */
async function expectBuiltWithoutTunnelSecrets(record: MarkedConnection, enabled: boolean): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(record);
  expect(markersReachableFrom(provider)).toEqual([]);
  const tunnel: Record<string, unknown> = { ...provider.config.sshTunnel };
  expect(tunnel).toEqual(expectedProviderTunnel(enabled));
  expect(configOf(provider)[LITERAL_SEED_FILE]).toBe(true);
  // The seal and the route the edit plan and Databend's sign-in latch frame are the record's.
  expect(await connectionFingerprint(provider.config)).toBe(await connectionFingerprint(record));
  expect(tunnelRoute(provider.config.sshTunnel)).toBe(tunnelRoute(record.sshTunnel));
  // The caller's record keeps its credentials: core dials the tunnel with them.
  expect(record.sshTunnel?.password).toBe(TUNNEL_MARKER_ONE);
  expect(record.sshTunnel?.privateKey).toBe(TUNNEL_MARKER_TWO);
  expect(record.sshTunnel?.passphrase).toBe(TUNNEL_MARKER_THREE);
  return provider;
}

describe("no provider holds the SSH tunnel's secret fields (FND-2)", () => {
  test.each(SHIPPED_DATABASE_TYPES)("%s built from a stored connection whose tunnel is switched off", async (type) => {
    const provider = await expectBuiltWithoutTunnelSecrets(storedRecord(type), false);
    expect(configOf(provider)[TUNNEL_FAR_END]).toBeUndefined();
  });

  test.each(SHIPPED_DATABASE_TYPES)("%s built as the factory builds a tunnelled connection", async (type) => {
    const provider = await expectBuiltWithoutTunnelSecrets(tunnelledRecord(type), true);
    expect(configOf(provider)[TUNNEL_FAR_END]).toEqual(FAR_END);
    expect(provider.config.host).toBe("127.0.0.1");
    expect(provider.config.port).toBe(40000);
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
