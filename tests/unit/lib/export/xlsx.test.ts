import { describe, test, expect } from "bun:test";
import { buildXlsxExport } from "@/lib/export/xlsx";

const source = (rows: readonly Record<string, unknown>[], fields: readonly string[]) => ({
  rows,
  fields,
  tabName: "t",
  dialect: undefined,
});

type Cell = { t?: string; v?: unknown; f?: unknown };

async function readWorkbook(file: Awaited<ReturnType<typeof buildXlsxExport>>) {
  expect(file.mimeType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  expect(file.extension).toBe("xlsx");
  expect(file.content).toBeInstanceOf(Blob);
  const XLSX = await import("@e965/xlsx");
  const buffer = await (file.content as Blob).arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  return { workbook, sheet: workbook.Sheets[workbook.SheetNames[0]] as Record<string, unknown> };
}

describe("buildXlsxExport", () => {
  test("names the single worksheet with the fixed name, never after user data", async () => {
    const { workbook } = await readWorkbook(await buildXlsxExport(source([{ a: 1 }], ["a"])));
    expect(workbook.SheetNames).toEqual(["Results"]);
  });

  test("writes every formula-lead value as a string cell with no formula field", async () => {
    const rows = [
      { v: "=1+1" },
      { v: "+cmd|' /C calc'!A0" },
      { v: "-1+1" },
      { v: "@SUM(A1:A9)" },
      { v: "\t=1+1" },
      { v: "\r=1+1" },
    ];
    const { sheet } = await readWorkbook(await buildXlsxExport(source(rows, ["v"])));
    rows.forEach((row, index) => {
      const cell = sheet[`A${index + 2}`] as Cell;
      expect(cell.t).toBe("s");
      expect(cell.f).toBeUndefined();
      expect(cell.v).toBe(row.v);
    });
  });

  test("keeps a plain number and a plus-signed number as string cells, not numbers", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([{ n: -12.5 }, { n: "+7" }], ["n"])));
    expect((sheet.A2 as Cell).t).toBe("s");
    expect((sheet.A2 as Cell).v).toBe("-12.5");
    expect((sheet.A3 as Cell).t).toBe("s");
    expect((sheet.A3 as Cell).v).toBe("+7");
  });

  test("writes falsy values as their text, never as an empty cell", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([{ a: 0, b: false, c: "" }], ["a", "b", "c"])));
    expect((sheet.A2 as Cell).v).toBe("0");
    expect((sheet.B2 as Cell).v).toBe("false");
    expect((sheet.C2 as Cell).v).toBe("");
  });

  test("writes an absent value as an empty string cell", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([{ a: null, b: undefined }], ["a", "b"])));
    expect((sheet.A2 as Cell).v).toBe("");
    expect((sheet.B2 as Cell).v).toBe("");
    expect((sheet.A2 as Cell).f).toBeUndefined();
  });

  test("writes a date as its ISO string", async () => {
    const { sheet } = await readWorkbook(
      await buildXlsxExport(source([{ at: new Date("2026-08-17T06:31:49.000Z") }], ["at"])),
    );
    expect((sheet.A2 as Cell).t).toBe("s");
    expect((sheet.A2 as Cell).v).toBe("2026-08-17T06:31:49.000Z");
  });

  test("writes a binary value as the shared hex", async () => {
    const { sheet } = await readWorkbook(
      await buildXlsxExport(source([{ b: { type: "Buffer", data: [0xde, 0xad, 0xbe, 0xef] } }], ["b"])),
    );
    expect((sheet.A2 as Cell).v).toBe("\\xdeadbeef");
  });

  test("writes a structured value as JSON and a bigint without losing digits", async () => {
    const { sheet } = await readWorkbook(
      await buildXlsxExport(source([{ meta: { a: 1 }, big: BigInt("9007199254740993") }], ["meta", "big"])),
    );
    expect((sheet.A2 as Cell).v).toBe('{"a":1}');
    expect((sheet.B2 as Cell).v).toBe("9007199254740993");
  });

  test("writes the header row from the declared columns", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([{ b: 2, a: 1 }], ["a", "b"])));
    expect((sheet.A1 as Cell).t).toBe("s");
    expect((sheet.A1 as Cell).v).toBe("a");
    expect((sheet.B1 as Cell).v).toBe("b");
  });

  test("writes a formula-lead column name in the header as a string cell, never a formula", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([{ "=1+1": "x" }], ["=1+1"])));
    expect((sheet.A1 as Cell).t).toBe("s");
    expect((sheet.A1 as Cell).v).toBe("=1+1");
    expect((sheet.A1 as Cell).f).toBeUndefined();
  });

  test("writes a header with no rows under it when the columns are known but empty", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([], ["a", "b"])));
    expect((sheet.A1 as Cell).v).toBe("a");
    expect((sheet.B1 as Cell).v).toBe("b");
    expect(sheet.A2).toBeUndefined();
  });

  test("writes a sheet with no cells for no rows and no declared columns", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([], [])));
    expect(sheet.A1).toBeUndefined();
  });

  test("preserves non-ASCII text through the round-trip", async () => {
    const { sheet } = await readWorkbook(await buildXlsxExport(source([{ s: "雪🚀" }], ["s"])));
    expect((sheet.A2 as Cell).v).toBe("雪🚀");
  });
});
