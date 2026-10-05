/**
 * Literal mode for seed values (SEED_LITERAL_VALUES).
 *
 * A seed file a platform writes from data its users control must not have its values resolved: a
 * database user named `${JWT_SECRET}` would be looked up in this process's environment and sent, as
 * that user name, to a server the platform user runs. With the mode on, every file seed skips
 * resolveAllCredentials and carries the literal marker from the role filter on, so nothing is
 * resolved when connections are listed (getManagedConnections), when a refused id is checked
 * (getSeedConnectionByIdUnfiltered, behind the 403) or when one is opened (resolveConnection, which
 * honours the marker and never calls resolveVaultCredentials). No plaintext-password warning is
 * logged, and one info line says so once per process. `true`, `1`, `on` and `yes`, trimmed and in
 * any case, turn it on; `false`, `0`, `off`, `no` and the empty string keep today's resolution
 * silently; any other value keeps it too and warns once per process, which the last two blocks pin
 * against the same file.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { Mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@/lib/logger";
import { getManagedConnections, resetCache } from "@/lib/seed";
import { resetLiteralModeNotices, resetPlaintextWarnings } from "@/lib/seed/credential-resolver";
import { resolveConnection, SeedConnectionError } from "@/lib/seed/resolve-connection";
import { SAMPLE_SEED_ID } from "@/lib/seed/libredb-sample";
import { SQLITE_SAMPLE_SEED_ID } from "@/lib/seed/sqlite-sample";
import type { ManagedConnection } from "@/lib/seed/types";
import { resetVaultCache } from "@/lib/seed/vault-client";

/** A seed file as a platform writes it: JSON, managed, a `${NAME}` user, a `${vault:...}` password and an admin-only `${JWT_SECRET}` user. */
const FIXTURE = path.resolve(import.meta.dir, "../../fixtures/seed-connections/literal-values-config.json");
const ENV_REFERENCE = "${LITERAL_MODE_PROBE}";
const SECRET_REFERENCE = "${JWT_SECRET}";
const VAULT_REFERENCE = "${vault:secret/data/platform/cache#password}";
const VAULT_URL = "http://127.0.0.1:8200/v1/secret/data/platform/cache";
const NOTICE =
  "Seed config read in literal mode (SEED_LITERAL_VALUES): no ${ENV} or ${vault:...} reference is resolved";
const PLAINTEXT_WARNING = "Seed connection has plaintext password, use ${ENV_VAR} syntax";
const USER = { role: "user", username: "user@libredb.org" };

const unrecognized = (raw: string): string =>
  `Unrecognized SEED_LITERAL_VALUES value "${raw}"; seed references stay resolved (use "true" to read every seed value as a literal)`;

/**
 * Every read of the named variables through `process.env` while `run` executes, with its result.
 *
 * The resolver looks a `${NAME}` up as `process.env[NAME]`. Comparing values shows that a variable's
 * value did not arrive; recording the reads shows that it was not looked up at all, which is what
 * literal mode promises for a name such as `JWT_SECRET`.
 */
