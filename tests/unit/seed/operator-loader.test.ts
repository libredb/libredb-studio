import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const debug = mock(() => {});
const info = mock(() => {});
const warn = mock(() => {});
const error = mock(() => {});
mock.module("@/lib/logger", () => ({
  logger: { debug, info, warn, error },
}));

import { getOperatorSourceStatus, loadOperatorSources, resetCache } from "@/lib/seed/operator-loader";
import {
  resetLiteralModeNotices,
  resetPlaintextWarnings,
  UndefinedSeedVariableError,
} from "@/lib/seed/credential-resolver";
import { DEFAULT_SEED_CONFIG_PATH } from "@/lib/seed/sources/file";
import { OperatorSourceError } from "@/lib/seed/sources/types";

const FIXTURES = path.resolve(__dirname, "../../fixtures/seed-connections");
const LOADED = "Seed config loaded";
const SKIPPED = "Seed connection skipped due to credential resolution failure";
const NOT_FOUND = "Seed config file not found, seed connections disabled";
const PLAINTEXT_WARNING = "Seed connection has plaintext password, use ${ENV_VAR} syntax";
const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
const ENV_KEYS = [
  "SEED_CONFIG_PATH",
  "SEED_CACHE_TTL_MS",
  "SEED_LITERAL_VALUES",
  "GOOD_PASSWORD",
  "OPERATOR_LOADER_PASSWORD",
] as const;

const callsOf = (logger: typeof info, message: string): unknown[][] =>
  (logger.mock.calls as unknown[][]).filter((call) => call[0] === message);

const pg = (id: string, password: string) => ({
  id,
  name: `PG ${id}`,
  type: "postgres",
  host: `${id}.internal`,
  password,
  roles: ["admin"],
});

