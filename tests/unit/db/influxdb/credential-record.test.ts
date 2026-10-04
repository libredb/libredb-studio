/**
 * The `influxdb` and `influxdb3` credential records (InfluxDB spec E12, SPEC-delivery A.9), over the real rows: one
 * `no-secret` entry each, worded by what the server does, which the dialog never draws and a read-only seed is
 * refused by. The refusal inside `connect()` is the providers' own test; this one holds the record and the options'
 * seed stage, which `connect()` calls before it builds a client.
 */
import { describe, expect, test } from "bun:test";
import { CREDENTIAL_WARNINGS, credentialWarningFor, readOnlySeedRefusal } from "@/lib/db/credential-warnings";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  buildInfluxConnectionOptions,
  type InfluxType,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

const TEST_PASSWORD = "password";
const TYPES: InfluxType[] = ["influxdb", "influxdb3"];

/** The record is keyed by `DatabaseType`, which gains the two ids at registration; read here by the id's text. */
const RECORD: Readonly<Record<string, readonly { readonly kind: string; readonly message: string }[] | undefined>> =
  CREDENTIAL_WARNINGS;
const asType = (type: InfluxType): DatabaseType => type as string as DatabaseType;

const MESSAGE: Readonly<Record<InfluxType, string>> = {
  influxdb:
    "An InfluxDB 1.x server with authentication off, its default, and an InfluxDB 3 server started with --without-auth accept any credential or none, so a read-only seed without a password or token promises a boundary the server does not keep.",
  influxdb3:
    "An InfluxDB 3 server started with --without-auth accepts any token or none, so a read-only seed without a token promises a boundary the server does not keep.",
};

describe.each(TYPES)("the %s record", (type) => {
  const sentence = `Credential warning: ${MESSAGE[type]}`;

  test("holds exactly one no-secret entry, in the words of SPEC-delivery A.9", () => {
    expect(RECORD[type]).toEqual([{ kind: "no-secret", message: MESSAGE[type] }]);
  });

  test("its wording names what the server does and the boundary it does not keep", () => {
    const message = RECORD[type]?.[0]?.message ?? "";
    expect(message).toContain("--without-auth");
    expect(message).toContain("accept");
    expect(message).toEndWith("promises a boundary the server does not keep.");
  });

  test("a read-only seed with no password, or an empty one, is refused; one holding a secret is not", () => {
    expect(readOnlySeedRefusal(asType(type), {})).toBe(sentence);
    expect(readOnlySeedRefusal(asType(type), { password: "" })).toBe(sentence);
    expect(readOnlySeedRefusal(asType(type), { user: "reader" })).toBe(sentence);
    expect(readOnlySeedRefusal(asType(type), { password: TEST_PASSWORD })).toBeUndefined();
  });

  test("the dialog never warns: an empty password box is not a credential to warn about", () => {
    expect(credentialWarningFor(asType(type), {})).toBeUndefined();
    expect(credentialWarningFor(asType(type), { password: "" })).toBeUndefined();
    expect(credentialWarningFor(asType(type), { password: TEST_PASSWORD })).toBeUndefined();
    expect(credentialWarningFor(asType(type), { user: "root", password: `root:${TEST_PASSWORD}` })).toBeUndefined();
  });

  test("the options' seed stage refuses a resolved read-only seed with no secret, before any client exists", () => {
    const seed = {
      id: "metrics",
      name: "Metrics",
      type,
      host: "127.0.0.1",
      createdAt: new Date(0),
      seedId: "metrics",
      readOnly: true,
    };
    const options = (overrides: Record<string, unknown>) =>
      buildInfluxConnectionOptions({ ...seed, ...overrides } as unknown as DatabaseConnection, {
        type,
        queryTimeout: 30_000,
      });
    for (const overrides of [{}, { password: "" }]) {
      expect(() => options(overrides)).toThrow(DatabaseConfigError);
      expect(() => options(overrides)).toThrow(sentence);
    }
    expect(options({ password: TEST_PASSWORD }).readOnlySeed).toBe(true);
    // The same connection as a user's own, or as a seed that is not read-only, opens with no secret.
    expect(options({ seedId: undefined }).readOnlySeed).toBe(false);
    expect(options({ readOnly: undefined }).readOnlySeed).toBe(false);
  });
});
