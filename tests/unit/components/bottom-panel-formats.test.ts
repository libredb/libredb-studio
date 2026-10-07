import { describe, test, expect } from "bun:test";
import { RESULT_FORMATS } from "@/components/studio/BottomPanel";

describe("RESULT_FORMATS", () => {
  test("offers Markdown and HTML alongside the existing formats", () => {
    const formats = RESULT_FORMATS.map((entry) => entry.format);
    expect(formats).toContain("markdown");
    expect(formats).toContain("html");
    expect(formats).toContain("csv");
    expect(formats).toContain("json");
    expect(formats).toContain("sql-insert");
    expect(formats).toContain("sql-ddl");
  });
});
