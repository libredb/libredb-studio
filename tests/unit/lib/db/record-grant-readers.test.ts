/**
 * The db and open readers of a grant read the grant of the connection's engine record (`servedEngineRecord` in
 * src/lib/db/server-catalog.ts), never a table of Studio's keyed by the connection's type: the choice of database
 * (`catalogChoice`), the masking exemption a client is handed (`clientCapabilities`), the provider cache key's posture
 * segment and owner (`providerCacheKey`, `providerOwner`), the fields a provider receives (`providerFields`), the file
 * and host path admissions (`admittedFileConnection`, `namesInMemoryDatabase`, `admittedHostPathConnection`) and the
 * session capacity class (`sessionCapacity`). So a package engine's grant reaches each of them through its register row
 * (docs/providers/CONTRACT.md, clause M-54).
 *
 * Every catalog here is composed in memory (tests/helpers/package-catalog.ts) and installed by the case that reads it,
 * then forgotten in `finally`, so no case leaves a catalog behind for the next.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseGrantRegister, type RegisterRow } from "@libredb/grant-register";
import { catalogChoice } from "@/lib/db/catalog-scope";
import { type EngineGrants, STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { clientCapabilities } from "@/lib/db/client-capabilities";
import { ProviderUnavailableError, UnknownProviderError } from "@/lib/db/errors";
import { providerCacheKey, providerOwner } from "@/lib/db/provider-cache-key";
import { providerFields } from "@/lib/db/provider-connection";
import { admittedFileConnection, admittedHostPathConnection, namesInMemoryDatabase } from "@/lib/db/provider-files";
import {
  forgetServerCatalog,
  installServerCatalog,
  type ServerCatalog,
  serverCatalogInstalled,
} from "@/lib/db/server-catalog";
import { type AdmittedForCatalog, composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { sessionCapacity } from "@/lib/db/session-capacity";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { ProviderCapabilities } from "@/lib/db/types";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import {
  ADMITTED_FILE,
  ADMITTED_HOST_PATHS,
  type DatabaseConnection,
  type DatabaseType,
  type WithAdmittedHostPaths,
} from "@/lib/types";
import {
  admittedFor,
  admittedManifest,
  packageRow,
  withEngineRecord,
  withLoosestClaims,
} from "../../../helpers/package-catalog";

/** Capabilities that declare catalog sessions and a masking exemption of the provider's own, which no gate reads. */
const DECLARING = Object.freeze({
  catalogSessions: true,
  maskingExemptColumns: { column: ".*", reason: "Every column is said to carry no personal data." },
}) as unknown as ProviderCapabilities;

/** A connection of `type`, with `fields` beside its identity. */
function connectionOf(type: string, fields: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: `grant-${type}`, name: type, type: type as DatabaseType, createdAt: new Date(0), ...fields };
}

/** Studio's own catalog with the grants of each engine `changes` names replaced by its record's grants and the change. */
function craftedCatalog(changes: Readonly<Record<string, Partial<EngineGrants>>>): ServerCatalog {
  let catalog = composeServerCatalog([], [], STUDIO_GRANT_REGISTER);
  for (const [id, change] of Object.entries(changes)) {
    catalog = withEngineRecord(catalog, id, (engine) => ({
      ...engine,
      grants: Object.freeze({ ...engine.grants, ...change }),
    }));
  }
  return catalog;
}

/** Runs `read` with `catalog` installed, and forgets it whatever `read` does. */
async function withCatalog<T>(catalog: ServerCatalog, read: () => T | Promise<T>): Promise<T> {
  installServerCatalog(catalog);
  try {
    return await read();
  } finally {
    forgetServerCatalog();
  }
}

/** What `read` throws, or a failure naming that it threw nothing. */
async function thrownBy(read: () => unknown): Promise<unknown> {
  try {
    await read();
  } catch (error) {
    return error;
  }
  throw new Error("the read threw nothing");
}

/** Whether the cache key of `connection` splits on the deny posture. */
async function keySplitsOnDeny(connection: DatabaseConnection): Promise<boolean> {
  return (await providerCacheKey(connection, false, "owner")) !== (await providerCacheKey(connection, true, "owner"));
}

