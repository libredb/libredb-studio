import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import { resetCache } from "@/lib/seed/config-loader";
import type { DiscoveredService, DiscoveryExport } from "@/lib/seed/discovery-export";
import {
  getDiscoveredConnections,
  getDiscoveryStatus,
  isDiscoveryEnabled,
  resetDiscoveryCache,
  type DiscoveryDeps,
  type DiscoveryStatus,
} from "@/lib/seed/discovery-loader";
import { defaultProbe } from "@/lib/seed/discovery-probe";
import { postgresService, writeDiscoveryExport, type DiscoveryExportFixture } from "../../helpers/discovery-fixture";

const T0 = Date.parse("2026-10-04T12:00:00.000Z");
const MAX_AGE_MS = 60_000;
const ROUTE = "seed/discovery-loader";
const WAITING = "Waiting for the discovery app to write its export file";
const HINT = "No export file yet: the discovery app may not be running, or it may run on another node than Studio";
const PG_CONNECTED = { name: "pgtest (PostgreSQL)", type: "postgres" };
const EXCLUDED = "listed in Apps to skip";

let dir = "";
let file = "";
let clock = T0;
let probeAnswer = true;
const probe = mock<(host: string, port: number) => Promise<boolean>>(async () => probeAnswer);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function service(appName: string, image: string, env: Record<string, string>): DiscoveredService {
  return {
    id: `svc-${appName}`,
    name: `srv-captain--${appName}`,
    appName,
    host: `srv-captain--${appName}`,
    image,
    env,
    requirepassEnv: null,
    tasks: { running: 1, desired: 1 },
  };
}

const POSTGRES = service("pgtest", "postgres:16", {
  POSTGRES_USER: "postgres",
  POSTGRES_PASSWORD: "pg-secret",
  POSTGRES_DB: "appdb",
});
// Built by CapRover from dockerfileLines, as the mariadb one-click template does: an env-fallback candidate.
const MARIADB = service("maria", "img-captain-maria:3", { MYSQL_ROOT_PASSWORD: "maria-secret" });
const WEB = service("web", "nginx:1.27", {});
const NO_PASSWORD = service("nopass", "postgres:16", { POSTGRES_USER: "postgres" });
// A client app CapRover built that only reads a database password: the probe finds nothing listening on it.
const WEB_CLIENT = service("web1", "img-captain-web1:3", { POSTGRES_PASSWORD: "client-secret" });

/** A valid export written at the current clock, listing POSTGRES unless told otherwise. */
function exportFile(overrides: Partial<DiscoveryExport> = {}): string {
  const generatedAt = overrides.generatedAt !== undefined ? overrides.generatedAt : iso(clock);
  const body: DiscoveryExport = {
    version: 1,
    platform: "caprover",
    generatedAt,
    checkedAt: iso(clock),
    status: { ok: true },
    network: { name: "captain-overlay-network", id: "jolhlap6b0rctoqh21rk8sidt" },
    services: generatedAt === null ? [] : [POSTGRES],
    excluded: [],
    ...overrides,
  };
  return JSON.stringify(body);
}

function write(content: string): void {
  writeFileSync(file, content);
}

function deps(extra: DiscoveryDeps = {}): DiscoveryDeps {
  return { now: () => clock, probe, fileSeedIds: async () => new Set<string>(), ...extra };
}

async function statusNow(extra: DiscoveryDeps = {}): Promise<DiscoveryStatus> {
  const status = await getDiscoveryStatus(deps(extra));
  if (status === null) throw new Error("discovery is off");
  return status;
}

function countingRead(): { reads: string[]; readFile: (target: string) => Promise<string> } {
  const reads: string[] = [];
  return {
    reads,
    readFile: (target) => {
      reads.push(target);
      return readFile(target, "utf8");
    },
  };
}

