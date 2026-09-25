/**
 * Reading each column's DEFAULT clause out of MySQL's own `SHOW CREATE TABLE` text (#1031).
 *
 * Every well-formed statement below is VERBATIM server output, captured from MySQL 26.7.0 on
 * 2026-09-23, never a hand-written approximation of it: a fixture shaped by what the parser's
 * author expected would only test the author. `MEASURED` drops some of the #1031 table's rows
 * and edits none. The malformed statements at the end are the only hand-written text, since
 * no server produces them; each is a captured statement cut short.
 */

import { describe, test, expect } from "bun:test";
import { portableDefaultSql, showCreateColumnDefaults } from "@/lib/db/providers/sql/mysql-show-create";

/**
 * Server text with its backslashes kept, and `^` standing in for the backtick, which a
 * template literal cannot hold. No captured statement contains a `^` of its own.
 *
 * ASCII only: bun's transpiler rewrites a non-ASCII character in a template literal as a
 * `\u` escape, and `raw` then answers the escape's six characters. Non-ASCII fixtures are
 * ordinary strings instead, which is safe because none of them needs a backslash.
 */
const ddl = (strings: TemplateStringsArray): string => strings.raw.join("").replaceAll("^", "`");

/** The #1031 measurement table: one column per default family the issue names. */
const MEASURED = ddl`CREATE TABLE ^m^ (
  ^bin_np^ binary(4) DEFAULT 0x00FF0A27,
  ^vbin_np^ varbinary(8) DEFAULT '\0''\0\\\r',
  ^i^ int DEFAULT '42',
  ^dec_^ decimal(6,2) DEFAULT '1.50',
  ^bt^ bit(8) DEFAULT b'101',
  ^s_q^ varchar(20) DEFAULT 'it''s',
  ^s_bs^ varchar(20) DEFAULT 'a\\b',
  ^s_nl^ varchar(20) DEFAULT 'a\nb',
  ^s_kw^ varchar(30) DEFAULT 'CURRENT_TIMESTAMP',
  ^s_null^ varchar(10) DEFAULT NULL,
  ^s_nullstr^ varchar(10) DEFAULT 'NULL',
  ^s_cm^ varchar(10) DEFAULT 'x' COMMENT 'has DEFAULT ''y'' inside',
  ^we^^ird col^ varchar(10) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL DEFAULT 'w',
  ^ts^ timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ^ts6^ datetime(6) DEFAULT CURRENT_TIMESTAMP(6),
  ^ex^ varchar(20) DEFAULT (concat(_latin1'x',_latin1'y')),
  ^js^ json DEFAULT (json_array()),
  ^en^ enum('a','b''c') DEFAULT 'b''c',
  ^gen^ int GENERATED ALWAYS AS ((^i^ + 1)) VIRTUAL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

/** Constraints, versioned comments and the places the word DEFAULT hides without being one. */
const TRAPS = ddl`CREATE TABLE ^x2^ (
  ^id^ int NOT NULL AUTO_INCREMENT,
  ^inv^ int DEFAULT '7' /*!80023 INVISIBLE */,
  ^pt^ point NOT NULL /*!80003 SRID 4326 */,
  ^n^ int DEFAULT ((now() + 0)) COMMENT 'c, with ) paren',
  ^a,(b^ varchar(10) DEFAULT 'a,b)',
  ^tr^ varchar(20) DEFAULT 'x DEFAULT y',
  ^en^ enum('x DEFAULT y','z') DEFAULT 'z',
  ^g^ int GENERATED ALWAYS AS ((default(^inv^) + 1)) VIRTUAL,
  ^fk^ int DEFAULT '3',
  ^lc^ varchar(5) DEFAULT (_utf8mb4'q'),
  PRIMARY KEY (^id^),
  UNIQUE KEY ^uk^ (^tr^),
  SPATIAL KEY ^sp^ (^pt^),
  KEY ^fk1^ (^fk^),
  KEY ^fx^ (((^n^ + 1))),
  CONSTRAINT ^fk1^ FOREIGN KEY (^fk^) REFERENCES ^x1^ (^id^),
  CONSTRAINT ^ck^ CHECK ((^n^ > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`;

describe("showCreateColumnDefaults", () => {
  test("reads every measured default family exactly as the server spelled it", () => {
    expect(showCreateColumnDefaults(MEASURED)).toEqual(
      new Map([
        ["bin_np", "0x00FF0A27"],
        ["vbin_np", String.raw`'\0''\0\\\r'`],
        ["i", "'42'"],
        ["dec_", "'1.50'"],
        ["bt", "b'101'"],
        ["s_q", "'it''s'"],
        ["s_bs", String.raw`'a\\b'`],
        ["s_nl", String.raw`'a\nb'`],
        ["s_kw", "'CURRENT_TIMESTAMP'"],
        ["s_null", "NULL"],
        ["s_nullstr", "'NULL'"],
        ["s_cm", "'x'"],
        ["we`ird col", "'w'"],
        ["ts", "CURRENT_TIMESTAMP"],
        ["ts6", "CURRENT_TIMESTAMP(6)"],
        ["ex", "(concat(_latin1'x',_latin1'y'))"],
        ["js", "(json_array())"],
        ["en", "'b''c'"],
      ]),
    );
  });

  test("a generated column has no DEFAULT clause and is absent, not NULL", () => {
    expect(showCreateColumnDefaults(MEASURED)?.has("gen")).toBe(false);
  });

  test("stops at a versioned comment, a COMMENT and ON UPDATE, and skips every constraint line", () => {
    expect(showCreateColumnDefaults(TRAPS)).toEqual(
      new Map([
        ["inv", "'7'"],
        ["n", "((now() + 0))"],
        ["a,(b", "'a,b)'"],
        ["tr", "'x DEFAULT y'"],
        ["en", "'z'"],
        ["fk", "'3'"],
        ["lc", "(_utf8mb4'q')"],
      ]),
    );
  });

  test("reads ANSI_QUOTES identifiers, doubled quote included", () => {
    // Verbatim under sql_mode=ANSI_QUOTES: the identifier quote becomes the double quote.
    const text = ddl`CREATE TABLE "e" (
  "we^ird" varchar(10) DEFAULT 'a\\b',
  "d""q" varchar(10) DEFAULT 'it''s'
)`;
    expect(showCreateColumnDefaults(text)).toEqual(
      new Map([
        ["we`ird", String.raw`'a\\b'`],
        ['d"q', "'it''s'"],
      ]),
    );
  });

  test("reads bare identifiers, as sql_quote_show_create=0 prints them", () => {
    // Verbatim under sql_quote_show_create=0: a name that needs no quoting gets none.
    const text = ddl`CREATE TABLE e (
  ^we^^ird^ varchar(10) DEFAULT 'a\\b',
  q varchar(10) DEFAULT 'it''s',
  v varbinary(4) DEFAULT '\0'''
)`;
    expect(showCreateColumnDefaults(text)).toEqual(
      new Map([
        ["we`ird", String.raw`'a\\b'`],
        ["q", "'it''s'"],
        ["v", String.raw`'\0'''`],
      ]),
    );
  });

  test("keeps a non-ASCII default as the server sent it", () => {
    const text =
      "CREATE TABLE `m` (\n  `s_u` varchar(20) DEFAULT 'é✓'\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";
    expect(showCreateColumnDefaults(text)).toEqual(new Map([["s_u", "'é✓'"]]));
  });

  test("a table name holding a paren does not open the column list", () => {
    const text =
      "CREATE TABLE `t(1` (\n  `a` int DEFAULT '1'\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci";
    expect(showCreateColumnDefaults(text)).toEqual(new Map([["a", "'1'"]]));
  });

  describe("answers undefined, never a partial map, for text it cannot read to the end", () => {
    test.each([
      ["an unterminated string", "CREATE TABLE `t` (\n  `a` varchar(3) DEFAULT 'ab\n)"],
      ["a backslash-escaped closing quote with nothing after it", ddl`CREATE TABLE ^t^ (^a^ varchar(3) DEFAULT 'a\')`],
      ["an unterminated identifier", "CREATE TABLE `t` (\n  `a int DEFAULT '1'\n)"],
      ["an unclosed column list", "CREATE TABLE `t` (\n  `a` int DEFAULT '1'"],
      ["an unbalanced expression default", "CREATE TABLE `t` (\n  `a` int DEFAULT ((1 + 2)\n)"],
      ["no column list at all", "CREATE TABLE `t`"],
      ["a DEFAULT with nothing after it", "CREATE TABLE `t` (\n  `a` int DEFAULT\n)"],
      ["an unterminated comment", "CREATE TABLE `t` (\n  `a` int DEFAULT '1' /*!80023 INVISIBLE\n)"],
      [
        "an item that opens with neither a name nor a keyword",
        "CREATE TABLE `t` (\n  `a` int DEFAULT '1',\n  'b' int\n)",
      ],
    ])("%s", (_label, text) => {
      expect(showCreateColumnDefaults(text)).toBeUndefined();
    });
  });
});

