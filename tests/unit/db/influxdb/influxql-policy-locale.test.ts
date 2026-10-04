/**
 * The InfluxQL read policy under a Turkish default locale (SPEC 3.6 E3, J1 1.4).
 *
 * `"into".toLocaleUpperCase()` is `İNTO` where the default locale is Turkish, so a policy that
 * folds keywords through a locale call misses the one word that turns a SELECT into a write. The
 * two locale methods are replaced with Turkish ones for this file's duration, which is what a
 * Turkish host gives every call without an argument.
 */
import { afterAll, beforeAll, describe, expect, type Mock, spyOn, test } from "bun:test";
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";

const originalUpper = String.prototype.toLocaleUpperCase;
const originalLower = String.prototype.toLocaleLowerCase;
const spies: Mock<(...args: never[]) => string>[] = [];

beforeAll(() => {
  spies.push(
    spyOn(String.prototype, "toLocaleUpperCase").mockImplementation(function turkishUpper(this: string): string {
      return originalUpper.call(this.replace(/i/g, "\u0130"));
    }),
    spyOn(String.prototype, "toLocaleLowerCase").mockImplementation(function turkishLower(this: string): string {
      return originalLower.call(this.replace(/I/g, "\u0131"));
    }),
  );
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("evaluateInfluxql under a Turkish default locale", () => {
  test("the locale methods are the Turkish ones while this file runs", () => {
    expect("into".toLocaleUpperCase()).toBe("İNTO");
    expect("INTO".toLocaleLowerCase()).toBe("ınto");
  });

  test("a lower-case into is still INTO", () => {
    const verdict = evaluateInfluxql("select temp into other..x from home");
    expect(verdict).toEqual({
      allowed: false,
      reason: "into",
      message: "SELECT ... INTO writes into a measurement, which Studio does not do.",
    });
  });

  test("a lower-case read is still a read", () => {
    expect(evaluateInfluxql("select * from home")).toEqual({ allowed: true, statement: "SELECT", namedDatabases: [] });
  });
});