describe("discovery-loader", () => {
  beforeEach(() => {
    resetDiscoveryCache();
    resetCache();
    for (const logger of [debug, info, warn, error]) logger.mockClear();
    probe.mockClear();
    probeAnswer = true;
    clock = T0;
    dir = mkdtempSync(path.join(tmpdir(), "discovery-loader-"));
    file = path.join(dir, "services.json");
    process.env.SEED_DISCOVERY_PATH = file;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SEED_DISCOVERY_PATH;
    delete process.env.SEED_DISCOVERY_MAX_AGE_MS;
    delete process.env.SEED_CACHE_TTL_MS;
    delete process.env.SEED_CONFIG_PATH;
  });

  describe("the off switch", () => {
    it.each([[undefined], [""], ["   "]])("is off when SEED_DISCOVERY_PATH is %p", async (value) => {
      if (value === undefined) delete process.env.SEED_DISCOVERY_PATH;
      else process.env.SEED_DISCOVERY_PATH = value;
      const { reads, readFile: read } = countingRead();

      expect(isDiscoveryEnabled()).toBe(false);
      expect(await getDiscoveryStatus(deps({ readFile: read }))).toBeNull();
      expect(await getDiscoveredConnections(deps({ readFile: read }))).toEqual([]);
      expect(reads).toEqual([]);
    });

    it("is on when SEED_DISCOVERY_PATH names a file", () => {
      expect(isDiscoveryEnabled()).toBe(true);
    });
  });

  describe("state table (spec section 9.2)", () => {
    it("waits while the export file is missing", async () => {
      expect(await statusNow()).toEqual({
        platform: "caprover",
        state: "waiting",
        message: WAITING,
        generatedAt: null,
        checkedAt: null,
        error: null,
        connected: [],
        skipped: [],
      });
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it.each([
      [
        "unparsable JSON with a secret in it",
        () => '{"version":1,"services":[{"env":{"POSTGRES_PASSWORD":"file-secret"',
      ],
      ["a schema-invalid document", () => JSON.stringify({ version: 2, platform: "caprover" })],
    ])("refuses %s as invalid_export without quoting it", async (_label, content) => {
      write(content());

      const status = await statusNow();

      expect(status.state).toBe("error");
      expect(status.error?.code).toBe("invalid_export");
      expect(status.message).toContain("The export file is not a valid discovery export: ");
      expect(JSON.stringify(status)).not.toContain("file-secret");
      expect(status.connected).toEqual([]);
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it("refuses an export file over 2 MiB as invalid_export by its size, without reading or quoting it", async () => {
      const content = " ".repeat(2 * 1024 * 1024) + exportFile();
      write(content);
      const message = "The export file is over the 2097152-byte limit, so it was not read";

      const status = await statusNow();

      expect(status.state).toBe("error");
      expect(status.message).toBe(message);
      expect(status.error).toEqual({ code: "invalid_export", message });
      expect(JSON.stringify(status)).not.toContain("pg-secret");
      expect(status.connected).toEqual([]);
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it("refuses an unreadable export path as invalid_export", async () => {
      mkdirSync(file);

      const status = await statusNow();

      expect(status.state).toBe("error");
      expect(status.error?.code).toBe("invalid_export");
      expect(status.message).toBe("The export file could not be read (not a regular file)");
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it("names no error code when the read failure carries none", async () => {
      const status = await statusNow({ readFile: () => Promise.reject(new Error("boom")) });

      expect(status.error).toEqual({
        code: "invalid_export",
        message: "The export file could not be read (unknown error)",
      });
    });

    it("reports the exporter's error before its first successful scan", async () => {
      write(
        exportFile({
          generatedAt: null,
          status: { ok: false, code: "socket_unavailable", message: "connect ENOENT /var/run/docker.sock" },
        }),
      );

      expect(await statusNow()).toEqual({
        platform: "caprover",
        state: "error",
        message: "connect ENOENT /var/run/docker.sock",
        generatedAt: null,
        checkedAt: iso(T0),
        error: { code: "socket_unavailable", message: "connect ENOENT /var/run/docker.sock" },
        connected: [],
        skipped: [],
      });
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it("withdraws the connections of an export older than SEED_DISCOVERY_MAX_AGE_MS", async () => {
      write(exportFile({ generatedAt: iso(T0 - MAX_AGE_MS - 1) }));

      const status = await statusNow();

      expect(status.state).toBe("stale");
      expect(status.message).toBe(
        "The last successful scan is older than SEED_DISCOVERY_MAX_AGE_MS (60000 ms), so its connections are withdrawn",
      );
      expect(status.error).toBeNull();
      expect(status.connected).toEqual([]);
      expect(status.generatedAt).toBe(iso(T0 - MAX_AGE_MS - 1));
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it("keeps the exporter's error on a stale export", async () => {
      write(
        exportFile({
          generatedAt: iso(T0 - MAX_AGE_MS - 1),
          status: {
            ok: false,
            code: "swarm_unavailable",
            httpStatus: 503,
            message: "This node is not a swarm manager.",
          },
        }),
      );

      const status = await statusNow();

      expect(status.state).toBe("stale");
      expect(status.error).toEqual({ code: "swarm_unavailable", message: "This node is not a swarm manager." });
      expect(await getDiscoveredConnections(deps())).toEqual([]);
    });

    it("serves the last good scan while the exporter reports an error", async () => {
      write(
        exportFile({
          generatedAt: iso(T0 - 20_000),
          status: { ok: false, code: "docker_error", httpStatus: 500, message: "Docker answered 500" },
        }),
      );

      expect(await statusNow()).toEqual({
        platform: "caprover",
        state: "error",
        message: "Docker answered 500",
        generatedAt: iso(T0 - 20_000),
        checkedAt: iso(T0),
        error: { code: "docker_error", message: "Docker answered 500" },
        connected: [PG_CONNECTED],
        skipped: [],
      });
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-pgtest"]);
    });

    it("lists the databases of a fresh export", async () => {
      write(exportFile());

      expect(await statusNow()).toEqual({
        platform: "caprover",
        state: "ok",
        message: "The discovery app's last scan is current",
        generatedAt: iso(T0),
        checkedAt: iso(T0),
        error: null,
        connected: [PG_CONNECTED],
        skipped: [],
      });
      const [conn] = await getDiscoveredConnections(deps());
      expect(conn).toMatchObject({
        id: "caprover-pgtest",
        name: "pgtest (PostgreSQL)",
        type: "postgres",
        host: "srv-captain--pgtest",
        port: 5432,
        user: "postgres",
        password: "pg-secret",
        database: "appdb",
        group: "CapRover",
        ssl: { mode: "disable" },
        managed: true,
        roles: ["admin"],
      });
    });

    it("reports the apps listed in Apps to skip after the other skips, without repeating them on the next call", async () => {
      process.env.SEED_CACHE_TTL_MS = "600000";
      write(exportFile({ services: [NO_PASSWORD, POSTGRES], excluded: ["cache", "legacy"] }));
      const expected = [
        { appName: "nopass", reason: expect.any(String) },
        { appName: "cache", reason: EXCLUDED },
        { appName: "legacy", reason: EXCLUDED },
      ];

      const status = await statusNow();

      expect(status.state).toBe("ok");
      expect(status.connected).toEqual([PG_CONNECTED]);
      expect(status.skipped).toEqual(expected);
      expect((await statusNow()).skipped).toEqual(expected);
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-pgtest"]);
    });

    it("reports the apps listed in Apps to skip with the last good scan while the exporter reports an error", async () => {
      write(
        exportFile({
          generatedAt: iso(T0 - 20_000),
          status: { ok: false, code: "docker_error", httpStatus: 500, message: "Docker answered 500" },
          excluded: ["cache"],
        }),
      );

      const status = await statusNow();

      expect(status.state).toBe("error");
      expect(status.skipped).toEqual([{ appName: "cache", reason: EXCLUDED }]);
    });

    it("drops the Apps to skip entries once the export turns stale", async () => {
      process.env.SEED_CACHE_TTL_MS = "600000";
      write(exportFile({ excluded: ["cache"] }));

      expect((await statusNow()).skipped).toEqual([{ appName: "cache", reason: EXCLUDED }]);
      clock = T0 + MAX_AGE_MS + 1;
      const stale = await statusNow();

      expect(stale.state).toBe("stale");
      expect(stale.skipped).toEqual([]);
    });

    it("re-reads a cached export once it turns stale, then at most every 5 seconds while it stays stale", async () => {
      process.env.SEED_CACHE_TTL_MS = "600000";
      write(exportFile());
      const { reads, readFile: read } = countingRead();

      expect((await statusNow({ readFile: read })).state).toBe("ok");
      clock = T0 + MAX_AGE_MS;
      expect((await statusNow({ readFile: read })).state).toBe("ok");
      expect(reads).toHaveLength(1);

      clock = T0 + MAX_AGE_MS + 1;
      expect((await statusNow({ readFile: read })).state).toBe("stale");
      expect(await getDiscoveredConnections(deps({ readFile: read }))).toEqual([]);
      expect(reads).toHaveLength(2);

      clock = T0 + MAX_AGE_MS + 1 + 4_999;
      expect((await statusNow({ readFile: read })).state).toBe("stale");
      expect(reads).toHaveLength(2);

      clock = T0 + MAX_AGE_MS + 1 + 5_000;
      expect((await statusNow({ readFile: read })).state).toBe("stale");
      expect(reads).toHaveLength(3);
    });

    it("keeps a healthy exporter listed when its cached copy turns stale before SEED_CACHE_TTL_MS runs out", async () => {
      // SEED_CACHE_TTL_MS unset: its 60000 default equals the default max age, and the exporter rescans
      // every 10 seconds, so the copy Studio caches is already up to one scan interval old when it is read.
      write(exportFile({ generatedAt: iso(T0 - 9_000) }));
      expect((await statusNow()).state).toBe("ok");

      clock = T0 + 52_000;
      write(exportFile({ generatedAt: iso(T0 + 50_000) }));

      const status = await statusNow();
      expect(status.state).toBe("ok");
      expect(status.connected).toEqual([PG_CONNECTED]);
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-pgtest"]);
    });

    it("re-reads an export from before the first successful scan every 5 seconds, not once per SEED_CACHE_TTL_MS", async () => {
      write(
        exportFile({
          generatedAt: null,
          status: {
            ok: false,
            code: "swarm_unavailable",
            httpStatus: 503,
            message: "This node is not a swarm manager.",
          },
        }),
      );
      const { reads, readFile: read } = countingRead();
      expect((await statusNow({ readFile: read })).state).toBe("error");

      clock = T0 + 4_999;
      write(exportFile());
      expect((await statusNow({ readFile: read })).state).toBe("error");
      expect(reads).toHaveLength(1);

      clock = T0 + 5_000;
      expect((await statusNow({ readFile: read })).state).toBe("ok");
      expect(reads).toHaveLength(2);
    });

    it.each([
      ["5000", 5_000],
      ["junk", MAX_AGE_MS],
      ["0", MAX_AGE_MS],
      ["-1", MAX_AGE_MS],
    ])("reads SEED_DISCOVERY_MAX_AGE_MS=%p as %p ms", async (raw, expected) => {
      process.env.SEED_DISCOVERY_MAX_AGE_MS = raw;
      process.env.SEED_CACHE_TTL_MS = "600000";
      write(exportFile());

      clock = T0 + expected;
      expect((await statusNow()).state).toBe("ok");
      clock = T0 + expected + 1;
      expect((await statusNow()).state).toBe("stale");
    });
  });

  describe("review focus", () => {
    it("treats a truncated export as invalid_export with no connections, and recovers on the next valid file", async () => {
      write(exportFile().slice(0, 100));

      const broken = await statusNow();
      expect(broken.state).toBe("error");
      expect(broken.error?.code).toBe("invalid_export");
      expect(broken.connected).toEqual([]);
      expect(await getDiscoveredConnections(deps())).toEqual([]);

      clock = T0 + 60_000;
      write(exportFile());

      const recovered = await statusNow();
      expect(recovered.state).toBe("ok");
      expect(recovered.error).toBeNull();
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-pgtest"]);
    });

    it("counts a generatedAt ahead of Studio's clock as fresh, never stale and never an error", async () => {
      process.env.SEED_CACHE_TTL_MS = "600000";
      write(exportFile({ generatedAt: iso(T0 + 3_600_000) }));

      for (const at of [T0, T0 + MAX_AGE_MS + 1]) {
        clock = at;
        // oxlint-disable-next-line no-await-in-loop -- the clock moves between the calls, so each must settle first.
        const status = await statusNow();
        expect(status.state).toBe("ok");
        expect(status.error).toBeNull();
        expect(status.connected).toEqual([PG_CONNECTED]);
      }
    });
  });

  describe("placement hint", () => {
    it("turns the waiting message into a placement hint after twice SEED_DISCOVERY_MAX_AGE_MS", async () => {
      process.env.SEED_DISCOVERY_MAX_AGE_MS = "1000";
      process.env.SEED_CACHE_TTL_MS = "600000";
      const { reads, readFile: read } = countingRead();

      expect((await statusNow({ readFile: read })).message).toBe(WAITING);
      clock = T0 + 2_000;
      expect((await statusNow({ readFile: read })).message).toBe(WAITING);
      clock = T0 + 2_001;
      const hinted = await statusNow({ readFile: read });
      expect(hinted.state).toBe("waiting");
      expect(hinted.message).toBe(HINT);
      expect(reads).toHaveLength(1);
    });

    it("keeps the placement clock across re-reads and restarts it when the file appears and disappears", async () => {
      process.env.SEED_DISCOVERY_MAX_AGE_MS = "1000";
      process.env.SEED_CACHE_TTL_MS = "0";

      expect((await statusNow()).message).toBe(WAITING);
      clock = T0 + 1_000;
      expect((await statusNow()).message).toBe(WAITING);
      clock = T0 + 2_001;
      expect((await statusNow()).message).toBe(HINT);

      write(exportFile());
      expect((await statusNow()).state).toBe("ok");

      rmSync(file);
      clock = T0 + 2_002;
      expect((await statusNow()).message).toBe(WAITING);
      clock = T0 + 4_003;
      expect((await statusNow()).message).toBe(HINT);
    });
  });

  describe("cache", () => {
    it("re-reads the file only after SEED_CACHE_TTL_MS", async () => {
      process.env.SEED_CACHE_TTL_MS = "1000";
      write(exportFile());
      const { reads, readFile: read } = countingRead();

      expect(await getDiscoveredConnections(deps({ readFile: read }))).toHaveLength(1);
      write(exportFile({ services: [] }));
      clock = T0 + 999;
      expect(await getDiscoveredConnections(deps({ readFile: read }))).toHaveLength(1);
      clock = T0 + 1_000;
      expect(await getDiscoveredConnections(deps({ readFile: read }))).toEqual([]);
      expect(reads).toEqual([file, file]);
    });

    it("re-reads the file when Studio's clock steps back past the cached read", async () => {
      process.env.SEED_CACHE_TTL_MS = "1000";
      write(exportFile());
      const { reads, readFile: read } = countingRead();

      expect(await getDiscoveredConnections(deps({ readFile: read }))).toHaveLength(1);
      write(exportFile({ services: [] }));
      clock = T0 - 1_001;
      expect(await getDiscoveredConnections(deps({ readFile: read }))).toEqual([]);
      expect(reads).toEqual([file, file]);
    });

    it("resetDiscoveryCache forces the next call to re-read", async () => {
      write(exportFile());
      const { reads, readFile: read } = countingRead();

      await getDiscoveredConnections(deps({ readFile: read }));
      resetDiscoveryCache();
      await getDiscoveredConnections(deps({ readFile: read }));

      expect(reads).toHaveLength(2);
    });

    it("resetDiscoveryCache also clears the default probe's cache", () => {
      const reset = spyOn(defaultProbe, "reset");
      try {
        resetDiscoveryCache();

        expect(reset).toHaveBeenCalledTimes(1);
      } finally {
        reset.mockRestore();
      }
    });

    it("drops the result of a recompute that resetDiscoveryCache interrupted", async () => {
      write(exportFile());
      const reads: string[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slowRead = async (target: string): Promise<string> => {
        reads.push(target);
        await gate;
        return readFile(target, "utf8");
      };

      const first = getDiscoveredConnections(deps({ readFile: slowRead }));
      resetDiscoveryCache();
      release();

      expect(await first).toHaveLength(1);
      await getDiscoveredConnections(deps({ readFile: slowRead }));
      expect(reads).toHaveLength(2);
    });

    it("starts a new read for a caller after resetDiscoveryCache, and caches and logs only its result", async () => {
      const release: ((content: string) => void)[] = [];
      const gated = deps({
        readFile: () =>
          new Promise<string>((resolve) => {
            release.push(resolve);
          }),
      });

      const beforeReset = getDiscoveryStatus(gated);
      resetDiscoveryCache();
      const afterReset = getDiscoveryStatus(gated);
      // The caller after the reset started its own read instead of joining the pending one.
      expect(release).toHaveLength(2);

      // The read from before the reset settles first, with a file that would be logged as a source error.
      release[0]("not json");
      expect((await beforeReset)?.state).toBe("error");
      expect(warn).not.toHaveBeenCalled();
      // Nothing of it was cached either: a caller arriving now joins the recompute still pending.
      const joined = getDiscoveryStatus(gated);
      expect(release).toHaveLength(2);

      release[1](exportFile({ services: [NO_PASSWORD, POSTGRES] }));
      expect((await afterReset)?.state).toBe("ok");
      expect((await joined)?.state).toBe("ok");

      const { reads, readFile: read } = countingRead();
      const cached = await statusNow({ readFile: read });
      expect(reads).toEqual([]);
      expect(cached.state).toBe("ok");
      expect(cached.connected).toEqual([PG_CONNECTED]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Discovered service skipped", {
        route: ROUTE,
        appName: "nopass",
        reason: expect.any(String),
      });
    });

    it("shares one read and one probe per host between concurrent callers, also after expiry", async () => {
      write(exportFile({ services: [POSTGRES, MARIADB] }));
      const { reads, readFile: read } = countingRead();
      const shared = deps({ readFile: read });

      const [first, status, third] = await Promise.all([
        getDiscoveredConnections(shared),
        getDiscoveryStatus(shared),
        getDiscoveredConnections(shared),
      ]);

      expect(first.map((c) => c.id)).toEqual(["caprover-pgtest", "caprover-maria"]);
      expect(third).toEqual(first);
      expect(status?.state).toBe("ok");
      expect(reads).toHaveLength(1);
      expect(probe).toHaveBeenCalledTimes(1);

      clock = T0 + 60_000;
      write(exportFile({ services: [POSTGRES, MARIADB] }));
      await Promise.all([
        getDiscoveredConnections(shared),
        getDiscoveryStatus(shared),
        getDiscoveredConnections(shared),
      ]);

      expect(reads).toHaveLength(2);
      expect(probe).toHaveBeenCalledTimes(2);
    });
  });

  describe("candidates", () => {
    it("probes only environment-fallback candidates and keeps the export's order", async () => {
      write(exportFile({ services: [POSTGRES, MARIADB, WEB] }));

      const connections = await getDiscoveredConnections(deps());

      expect(connections.map((c) => c.id)).toEqual(["caprover-pgtest", "caprover-maria"]);
      expect(connections[1]).toMatchObject({
        name: "maria (MySQL-compatible)",
        type: "mysql",
        host: "srv-captain--maria",
        port: 3306,
      });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith("srv-captain--maria", 3306);
      // The nginx app is ignored, not counted as skipped.
      expect((await statusNow()).skipped).toEqual([]);
    });

    it("skips a fallback candidate that does not answer, and lists it once it does", async () => {
      probeAnswer = false;
      write(exportFile({ services: [POSTGRES, MARIADB] }));

      const status = await statusNow();
      expect(status.connected).toEqual([PG_CONNECTED]);
      expect(status.skipped).toEqual([{ appName: "maria", reason: "did not answer on port 3306" }]);

      probeAnswer = true;
      clock = T0 + 60_000;
      write(exportFile({ services: [POSTGRES, MARIADB] }));
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-pgtest", "caprover-maria"]);
    });

    it("skips a built client app that only reads POSTGRES_PASSWORD, because nothing answers on its port", async () => {
      probeAnswer = false;
      write(exportFile({ services: [POSTGRES, WEB_CLIENT] }));

      const status = await statusNow();

      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe).toHaveBeenCalledWith("srv-captain--web1", 5432);
      expect(status.connected).toEqual([PG_CONNECTED]);
      expect(status.skipped).toEqual([{ appName: "web1", reason: "did not answer on port 5432" }]);
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-pgtest"]);
    });

    it("keeps the first of two discovered services that map to the same id and skips the second", async () => {
      // A legacy service named srv-captain--foo and an app named foo both become caprover-foo.
      const prefixed = service("foo", "postgres:16", { POSTGRES_PASSWORD: "first-secret" });
      const bare: DiscoveredService = {
        ...service("foo", "postgres:16", { POSTGRES_PASSWORD: "second-secret" }),
        id: "svc-foo-bare",
        name: "foo",
        host: "foo",
      };
      write(exportFile({ services: [prefixed, bare] }));

      const status = await statusNow();
      const connections = await getDiscoveredConnections(deps());

      expect(connections.map((c) => [c.id, c.host, c.password])).toEqual([
        ["caprover-foo", "srv-captain--foo", "first-secret"],
      ]);
      expect(status.connected).toEqual([{ name: "foo (PostgreSQL)", type: "postgres" }]);
      expect(status.skipped).toEqual([{ appName: "foo", reason: "id taken by another discovered service" }]);
    });

    it("lists a database from an export the shared fixture wrote", async () => {
      const fixture: DiscoveryExportFixture = writeDiscoveryExport([postgresService("shared", "fixture-secret")]);
      try {
        process.env.SEED_DISCOVERY_PATH = fixture.path;

        // The fixture stamps the real time, so this call keeps the real clock.
        const connections = await getDiscoveredConnections({ probe, fileSeedIds: async () => new Set<string>() });

        expect(connections.map((c) => c.id)).toEqual(["caprover-shared"]);
        expect(connections[0]).toMatchObject({ host: "srv-captain--shared", password: "fixture-secret" });
      } finally {
        fixture.remove();
      }
    });

    it("lists a repository match without probing it, even while it does not answer", async () => {
      probeAnswer = false;
      write(exportFile({ services: [POSTGRES] }));

      expect(await getDiscoveredConnections(deps())).toHaveLength(1);
      expect(probe).not.toHaveBeenCalled();
    });

    it("skips a service whose mapping fails and keeps the others", async () => {
      write(exportFile({ services: [NO_PASSWORD, POSTGRES] }));

      const status = await statusNow();

      expect(status.connected).toEqual([PG_CONNECTED]);
      expect(status.skipped).toEqual([{ appName: "nopass", reason: expect.any(String) }]);
    });

    it("skips a discovered id the seed file already uses, without probing it", async () => {
      write(exportFile({ services: [POSTGRES, MARIADB] }));

      const status = await statusNow({ fileSeedIds: async () => new Set(["caprover-pgtest", "caprover-maria"]) });

      expect(status.connected).toEqual([]);
      expect(status.skipped).toEqual([
        { appName: "pgtest", reason: "id taken by the seed file" },
        { appName: "maria", reason: "id taken by the seed file" },
      ]);
      expect(probe).not.toHaveBeenCalled();
    });

    it("reads the taken ids from the seed file by default", async () => {
      const seedFile = path.join(dir, "seed-connections.yaml");
      writeFileSync(
        seedFile,
        [
          'version: "1"',
          "connections:",
          "  - id: caprover-pgtest",
          "    name: File seed",
          "    type: postgres",
          "    host: db.internal",
          "    roles: [admin]",
          "",
        ].join("\n"),
      );
      process.env.SEED_CONFIG_PATH = seedFile;
      write(exportFile());

      const status = await getDiscoveryStatus({ now: () => clock, probe });

      expect(status?.connected).toEqual([]);
      expect(status?.skipped).toEqual([{ appName: "pgtest", reason: "id taken by the seed file" }]);
    });

    it.each([
      [
        "a malformed seed file",
        () => {
          const seedFile = path.join(dir, "seed-connections.yaml");
          writeFileSync(seedFile, "version: [\n");
          return seedFile;
        },
      ],
      ["no seed file", () => path.join(dir, "absent.yaml")],
    ])("takes no id when there is %s", async (_label, seedPath) => {
      process.env.SEED_CONFIG_PATH = seedPath();
      write(exportFile());

      const connections = await getDiscoveredConnections({ now: () => clock, probe });

      expect(connections.map((c) => c.id)).toEqual(["caprover-pgtest"]);
    });

    it("probes through the default probe when none is injected", async () => {
      const check = spyOn(defaultProbe, "check").mockResolvedValue(true);
      try {
        write(exportFile({ services: [MARIADB] }));

        const connections = await getDiscoveredConnections({
          now: () => clock,
          fileSeedIds: async () => new Set<string>(),
        });

        expect(connections.map((c) => c.id)).toEqual(["caprover-maria"]);
        expect(check).toHaveBeenCalledWith("srv-captain--maria", 3306);
      } finally {
        check.mockRestore();
      }
    });

    it("does not probe the candidates of an export that is already stale when read", async () => {
      write(exportFile({ generatedAt: iso(T0 - MAX_AGE_MS - 1), services: [MARIADB] }));

      expect((await statusNow()).state).toBe("stale");
      expect(probe).not.toHaveBeenCalled();
    });

    it("puts no env value in the status", async () => {
      write(exportFile({ services: [POSTGRES, MARIADB, NO_PASSWORD] }));

      const text = JSON.stringify(await statusNow());

      expect(text).toContain("pgtest");
      expect(text).not.toContain("pg-secret");
      expect(text).not.toContain("maria-secret");
    });
  });

  describe("failure isolation", () => {
    it.each([
      [
        "an Error",
        () => Promise.reject(new TypeError("seed ids exploded")),
        "Discovery failed inside Studio (TypeError)",
      ],
      [
        "a non-Error value",
        () => Promise.reject("seed ids exploded"),
        "Discovery failed inside Studio (non-error value)",
      ],
      [
        "a synchronous throw",
        (): Promise<ReadonlySet<string>> => {
          throw new RangeError("seed ids exploded");
        },
        "Discovery failed inside Studio (RangeError)",
      ],
    ])("never throws when the seed-file ids fail with %s", async (_label, fileSeedIds, message) => {
      write(exportFile());

      const status = await statusNow({ fileSeedIds });

      expect(status.state).toBe("error");
      expect(status.error).toEqual({ code: "discovery_failed", message });
      expect(await getDiscoveredConnections(deps({ fileSeedIds }))).toEqual([]);
    });

    it("never throws when readFile throws synchronously", async () => {
      write(exportFile());
      const readFileThatThrows = (): Promise<string> => {
        throw new Error("read exploded");
      };

      const status = await statusNow({ readFile: readFileThatThrows });

      expect(status.state).toBe("error");
      expect(status.error).toEqual({
        code: "invalid_export",
        message: "The export file could not be read (unknown error)",
      });
      expect(await getDiscoveredConnections(deps({ readFile: readFileThatThrows }))).toEqual([]);
    });

    it.each([
      ["rejects", (): Promise<boolean> => Promise.reject(new Error("socket exploded"))],
      [
        "throws synchronously",
        (): Promise<boolean> => {
          throw new Error("socket exploded");
        },
      ],
    ])("never throws when the probe %s, and recovers on the next recompute", async (_label, failingProbe) => {
      write(exportFile({ services: [MARIADB] }));
      const failing = deps({ probe: failingProbe });

      expect(await getDiscoveredConnections(failing)).toEqual([]);
      expect((await getDiscoveryStatus(failing))?.error).toEqual({
        code: "discovery_failed",
        message: "Discovery failed inside Studio (Error)",
      });

      clock = T0 + 60_000;
      write(exportFile({ services: [MARIADB] }));
      expect((await getDiscoveredConnections(deps())).map((c) => c.id)).toEqual(["caprover-maria"]);
    });

    it("keeps the cache it stored when the logger throws, so only the callers of that recompute fail", async () => {
      write("not json");
      const { reads, readFile: read } = countingRead();
      warn.mockImplementationOnce(() => {
        throw new Error("logger exploded");
      });
      try {
        // Raised by the call that logged, never swallowed.
        await expect(getDiscoveryStatus(deps({ readFile: read }))).rejects.toThrow("logger exploded");

        const cached = await statusNow({ readFile: read });
        expect(cached.state).toBe("error");
        expect(cached.error?.code).toBe("invalid_export");
        expect(reads).toHaveLength(1);

        clock = T0 + 60_000;
        write(exportFile());
        expect((await statusNow({ readFile: read })).state).toBe("ok");
        expect(reads).toHaveLength(2);
      } finally {
        // beforeEach's mockClear keeps a queued implementation, so a failure above must not leave this one behind.
        warn.mockReset();
      }
    });
  });

  describe("logging", () => {
    it("logs a rejected export once until the problem changes", async () => {
      process.env.SEED_CACHE_TTL_MS = "0";
      write("not json");

      await getDiscoveryStatus(deps());
      await getDiscoveryStatus(deps());

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Discovery source error", {
        route: ROUTE,
        path: file,
        code: "invalid_export",
        reason: expect.stringContaining("The export file is not a valid discovery export: "),
      });

      rmSync(file);
      mkdirSync(file);
      await getDiscoveryStatus(deps());

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenLastCalledWith("Discovery source error", {
        route: ROUTE,
        path: file,
        code: "invalid_export",
        reason: expect.stringContaining("The export file could not be read ("),
      });
    });

    it("logs an oversized export once while it keeps growing", async () => {
      process.env.SEED_CACHE_TTL_MS = "0";
      const content = " ".repeat(2 * 1024 * 1024) + exportFile();
      write(content);

      await getDiscoveryStatus(deps());
      write(content + " ".repeat(1024));
      await getDiscoveryStatus(deps());

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Discovery source error", {
        route: ROUTE,
        path: file,
        code: "invalid_export",
        reason: "The export file is over the 2097152-byte limit, so it was not read",
      });
    });

    it("logs a discovery failure once, by error name only", async () => {
      process.env.SEED_CACHE_TTL_MS = "0";
      write(exportFile());
      const fileSeedIds = () => Promise.reject(new TypeError("ids near pg-secret"));

      await getDiscoveryStatus(deps({ fileSeedIds }));
      await getDiscoveryStatus(deps({ fileSeedIds }));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Discovery source error", {
        route: ROUTE,
        path: file,
        code: "discovery_failed",
        reason: "Discovery failed inside Studio (TypeError)",
      });
    });

    it("logs each skipped service once while it stays skipped", async () => {
      process.env.SEED_CACHE_TTL_MS = "0";
      probeAnswer = false;
      write(exportFile({ services: [MARIADB, NO_PASSWORD] }));

      await getDiscoveryStatus(deps());
      await getDiscoveryStatus(deps());

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith("Discovered service skipped", {
        route: ROUTE,
        appName: "maria",
        reason: "did not answer on port 3306",
      });
      expect(warn).toHaveBeenCalledWith("Discovered service skipped", {
        route: ROUTE,
        appName: "nopass",
        reason: expect.any(String),
      });
    });

    it("does not log the apps listed in Apps to skip", async () => {
      write(exportFile({ services: [NO_PASSWORD, POSTGRES], excluded: ["cache"] }));

      await getDiscoveryStatus(deps());

      // Control: the mapping failure is logged, so the excluded app's silence is not a logger that never ran.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("Discovered service skipped", {
        route: ROUTE,
        appName: "nopass",
        reason: expect.any(String),
      });
    });

    it("never writes an env value to a log line", async () => {
      process.env.SEED_CACHE_TTL_MS = "0";
      probeAnswer = false;
      write(exportFile({ services: [POSTGRES, MARIADB, NO_PASSWORD] }));
      await getDiscoveryStatus(deps({ fileSeedIds: async () => new Set(["caprover-pgtest"]) }));
      write('{"version":1,"services":[{"env":{"POSTGRES_PASSWORD":"file-secret"');
      await getDiscoveryStatus(deps());

      const captured = JSON.stringify([debug, info, warn, error].flatMap((logger) => logger.mock.calls));
      // Control: the skips and the rejected file were logged at all.
      expect(captured).toContain("maria");
      expect(captured).toContain("invalid_export");
      for (const secret of ["pg-secret", "maria-secret", "file-secret"]) {
        expect(captured).not.toContain(secret);
      }
    });
  });
});
