import { describe, expect, test } from "bun:test";
import { dataProfileText, type ColumnProfile, type ProfileData } from "@/lib/export/data-profile";
import type { MaskingRule } from "@/lib/data-masking";

const headers = "Column,Type,Total Rows,Null Count,Null %,Distinct Count,Min,Max,Sample Values,Error";

const column: ColumnProfile = {
  name: "id",
  type: "integer",
  totalRows: 100,
  nullCount: 0,
  nullPercent: 0,
  distinctCount: 100,
  minValue: "1",
  maxValue: "100",
  sampleValues: ["1", "2", "3"],
};

const profile = (columns: ColumnProfile[]): ProfileData => ({ tableName: "users", totalRows: 100, columns });

const emailRule: MaskingRule = { pattern: /email/i, label: "Email", mask: () => "****" };
const sensitive = new Map<string, MaskingRule>([["email", emailRule]]);

describe("dataProfileText", () => {
  test("empty CSV retains all ten headers", () => {
    expect(dataProfileText(profile([]), new Map(), "csv")).toBe(headers);
  });

  test("CSV writes one row per column and preserves zero", () => {
    expect(dataProfileText(profile([column]), new Map(), "csv")).toBe(
      `${headers}\nid,integer,100,0,0,100,1,100,1 | 2 | 3,`,
    );
  });

  test("CSV leaves an absent type, min, max, sample list and error empty", () => {
    const bare: ColumnProfile = { name: "notes", totalRows: 7, nullCount: 7, nullPercent: 100, distinctCount: 0 };
    expect(dataProfileText(profile([bare]), new Map(), "csv")).toBe(`${headers}\nnotes,,7,7,100,0,,,,`);
  });

  test("CSV keeps commas, quotes, newlines and Unicode in their original columns", () => {
    const awkward: ColumnProfile = {
      ...column,
      name: 'çağrı,"notu"',
      minValue: "a,b",
      maxValue: 'say "merhaba"',
      sampleValues: ["line\none", "x,y"],
      error: "Could not profile this column",
    };
    expect(dataProfileText(profile([awkward]), new Map(), "csv")).toBe(
      `${headers}\n"çağrı,""notu""",integer,100,0,0,100,"a,b","say ""merhaba""","line\none | x,y",Could not profile this column`,
    );
  });

  test("CSV masks min, max and every sample value of a sensitive column, and only that column", () => {
    const email: ColumnProfile = {
      ...column,
      name: "email",
      minValue: "alice@example.com",
      maxValue: "zara@example.com",
      sampleValues: ["alice@example.com", "bob@example.com"],
    };
    expect(dataProfileText(profile([column, email]), sensitive, "csv")).toBe(
      `${headers}\nid,integer,100,0,0,100,1,100,1 | 2 | 3,\nemail,integer,100,0,0,100,****,****,**** | ****,`,
    );
  });

  test("an absent min and max stay empty on a sensitive column rather than becoming the mask", () => {
    // `maskValue` answers `NULL` for an absent value, which reads back as a column
    // that genuinely holds that word. A column with no MIN has nothing to hide.
    const empty: ColumnProfile = { name: "email", totalRows: 0, nullCount: 0, nullPercent: 0, distinctCount: 0 };
    expect(dataProfileText(profile([empty]), sensitive, "csv")).toBe(`${headers}\nemail,,0,0,0,0,,,,`);
  });

  test("CSV neutralizes a formula prefix in the column name and in a sample value", () => {
    const formula: ColumnProfile = { ...column, name: "=name", sampleValues: ["@cmd"] };
    expect(dataProfileText(profile([formula]), new Map(), "csv")).toBe(
      `${headers}\n"'=name",integer,100,0,0,100,1,100,"'@cmd",`,
    );
  });

  test("JSON carries the table, its row count and every column with two-space indentation", () => {
    expect(dataProfileText(profile([column]), new Map(), "json")).toBe(
      JSON.stringify({ tableName: "users", totalRows: 100, columns: [{ ...column, error: "" }] }, null, 2),
    );
  });

  test("JSON masks the same three fields as the CSV", () => {
    const email: ColumnProfile = { ...column, name: "email", minValue: "a@b.co", sampleValues: ["a@b.co"] };
    const written = JSON.parse(dataProfileText(profile([email]), sensitive, "json")) as ProfileData;
    expect(written.columns[0].minValue).toBe("****");
    expect(written.columns[0].maxValue).toBe("****");
    expect(written.columns[0].sampleValues).toEqual(["****"]);
  });

  test("JSON writes an absent optional as empty rather than dropping the key", () => {
    const bare: ColumnProfile = { name: "notes", totalRows: 7, nullCount: 7, nullPercent: 100, distinctCount: 0 };
    expect(JSON.parse(dataProfileText(profile([bare]), new Map(), "json")).columns[0]).toEqual({
      name: "notes",
      type: "",
      totalRows: 7,
      nullCount: 7,
      nullPercent: 100,
      distinctCount: 0,
      minValue: "",
      maxValue: "",
      sampleValues: [],
      error: "",
    });
  });
});
