/**
 * The declared table of provider directories that serve more than one type-id (InfluxDB spec F1, R28 SR2 14).
 *
 * Two censuses read it: the container path shape census attributes a caller file to its type-id through it, and the
 * connection dialog's field census reads each type's own files through it. A table that missed a file would let a
 * new module's reads go to no type-id, and one that named a deleted file would read nothing, so both are held here
 * against the directory as it is on disk.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import path from "node:path";
import {
  PROVIDER_DIRECTORY_MAP,
  PROVIDERS_ROOT,
  providerDirectoryFiles,
  typeIdsOfProviderFile,
} from "../../helpers/provider-directory-map";

const INFLUX = path.join(PROVIDERS_ROOT, "timeseries/influxdb");

describe("PROVIDER_DIRECTORY_MAP", () => {
  for (const [directory, entry] of Object.entries(PROVIDER_DIRECTORY_MAP)) {
    const onDisk = readdirSync(path.join(PROVIDERS_ROOT, directory)).filter((name) => name.endsWith(".ts"));

    test(`${directory}: every file on disk is a prefixed file or a declared shared file`, () => {
      const prefixes = Object.keys(entry.byPrefix);
      const unclaimed = onDisk.filter(
        (name) => !entry.shared.includes(name) && !prefixes.some((prefix) => name.startsWith(prefix)),
      );
      expect(unclaimed).toEqual([]);
    });

    test(`${directory}: every declared shared file exists, and every prefix selects a file`, () => {
      expect(entry.shared.filter((name) => !onDisk.includes(name))).toEqual([]);
      for (const prefix of Object.keys(entry.byPrefix)) {
        expect(onDisk.some((name) => name.startsWith(prefix))).toBe(true);
      }
    });
  }

  test("the InfluxDB directory maps influxql-* to influxdb and sql-* to influxdb3", () => {
    expect(PROVIDER_DIRECTORY_MAP["timeseries/influxdb"].byPrefix).toEqual({
      "influxql-": "influxdb",
      "sql-": "influxdb3",
    });
  });
});

describe("typeIdsOfProviderFile", () => {
  test("a prefixed file serves the one type-id its prefix names", () => {
    expect(typeIdsOfProviderFile(path.join(INFLUX, "influxql-objects.ts"))).toEqual(["influxdb"]);
    expect(typeIdsOfProviderFile(path.join(INFLUX, "sql-provider.ts"))).toEqual(["influxdb3"]);
  });

  test("a shared file serves every type-id of its directory", () => {
    expect(typeIdsOfProviderFile(path.join(INFLUX, "client.ts"))).toEqual(["influxdb", "influxdb3"]);
  });

  test("a file in a directory that serves one type-id is not the table's to answer", () => {
    expect(typeIdsOfProviderFile(path.join(PROVIDERS_ROOT, "sql/trino/objects.ts"))).toBeNull();
    expect(typeIdsOfProviderFile(path.join(PROVIDERS_ROOT, "sql/mssql.ts"))).toBeNull();
  });

  test("a file the table does not declare is refused by name, never attributed to nobody", () => {
    expect(() => typeIdsOfProviderFile(path.join(INFLUX, "helpers.ts"))).toThrow(
      "timeseries/influxdb/helpers.ts is neither a prefixed nor a declared shared file of its directory",
    );
  });
});

describe("providerDirectoryFiles", () => {
  test("each type reads its prefixed files and the shared files, never the other type's", () => {
    const influxdb = providerDirectoryFiles(INFLUX, "influxdb");
    const influxdb3 = providerDirectoryFiles(INFLUX, "influxdb3");
    expect(influxdb).toContain(path.join(INFLUX, "influxql-provider.ts"));
    expect(influxdb).toContain(path.join(INFLUX, "client.ts"));
    expect(influxdb).not.toContain(path.join(INFLUX, "sql-provider.ts"));
    expect(influxdb3).toContain(path.join(INFLUX, "sql-provider.ts"));
    expect(influxdb3).toContain(path.join(INFLUX, "client.ts"));
    expect(influxdb3).not.toContain(path.join(INFLUX, "influxql-provider.ts"));
  });

  test("a directory the table does not map answers null", () => {
    expect(providerDirectoryFiles(path.join(PROVIDERS_ROOT, "vector/qdrant"), "qdrant")).toBeNull();
  });

  test("a type the directory does not serve is refused by name", () => {
    expect(() => providerDirectoryFiles(INFLUX, "qdrant")).toThrow("timeseries/influxdb serves no qdrant files");
  });
});