/** Whether the cache key of `connection` frames the owner it is handed. */
async function keyFramesOwner(connection: DatabaseConnection): Promise<boolean> {
  return (await providerCacheKey(connection, true, "owner")) !== (await providerCacheKey(connection, true, undefined));
}

describe("the db and open readers of a grant", () => {
  test("each db and open reader answers the connection's installed record's grant, not Studio's table", async () => {
    const postgres = connectionOf("postgres", { host: "db.internal", port: 5432, user: "app" });
    const sqliteFile = connectionOf("sqlite", { database: path.join(tmpdir(), "record-grant-readers.db") });
    const sqliteMemory = connectionOf("sqlite", { database: ":memory:" });
    const certificate = path.join(tmpdir(), "record-grant-readers", "client.pem");
    const exemption = Object.freeze({ column: "^opaque_id$", reason: "An opaque id no rule needs to mask." });

    // Studio's grants, read with nothing installed: what each crafted grant below differs from.
    expect(catalogChoice(postgres, DECLARING)).toBe("honoured");
    expect(clientCapabilities("postgres", DECLARING).maskingExemptColumns).toBeUndefined();
    expect(await keySplitsOnDeny(postgres)).toBe(false);
    expect(providerOwner(sqliteFile, "owner")).toBe("owner");
    expect(await keyFramesOwner(sqliteFile)).toBe(true);
    expect(providerFields("sqlite")).not.toContain("port");
    expect(ADMITTED_FILE in admittedFileConnection(sqliteFile)).toBe(true);
    expect(namesInMemoryDatabase(sqliteMemory)).toBe(true);
    expect(ADMITTED_HOST_PATHS in admittedHostPathConnection({ ...postgres, clientCertificatePath: certificate })).toBe(
      false,
    );
    expect(sessionCapacity(postgres)).toBe("several");

    const catalog = craftedCatalog({
      postgres: {
        serverLevelAtCatalogChoice: false,
        maskingExemptColumns: exemption,
        readsFileAccessPosture: true,
        hostPathFields: Object.freeze(["clientCertificatePath"] as const),
        servesOneSession: "The engine serves its object tree from the editor's session in this test.",
      },
      sqlite: { singleWriterFile: true, sshTunnel: null, opensLocalFile: false },
    });
    await withCatalog(catalog, async () => {
      expect(catalogChoice(postgres, DECLARING)).toBe("engine-not-recorded");
      expect(clientCapabilities("postgres", DECLARING).maskingExemptColumns).toBe(exemption);
      expect(await keySplitsOnDeny(postgres)).toBe(true);
      expect(providerOwner(sqliteFile, "owner")).toBeUndefined();
      expect(await keyFramesOwner(sqliteFile)).toBe(false);
      // A tunnel the record offers hands the provider the host and port core writes its local endpoint to.
      expect(providerFields("sqlite")).toEqual(expect.arrayContaining(["host", "port"]));
      // A file the record does not grant is no file: the connection itself, and `:memory:` no in-memory database.
      expect(admittedFileConnection(sqliteFile)).toBe(sqliteFile);
      expect(namesInMemoryDatabase(sqliteMemory)).toBe(false);
      const admitted = admittedHostPathConnection({
        ...postgres,
        clientCertificatePath: certificate,
      }) as WithAdmittedHostPaths;
      expect(admitted[ADMITTED_HOST_PATHS]).toEqual({ clientCertificatePath: certificate });
      expect(sessionCapacity(postgres)).toBe("one");
    });
    expect(serverCatalogInstalled()).toBe(false);
  });

  test("each db and open reader refuses a refused package's engine as ProviderUnavailableError, and the provider's fields as an unknown type", async () => {
    const catalog = composeServerCatalog(
      [],
      [{ name: "acme-gone", version: "1.0.0", engines: ["acmegone"], code: "PROVIDER_LOAD_FAILED" }],
      STUDIO_GRANT_REGISTER,
    );
    const gone = connectionOf("acmegone", { database: ":memory:" });
    const reads: Readonly<Record<string, () => unknown>> = {
      catalogChoice: () => catalogChoice(gone, DECLARING),
      clientCapabilities: () => clientCapabilities("acmegone" as DatabaseType, DECLARING),
      providerCacheKey: () => providerCacheKey(gone, true, "owner"),
      providerOwner: () => providerOwner(gone, "owner"),
      admittedFileConnection: () => admittedFileConnection(gone),
      namesInMemoryDatabase: () => namesInMemoryDatabase(gone),
      admittedHostPathConnection: () => admittedHostPathConnection(gone),
      sessionCapacity: () => sessionCapacity(gone),
    };
    await withCatalog(catalog, async () => {
      const errors = await Promise.all(
        Object.entries(reads).map(async ([reader, read]) => [reader, await thrownBy(read)] as const),
      );
      for (const [reader, error] of errors) {
        expect([reader, error instanceof ProviderUnavailableError]).toEqual([reader, true]);
        expect((error as ProviderUnavailableError).codes).toEqual(["PROVIDER_LOAD_FAILED"]);
      }
      // The provider's fields read the engine's declaration rows first, which hold no package's engine.
      const fields = await thrownBy(() => providerFields("acmegone" as DatabaseType));
      expect(fields).toBeInstanceOf(UnknownProviderError);
      expect((fields as Error).message).toBe(unknownTypeSentence("acmegone"));
    });
  });

  test("an admitted package's engine is read at its register row's grant on every db and open reader, and at each claim's restrictive value where no row exists", async () => {
    const rowed = admittedFor("acme-rowed", admittedManifest("acmerowed", withLoosestClaims));
    const bare = admittedFor("acme-bare", admittedManifest("acmebare", withLoosestClaims));
    const exemption = { column: "^acme_id$", reason: "An opaque id no rule needs to mask." };
    const row: RegisterRow = packageRow(rowed, "acmerowed", {
      serverLevelWithoutDatabase: true,
      maskingExemptColumns: exemption,
      singleWriterFile: true,
      readsFileAccessPosture: false,
      opensLocalFile: false,
      servesOneSession: "The engine serves its object tree from the editor's session in this test.",
    });
    const register = parseGrantRegister([row], LEGACY_ENGINE_IDS);
    const catalog = composeServerCatalog([rowed, bare] as readonly AdmittedForCatalog[], [], register);
    const withRow = connectionOf("acmerowed", { host: "db.internal", port: 5432 });
    const withoutRow = connectionOf("acmebare", { host: "db.internal", port: 5432 });

    await withCatalog(catalog, async () => {
      // The register row's grant.
      expect(catalogChoice(withRow, DECLARING)).toBe("honoured");
      expect(clientCapabilities("acmerowed" as DatabaseType, DECLARING).maskingExemptColumns).toEqual(exemption);
      expect(providerOwner(withRow, "owner")).toBeUndefined();
      expect(await keySplitsOnDeny(withRow)).toBe(false);
      expect(await keyFramesOwner(withRow)).toBe(false);
      expect(admittedFileConnection(withRow)).toBe(withRow);
      expect(admittedHostPathConnection(withRow)).toBe(withRow);
      expect(sessionCapacity(withRow)).toBe("one");

      // No row: each claim's restrictive value.
      expect(catalogChoice(withoutRow, DECLARING)).toBe("engine-not-recorded");
      expect(Object.hasOwn(clientCapabilities("acmebare" as DatabaseType, DECLARING), "maskingExemptColumns")).toBe(
        false,
      );
      expect(providerOwner(withoutRow, "owner")).toBe("owner");
      expect(await keySplitsOnDeny(withoutRow)).toBe(true);
      expect(await keyFramesOwner(withoutRow)).toBe(true);
      // A local file is the restrictive value of its claim, so the admission reads the file the connection names
      // through the declaration rows, which hold no package's engine (a declaration read, opened with M5).
      const capacity = await thrownBy(() => sessionCapacity(withoutRow));
      expect(capacity).toBeInstanceOf(UnknownProviderError);
      expect((capacity as Error).message).toBe(unknownTypeSentence("acmebare"));
    });
  });
});
