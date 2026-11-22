/**
 * STORAGE_ENCRYPTION_RESEAL at boot (docs/STORAGE.md, "Re-sealing the store"): read once by register(), it re-seals
 * the server store after a complete backup and retires version 1, or refuses the boot by name. Run against a real
 * SQLite store through the storage factory, with process.exit and console.error stubbed as the other boot checks'
 * tests do.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { logger } from "@/lib/logger";
import { resetStorageEncryptionKey } from "@/lib/storage/encryption";
import { VERSION_TWO_NOT_RECORDED } from "@/lib/storage/envelope-settings";
import { closeStorageProvider, getStorageProvider } from "@/lib/storage/factory";
import { SQLiteStorageProvider } from "@/lib/storage/providers/sqlite";
import { resealStoreAtBoot, UNOPENED_ADVICE } from "@/lib/storage/reseal-at-boot";
import { sealVersionOne } from "../../../helpers/storage-envelope-v1";

/** Logged when STORAGE_ENCRYPTION_RESEAL is set and the store records the re-seal already. */
const ALREADY_RETIRED_LINE =
  "STORAGE_ENCRYPTION_RESEAL: this store retired version 1 already, so no stored credential was read or re-sealed and nothing was backed up.";
/** Logged after every start with STORAGE_ENCRYPTION_RESEAL set that the store passed. */
const REMOVE_RESEAL_LINE =
  "STORAGE_ENCRYPTION_RESEAL: remove it now, and start with STORAGE_ENCRYPTION_REQUIRE_V2=true from now on; while STORAGE_ENCRYPTION_RESEAL is set without STORAGE_ENCRYPTION_REQUIRE_V2, every start that finds no credential_envelope row re-seals the store as it is then.";

const ENV_KEYS = [
  "STORAGE_ENCRYPTION_RESEAL",
  "STORAGE_ENCRYPTION_REQUIRE_V2",
  "STORAGE_PROVIDER",
  "STORAGE_SQLITE_PATH",
  "JWT_SECRET",
] as const;

