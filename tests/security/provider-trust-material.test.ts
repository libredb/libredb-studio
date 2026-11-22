/**
 * The operator's CA bundle reaches the providers whose TLS library does not read Node.js's trust store as data from
 * core, and no other provider (FND-2 slice 4).
 *
 * Node.js adds the certificates of the file `NODE_EXTRA_CA_CERTS` names to every TLS connection it opens without a `ca`
 * of its own, so a provider on Node's TLS needs nothing. Measured on 2026-11-22 for every provider that opens TLS, one
 * does not see them: Db2, whose driver verifies with rustls against the operating system's store. Core reads the file
 * once per process (`src/lib/db/trust-material.ts`), and `createDatabaseProvider` hands the material in the build
 * context to the engines whose `READS_TRUST_MATERIAL` row is true, never a caller's. This census builds every type-id
 * through the real factory, from `tests/helpers/census-connection.ts`, and finds the very material object the process
 * keeps inside the provider, by identity, exactly where the row is true; and the bundle's certificate text nowhere
 * else. Building connects nothing.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READS_TRUST_MATERIAL } from "@/lib/db/compatibility";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createDatabaseProvider } from "@/lib/db/factory";
import { trustMaterial } from "@/lib/db/trust-material";
import type { ProviderExecutionContext, TrustMaterial } from "@/lib/db/types";
import { logger } from "@/lib/logger";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../helpers/census-connection";
import { setExtraCaCerts } from "../helpers/extra-ca-certs";
import { markersReachableFrom, pathsToObject } from "../helpers/reachable-markers";

const TYPES = Object.keys(CENSUS_CONNECTION) as DatabaseType[];

/** A certificate block with a body made at run time, so the census can look for its text anywhere in a provider. */
const block = (): string =>
  ["-----BEGIN CERTIFICATE-----", `MIIB${crypto.randomUUID().replaceAll("-", "")}`, "-----END CERTIFICATE-----"].join(
    "\n",
  );

const original = process.env.NODE_EXTRA_CA_CERTS;
let dir: string;
let blocks: string[];
let file: string;
let info: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "libredb-trust-census-"));
  blocks = [block(), block()];
  file = join(dir, "ca-bundle.crt");
  writeFileSync(file, `${blocks[0]}\n${blocks[1]}\n`);
  setExtraCaCerts(file);
  info = spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  setExtraCaCerts(original);
  rmSync(dir, { recursive: true, force: true });
});

describe("the operator's CA bundle reaches only the providers whose TLS does not read Node's store (FND-2 slice 4)", () => {
  test("READS_TRUST_MATERIAL names db2 alone, the engine whose TLS the probe found outside Node's trust store", () => {
    expect(TYPES.filter((type) => READS_TRUST_MATERIAL[type])).toEqual(["db2"]);
    expect(Object.keys(READS_TRUST_MATERIAL).sort()).toEqual([...TYPES].sort());
    expect(Object.isFrozen(READS_TRUST_MATERIAL)).toBe(true);
  });

  test.each(TYPES)(
    "%s built by createDatabaseProvider holds core's trust material exactly when its READS_TRUST_MATERIAL row is true",
    async (type) => {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      const material = trustMaterial();
      expect(material.certificates).toEqual(blocks);
      expect(pathsToObject(provider, material).length > 0).toBe(READS_TRUST_MATERIAL[type]);
    },
  );

  test("no provider but db2 holds a certificate of the bundle anywhere in its object graph", async () => {
    const holders: string[] = [];
    for (const type of TYPES) {
      const provider = await createDatabaseProvider(CENSUS_CONNECTION[type]);
      if (markersReachableFrom(provider, blocks).length > 0) holders.push(type);
    }
    expect(holders).toEqual(["db2"]);
  });

  test("a caller's trust in the execution context never reaches a provider", async () => {
    /** As plain JavaScript or a value typed through a variable can pass it: the caller's type has no such field. */
    const callers: TrustMaterial = Object.freeze({ certificates: Object.freeze([block()]) });
    const context = { readOnly: false, trust: callers } as ProviderExecutionContext;

    const db2 = await createDatabaseProvider(CENSUS_CONNECTION.db2, {}, context);
    expect(pathsToObject(db2, trustMaterial())).not.toEqual([]);
    expect(pathsToObject(db2, callers)).toEqual([]);
    expect(markersReachableFrom(db2, callers.certificates)).toEqual([]);

    // MQTT keeps its whole build context, so a copied caller's field would sit there.
    const mqtt = await createDatabaseProvider(CENSUS_CONNECTION.mqtt, {}, context);
    expect(pathsToObject(mqtt, trustMaterial())).toEqual([]);
    expect(pathsToObject(mqtt, callers)).toEqual([]);
  });

  test("an invalid bundle refuses a Db2 build by name before anything is built, and a PostgreSQL build goes on as before", async () => {
    setExtraCaCerts(join(dir, "absent.crt"));
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const failure = await createDatabaseProvider(CENSUS_CONNECTION.db2).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DatabaseConfigError);
      expect((failure as Error).message).toBe("Invalid NODE_EXTRA_CA_CERTS: the file cannot be read (ENOENT)");
      expect(log.mock.calls.flat().join("\n")).not.toContain("[DB] Creating");

      const postgres = await createDatabaseProvider(CENSUS_CONNECTION.postgres);
      expect(postgres).toBeDefined();
      expect(log.mock.calls.flat().join("\n")).toContain("[DB] Creating postgres provider");
    } finally {
      log.mockRestore();
    }
  });

  test("the bundle is read once: a later Db2 build holds the same material", async () => {
    const first = await createDatabaseProvider(CENSUS_CONNECTION.db2);
    const material = trustMaterial();
    // A direct write, not the helper: the file changes and the variable does not.
    writeFileSync(file, `${block()}\n`);
    const second = await createDatabaseProvider(CENSUS_CONNECTION.db2);
    expect(pathsToObject(first, material)).not.toEqual([]);
    expect(pathsToObject(second, material)).not.toEqual([]);
    expect(trustMaterial()).toBe(material);
    expect(markersReachableFrom(second, blocks)).not.toEqual([]);
  });
});
