import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "path";
import {
  getManagedConnections,
  getPendingSeeds,
  getSeedConnectionById,
  getSeedConnectionByIdUnfiltered,
  resetCache,
} from "@/lib/seed";
import { resetLiteralModeNotices, resetPlaintextWarnings } from "@/lib/seed/credential-resolver";
import { getDiscoveredConnections, resetDiscoveryCache } from "@/lib/seed/discovery-loader";
import { SAMPLE_SEED_ID } from "@/lib/seed/libredb-sample";
import { DEFAULT_SEED_CONFIG_PATH } from "@/lib/seed/sources/file";
import { SQLITE_SAMPLE_SEED_ID, setSqliteSampleSeedState } from "@/lib/seed/sqlite-sample";
import { logger } from "@/lib/logger";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");

describe("seed/index orchestrator", () => {
  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
    process.env.ADMIN_PG_PASS = "admin-secret";
    process.env.USER_MYSQL_PASS = "user-secret";
    process.env.SHARED_PG_PASS = "shared-secret";
    process.env.BOTH_PG_PASS = "both-secret";
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.ADMIN_PG_PASS;
    delete process.env.USER_MYSQL_PASS;
    delete process.env.SHARED_PG_PASS;
    delete process.env.BOTH_PG_PASS;
  });

  it("getManagedConnections returns role-filtered connections", async () => {
    const adminConns = await getManagedConnections(["admin"]);
    expect(adminConns.length).toBeGreaterThanOrEqual(3);

    const userConns = await getManagedConnections(["user"]);
    const userIds = userConns.map((c) => c.seedId);
    expect(userIds).toContain("everyone");
    expect(userIds).toContain("user-only");
    expect(userIds).not.toContain("admin-only");
  });

  it("getSeedConnectionById returns connection with role check", async () => {
    const conn = await getSeedConnectionById("everyone", ["user"]);
    expect(conn).not.toBeNull();
    expect(conn!.seedId).toBe("everyone");
    expect(conn!.password).toBe("shared-secret");
  });

  it("getSeedConnectionById returns null when role mismatches", async () => {
    const conn = await getSeedConnectionById("admin-only", ["user"]);
    expect(conn).toBeNull();
  });

  it("getSeedConnectionByIdUnfiltered returns connection regardless of role", async () => {
    const conn = await getSeedConnectionByIdUnfiltered("admin-only");
    expect(conn).not.toBeNull();
    expect(conn!.seedId).toBe("admin-only");
  });

  it("getSeedConnectionByIdUnfiltered returns null for nonexistent ID", async () => {
    const conn = await getSeedConnectionByIdUnfiltered("nonexistent");
    expect(conn).toBeNull();
  });

  it("returns empty array when config file missing", async () => {
    process.env.SEED_CONFIG_PATH = "/nonexistent.yaml";
    resetCache();
    const conns = await getManagedConnections(["admin"]);
    expect(conns).toHaveLength(0);
  });

  it("marks every operator entry literal on both lookups while SEED_LITERAL_VALUES is on, and resolves none", async () => {
    resetLiteralModeNotices();
    process.env.SEED_LITERAL_VALUES = "true";
    try {
      const admin = await getManagedConnections(["admin"]);
      expect(admin.map((c) => [c.seedId, c.password, c.literal])).toEqual([
        ["admin-only", "${ADMIN_PG_PASS}", true],
        ["everyone", "${SHARED_PG_PASS}", true],
        ["admin-and-user", "${BOTH_PG_PASS}", true],
      ]);

      const unfiltered = await getSeedConnectionByIdUnfiltered("user-only");
      expect(unfiltered?.password).toBe("${USER_MYSQL_PASS}");
      expect(unfiltered?.literal).toBe(true);
    } finally {
      delete process.env.SEED_LITERAL_VALUES;
    }
  });
});