async function envReadsDuring<T>(
  names: readonly string[],
  run: () => T | Promise<T>,
): Promise<{ result: T; reads: string[] }> {
  const reads: string[] = [];
  const realEnv = process.env;
  process.env = new Proxy(realEnv, {
    get(target, key, receiver) {
      if (typeof key === "string" && names.includes(key)) reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    return { result: await run(), reads };
  } finally {
    process.env = realEnv;
  }
}

describe("SEED_LITERAL_VALUES", () => {
  const realFetch = globalThis.fetch;
  let info: Mock<typeof logger.info>;
  let warn: Mock<typeof logger.warn>;
  let vaultCalls: string[];

  /** The literal-mode notices logged so far; `info` also carries the loader's own "Seed config loaded". */
  const notices = () => info.mock.calls.filter(([message]) => message === NOTICE);

  /** The seed file's connections by seed id, as the list path hands them to these roles. */
  const listed = async (roles: string[] = ["admin"]) =>
    new Map((await getManagedConnections(roles)).map((conn) => [conn.seedId, conn]));

  beforeEach(() => {
    resetCache();
    resetPlaintextWarnings();
    resetLiteralModeNotices();
    resetVaultCache();
    vaultCalls = [];
    process.env.SEED_CONFIG_PATH = FIXTURE;
    process.env.LITERAL_MODE_PROBE = "user-from-the-environment";
    // A sample path in a developer's `.env` would add a built-in sample to every list here.
    delete process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
    delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
    // A discovery export path there would add a discovered connection, marked literal, to every admin list
    // here, and log a warning whenever the export cannot be read.
    delete process.env.SEED_DISCOVERY_PATH;
    // Vault is configured and answers, so a request that should not happen would succeed and be counted.
    process.env.VAULT_ADDR = "http://127.0.0.1:8200";
    process.env.VAULT_TOKEN = "root";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      vaultCalls.push(String(input));
      return new Response(JSON.stringify({ data: { data: { password: "vault-secret" } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    info = spyOn(logger, "info").mockImplementation(() => {});
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
    globalThis.fetch = realFetch;
    delete process.env.SEED_LITERAL_VALUES;
    delete process.env.SEED_CONFIG_PATH;
    delete process.env.LITERAL_MODE_PROBE;
    delete process.env.VAULT_ADDR;
    delete process.env.VAULT_TOKEN;
    resetCache();
  });

  describe("on: every seed value is a literal", () => {
    it.each(["true", "TRUE", " 1 ", "on", "Yes\n"])(
      "lists a ${NAME} and a ${vault:...} value as written for %p, with no request to Vault",
      async (value) => {
        process.env.SEED_LITERAL_VALUES = value;

        const bySeedId = await listed();

        expect(bySeedId.get("orders")?.user).toBe(ENV_REFERENCE);
        expect(bySeedId.get("cache")?.password).toBe(VAULT_REFERENCE);
        expect(vaultCalls).toEqual([]);
      },
    );

    it("marks every file seed literal, and lists only the ones the role may see", async () => {
      process.env.SEED_LITERAL_VALUES = "true";

      const forUser = await getManagedConnections(["user"]);

      expect(forUser.map((conn) => [conn.seedId, conn.literal])).toEqual([
        ["orders", true],
        ["cache", true],
      ]);
    });

    it("leaves the built-in samples unmarked", async () => {
      process.env.SEED_LITERAL_VALUES = "true";
      // On unless set to "false"; deleted so a developer's `.env` cannot hide the samples this test needs.
      delete process.env.SQLITE_EMBEDDED_SAMPLE;
      delete process.env.LIBREDB_EMBEDDED_SAMPLE;
      const scratch = mkdtempSync(path.join(tmpdir(), "libredb-literal-sample-"));
      // getManagedConnections lists each sample when its file exists; their content is never read here.
      const sqliteSample = path.join(scratch, "sample-employees.db");
      const libredbSample = path.join(scratch, "sample.libredb");
      writeFileSync(sqliteSample, "");
      writeFileSync(libredbSample, "");
      process.env.SQLITE_EMBEDDED_SAMPLE_PATH = sqliteSample;
      process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = libredbSample;

      try {
        const bySeedId = await listed();

        expect(bySeedId.get("orders")?.literal).toBe(true);
        expect(bySeedId.has(SQLITE_SAMPLE_SEED_ID)).toBe(true);
        expect(bySeedId.get(SQLITE_SAMPLE_SEED_ID)?.literal).toBeUndefined();
        expect(bySeedId.has(SAMPLE_SEED_ID)).toBe(true);
        expect(bySeedId.get(SAMPLE_SEED_ID)?.literal).toBeUndefined();
      } finally {
        delete process.env.SQLITE_EMBEDDED_SAMPLE_PATH;
        delete process.env.LIBREDB_EMBEDDED_SAMPLE_PATH;
        rmSync(scratch, { recursive: true, force: true });
      }
    });

    it("opens the ${vault:...} value as written, and Vault is never asked", async () => {
      process.env.SEED_LITERAL_VALUES = "true";

      const opened = await resolveConnection({ connectionId: "seed:cache" }, USER);

      expect(opened.password).toBe(VAULT_REFERENCE);
      // The marker is on what resolveConnection received from the list, after the role filter.
      expect((opened as ManagedConnection).literal).toBe(true);
      expect(vaultCalls).toEqual([]);
    });

    it("opens the ${NAME} value as written, and the variable is never read", async () => {
      process.env.SEED_LITERAL_VALUES = "true";

      const { result: opened, reads } = await envReadsDuring(["LITERAL_MODE_PROBE"], () =>
        resolveConnection({ connectionId: "seed:orders" }, USER),
      );

      expect(opened.user).toBe(ENV_REFERENCE);
      expect(reads).toEqual([]);
    });

    it("never looks up JWT_SECRET when it lists or refuses the connection whose user names it", async () => {
      process.env.SEED_LITERAL_VALUES = "true";
      // Vacuity: tests/setup.ts sets the secret, so a resolution would have had a value to hand over.
      expect(process.env.JWT_SECRET).toBeTruthy();

      const { result, reads } = await envReadsDuring(["JWT_SECRET"], async () => ({
        bySeedId: await listed(),
        // A user may not open it, and the 403 is decided by looking the id up without the role filter.
        refusal: await resolveConnection({ connectionId: "seed:admin-only" }, USER).catch((thrown: unknown) => thrown),
      }));

      expect(result.bySeedId.get("admin-only")?.user).toBe(SECRET_REFERENCE);
      expect(result.refusal).toBeInstanceOf(SeedConnectionError);
      expect((result.refusal as SeedConnectionError).statusCode).toBe(403);
      expect(reads).toEqual([]);
    });

    it("lists a connection whose ${NAME} is unset, rather than skipping it", async () => {
      process.env.SEED_LITERAL_VALUES = "true";
      delete process.env.LITERAL_MODE_PROBE;

      const bySeedId = await listed();

      expect(bySeedId.get("orders")?.user).toBe(ENV_REFERENCE);
    });

    it("logs no plaintext-password warning for a literal password", async () => {
      process.env.SEED_LITERAL_VALUES = "true";

      const bySeedId = await listed();

      // Vacuity: the file holds a literal password, which the warning fires on outside literal mode.
      expect(bySeedId.get("orders")?.password).toBe("orders-pw");
      expect(warn).not.toHaveBeenCalled();
    });

    it("says once per process, at the first load, that the seed is read in literal mode", async () => {
      process.env.SEED_LITERAL_VALUES = "true";

      await listed();
      expect(notices()).toEqual([[NOTICE, { route: "seed/credential-resolver" }]]);

      await getManagedConnections(["user"]);
      await resolveConnection({ connectionId: "seed:cache" }, USER);
      resetCache();
      await listed();

      expect(notices()).toHaveLength(1);
    });
  });

  /**
   * Today's behaviour on the same file, with the values that mean off, unset included: `${NAME}` is
   * resolved on the list path, `${vault:...}` when the connection is opened, the literal password
   * draws its warning, and nothing is marked.
   */
  async function expectTodaysResolution(): Promise<void> {
    const bySeedId = await listed();

    expect(bySeedId.get("orders")?.user).toBe("user-from-the-environment");
    expect(bySeedId.get("cache")?.password).toBe(VAULT_REFERENCE);
    expect([...bySeedId.values()].map((conn) => conn.literal)).toEqual([undefined, undefined, undefined]);
    expect(vaultCalls).toEqual([]);

    const opened = await resolveConnection({ connectionId: "seed:cache" }, USER);

    expect(opened.password).toBe("vault-secret");
    expect(vaultCalls).toEqual([VAULT_URL]);
    expect(notices()).toEqual([]);
  }

  describe("off: today's resolution and warning", () => {
    it.each([undefined, "", "  ", "false", "0", "no", "OFF"])(
      "resolves the same file as it always has for %p, and warns about nothing else",
      async (value) => {
        if (value === undefined) delete process.env.SEED_LITERAL_VALUES;
        else process.env.SEED_LITERAL_VALUES = value;

        await expectTodaysResolution();

        expect(warn.mock.calls).toEqual([
          [PLAINTEXT_WARNING, { route: "seed/credential-resolver", connectionId: "orders" }],
        ]);
      },
    );

    it("reads JWT_SECRET for a user named after it, which is what the mode exists to stop", async () => {
      const { result, reads } = await envReadsDuring(["JWT_SECRET"], () => listed());

      expect(result.get("admin-only")?.user).toBe(process.env.JWT_SECRET);
      expect(reads).toEqual(["JWT_SECRET"]);
    });
  });

  describe("any other value: today's resolution, and one warning per process", () => {
    it.each(["literal", "y", "enabled"])(
      "resolves as when off for %p, and says once that the value was not recognized",
      async (value) => {
        process.env.SEED_LITERAL_VALUES = value;

        await expectTodaysResolution();
        resetCache();
        await listed();

        expect(warn.mock.calls).toEqual([
          [unrecognized(value), { route: "seed/credential-resolver" }],
          [PLAINTEXT_WARNING, { route: "seed/credential-resolver", connectionId: "orders" }],
        ]);
      },
    );
  });
});
