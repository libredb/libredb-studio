/**
 * Each of the provider factory's four entry points refuses an engine whose claims leave a refusal no grant covers
 * (its record's `grants.ungrantedRefusals`, for a legacy engine its row of `UNGRANTED_CLAIM_REFUSALS` in
 * src/lib/db/claim-grants.ts, docs/providers/CONTRACT.md clause M-54) before any cache lookup, tunnel or build:
 * `assertClaimsGranted` runs right after `assertReadOnlyHonoured` in each (src/lib/db/open-check.ts).
 *
 * Under tests/isolated because it replaces `@/lib/ssh/tunnel` with `mock.module()` before it imports the factory, which
 * holds only while this file is the first in its bun process to evaluate it. The installed catalog holds postgres's
 * record with its `ungrantedRefusals` set to the single-writer sentence, so no shipped engine's declaration needs to
 * differ from its record for the refusal to be reached.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { UNGRANTED_SINGLE_WRITER_FILE_SENTENCE as REFUSAL } from "@/lib/db/claim-grants";
import { forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import type { SSHTunnelConfig } from "@/lib/types";
import type { DatabaseConnection } from "@/lib/db/types";
import { withEngineRecord } from "../helpers/package-catalog";

beforeAll(() => {
  installServerCatalog(
    withEngineRecord(composeServerCatalog([], []), "postgres", (engine) => ({
      ...engine,
      grants: Object.freeze({ ...engine.grants, ungrantedRefusals: REFUSAL }),
    })),
  );
});
afterAll(forgetServerCatalog);

const mockCreateSSHTunnel = mock(async () => {
  throw new Error("no tunnel is dialled for a refused engine");
});
mock.module("@/lib/ssh/tunnel", () => ({
  createSSHTunnel: mockCreateSSHTunnel,
  closeSSHTunnel: mock(async () => {}),
  releaseUnopenedTunnel: mock(async () => {}),
  tunnelProviderOpened: mock(() => {}),
  getTunnelInfo: mock(() => undefined),
}));

const {
  acquireExecutionProfileProvider,
  createDatabaseProvider,
  getExecutionProfileCacheStats,
  getOrCreateProvider,
  getProviderCacheStats,
  withOneShotTunnel,
} = await import("@/lib/db/factory");

const bastion: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.internal",
  port: 22,
  username: "jump",
  authMethod: "password",
  password: randomUUID(),
};

/** A tunnelled postgres connection, refused by the replaced grant table. */
function refusedConnection(id: string): DatabaseConnection {
  return {
    id,
    name: id,
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "app",
    sshTunnel: bastion,
    createdAt: new Date(),
  } as DatabaseConnection;
}

describe("the open refusal of an engine whose claims no grant covers", () => {
  test("each of the factory's four entry points refuses an engine left refused at open before any cache lookup, tunnel or build", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const run = mock(async () => "ran");
    try {
      await expect(createDatabaseProvider(refusedConnection("refused-create"))).rejects.toThrow(REFUSAL);
      await expect(getOrCreateProvider(refusedConnection("refused-cached"))).rejects.toThrow(REFUSAL);
      await expect(
        acquireExecutionProfileProvider(refusedConnection("refused-profiled"), "agent-operations"),
      ).rejects.toThrow(REFUSAL);
      await expect(withOneShotTunnel(refusedConnection("refused-one-shot"), run)).rejects.toThrow(REFUSAL);

      // The first thing a build does is log the provider it creates, so no such line means nothing was built.
      expect(log.mock.calls.filter(([line]) => String(line).startsWith("[DB] Creating"))).toEqual([]);
    } finally {
      log.mockRestore();
    }
    expect(run).not.toHaveBeenCalled();
    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
    expect(getProviderCacheStats().size).toBe(0);
    expect(getExecutionProfileCacheStats().size).toBe(0);
  });
});
