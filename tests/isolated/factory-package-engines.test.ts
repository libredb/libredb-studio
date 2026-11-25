/**
 * The provider factory's entry points with a server catalog installed (src/lib/db/server-catalog.ts): an engine whose
 * provider package was refused at boot answers `PROVIDER_UNAVAILABLE` naming the refusal code, and an admitted
 * package's engine is refused as one this Studio opens no session on yet, each as the first statement of the entry
 * point, before any cache, tunnel or build (docs/providers/CONTRACT.md, clause C-107).
 *
 * Each connection here carries no id and an SSH tunnel that is on, so a check that ran after the type check would
 * answer another refusal (the id's, the tunnel's), and the callback a tunnel scope runs records its call.
 */
// oxlint-disable no-await-in-loop -- each entry point runs after the one before, so the cache is read after each.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DatabaseConfigError, PackageEngineUnsupportedError, ProviderUnavailableError } from "@/lib/db/errors";
import {
  acquireExecutionProfileProvider,
  createDatabaseProvider,
  getExecutionProfileCacheStats,
  getOrCreateMetadataProvider,
  getOrCreateProvider,
  getProviderCacheStats,
  readProviderDeclarations,
  withOneShotTunnel,
} from "@/lib/db/factory";
import { forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import type { DatabaseConnection } from "@/lib/types";
import { admittedFor, admittedManifest } from "../helpers/package-catalog";

beforeAll(() => {
  installServerCatalog(
    composeServerCatalog(
      [admittedFor("acme-factory", admittedManifest("acmefactory"))],
      [{ name: "acme-factory-gone", version: "1.0.0", engines: ["acmefactorygone"], code: "PROVIDER_LOAD_FAILED" }],
    ),
  );
});
afterAll(forgetServerCatalog);

/** A connection of `type` with no id and a tunnel that is on. */
function connectionOf(type: string): DatabaseConnection {
  return {
    name: "c",
    type,
    host: "db.local",
    port: 7000,
    sshTunnel: { enabled: true, host: "bastion.local", port: 22, username: "u", authMethod: "password" },
  } as unknown as DatabaseConnection;
}

/** What each entry point answers for `type`, and whether a tunnel scope ran its callback. */
async function refusals(type: string): Promise<{ errors: unknown[]; ran: number }> {
  const connection = connectionOf(type);
  let ran = 0;
  const entries: (() => Promise<unknown>)[] = [
    () => createDatabaseProvider(connection),
    () => readProviderDeclarations(connection),
    () =>
      withOneShotTunnel(connection, async () => {
        ran += 1;
      }),
    () => getOrCreateProvider(connection),
    () => getOrCreateMetadataProvider(connection),
    () => acquireExecutionProfileProvider(connection, "agent-read-only"),
  ];
  const errors: unknown[] = [];
  for (const entry of entries) errors.push(await entry().catch((error: unknown) => error));
  return { errors, ran };
}

describe("the factory and a provider package's engine", () => {
  test("an engine whose package was refused answers PROVIDER_UNAVAILABLE naming the refusal at each factory entry point, before any cache, tunnel or build", async () => {
    const { errors, ran } = await refusals("acmefactorygone");
    expect(errors.length).toBe(6);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect((error as ProviderUnavailableError).codes).toEqual(["PROVIDER_LOAD_FAILED"]);
    }
    expect(ran).toBe(0);
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });

  test("an admitted package's engine is refused at each factory entry point, its session opening through its package", async () => {
    const { errors, ran } = await refusals("acmefactory");
    for (const error of errors) {
      expect(error).toBeInstanceOf(PackageEngineUnsupportedError);
      expect(error).not.toBeInstanceOf(DatabaseConfigError);
      expect((error as Error).message).toBe(
        "LibreDB Studio's provider factory builds no provider for an engine of a provider package; that engine's session opens through its package, and this caller does not serve one.",
      );
    }
    expect(ran).toBe(0);
    expect(getProviderCacheStats().size).toBe(0);
  });
});
