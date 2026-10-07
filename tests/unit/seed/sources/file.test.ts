import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import {
  createFileSource,
  DEFAULT_SEED_CONFIG_PATH,
  resetFileSourceState,
  seedConfigPath,
} from "@/lib/seed/sources/file";
import { OperatorSourceError } from "@/lib/seed/sources/types";

const FIXTURES = path.resolve(__dirname, "../../../fixtures/seed-connections");
const NOT_FOUND = "Seed config file not found, seed connections disabled";
const LOADED = "Seed config loaded";

const source = createFileSource();
const load = (literalValues = false) => source.load({ literalValues });
const callsOf = (logger: typeof warn, message: string): unknown[][] =>
  (logger.mock.calls as unknown[][]).filter((call) => call[0] === message);

async function sourceErrorOf(run: () => Promise<unknown>): Promise<OperatorSourceError> {
  const thrown = await run().then(
    () => new Error("expected an OperatorSourceError, and the load succeeded"),
    (err: unknown) => err,
  );
  if (thrown instanceof OperatorSourceError) return thrown;
  throw thrown;
}

describe("the SEED_CONFIG_PATH source", () => {
  beforeEach(() => {
    delete process.env.SEED_CONFIG_PATH;
    resetFileSourceState();
    for (const logger of [debug, info, warn, error]) logger.mockClear();
  });

  afterEach(() => {
    delete process.env.SEED_CONFIG_PATH;
  });

  it("is named after its variable", () => {
    expect(source.name).toBe("SEED_CONFIG_PATH");
  });

  describe("seedConfigPath", () => {
    it("is the default path, not explicit, when SEED_CONFIG_PATH is unset or empty", () => {
      expect(seedConfigPath()).toEqual({ path: DEFAULT_SEED_CONFIG_PATH, explicit: false });
      process.env.SEED_CONFIG_PATH = "";
      expect(seedConfigPath()).toEqual({ path: DEFAULT_SEED_CONFIG_PATH, explicit: false });
    });

    it("is the variable's value, explicit, when it is set", () => {
      process.env.SEED_CONFIG_PATH = "/srv/seed.yaml";
      expect(seedConfigPath()).toEqual({ path: "/srv/seed.yaml", explicit: true });
    });

    it("defaults to the chart's mount path", () => {
      expect(DEFAULT_SEED_CONFIG_PATH).toBe("/app/config/seed-connections.yaml");
    });
  });

  it("loads a YAML file as entries with the file's defaults merged and the path as origin", async () => {
    const file = path.join(FIXTURES, "valid-config.yaml");
    process.env.SEED_CONFIG_PATH = file;

    const result = await load();

    expect(result.status).toEqual({ state: "ok" });
    expect(result.skips).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.entries.map((entry) => entry.connection.id)).toEqual([
      "test-postgres",
      "test-mysql",
      "test-mongo",
      "test-redis",
    ]);
    expect(result.entries.every((entry) => entry.origin === file && entry.literal === false)).toBe(true);
    // test-redis sets no environment of its own: it comes from defaults.environment.
    expect(result.entries[3]?.connection.environment).toBe("production");
    // Unresolved: the loader resolves, not the source.
    expect(result.entries[0]?.connection.password).toBe("${TEST_PG_PASSWORD}");
    expect(callsOf(info, LOADED)).toEqual([[LOADED, { route: "seed/sources/file", connectionCount: 4 }]]);
  });

  it("reads a .json path as JSON", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.json");

    expect((await load()).entries.map((entry) => entry.connection.id)).toEqual(["test-postgres"]);
  });

  it("loads a minimal config with only the required fields", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "minimal-config.yaml");

    expect((await load()).entries.map((entry) => entry.connection.id)).toEqual(["minimal-pg"]);
  });

  it("marks every entry literal when the fill reads literal mode", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");

    const result = await load(true);

    expect(result.entries.map((entry) => entry.literal)).toEqual([true, true, true, true]);
    expect(result.entries[0]?.connection.password).toBe("${TEST_PG_PASSWORD}");
  });

  it("keeps no cache of its own: every load reads the file again", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "valid-config.yaml");

    const first = await load();
    const second = await load();

    expect(second.entries).not.toBe(first.entries);
    expect(callsOf(info, LOADED)).toHaveLength(2);
  });

  it("reports an explicit path that does not exist as missing", async () => {
    process.env.SEED_CONFIG_PATH = "/nonexistent/path/config.yaml";

    expect(await load()).toEqual({ entries: [], skips: [], notes: [], status: { state: "missing" } });
  });

  it("reports the absent default file as empty, unset or empty alike", async () => {
    expect((await load()).status).toEqual({ state: "empty" });
    process.env.SEED_CONFIG_PATH = "";
    expect((await load()).status).toEqual({ state: "empty" });
    expect(callsOf(warn, NOT_FOUND)).toEqual([
      [NOT_FOUND, { route: "seed/sources/file", path: DEFAULT_SEED_CONFIG_PATH }],
    ]);
  });

  it("refuses a config the schema refuses, naming the file", async () => {
    const file = path.join(FIXTURES, "invalid-config.yaml");
    process.env.SEED_CONFIG_PATH = file;

    const error = await sourceErrorOf(() => load());

    expect(error.code).toBe("invalid");
    expect(error.message.startsWith(`Invalid seed config at ${file}: `)).toBe(true);
  });

  it("refuses malformed JSON with the parse message", async () => {
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "malformed-config.json");

    const error = await sourceErrorOf(() => load());

    expect(error.code).toBe("unparseable");
    expect(error.message).toMatch(/^Failed to parse seed config at /);
  });

  it("says where a YAML file fails to parse without quoting the file", async () => {
    const file = path.join(FIXTURES, "malformed-secret-config.yaml");
    process.env.SEED_CONFIG_PATH = file;

    const error = await sourceErrorOf(() => load());

    expect(error.message).toBe(`Failed to parse seed config at ${file}: BAD_SCALAR_START at line 8, column 15`);
    expect((error.cause as Error).message).toContain("CanaryPlaintextPassword");
  });

  it("says a YAML file fails to load without quoting an alias it names", async () => {
    const file = path.join(FIXTURES, "malformed-alias-config.yaml");
    process.env.SEED_CONFIG_PATH = file;

    const error = await sourceErrorOf(() => load());

    expect(error.message).toBe(`Failed to parse seed config at ${file}: the file is not valid YAML`);
    expect((error.cause as Error).message).toContain("CanaryAliasPassword");
  });

  it("says a JSON file fails to parse without quoting the file", async () => {
    const file = path.join(FIXTURES, "malformed-secret-config.json");
    process.env.SEED_CONFIG_PATH = file;

    const error = await sourceErrorOf(() => load());

    expect(error.message).toBe(`Failed to parse seed config at ${file}: the file is not valid JSON`);
    expect((error.cause as Error).message).toContain("CanaryPlaintextPassword");
  });

  it("refuses a read error other than a missing file as unreadable, keeping the cause", async () => {
    // Reading a directory fails with EISDIR, which must not pass for a missing file.
    process.env.SEED_CONFIG_PATH = FIXTURES;

    const error = await sourceErrorOf(() => load());

    expect(error.code).toBe("unreadable");
    expect(error.message).toBe(`Cannot read seed config at ${FIXTURES}: EISDIR`);
    expect((error.cause as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  describe("missing file warning", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "seed-file-source-missing-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("logs a missing file once however often it is read", async () => {
      const file = path.join(dir, "seed-connections.yaml");
      process.env.SEED_CONFIG_PATH = file;

      await load();
      await load();
      await load();

      expect(callsOf(warn, NOT_FOUND)).toEqual([[NOT_FOUND, { route: "seed/sources/file", path: file }]]);
    });

    it("logs each missing path once", async () => {
      const first = path.join(dir, "first.yaml");
      const second = path.join(dir, "second.yaml");

      for (const file of [first, second, first, second]) {
        process.env.SEED_CONFIG_PATH = file;
        // oxlint-disable-next-line no-await-in-loop -- the reads are the sequence under test.
        await load();
      }

      expect(callsOf(warn, NOT_FOUND).map((call) => (call[1] as { path: string }).path)).toEqual([first, second]);
    });

    it("logs again after the file appears and disappears", async () => {
      const file = path.join(dir, "seed-connections.yaml");
      process.env.SEED_CONFIG_PATH = file;

      expect((await load()).status).toEqual({ state: "missing" });
      expect(callsOf(warn, NOT_FOUND)).toHaveLength(1);

      copyFileSync(path.join(FIXTURES, "valid-config.yaml"), file);
      expect((await load()).status).toEqual({ state: "ok" });
      expect(callsOf(warn, NOT_FOUND)).toHaveLength(1);

      unlinkSync(file);
      await load();
      await load();
      expect(callsOf(warn, NOT_FOUND)).toHaveLength(2);
    });

    it("logs again after resetFileSourceState", async () => {
      process.env.SEED_CONFIG_PATH = path.join(dir, "seed-connections.yaml");

      await load();
      resetFileSourceState();
      await load();

      expect(callsOf(warn, NOT_FOUND)).toHaveLength(2);
    });
  });
});
