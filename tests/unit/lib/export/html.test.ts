import { describe, test, expect } from "bun:test";
import { htmlCell, htmlTable } from "@/lib/export/html";

// The `&` is kept in a constant and spliced in, so the entity text is never decoded before it reaches the file.
const ENTITY_MARK = "&";
const amp = `${ENTITY_MARK}amp;`;
const lt = `${ENTITY_MARK}lt;`;
const gt = `${ENTITY_MARK}gt;`;
const quot = `${ENTITY_MARK}quot;`;
const apos = `${ENTITY_MARK}#39;`;

describe("htmlCell", () => {
  test("escapes every character a parser would read as markup", () => {
    expect(htmlCell(`&<>"'`)).toBe(amp + lt + gt + quot + apos);
  });

  test("escapes a script payload so no raw tag survives", () => {
    expect(htmlCell("<script>alert(1)</script>")).toBe(lt + "script" + gt + "alert(1)" + lt + "/script" + gt);
    expect(htmlCell("<img src=x onerror=alert(1)>")).toBe(lt + "img src=x onerror=alert(1)" + gt);
  });

  test("double-escapes a value that already holds an entity, because the value is data", () => {
    expect(htmlCell(amp)).toBe(amp + "amp;");
  });

  test("writes an absent value as an empty cell", () => {
    expect(htmlCell(null)).toBe("");
    expect(htmlCell(undefined)).toBe("");
  });

  test("writes a date and a binary value through the shared contract", () => {
    expect(htmlCell(new Date("2026-08-17T06:31:49.000Z"))).toBe("2026-08-17T06:31:49.000Z");
    expect(htmlCell({ type: "Buffer", data: [0xde, 0xad] })).toBe("\\xdead");
    expect(htmlCell(new Uint8Array([0xde, 0xad]))).toBe("\\xdead");
  });

  test("escapes the quotes inside a Buffer-shaped document, as part of the HTML text", () => {
    const cell = htmlCell({ type: "Buffer", data: [1, "two"] });
    expect(cell).toBe(
      "{" + quot + "type" + quot + ":" + quot + "Buffer" + quot + "," + quot + "data" + quot + ":[1," + quot + "two" + quot + "]}",
    );
    expect(cell).not.toContain('"');
  });

  test("serializes a structured value, escaping its quotes, and writes a bigint", () => {
    expect(htmlCell({ a: 1 })).toBe("{" + quot + "a" + quot + ":1}");
    expect(htmlCell([1, 2])).toBe("[1,2]");
    expect(htmlCell(BigInt(10))).toBe("10");
  });
});

describe("htmlTable", () => {
  test("renders a complete standalone document with a header row", () => {
    const html = htmlTable([{ id: 1, name: "Ada" }], ["id", "name"]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<tr><th>id</th><th>name</th></tr>");
    expect(html).toContain("<tr><td>1</td><td>Ada</td></tr>");
  });

  test("escapes a column name in the header", () => {
    const html = htmlTable([{ "a<b": 1 }], ["a<b"]);
    expect(html).toContain("<th>a" + lt + "b</th>");
  });

  test("escapes a quote in a header, so it cannot close an attribute if one is ever added", () => {
    const html = htmlTable([{ 'a"b': 1 }], ['a"b']);
    expect(html).toContain("<th>a" + quot + "b</th>");
  });

  test("writes a header with no rows under it when the columns are known but empty", () => {
    const html = htmlTable([], ["a"]);
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<tbody>\n\n</tbody>");
  });

  test("writes nothing for no rows and no declared columns", () => {
    expect(htmlTable([])).toBe("");
  });

  test("writes an empty cell for a prototype-named column the row does not carry", () => {
    const html = htmlTable([{ id: 1 }], ["id", "constructor"]);
    expect(html).toContain("<tr><td>1</td><td></td></tr>");
  });

  test("still writes a row's own value for a prototype-named column", () => {
    const html = htmlTable([{ toString: "mine" }], ["toString"]);
    expect(html).toContain("<td>mine</td>");
  });
});