describe("portableDefaultSql", () => {
  // MySQL's `SHOW CREATE` quotes every numeric default and MariaDB's catalog reports none of
  // them quoted (#1031 section 3, both servers 2026-09-23). Unquoted, each row is MariaDB's
  // text exactly, so a MySQL-to-MariaDB diff of an unchanged numeric default stays equal.
  test.each([
    ["int", "'42'", "42"],
    ["int", "'-5'", "-5"],
    ["bigint", "'18446744073709551615'", "18446744073709551615"],
    ["tinyint", "'1'", "1"],
    ["decimal", "'1.50'", "1.50"],
    ["float", "'1500'", "1500"],
    ["double", "'0.1'", "0.1"],
    ["year", "'2020'", "2020"],
  ])("unquotes a numeric %s default %s as %s", (dataType, text, expected) => {
    expect(portableDefaultSql(text, dataType)).toBe(expected);
  });

  test.each([
    ["a varchar holding digits, where the quotes are the value's", "varchar", "'42'"],
    ["a numeric column whose default is not a number", "int", "NULL"],
    ["a numeric expression default", "int", "((now() + 0))"],
  ])("keeps %s", (_label, dataType, text) => {
    expect(portableDefaultSql(text, dataType)).toBe(text);
  });

  // `SHOW CREATE` writes backslash escapes even for a NO_BACKSLASH_ESCAPES session, and a
  // server in that mode stores different bytes for them (#1031 section 5). Hex means the same
  // bytes in both modes. A text column needs the introducer, because a bare hex literal is
  // read in the COLUMN's charset: latin1 `DEFAULT 0x5CC3A9` stores 5CC3A9, not 5CE9. Every
  // row below was stored under both modes on MySQL 26.7.0 and read back byte for byte.
  test.each([
    ["varbinary", String.raw`'\0''\0\\\r'`, "0x0027005C0D"],
    ["binary", String.raw`'\0\0\0'`, "0x000000"],
    ["varchar", String.raw`'a\\b'`, "_utf8mb4 0x615C62"],
    ["varchar", String.raw`'a\nb'`, "_utf8mb4 0x610A62"],
    ["enum", String.raw`'a\\'`, "_utf8mb4 0x615C"],
  ])("renders a backslash-escaped %s literal %s as %s", (dataType, text, expected) => {
    expect(portableDefaultSql(text, dataType)).toBe(expected);
  });

  test("encodes non-ASCII text as UTF-8 behind the introducer, whatever the column charset", () => {
    // `'\\é'` on a latin1 column arrives as UTF-8 text; `_utf8mb4 0x5CC3A9` stores 5CE9 there.
    expect(portableDefaultSql("'\\\\é'", "varchar")).toBe("_utf8mb4 0x5CC3A9");
  });

  test("decodes a doubled quote inside a literal that also has an escape", () => {
    expect(portableDefaultSql(String.raw`'it''s\\'`, "varchar")).toBe("_utf8mb4 0x697427735C");
  });

  test("decodes every escape in MySQL's table, and a backslash before anything else as that character", () => {
    // The server emits only \0 \n \r and \\ (measured); the rest are the manual's table
    // (String Literals, 11.1.1), so a literal from any source decodes the way the server would.
    expect(portableDefaultSql(String.raw`'\0\'\"\b\n\r\t\Z\\\%\_\q'`, "varbinary")).toBe(
      "0x002722080A0D091A5C5C255C5F71",
    );
  });

  test.each([
    ["a literal with no backslash", "varchar", "'it''s'"],
    ["raw bytes the server wrote unescaped", "binary", "'é'"],
    ["a hex literal", "binary", "0x00FF0A27"],
    ["a bit literal", "bit", "b'101'"],
    ["a keyword", "timestamp", "CURRENT_TIMESTAMP"],
    ["an expression, which is left as the server wrote it", "varchar", String.raw`(concat('a\\b'))`],
  ])("keeps %s unchanged", (_label, dataType, text) => {
    expect(portableDefaultSql(text, dataType)).toBe(text);
  });
});
