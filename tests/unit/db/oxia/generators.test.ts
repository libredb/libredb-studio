/**
 * What a tree click and Generate Command write for an Oxia object (SB2-4.5): each form, `--` before a key that
 * begins with -, the notes for a key no command line spells, and every output a command the parser accepts or a
 * comment.
 */
import { describe, expect, test } from "bun:test";
import { parseOxiaCommand } from "@/lib/db/providers/keyvalue/oxia/commands";
import { oxiaSelectQuery, oxiaTableQuery } from "@/lib/db/providers/keyvalue/oxia/generators";

const CR_NOTE = "# This key holds a carriage return, which a command line cannot spell: open it from the Keys panel.";
const NUL_NOTE = "# This key holds a NUL character, which a command line cannot pass: open it from the Keys panel.";

/** The command a text runs, or "comment" for a text that is comment lines only. */
function reads(text: string): unknown {
  const parsed = parseOxiaCommand(text, {});
  if (!parsed.ok) return parsed.refusal.code === "empty" ? "comment" : parsed.refusal.message;
  return parsed.parsed.command;
}

describe("oxiaTableQuery: the click", () => {
  test.each([
    [["/admin/policies/public"], "get /admin/policies/public"],
    [["0"], "get 0"],
    [["a key"], "get 'a key'"],
    [["it's"], "get 'it'\\''s'"],
    [["-x"], "get -- -x"],
    [["-x y"], "get -- '-x y'"],
    [["a\nb"], "get 'a\nb'"],
    [["c0", "/a"], "get /a"],
  ])("%j writes %j, which reads that key", (path, text) => {
    expect(oxiaTableQuery(path)).toBe(text);
    expect(reads(text)).toEqual({ kind: "get", key: path[path.length - 1], comparison: "equal", hex: false });
  });

  test("a key that holds a CR or a NUL gets a note, which is a comment", () => {
    expect(oxiaTableQuery(["a\rb"])).toBe(CR_NOTE);
    expect(oxiaTableQuery(["a\u0000b"])).toBe(NUL_NOTE);
    // A key holding both is named by its CR, the first rule.
    expect(oxiaTableQuery(["a\r\u0000"])).toBe(CR_NOTE);
    expect(reads(CR_NOTE)).toBe("comment");
    expect(reads(NUL_NOTE)).toBe("comment");
  });
});

describe("oxiaSelectQuery: Generate Command", () => {
  test("the get, then the list and range-scan prefix forms as comments", () => {
    const text = oxiaSelectQuery(["/admin/policies"]);
    expect(text).toBe(
      "get /admin/policies\n# list --prefix /admin/policies/\n# range-scan --prefix /admin/policies/ --limit 50",
    );
    // The whole text runs its first line; each comment, uncommented, runs its own form.
    expect(reads(text)).toEqual({ kind: "get", key: "/admin/policies", comparison: "equal", hex: false });
    const [, list, scan] = text.split("\n");
    expect(reads(list.slice(2))).toEqual({
      kind: "list",
      range: { kind: "prefix", prefix: "/admin/policies/" },
      limit: 500,
    });
    expect(reads(scan.slice(2))).toEqual({
      kind: "range-scan",
      range: { kind: "prefix", prefix: "/admin/policies/" },
      limit: 50,
      hex: false,
    });
  });

  test("a key that needs quotes, or begins with -, is spelled so in every line", () => {
    const text = oxiaSelectQuery(["-a b"]);
    expect(text).toBe("get -- '-a b'\n# list --prefix '-a b/'\n# range-scan --prefix '-a b/' --limit 50");
    expect(reads(text)).toMatchObject({ key: "-a b" });
    expect(reads(text.split("\n")[1].slice(2))).toMatchObject({ range: { kind: "prefix", prefix: "-a b/" } });
  });

  test("a key that holds a line feed spells over two lines, so its text is the get alone", () => {
    expect(oxiaSelectQuery(["a\nb"])).toBe("get 'a\nb'");
    expect(reads(oxiaSelectQuery(["a\nb"]))).toMatchObject({ key: "a\nb" });
  });

  test("a key that holds a CR or a NUL gets the click's note", () => {
    expect(oxiaSelectQuery(["a\rb"])).toBe(CR_NOTE);
    expect(oxiaSelectQuery(["a\u0000b"])).toBe(NUL_NOTE);
  });
});