/*
  Discovered connections (CapRover auto-connect spec 9.5 and 9.7) read through the real loader from an export file,
  next to the multi-role seed file and the SQLite sample, so the order, the clash rule and the role filter are
  measured on the list getManagedConnections really builds.
*/
describe("seed/index with discovered connections", () => {
  const PLAINTEXT_WARNING = "Seed connection has plaintext password, use ${ENV_VAR} syntax";
  let discovery: DiscoveryExportFixture;
  let scratch: string;

  beforeEach(() => {
    resetCache();
    resetDiscoveryCache();
    resetPlaintextWarnings();
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "multi-role-config.yaml");
    process.env.ADMIN_PG_PASS = "admin-secret";
    process.env.USER_MYSQL_PASS = "user-secret";
    process.env.SHARED_PG_PASS = "shared-secret";
    process.env.BOTH_PG_PASS = "both-secret";
    scratch = mkdtempSync(path.join(tmpdir(), "libredb-seed-index-"));
    // getManagedConnections lists the SQLite sample when its file exists; its content is never read here.
    const sample = path.join(scratch, "sample-employees.db");
    writeFileSync(sample, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sample;
    discovery = writeDiscoveryExport([postgresService("pg", "discovered-secret")]);
    process.env.SEED_DISCOVERY_PATH = discovery.path;
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.ADMIN_PG_PASS;
    delete process.env.USER_MYSQL_PASS;
    delete process.env.SHARED_PG_PASS;
    delete process.env.BOTH_PG_PASS;
    delete process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
    delete process.env.SEED_DISCOVERY_PATH;
    resetCache();
    resetDiscoveryCache();
    discovery.remove();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("lists the file seeds, then the discovered connections, then the samples", async () => {
    const seedIds = (await getManagedConnections(["admin"])).map((c) => c.seedId);
    expect(seedIds).toEqual(["admin-only", "everyone", "admin-and-user", "caprover-pg", SQLITE_SAMPLE_SEED_ID]);
  });

  it("lists the discovered connections when there is no seed file at all, as the auto-connect template ships", async () => {
    process.env.SEED_CONFIG_PATH = path.join(scratch, "no-seed-file.yaml");
    resetCache();

    const admin = await getManagedConnections(["admin"]);
    expect(admin.map((c) => c.seedId)).toEqual(["caprover-pg", SQLITE_SAMPLE_SEED_ID]);
    expect(admin.find((c) => c.seedId === "caprover-pg")?.literal).toBe(true);
    expect((await getManagedConnections(["user"])).map((c) => c.seedId)).toEqual([]);
  });

  it("marks a discovered connection literal and leaves the file seeds and samples unmarked", async () => {
    const conns = await getManagedConnections(["admin"]);
    expect(conns.find((c) => c.seedId === "caprover-pg")?.literal).toBe(true);
    expect(conns.find((c) => c.seedId === "everyone")?.literal).toBeUndefined();
    expect(conns.find((c) => c.seedId === SQLITE_SAMPLE_SEED_ID)?.literal).toBeUndefined();
  });

  it("keeps the seed file's connection when a discovered one takes its id", async () => {
    const seedFile = path.join(scratch, "seed-connections.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          {
            id: "caprover-pg",
            name: "File PG",
            type: "postgres",
            host: "file-pg.internal",
            password: "${ADMIN_PG_PASS}",
            roles: ["admin"],
          },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    resetCache();
    resetDiscoveryCache();

    const clashing = (await getManagedConnections(["admin"])).filter((c) => c.seedId === "caprover-pg");
    expect(clashing).toHaveLength(1);
    expect(clashing[0]?.host).toBe("file-pg.internal");
    expect(clashing[0]?.password).toBe("admin-secret");
    expect(clashing[0]?.literal).toBeUndefined();
  });

  /*
    The seed file gains a connection whose id is the discovered `caprover-pg`. Only the seed file's cache is reset:
    the loader checks a service's id against the file only when its own cache recomputes, and the two caches expire
    independently, so this is the window of up to one SEED_CACHE_TTL_MS in which the loader still lists the id.
  */
  function gainSeedConnectionWithDiscoveredId(roles: string[]): void {
    const seedFile = path.join(scratch, "seed-connections.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          {
            id: "caprover-pg",
            name: "File PG",
            type: "postgres",
            host: "file-pg.internal",
            password: "${ADMIN_PG_PASS}",
            roles,
          },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    resetCache();
  }

  it("lists one connection for an id the seed file gains while the discovery cache is warm", async () => {
    // Fills the discovery cache: the export's service is listed, marked literal.
    const before = (await getManagedConnections(["admin"])).filter((c) => c.seedId === "caprover-pg");
    expect(before).toHaveLength(1);
    expect(before[0]?.literal).toBe(true);

    gainSeedConnectionWithDiscoveredId(["admin"]);
    // Control: the loader's cache, which this test did not reset, still lists the id.
    expect((await getDiscoveredConnections()).map((c) => c.id)).toEqual(["caprover-pg"]);

    const after = (await getManagedConnections(["admin"])).filter((c) => c.seedId === "caprover-pg");
    expect(after).toHaveLength(1);
    expect(after[0]?.host).toBe("file-pg.internal");
    expect(after[0]?.password).toBe("admin-secret");
    expect(after[0]?.literal).toBeUndefined();
  });

  it("counts every id in the seed file as taken, including one its role filter hides from the caller", async () => {
    await getManagedConnections(["admin"]);

    // The file's connection is for standard users, so an admin lists neither it nor the discovered one: the
    // loader's rule reads every id in the file, and the merge reads the same set.
    gainSeedConnectionWithDiscoveredId(["user"]);

    const seedIds = (await getManagedConnections(["admin"])).map((c) => c.seedId);
    expect(seedIds).toEqual([SQLITE_SAMPLE_SEED_ID]);
  });

  it("drops a discovered id that only an operator entry dropped for an undefined variable declares", async () => {
    // Fills the discovery cache: the export's service is listed.
    await getManagedConnections(["admin"]);

    const seedFile = path.join(scratch, "seed-connections.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [
          {
            id: "caprover-pg",
            name: "File PG",
            type: "postgres",
            host: "file-pg.internal",
            password: "${SEED_INDEX_UNSET_PASSWORD}",
            roles: ["admin"],
          },
        ],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    resetCache();
    // Control: the discovery cache, which this test did not reset, still lists the id.
    expect((await getDiscoveredConnections()).map((c) => c.id)).toEqual(["caprover-pg"]);

    const seedIds = (await getManagedConnections(["admin"])).map((c) => c.seedId);
    expect(seedIds).toEqual([SQLITE_SAMPLE_SEED_ID]);
    expect(await getSeedConnectionByIdUnfiltered("caprover-pg")).toBeNull();
  });

  it("gives a standard user none of the discovered connections", async () => {
    const seedIds = (await getManagedConnections(["user"])).map((c) => c.seedId);
    expect(seedIds).toContain("everyone");
    expect(seedIds.filter((id) => id.startsWith("caprover-"))).toEqual([]);
  });

  it("does not find a discovered id through the unfiltered lookup", async () => {
    // Control: the filtered lookup an admin's query goes through does find it.
    expect((await getSeedConnectionById("caprover-pg", ["admin"]))?.seedId).toBe("caprover-pg");
    expect(await getSeedConnectionByIdUnfiltered("caprover-pg")).toBeNull();
  });

  it("keeps a discovered value literal on the list path and logs no plaintext warning for it", async () => {
    const references = writeDiscoveryExport([
      postgresService("ref", "${JWT_SECRET}"),
      postgresService("plain", "plain-discovered-password"),
    ]);
    process.env.SEED_DISCOVERY_PATH = references.path;
    resetDiscoveryCache();
    const warn = spyOn(logger, "warn");

    try {
      const conns = await getManagedConnections(["admin"]);
      expect(conns.find((c) => c.seedId === "caprover-ref")?.password).toBe("${JWT_SECRET}");
      expect(conns.find((c) => c.seedId === "caprover-plain")?.password).toBe("plain-discovered-password");
      expect(warn.mock.calls.filter((call) => call[0] === PLAINTEXT_WARNING)).toEqual([]);
    } finally {
      warn.mockRestore();
      references.remove();
    }
  });

  it("keeps the file seeds and samples when reading the export throws", async () => {
    // A directory where the export file should be: the loader's read throws "not a regular file" inside the source.
    process.env.SEED_DISCOVERY_PATH = scratch;
    resetDiscoveryCache();

    const seedIds = (await getManagedConnections(["admin"])).map((c) => c.seedId);
    expect(seedIds).toEqual(["admin-only", "everyone", "admin-and-user", SQLITE_SAMPLE_SEED_ID]);
  });
});

/*
  Governance mode (docs/GOVERNANCE.md) makes the governance source Studio's only catalog of connections, so the seed
  lookups read no source at all, whatever the environment says. That includes the seed file at its default path,
  which Studio reads when SEED_CONFIG_PATH is unset, as a governance install leaves it. The boot check refuses an
  environment that names a seed file, an export or a sample, and these cases hold where it was bypassed.
*/
describe("seed/index under governance", () => {
  /** A seed file at the default path, which a test cannot write: the readFile spy serves it from memory. */
  const DEFAULT_PATH_SEED = [
    'version: "1"',
    "connections:",
    '  - id: "default-path"',
    '    name: "Default path"',
    "    type: postgres",
    '    host: "db.internal"',
    '    roles: ["*"]',
    "",
  ].join("\n");
  const ENV_KEYS = [
    "GOVERNANCE_SOURCE",
    "SEED_CONFIG_PATH",
    "SEED_DISCOVERY_PATH",
    "SQLITE_EMBEDDED_SAMPLE_PATH",
    "LIBREDB_EMBEDDED_SAMPLE_PATH",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  const realReadFile = fsPromises.readFile;
  let scratch: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetCache();
    resetDiscoveryCache();
    setSqliteSampleSeedState("idle");
    scratch = mkdtempSync(path.join(tmpdir(), "libredb-seed-index-governance-"));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCache();
    resetDiscoveryCache();
    setSqliteSampleSeedState("idle");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("under governance a seed file at the default path is never read", async () => {
    const readFile = spyOn(fsPromises, "readFile").mockImplementation(((file: unknown, ...rest: unknown[]) =>
      file === DEFAULT_SEED_CONFIG_PATH
        ? Promise.resolve(DEFAULT_PATH_SEED)
        : Reflect.apply(realReadFile, fsPromises, [file, ...rest])) as typeof fsPromises.readFile);

    try {
      // Control: without governance the seed file at the default path is read, and its connection listed.
      expect((await getManagedConnections(["admin"])).map((c) => c.seedId)).toEqual(["default-path"]);
      expect(readFile.mock.calls.map((call) => call[0])).toEqual([DEFAULT_SEED_CONFIG_PATH]);
      resetCache();
      readFile.mockClear();

      process.env.GOVERNANCE_SOURCE = "postgres";

      expect(await getManagedConnections(["admin"])).toEqual([]);
      expect(await getManagedConnections(["user"])).toEqual([]);
      expect(await getSeedConnectionById("default-path", ["admin"])).toBeNull();
      expect(await getSeedConnectionByIdUnfiltered("default-path")).toBeNull();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readFile.mockRestore();
    }
  });

  it("under governance neither the discovery export nor a sample is consulted, and no seed is pending", async () => {
    process.env.SEED_CONFIG_PATH = path.join(scratch, "no-seed-file.yaml");
    // Both samples are listed once their file exists; their content is never read here.
    const sqliteSample = path.join(scratch, "sample-employees.db");
    const libredbSample = path.join(scratch, "sample.libredb");
    writeFileSync(sqliteSample, "");
    writeFileSync(libredbSample, "");
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteSample;
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbSample;
    const discovery = writeDiscoveryExport([postgresService("pg", "discovered-secret")]);
    process.env.SEED_DISCOVERY_PATH = discovery.path;
    setSqliteSampleSeedState("seeding");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const open = spyOn(fsPromises, "open");
    const existsSync = spyOn(fs, "existsSync");

    try {
      // Control: without governance the export and both samples are read and listed, and the SQLite sample pends.
      expect((await getManagedConnections(["admin"])).map((c) => c.seedId)).toEqual([
        "caprover-pg",
        SQLITE_SAMPLE_SEED_ID,
        SAMPLE_SEED_ID,
      ]);
      expect(open.mock.calls.map((call) => call[0])).toEqual([discovery.path]);
      expect(existsSync.mock.calls.map((call) => call[0])).toEqual([sqliteSample, libredbSample]);
      expect(getPendingSeeds()).toEqual([SQLITE_SAMPLE_SEED_ID]);
      resetCache();
      resetDiscoveryCache();
      open.mockClear();
      existsSync.mockClear();

      process.env.GOVERNANCE_SOURCE = "postgres";

      expect(await getManagedConnections(["admin"])).toEqual([]);
      expect(await getSeedConnectionById("caprover-pg", ["admin"])).toBeNull();
      expect(await getSeedConnectionById(SQLITE_SAMPLE_SEED_ID, ["admin"])).toBeNull();
      expect(await getSeedConnectionById(SAMPLE_SEED_ID, ["user"])).toBeNull();
      expect(getPendingSeeds()).toEqual([]);
      expect(open).not.toHaveBeenCalled();
      expect(existsSync).not.toHaveBeenCalled();
    } finally {
      existsSync.mockRestore();
      open.mockRestore();
      warn.mockRestore();
      discovery.remove();
    }
  });

  it("counts an invalid GOVERNANCE_SOURCE as on, so a typo reads no source either", async () => {
    const seedFile = path.join(scratch, "seed-connections.json");
    writeFileSync(
      seedFile,
      JSON.stringify({
        version: "1",
        connections: [{ id: "reporting", name: "Reporting", type: "postgres", host: "db.internal", roles: ["*"] }],
      }),
    );
    process.env.SEED_CONFIG_PATH = seedFile;
    // Control: without governance the file's connection is found.
    expect((await getSeedConnectionByIdUnfiltered("reporting"))?.seedId).toBe("reporting");
    resetCache();

    process.env.GOVERNANCE_SOURCE = "Postgres";

    expect(await getManagedConnections(["admin"])).toEqual([]);
    expect(await getSeedConnectionByIdUnfiltered("reporting")).toBeNull();
  });
});
