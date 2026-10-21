import { describe, expect, test } from "bun:test";
import { mapTLSValue, readADONetTLS, readBooleanTLS } from "@/lib/db/connection-string/shared";

/** The three TLS readers the engine modules share, held to the answers the Task 7.1 fixtures pin for them. */
describe("connection string TLS helpers", () => {
  test("readBooleanTLS maps both ends of a boolean and echoes anything else", () => {
    expect(readBooleanTLS({ name: "ssl", value: "true" })).toEqual({ sslMode: "verify-system" });
    expect(readBooleanTLS({ name: "ssl", value: "1" })).toEqual({ sslMode: "verify-system" });
    expect(readBooleanTLS({ name: "ssl", value: "false" })).toEqual({ sslMode: "disable" });
    expect(readBooleanTLS({ name: "ssl", value: "0" })).toEqual({ sslMode: "disable" });
    expect(readBooleanTLS({ name: "useSSL", value: "maybe" })).toEqual({ unmappedTLSParam: "useSSL=maybe" });
  });

  test("readADONetTLS reads Encrypt and TrustServerCertificate", () => {
    const from = (params: Record<string, string>) => (key: string) => params[key];
    expect(readADONetTLS(from({ encrypt: "strict" }))).toEqual({ sslMode: "verify-full" });
    expect(readADONetTLS(from({ encrypt: "false" }))).toEqual({ sslMode: "disable" });
    expect(readADONetTLS(from({}))).toEqual({});
  });

  test("mapTLSValue maps a documented value case-insensitively and never an Object.prototype key", () => {
    // A copy of the postgres table: the engine module keeps its own private.
    const postgres = {
      disable: "disable",
      require: "require",
      "verify-ca": "verify-ca",
      "verify-full": "verify-full",
    } as const;
    expect(mapTLSValue({ name: "sslmode", value: "verify-full" }, postgres)).toEqual({ sslMode: "verify-full" });
    expect(mapTLSValue({ name: "sslmode", value: "constructor" }, postgres)).toEqual({
      unmappedTLSParam: "sslmode=constructor",
    });
  });
});