describe("operator-loader with the file source", () => {
  let dir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetCache();
    resetPlaintextWarnings();
    resetLiteralModeNotices();
    for (const logger of [debug, info, warn, error]) logger.mockClear();
    dir = mkdtempSync(path.join(tmpdir(), "libredb-operator-loader-"));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetCache();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSeed(connections: object[]): string {
    const file = path.join(dir, "seed-connections.json");
    writeFileSync(file, JSON.stringify({ version: "1", connections }));
    return file;
  }

  it("resolves the file's entries in the fill and serves them from the cache within SEED_CACHE_TTL_MS", async () => {
    process.env.OPERATOR_LOADER_PASSWORD = "resolved-password";
    process.env.SEED_CONFIG_PATH = writeSeed([pg("first", "${OPERATOR_LOADER_PASSWORD}")]);

    const first = await loadOperatorSources();
    const second = await loadOperatorSources();

    expect(second).toBe(first);
    expect(first.entries.map((entry) => entry.connection.password)).toEqual(["resolved-password"]);
    expect(callsOf(info, LOADED)).toHaveLength(1);
  });

  it("fills again once SEED_CACHE_TTL_MS has passed, and when the clock steps back", async () => {
    process.env.SEED_CONFIG_PATH = writeSeed([pg("first", "plain")]);
    let clock = T0;
    const now = spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const filled = await loadOperatorSources();
      clock = T0 + 59_999;
      expect(await loadOperatorSources()).toBe(filled);

      clock = T0 + 60_000;
      const refilled = await loadOperatorSources();
      expect(refilled).not.toBe(filled);

      // Behind the refill's own time: a clock that stepped back expires the cache.
      clock = T0 + 59_999;
      expect(await loadOperatorSources()).not.toBe(refilled);
      expect(callsOf(info, LOADED)).toHaveLength(3);
    } finally {
      now.mockRestore();
    }
  });

  it.each([[""], ["0"]])("fills on every call when SEED_CACHE_TTL_MS is %p", async (ttl) => {
    process.env.SEED_CACHE_TTL_MS = ttl;
    process.env.SEED_CONFIG_PATH = writeSeed([pg("first", "plain")]);

    const first = await loadOperatorSources();

    expect(await loadOperatorSources()).not.toBe(first);
    expect(callsOf(info, LOADED)).toHaveLength(2);
  });

  it("shares one fill, and one read, between concurrent callers", async () => {
    // A TTL of 0 rules the cache out: the second caller can only get the first one's load through the fill in flight.
    process.env.SEED_CACHE_TTL_MS = "0";
    process.env.SEED_CONFIG_PATH = writeSeed([pg("first", "plain")]);

    const [a, b] = await Promise.all([loadOperatorSources(), loadOperatorSources()]);

    expect(b).toBe(a);
    expect(callsOf(info, LOADED)).toHaveLength(1);
  });

  it("stores nothing from a fill that resetCache() superseded", async () => {
    process.env.SEED_CONFIG_PATH = writeSeed([pg("first", "plain")]);

    const superseded = loadOperatorSources();
    resetCache();
    const stale = await superseded;
    const fresh = await loadOperatorSources();

    expect(fresh).not.toBe(stale);
    expect(await loadOperatorSources()).toBe(fresh);
    expect(callsOf(info, LOADED)).toHaveLength(2);
  });

  it("fills again when the literal mode flips on a warm cache, and serves each fill while it holds", async () => {
    process.env.OPERATOR_LOADER_PASSWORD = "resolved-password";
    process.env.SEED_CONFIG_PATH = writeSeed([pg("first", "${OPERATOR_LOADER_PASSWORD}")]);
    const shape = (load: Awaited<ReturnType<typeof loadOperatorSources>>) =>
      load.entries.map((entry) => [entry.literal, entry.connection.password]);

    const resolved = await loadOperatorSources();
    process.env.SEED_LITERAL_VALUES = "true";
    const literal = await loadOperatorSources();
    expect(await loadOperatorSources()).toBe(literal);
    process.env.SEED_LITERAL_VALUES = "false";
    const again = await loadOperatorSources();

    expect(shape(resolved)).toEqual([[false, "resolved-password"]]);
    expect(shape(literal)).toEqual([[true, "${OPERATOR_LOADER_PASSWORD}"]]);
    expect(again).not.toBe(resolved);
    expect(shape(again)).toEqual([[false, "resolved-password"]]);
    expect(await loadOperatorSources()).toBe(again);
    expect(callsOf(info, LOADED)).toHaveLength(3);
  });

  it("drops an entry whose variable is undefined, records the skip, logs it, and keeps its id declared", async () => {
    process.env.GOOD_PASSWORD = "good-pass";
    const file = path.join(FIXTURES, "mixed-credentials.yaml");
    process.env.SEED_CONFIG_PATH = file;

    const load = await loadOperatorSources();

    const skip = {
      id: "missing-env",
      origin: file,
      reason: "Environment variable NONEXISTENT_VAR is not defined",
      variable: "NONEXISTENT_VAR",
      field: "password",
    };
    expect(load.entries.map((entry) => entry.connection.id)).toEqual(["env-var-creds", "plaintext-creds"]);
    expect(load.entries[0]?.connection.password).toBe("good-pass");
    expect(load.skips).toEqual([skip]);
    expect([...load.declaredIds]).toEqual(["env-var-creds", "plaintext-creds", "missing-env"]);
    expect(load.reports).toEqual([
      {
        source: "SEED_CONFIG_PATH",
        location: file,
        state: "ok",
        checkedAt: expect.any(String),
        error: null,
        connected: [
          { id: "env-var-creds", name: "Env Var Creds", type: "postgres" },
          { id: "plaintext-creds", name: "Plaintext Creds", type: "mysql" },
        ],
        skipped: [skip],
        notes: [],
      },
    ]);
    const logged = callsOf(error, SKIPPED);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[1]).toBeInstanceOf(UndefinedSeedVariableError);
    expect(logged[0]?.[2]).toEqual({ route: "seed/operator-loader", connectionId: "missing-env" });
    expect(JSON.stringify([debug, info, warn, error].flatMap((logger) => logger.mock.calls))).not.toContain(
      "good-pass",
    );
  });

  it("logs a skipped entry once per fill, not once per call", async () => {
    process.env.GOOD_PASSWORD = "good-pass";
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "mixed-credentials.yaml");

    await loadOperatorSources();
    await loadOperatorSources();
    expect(callsOf(error, SKIPPED)).toHaveLength(1);

    process.env.SEED_CACHE_TTL_MS = "0";
    await loadOperatorSources();
    expect(callsOf(error, SKIPPED)).toHaveLength(2);
  });

  it("passes literal entries through unresolved, with no skip and no plaintext warning", async () => {
    process.env.SEED_LITERAL_VALUES = "true";
    process.env.GOOD_PASSWORD = "good-pass";
    process.env.SEED_CONFIG_PATH = path.join(FIXTURES, "mixed-credentials.yaml");

    const load = await loadOperatorSources();

    expect(load.entries.map((entry) => [entry.connection.id, entry.literal, entry.connection.password])).toEqual([
      ["env-var-creds", true, "${GOOD_PASSWORD}"],
      ["plaintext-creds", true, "hardcoded_secret"],
      ["missing-env", true, "${NONEXISTENT_VAR}"],
    ]);
    expect(load.skips).toEqual([]);
    expect(callsOf(warn, PLAINTEXT_WARNING)).toEqual([]);
    expect(callsOf(error, SKIPPED)).toEqual([]);

    // Control: the same file with the mode off warns about its plaintext password.
    process.env.SEED_LITERAL_VALUES = "false";
    await loadOperatorSources();
    expect(callsOf(warn, PLAINTEXT_WARNING)).toEqual([
      [PLAINTEXT_WARNING, { route: "seed/credential-resolver", connectionId: "plaintext-creds" }],
    ]);
  });

  it("records the error status before it throws, never caches the failure, and the status read never throws", async () => {
    const file = path.join(dir, "seed-connections.yaml");
    copyFileSync(path.join(FIXTURES, "invalid-config.yaml"), file);
    process.env.SEED_CONFIG_PATH = file;
    const now = spyOn(Date, "now").mockImplementation(() => T0);
    try {
      const failure = await loadOperatorSources().catch((thrown: unknown) => thrown);
      expect(failure).toBeInstanceOf(OperatorSourceError);
      expect((failure as OperatorSourceError).code).toBe("invalid");
      expect((failure as Error).message.startsWith(`Invalid seed config at ${file}: `)).toBe(true);

      expect(await getOperatorSourceStatus()).toEqual([
        {
          source: "SEED_CONFIG_PATH",
          location: file,
          state: "error",
          checkedAt: new Date(T0).toISOString(),
          error: { code: "invalid", message: (failure as Error).message },
          connected: [],
          skipped: [],
          notes: [],
        },
      ]);

      // Not cached: with no reset and a warm TTL, the next call reads the file again.
      copyFileSync(path.join(FIXTURES, "minimal-config.yaml"), file);
      const load = await loadOperatorSources();
      expect(load.entries.map((entry) => entry.connection.id)).toEqual(["minimal-pg"]);
      expect((await getOperatorSourceStatus()).map((report) => report.state)).toEqual(["ok"]);
    } finally {
      now.mockRestore();
    }
  });

  it("reports an explicit path that does not exist as missing and the absent default file as empty", async () => {
    const absent = path.join(dir, "absent.yaml");
    process.env.SEED_CONFIG_PATH = absent;
    expect((await getOperatorSourceStatus()).map((report) => [report.location, report.state])).toEqual([
      [absent, "missing"],
    ]);

    delete process.env.SEED_CONFIG_PATH;
    resetCache();
    expect((await getOperatorSourceStatus()).map((report) => [report.location, report.state])).toEqual([
      [DEFAULT_SEED_CONFIG_PATH, "empty"],
    ]);
  });

  it("clears the source-level state on resetCache()", async () => {
    process.env.SEED_CONFIG_PATH = path.join(dir, "absent.yaml");
    process.env.SEED_CACHE_TTL_MS = "0";

    await loadOperatorSources();
    await loadOperatorSources();
    expect(callsOf(warn, NOT_FOUND)).toHaveLength(1);

    resetCache();
    await loadOperatorSources();
    expect(callsOf(warn, NOT_FOUND)).toHaveLength(2);
  });
});