describe("resealStoreAtBoot", () => {
  const saved: Record<string, string | undefined> = {};
  let dir = "";
  let path = "";

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    dir = mkdtempSync(join(tmpdir(), "libredb-reseal-at-boot-"));
    path = join(dir, "store.db");
    delete process.env.STORAGE_ENCRYPTION_RESEAL;
    delete process.env.STORAGE_ENCRYPTION_REQUIRE_V2;
    process.env.STORAGE_PROVIDER = "sqlite";
    process.env.STORAGE_SQLITE_PATH = path;
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();
  });

  afterEach(async () => {
    await closeStorageProvider();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetStorageEncryptionKey();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the boot step with process.exit, console.error and logger.warn recorded. */
  async function run(): Promise<{
    result: boolean;
    exits: Array<number | undefined>;
    banner: string;
    warned: string[];
  }> {
    const originalExit = process.exit;
    const exits: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exits.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await resealStoreAtBoot();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      return {
        result,
        exits,
        banner: errorSpy.mock.calls.flat().join("\n"),
        warned: warn.mock.calls.map((call) => String(call[0])),
      };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
      warn.mockRestore();
    }
  }

  /** Writes a store the previous version left: one user's connection with a version 1 password. */
  function previousVersionStore(): void {
    const db = new Database(path);
    try {
      db.exec(
        "CREATE TABLE user_storage (user_id TEXT, collection TEXT, data TEXT, updated_at TEXT, PRIMARY KEY (user_id, collection))",
      );
      const record = {
        id: "c1",
        name: "c1",
        type: "postgres",
        host: "db.internal",
        password: sealVersionOne(randomUUID()),
      };
      db.prepare("INSERT INTO user_storage VALUES ('alice', 'connections', ?, 't')").run(JSON.stringify([record]));
    } finally {
      db.close();
    }
  }

  test("does nothing while STORAGE_ENCRYPTION_RESEAL is unset, empty or off", async () => {
    for (const value of [undefined, "", "  ", "false", "0", "off", "OFF"]) {
      if (value === undefined) delete process.env.STORAGE_ENCRYPTION_RESEAL;
      else process.env.STORAGE_ENCRYPTION_RESEAL = value;

      // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
      const outcome = await run();

      expect({ value, ...outcome }).toEqual({ value, result: true, exits: [], banner: "", warned: [] });
    }
    // Nothing opened the store.
    expect(existsSync(path)).toBe(false);
  });

  test("accepts true, 1 and on in any letter case", async () => {
    for (const value of ["true", "1", "on", "TRUE", " On "]) {
      // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
      await closeStorageProvider();
      process.env.STORAGE_ENCRYPTION_RESEAL = value;

      // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
      const { result, exits } = await run();

      expect({ value, result, exits }).toEqual({ value, result: true, exits: [] });
    }
  });

  test("refuses the boot by name on any other value", async () => {
    process.env.STORAGE_ENCRYPTION_RESEAL = 'yes"\n';

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain("STORAGE_ENCRYPTION_RESEAL is invalid");
    expect(banner).toContain('Got "yes\\"\\n"');
    expect(banner).toContain("true, on or 1");
    expect(banner).toContain("leave-unopened");
    expect(existsSync(path)).toBe(false);
  });

  test("refuses the boot when STORAGE_PROVIDER is local", async () => {
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    delete process.env.STORAGE_PROVIDER;

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain("STORAGE_ENCRYPTION_RESEAL is set, but STORAGE_PROVIDER is local");
  });

  test("re-seals and logs the backup, the counts and the reminder to remove the variable", async () => {
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";

    const { result, exits, warned } = await run();

    expect(result).toBe(true);
    expect(exits).toEqual([]);
    const backup = readdirSync(dir).find((name) => name.startsWith("store.db.pre-reseal-"));
    expect(backup).toMatch(/^store\.db\.pre-reseal-\d{8}T\d{6}Z$/);
    const lines = warned.filter((line) => line.startsWith("STORAGE_ENCRYPTION_RESEAL"));
    expect(lines).toEqual([
      `STORAGE_ENCRYPTION_RESEAL: backed up the store to ${join(dir, backup!)}, re-sealed 1 value(s) and kept 0 already sealed for their place; version 1 is retired.`,
      REMOVE_RESEAL_LINE,
    ]);
    const db = new Database(path);
    try {
      const row = db.prepare("SELECT data FROM user_storage").get() as { data: string };
      expect(JSON.parse(row.data)[0].password).toStartWith("v2:");
      expect(db.prepare("SELECT value FROM storage_meta").get()).toEqual({ value: "v2" });
    } finally {
      db.close();
    }
  });

  test("names the values and rows it left as they were", async () => {
    previousVersionStore();
    const db = new Database(path);
    try {
      db.prepare("INSERT INTO user_storage VALUES ('bob', 'connections', '{not json', 't')").run();
      db.prepare("INSERT INTO user_storage VALUES ('carol', 'connections', ?, 't')").run(
        JSON.stringify([{ id: "c9", password: `v2:${randomUUID()}:${randomUUID()}`, apiKeyId: 7 }]),
      );
    } finally {
      db.close();
    }
    process.env.STORAGE_ENCRYPTION_RESEAL = "on";

    const { warned } = await run();

    // Only a malformed or v2 value can be left without leave-unopened, and retirement does not change those, so the
    // line carries no advice about version 1.
    expect(warned).toContain(
      "STORAGE_ENCRYPTION_RESEAL: left 1 value(s) as they were, because they open nowhere here: carol c9 password. They are malformed, or sealed as v2 for another place or under another key, which retiring version 1 does not change.",
    );
    expect(warned.filter((line) => line.includes(UNOPENED_ADVICE))).toEqual([]);
    expect(warned).toContain(
      "STORAGE_ENCRYPTION_RESEAL: left 1 value(s) as they were, because they are not text or sit beside a value sealed as v2: carol c9 apiKeyId (not-text).",
    );
    expect(warned).toContain(
      "STORAGE_ENCRYPTION_RESEAL: left 1 row(s) or element(s) unread, because they are not connections or nest too deep to bind: bob connections.",
    );
  });

  test("refuses the boot naming the version 1 values the key in use does not open, and leaves the stored credentials and the envelope row as they were", async () => {
    previousVersionStore();
    const before = userStorageRows();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain("the credential re-seal did not complete");
    expect(banner).toContain("1 version 1 value(s) do not open under the key in use: alice c1 password");
    expect(banner).toContain("STORAGE_ENCRYPTION_RESEAL=leave-unopened");
    expect(markerOf()).toBeUndefined();
    expect(userStorageRows()).toEqual(before);
  });

  test("with leave-unopened, re-seals, retires version 1 and names the version 1 values it left", async () => {
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "Leave-Unopened";
    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();

    const { result, exits, warned } = await run();

    expect(result).toBe(true);
    expect(exits).toEqual([]);
    expect(warned).toContain(
      `STORAGE_ENCRYPTION_RESEAL: left 1 version 1 value(s) as they were, because they do not open under the key in use and STORAGE_ENCRYPTION_RESEAL is leave-unopened: alice c1 password. ${UNOPENED_ADVICE}`,
    );
    expect(warned.filter((line) => line.includes("open nowhere here"))).toEqual([]);
    expect(UNOPENED_ADVICE).toContain("a second re-seal finds nothing to do");
    expect(UNOPENED_ADVICE).toContain(
      "comes back only by stopping every server, restoring the key that sealed it, deleting the store's storage_meta row credential_envelope, starting once with STORAGE_ENCRYPTION_RESEAL set and STORAGE_ENCRYPTION_REQUIRE_V2 not set, and then setting STORAGE_ENCRYPTION_REQUIRE_V2 again, or from the backup above",
    );
    expect(markerOf()).toBe("v2");
  });

  test("says there was nothing to do on a retired store", async () => {
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    await run();
    await closeStorageProvider();
    const backups = readdirSync(dir).filter((name) => name.includes("pre-reseal"));

    const { result, warned } = await run();

    expect(result).toBe(true);
    expect(warned.filter((line) => line.startsWith("STORAGE_ENCRYPTION_RESEAL"))).toEqual([
      ALREADY_RETIRED_LINE,
      REMOVE_RESEAL_LINE,
    ]);
    expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual(backups);
  });

  test("refuses the boot with the failure, claiming no rollback it cannot know, when the re-seal does not complete", async () => {
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    process.env.STORAGE_SQLITE_PATH = ":memory:";

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain("LibreDB Studio cannot start: the credential re-seal did not complete");
    expect(banner).toContain("An in-memory SQLite store cannot be backed up");
    expect(banner).toContain("start again with STORAGE_ENCRYPTION_RESEAL still set");
    expect(banner).toContain("retired already or re-sealed now");
    // Opening the store creates the tables this version adds, so a failure before the transaction claims only that no
    // stored credential changed.
    expect(banner).toContain(
      "failure before it (opening the store, reading its state, the key, the backup) changed no stored credential.",
    );
    expect(banner).not.toContain("changed nothing");
    // The failing process cannot tell a failure before the transaction, a rollback and a commit whose answer was lost
    // apart, so the banner promises none of them.
    expect(banner).not.toContain("The store is as it was");
    expect(banner).not.toContain("version 1 is still accepted");
  });

  test("refuses the boot on a store whose envelope marker a newer version wrote, with the marker named", async () => {
    previousVersionStore();
    const db = new Database(path);
    try {
      db.exec("CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)");
      db.prepare("INSERT INTO storage_meta VALUES ('credential_envelope', 'v3', 't')").run();
    } finally {
      db.close();
    }
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain('credential_envelope is "v3"');
    expect(banner).toContain("refuses to open the store");
    expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual([]);
  });
  /** The store's credential_envelope row, or undefined; the file is opened read-only and closed again. */
  function markerOf(): string | undefined {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare("SELECT value FROM storage_meta WHERE key = 'credential_envelope'").get() as
        | { value: string }
        | undefined;
      return row?.value;
    } finally {
      db.close();
    }
  }

  test("refuses the boot by name on a STORAGE_ENCRYPTION_REQUIRE_V2 value it cannot read, before the store is opened", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "yes";

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain("STORAGE_ENCRYPTION_REQUIRE_V2 is invalid");
    expect(banner).toContain('Got "yes"');
    expect(banner).toContain("true, on or 1");
    expect(existsSync(path)).toBe(false);
  });

  test("refuses the boot when STORAGE_ENCRYPTION_REQUIRE_V2 is set and STORAGE_PROVIDER is local", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";
    delete process.env.STORAGE_PROVIDER;

    const { result, exits, banner } = await run();

    expect(result).toBe(false);
    expect(exits).toEqual([1]);
    expect(banner).toContain("STORAGE_ENCRYPTION_REQUIRE_V2 is set, but STORAGE_PROVIDER is local");
  });

  test("with STORAGE_ENCRYPTION_REQUIRE_V2 set, refuses the start by name on a store an earlier version wrote, reading or writing no stored credential and backing nothing up, whatever STORAGE_ENCRYPTION_RESEAL says", async () => {
    previousVersionStore();
    const before = userStorageRows();
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";

    for (const value of [undefined, "true", "leave-unopened"]) {
      // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
      await closeStorageProvider();
      if (value === undefined) delete process.env.STORAGE_ENCRYPTION_RESEAL;
      else process.env.STORAGE_ENCRYPTION_RESEAL = value;
      const reads = spyOnStoreReads();
      try {
        // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
        const { result, exits, banner } = await run();

        // rewriteStoredCredentials, getAllData, getCollection, listAccounts: none ran.
        expect({ value, reads: reads.calls() }).toEqual({ value, reads: [0, 0, 0, 0] });
        expect({ value, result, exits }).toEqual({ value, result: false, exits: [1] });
        expect(banner).toContain("the STORAGE_ENCRYPTION_REQUIRE_V2 check did not pass");
        expect(banner).toContain(VERSION_TWO_NOT_RECORDED);
      } finally {
        reads.restore();
      }
      expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual([]);
      expect(markerOf()).toBeUndefined();
      expect(userStorageRows()).toEqual(before);
    }
  });

  /** The user_storage rows of the store file, read on a connection of its own. */
  function userStorageRows(): unknown[] {
    const db = new Database(path, { readonly: true });
    try {
      return db.prepare("SELECT * FROM user_storage ORDER BY user_id, collection").all();
    } finally {
      db.close();
    }
  }

  /** Every table of the store file and its rows, read on a connection of its own. */
  function storeDump(): Record<string, unknown[]> {
    const db = new Database(path, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[];
      return Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]));
    } finally {
      db.close();
    }
  }

  /** The store methods that read or write credentials, counted on every SQLite store this process opens. */
  function spyOnStoreReads() {
    const spies = [
      spyOn(SQLiteStorageProvider.prototype, "rewriteStoredCredentials"),
      spyOn(SQLiteStorageProvider.prototype, "getAllData"),
      spyOn(SQLiteStorageProvider.prototype, "getCollection"),
      spyOn(SQLiteStorageProvider.prototype, "listAccounts"),
    ];
    return {
      calls: () => spies.map((spy) => spy.mock.calls.length),
      restore: () => {
        for (const spy of spies) spy.mockRestore();
      },
    };
  }

  test("with both set, refuses the start by name on a store that records no re-seal, reading or writing no stored credential and backing nothing up, whatever STORAGE_ENCRYPTION_RESEAL says", async () => {
    // A store re-sealed once whose credential_envelope row is gone since, so every table exists and only the row is
    // missing.
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    await run();
    await closeStorageProvider();
    const db = new Database(path);
    try {
      db.prepare("DELETE FROM storage_meta WHERE key = 'credential_envelope'").run();
      db.prepare("INSERT INTO user_storage VALUES ('bob', 'connections', ?, 't')").run(
        JSON.stringify([
          { id: "b1", name: "b1", type: "postgres", host: "b.internal", password: sealVersionOne(randomUUID()) },
        ]),
      );
    } finally {
      db.close();
    }
    const before = storeDump();
    const backups = readdirSync(dir).filter((name) => name.includes("pre-reseal"));

    for (const value of ["true", "leave-unopened"]) {
      // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
      await closeStorageProvider();
      process.env.STORAGE_ENCRYPTION_RESEAL = value;
      process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";
      const reads = spyOnStoreReads();
      try {
        // oxlint-disable-next-line no-await-in-loop -- each value boots on its own, one after another.
        const { result, exits, banner, warned } = await run();

        // rewriteStoredCredentials, getAllData, getCollection, listAccounts: none ran.
        expect({ value, reads: reads.calls() }).toEqual({ value, reads: [0, 0, 0, 0] });
        expect({ value, result, exits }).toEqual({ value, result: false, exits: [1] });
        expect(banner).toContain("the STORAGE_ENCRYPTION_REQUIRE_V2 check did not pass");
        expect(banner).toContain(VERSION_TWO_NOT_RECORDED);
        expect(warned.filter((line) => line.startsWith("STORAGE_ENCRYPTION_RESEAL"))).toEqual([]);
      } finally {
        reads.restore();
      }
      expect(storeDump()).toEqual(before);
      expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual(backups);
    }
  });

  test("with both set and the store retired, does nothing, and says so and to remove STORAGE_ENCRYPTION_RESEAL", async () => {
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    await run();
    await closeStorageProvider();
    const before = storeDump();
    const backups = readdirSync(dir).filter((name) => name.includes("pre-reseal"));
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";
    const reads = spyOnStoreReads();

    try {
      const { result, exits, warned } = await run();

      expect(result).toBe(true);
      expect(exits).toEqual([]);
      expect(warned.filter((line) => line.startsWith("STORAGE_ENCRYPTION_RESEAL"))).toEqual([
        ALREADY_RETIRED_LINE,
        REMOVE_RESEAL_LINE,
      ]);
      expect(reads.calls()).toEqual([0, 0, 0, 0]);
    } finally {
      reads.restore();
    }
    expect(storeDump()).toEqual(before);
    expect(readdirSync(dir).filter((name) => name.includes("pre-reseal"))).toEqual(backups);
  });

  test("the upgrade takes two starts: the re-seal without STORAGE_ENCRYPTION_REQUIRE_V2, then the requirement without the re-seal", async () => {
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";

    const first = await run();

    expect(first).toMatchObject({ result: true, exits: [] });
    expect(first.warned.some((line) => line.includes("re-sealed 1 value(s)"))).toBe(true);
    expect(first.warned).toContain(REMOVE_RESEAL_LINE);
    expect(markerOf()).toBe("v2");

    await closeStorageProvider();
    delete process.env.STORAGE_ENCRYPTION_RESEAL;
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";
    const second = await run();

    expect(second).toMatchObject({ result: true, exits: [], banner: "" });
    expect(second.warned.filter((line) => line.startsWith("STORAGE_ENCRYPTION_RESEAL"))).toEqual([]);
  });

  test("with STORAGE_ENCRYPTION_REQUIRE_V2 set, a store created from nothing starts, because initialize records the row as it creates the store", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";

    const { result, exits, banner } = await run();

    expect({ result, exits, banner }).toEqual({ result: true, exits: [], banner: "" });
    expect(markerOf()).toBe("v2");
  });

  test("with STORAGE_ENCRYPTION_REQUIRE_V2 set, refuses the start when the store does not read as retired at the check", async () => {
    previousVersionStore();
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    await run();
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";
    const provider = (await getStorageProvider())!;
    const state = spyOn(provider, "readEnvelopeState").mockImplementation(async () => "v1-accepted");

    try {
      const { result, exits, banner } = await run();

      expect(result).toBe(false);
      expect(exits).toEqual([1]);
      expect(banner).toContain(VERSION_TWO_NOT_RECORDED);
    } finally {
      state.mockRestore();
    }
  });
});
