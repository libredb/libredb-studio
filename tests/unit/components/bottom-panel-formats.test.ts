import { describe, test, expect } from "bun:test";
import { RESULT_FORMATS, clipboardResultFormats } from "@/components/studio/BottomPanel";

describe("RESULT_FORMATS", () => {
  test("offers Markdown, HTML and XLSX alongside the existing formats", () => {
    const formats = RESULT_FORMATS.map((entry) => entry.format);
    expect(formats).toContain("markdown");
    expect(formats).toContain("html");
    expect(formats).toContain("xlsx");
    expect(formats).toContain("csv");
    expect(formats).toContain("json");
    expect(formats).toContain("sql-insert");
    expect(formats).toContain("sql-ddl");
  });

  test("keeps XLSX off the clipboard menu, where only text formats can go", () => {
    const clipboard = clipboardResultFormats(RESULT_FORMATS).map((entry) => entry.format);
    expect(clipboard).not.toContain("xlsx");
    expect(clipboard).toContain("markdown");
    expect(clipboard).toContain("html");
  });

  test("offers every non-XLSX format on the clipboard, so the two menus cannot drift", () => {
    const file = RESULT_FORMATS.map((entry) => entry.format);
    const clipboard = clipboardResultFormats(RESULT_FORMATS).map((entry) => entry.format);
    expect(clipboard).toEqual(file.filter((format) => format !== "xlsx"));
  });

  test("marks exactly one entry as binary-only, and it is XLSX", () => {
    const binaryOnly = RESULT_FORMATS.filter((entry) => entry.clipboard === false);
    expect(binaryOnly.map((entry) => entry.format)).toEqual(["xlsx"]);
  });
});
