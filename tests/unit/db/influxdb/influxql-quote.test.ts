/**
 * InfluxQL quoting (C6, E6): a name always double-quoted, a string always single-quoted, each with
 * only the scanner's four escapes, a control character the scanner has no escape for refused without
 * echoing the value, and the `"db".."m"` source every tree read and Generate Query write.
 * The policy round trips of these outputs are the generator and objects tests'.
 */
import { describe, expect, test } from "bun:test";
import {
  InfluxqlQuoteError,
  influxqlSource,
  quoteInfluxqlIdentifier,
  quoteInfluxqlString,
} from "@/lib/db/providers/timeseries/influxdb/influxql-quote";

function quoteErrorOf(quote: (value: string) => string, value: string): InfluxqlQuoteError {
  try {
    quote(value);
  } catch (error) {
    if (error instanceof InfluxqlQuoteError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(value)} to be refused`);
}

describe("quoteInfluxqlIdentifier", () => {
  test.each([
    ["temperature", '"temperature"'],
    ["", '""'],
    ['we"ird name;x', '"we\\"ird name;x"'],
    ["line\nbreak", '"line\\nbreak"'],
    ["*/", '"*/"'],
    ["--", '"--"'],
    ["/", '"/"'],
    ["\\", '"\\\\"'],
    ["it's", '"it\'s"'],
    ["Wohnzimmer äöü", '"Wohnzimmer äöü"'],
    ['\\"', '"\\\\\\""'],
  ])("%j quotes to %s", (name, quoted) => {
    expect(quoteInfluxqlIdentifier(name)).toBe(quoted);
  });

  test.each(["\u0000", "\u0001", "\t", "\r", "\u001f", "\u007f"])("refuses the control character %j", (character) => {
    const error = quoteErrorOf(quoteInfluxqlIdentifier, `secret-sensor${character}`);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InfluxqlQuoteError");
    expect(error.message).toBe(
      "An InfluxQL name cannot hold a control character other than a newline (U+0000 to U+001F, or U+007F), because the InfluxQL scanner has no escape for it.",
    );
    expect(error.message).not.toContain("secret-sensor");
  });
});

describe("quoteInfluxqlString", () => {
  test.each([
    ["living room", "'living room'"],
    ["", "''"],
    ["it's", "'it\\'s'"],
    ['we"ird name;x', "'we\"ird name;x'"],
    ["line\nbreak", "'line\\nbreak'"],
    ["*/", "'*/'"],
    ["--", "'--'"],
    ["/", "'/'"],
    ["\\", "'\\\\'"],
    ["Wohnzimmer äöü", "'Wohnzimmer äöü'"],
    ["\\'", "'\\\\\\''"],
  ])("%j quotes to %s", (value, quoted) => {
    expect(quoteInfluxqlString(value)).toBe(quoted);
  });

  test.each(["\u0000", "\u0001", "\t", "\r", "\u001f", "\u007f"])("refuses the control character %j", (character) => {
    const error = quoteErrorOf(quoteInfluxqlString, `secret-value${character}`);
    expect(error.name).toBe("InfluxqlQuoteError");
    expect(error.message).toBe(
      "An InfluxQL string cannot hold a control character other than a newline (U+0000 to U+001F, or U+007F), because the InfluxQL scanner has no escape for it.",
    );
    expect(error.message).not.toContain("secret-value");
  });
});

describe("influxqlSource", () => {
  test("names the database's default retention policy with an empty middle segment", () => {
    expect(influxqlSource("home", "home")).toBe('"home".."home"');
  });

  test("quotes both the database and the measurement", () => {
    expect(influxqlSource('we"ird', "a b")).toBe('"we\\"ird".."a b"');
  });

  test("refuses a control character in either part", () => {
    expect(() => influxqlSource("db\t", "m")).toThrow(InfluxqlQuoteError);
    expect(() => influxqlSource("db", "m\r")).toThrow(InfluxqlQuoteError);
  });
});
