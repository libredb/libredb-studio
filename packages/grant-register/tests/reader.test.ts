/**
 * The grant register's reader: it validates a register against the register's schema, then refuses a repeated key and a
 * legacy row for an engine the legacy adapter does not serve, reports every refusal of one read together, and answers
 * a frozen row for a key or none, and every package row in its order. Every engine id here is synthetic and every
 * digest generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import committed from "../src/register.json";
import { LEGACY_KEY, parseGrantRegister, readGrantRegister } from "../src/index";
import { schemaRefusals } from "../src/schema-subset";
import { digest, ENGINE_A, ENGINE_B, grants, hexDigest, legacyRow, omit, packageRow } from "./helpers/rows";

const SERVED = [ENGINE_A, ENGINE_B];

/** A statement language name of the register's form, never one Studio holds a module for, new on every call. */
function generatedLanguage(): string {
  return `acme${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** The lines of the refusal `read` throws, without the heading line. */
function refusalLines(read: () => unknown): string[] {
  try {
    read();
  } catch (error) {
    const [heading, ...lines] = (error as Error).message.split("\n");
    expect(heading).toBe("The grant register is refused:");
    return lines;
  }
  throw new Error("the register was read without a refusal");
}

describe("refusals", () => {
  test("the reader refuses a duplicate key, a legacy row for an engine the adapter does not serve, a malformed digest and a member outside its vocabulary, each by name", () => {
    const repeated = digest();
    expect(refusalLines(() => parseGrantRegister([legacyRow(), legacyRow()], SERVED))).toEqual([
      "duplicate-key at /1: the row repeats the key of the row at /0",
    ]);
    expect(
      refusalLines(() =>
        parseGrantRegister(
          [packageRow(ENGINE_B, { digest: repeated }), packageRow(ENGINE_B, { digest: repeated })],
          SERVED,
        ),
      ),
    ).toEqual(["duplicate-key at /1: the row repeats the key of the row at /0"]);
    expect(refusalLines(() => parseGrantRegister([legacyRow("enginec")], SERVED))).toEqual([
      "legacy-engine-not-served at /0/engine: the legacy adapter serves no engine of this id",
    ]);
    expect(
      refusalLines(() => parseGrantRegister([packageRow(ENGINE_B, { digest: `${digest().toUpperCase()}` })], SERVED)),
    ).toEqual(["pattern-mismatch at /0/package/digest: the value does not have the form the schema defines here"]);
    expect(refusalLines(() => parseGrantRegister([packageRow(ENGINE_B, { digest: "sha256:ab" })], SERVED))).toEqual([
      "pattern-mismatch at /0/package/digest: the value does not have the form the schema defines here",
    ]);
    expect(
      refusalLines(() => parseGrantRegister([legacyRow(ENGINE_A, { grants: grants({ writeReach: "wide" }) })], SERVED)),
    ).toEqual([
      'value-not-allowed at /0/grants/writeReach: the value is not one the schema allows here, "open", "guarded", "none"',
    ]);
  });

  test("a package row, one of each package's key, and a legacy row for one engine are distinct keys", () => {
    const shared = { name: "@planted/provider-b", version: "1.2.3", digest: digest() };
    const register = parseGrantRegister(
      [
        legacyRow(ENGINE_B),
        packageRow(ENGINE_B, shared),
        packageRow(ENGINE_A, shared),
        packageRow(ENGINE_B, { ...shared, version: "1.2.4" }),
        packageRow(ENGINE_B, { ...shared, name: "@planted/provider-c" }),
        packageRow(ENGINE_B, { ...shared, digest: digest() }),
      ],
      SERVED,
    );

    expect(register.rowFor({ legacy: LEGACY_KEY, engine: ENGINE_B })?.engine).toBe(ENGINE_B);
    expect(register.rowFor({ package: shared, engine: ENGINE_A })?.engine).toBe(ENGINE_A);
  });

  test("every refusal of one register is reported together, each naming its rule and the JSON Pointer of the value", () => {
    const lacking = omit(grants(), "statementLanguage");
    const value = [
      legacyRow(ENGINE_A, { planted: 1, grants: grants({ exposable: "yes", sshTunnel: "" }) }),
      packageRow(ENGINE_B, { version: "1.2", extra: true }),
      { legacy: LEGACY_KEY, engine: "Engine-A", grants: lacking },
    ];

    expect(refusalLines(() => parseGrantRegister(value, SERVED))).toEqual([
      "wrong-type at /0/grants/exposable: the value is not of the type the schema defines here, boolean",
      "out-of-range at /0/grants/sshTunnel: the value is outside the length the schema allows here",
      'unknown-key at /0: the key "planted" is not one the schema defines here',
      "pattern-mismatch at /1/package/version: the value does not have the form the schema defines here",
      'unknown-key at /1/package: the key "extra" is not one the schema defines here',
      "pattern-mismatch at /2/engine: the value does not have the form the schema defines here",
      'missing-key at /2/grants: the key "statementLanguage" is missing, which the schema requires here',
    ]);
  });

  test("the code rules are read only once the schema admits the register", () => {
    expect(
      refusalLines(() => parseGrantRegister([legacyRow("enginec"), legacyRow("enginec", { x: 1 })], SERVED)),
    ).toEqual(['unknown-key at /1: the key "x" is not one the schema defines here']);
  });

  test("a row with neither or both of legacy and package is refused as no-variant", () => {
    const neither = omit(legacyRow(), "legacy");
    const both = { ...packageRow(), legacy: LEGACY_KEY };

    expect(refusalLines(() => parseGrantRegister([neither], SERVED))).toEqual([
      "no-variant at /0: the value does not have exactly one of the shapes the schema defines here",
    ]);
    expect(refusalLines(() => parseGrantRegister([both], SERVED))).toEqual([
      "no-variant at /0: the value does not have exactly one of the shapes the schema defines here",
    ]);
    expect(refusalLines(() => parseGrantRegister([legacyRow(ENGINE_A, { legacy: "@libredb/other" })], SERVED))).toEqual(
      ['value-not-allowed at /0/legacy: the value is not the one the schema allows here, "@libredb/studio"'],
    );
  });

  test("a package row granting a command redaction is refused by name, and a legacy row's is admitted", () => {
    const command = { redaction: { kind: "command", reader: "redactionReader" } } as const;

    expect(
      refusalLines(() => parseGrantRegister([packageRow(ENGINE_B, {}, { grants: grants(command) })], SERVED)),
    ).toEqual([
      "package-command-redaction at /0/grants/redaction: a package row grants no command redaction, since Studio binds a command reader only for an engine its legacy adapter serves",
    ]);
    const register = parseGrantRegister([legacyRow(ENGINE_A, { grants: grants(command) })], SERVED);
    expect(register.rowFor({ legacy: LEGACY_KEY, engine: ENGINE_A })?.grants.redaction).toEqual(command.redaction);
    // Vacuity: a package row granting a sql redaction is admitted.
    const sql = { redaction: { kind: "sql", nameQuote: '"' } };
    expect(() => parseGrantRegister([packageRow(ENGINE_B, {}, { grants: grants(sql) })], SERVED)).not.toThrow();
  });

  test("a SQL text member outside its vocabulary is refused at its pointer", () => {
    const rowWith = (overrides: Record<string, unknown>) => [legacyRow(ENGINE_A, { grants: grants(overrides) })];

    expect(
      refusalLines(() => parseGrantRegister(rowWith({ redaction: { kind: "sql", nameQuote: "'" } }), SERVED)),
    ).toEqual([
      `value-not-allowed at /0/grants/redaction: the value is not one the schema allows here, {"kind":"none"}, {"kind":"sql","nameQuote":"\\""}, {"kind":"sql","nameQuote":"\`"}, {"kind":"sql","nameQuote":"["}, {"kind":"sql","nameQuote":null}, {"kind":"command","reader":"redactionReader"}`,
    ]);
    expect(
      refusalLines(() => parseGrantRegister(rowWith({ confirmExemptForms: [["ALTER", "session"]] }), SERVED)),
    ).toEqual([
      "pattern-mismatch at /0/grants/confirmExemptForms/0/1: the value does not have the form the schema defines here",
    ]);
    expect(
      refusalLines(() => parseGrantRegister(rowWith({ confirmExemptForms: ["ALTER SESSION SET"] }), SERVED)),
    ).toEqual([
      "wrong-type at /0/grants/confirmExemptForms/0: the value is not of the type the schema defines here, array",
    ]);
    expect(
      refusalLines(() => parseGrantRegister(rowWith({ confirmExemptForms: [["ALTER"], ["ALTER"]] }), SERVED)),
    ).toEqual(["duplicate at /0/grants/confirmExemptForms/1: the item repeats an earlier item of its list"]);
    expect(refusalLines(() => parseGrantRegister(rowWith({ grammarSha256: "AB" }), SERVED))).toEqual([
      "pattern-mismatch at /0/grants/grammarSha256: the value does not have the form the schema defines here",
    ]);
    expect(
      refusalLines(() =>
        parseGrantRegister([legacyRow(ENGINE_A, { grants: omit(grants(), "grammarSha256") })], SERVED),
      ),
    ).toEqual(['missing-key at /0/grants: the key "grammarSha256" is missing, which the schema requires here']);
    expect(refusalLines(() => parseGrantRegister(rowWith({ languageSha256: "AB" }), SERVED))).toEqual([
      "pattern-mismatch at /0/grants/languageSha256: the value does not have the form the schema defines here",
    ]);
    expect(
      refusalLines(() =>
        parseGrantRegister([legacyRow(ENGINE_A, { grants: omit(grants(), "languageSha256") })], SERVED),
      ),
    ).toEqual(['missing-key at /0/grants: the key "languageSha256" is missing, which the schema requires here']);
    // Vacuity: a reviewed grammar's digest and an exempt form of keywords are admitted.
    const reviewed = {
      grammarSha256: hexDigest(),
      languageSha256: hexDigest(),
      confirmExemptForms: [["ALTER", "SESSION", "SET"]],
    };
    expect(() => parseGrantRegister(rowWith(reviewed), SERVED)).not.toThrow();
  });

  test("a package row granting readsSqlText false or decidesAlone true with no language digest is refused by name", () => {
    const line =
      "package-language-unreviewed at /0/grants/languageSha256: a package row grants a statement language other than SQL, readsSqlText false or decidesAlone true only with the digest of the statement language data it reviewed";
    const packageWith = (overrides: Record<string, unknown>) => [
      packageRow(ENGINE_B, {}, { grants: grants(overrides) }),
    ];

    expect(refusalLines(() => parseGrantRegister(packageWith({ readsSqlText: false }), SERVED))).toEqual([line]);
    expect(refusalLines(() => parseGrantRegister(packageWith({ decidesAlone: true }), SERVED))).toEqual([line]);
    // Both claims on one row are one refusal, at the one member that would admit them.
    expect(
      refusalLines(() => parseGrantRegister(packageWith({ readsSqlText: false, decidesAlone: true }), SERVED)),
    ).toEqual([line]);
    // It is reported together with every other refusal of the read.
    expect(
      refusalLines(() =>
        parseGrantRegister(
          [
            packageRow(ENGINE_B, {}, { grants: grants({ decidesAlone: true }) }),
            packageRow(ENGINE_A, {}, { grants: grants({ redaction: { kind: "command", reader: "redactionReader" } }) }),
          ],
          SERVED,
        ),
      ),
    ).toEqual([
      line,
      "package-command-redaction at /1/grants/redaction: a package row grants no command redaction, since Studio binds a command reader only for an engine its legacy adapter serves",
    ]);
    // Vacuity: a package row stating a language digest is admitted with both claims, and a legacy row with none.
    const reviewed = { readsSqlText: false, decidesAlone: true, languageSha256: hexDigest() };
    const admitted = parseGrantRegister(packageWith(reviewed), SERVED);
    expect(admitted).toBeDefined();
    expect(() =>
      parseGrantRegister(
        [legacyRow(ENGINE_A, { grants: grants({ readsSqlText: false, decidesAlone: true }) })],
        SERVED,
      ),
    ).not.toThrow();
    // A package row granting neither claim needs no language digest.
    expect(() => parseGrantRegister(packageWith({}), SERVED)).not.toThrow();
  });

  test("a package row granting a statement language other than SQL with a null digest is refused by name", () => {
    const line =
      "package-language-unreviewed at /0/grants/languageSha256: a package row grants a statement language other than SQL, readsSqlText false or decidesAlone true only with the digest of the statement language data it reviewed";
    const language = generatedLanguage();
    const packageWith = (overrides: Record<string, unknown>) => [
      packageRow(ENGINE_B, {}, { grants: grants(overrides) }),
    ];

    expect(refusalLines(() => parseGrantRegister(packageWith({ statementLanguage: language }), SERVED))).toEqual([
      line,
    ]);
    // With decidesAlone true as well, it is still one refusal, at the one member that would admit them.
    expect(
      refusalLines(() => parseGrantRegister(packageWith({ statementLanguage: language, decidesAlone: true }), SERVED)),
    ).toEqual([line]);
    // It is reported together with every other refusal of the read.
    expect(
      refusalLines(() =>
        parseGrantRegister(
          [
            packageRow(ENGINE_B, {}, { grants: grants({ statementLanguage: language }) }),
            packageRow(ENGINE_A, {}, { grants: grants({ redaction: { kind: "command", reader: "redactionReader" } }) }),
          ],
          SERVED,
        ),
      ),
    ).toEqual([
      line,
      "package-command-redaction at /1/grants/redaction: a package row grants no command redaction, since Studio binds a command reader only for an engine its legacy adapter serves",
    ]);
    // Vacuity: the same row with the digest of the language data it reviewed is admitted with its language.
    const reviewed = parseGrantRegister(
      packageWith({ statementLanguage: language, languageSha256: hexDigest() }),
      SERVED,
    );
    expect(reviewed.packageRows()[0]?.grants.statementLanguage).toBe(language);
    // SQL is stated as no statement language data (M-85), so a package row grants it with a null digest.
    expect(() => parseGrantRegister(packageWith({ statementLanguage: "sql" }), SERVED)).not.toThrow();
    // A legacy row's language is Studio's own module, reviewed with Studio's code.
    expect(() =>
      parseGrantRegister([legacyRow(ENGINE_A, { grants: grants({ statementLanguage: language }) })], SERVED),
    ).not.toThrow();
    // A package row granting no statement language needs no language digest.
    expect(() => parseGrantRegister(packageWith({ statementLanguage: null }), SERVED)).not.toThrow();
  });

  test("the statement language is a name of the form, and no row is refused for naming a language Studio has no module for", () => {
    const rowWith = (language: unknown) => [legacyRow(ENGINE_A, { grants: grants({ statementLanguage: language }) })];
    const form = "the value does not have the form the schema defines here";

    for (const language of ["SQL", "", "9ql", `a${"b".repeat(32)}`]) {
      expect(refusalLines(() => parseGrantRegister(rowWith(language), SERVED))).toEqual([
        `pattern-mismatch at /0/grants/statementLanguage: ${form}`,
      ]);
    }
    expect(refusalLines(() => parseGrantRegister(rowWith(1), SERVED))).toEqual([
      "wrong-type at /0/grants/statementLanguage: the value is not of the type the schema defines here, string or null",
    ]);
    // A language Studio has no module for, on a legacy row and on a package row, and the longest name of the form.
    for (const language of ["acmeql", `a${"b".repeat(31)}`]) {
      const register = parseGrantRegister(
        [
          legacyRow(ENGINE_A, { grants: grants({ statementLanguage: language }) }),
          packageRow(ENGINE_B, {}, { grants: grants({ statementLanguage: language, languageSha256: hexDigest() }) }),
        ],
        SERVED,
      );
      expect(register.rowFor({ legacy: LEGACY_KEY, engine: ENGINE_A })?.grants.statementLanguage).toBe(language);
      expect(register.packageRows()[0]?.grants.statementLanguage).toBe(language);
    }
  });

  test("a register that is not a list is refused at the top level", () => {
    expect(refusalLines(() => parseGrantRegister({ rows: [] }, SERVED))).toEqual([
      "wrong-type at the top level: the value is not of the type the schema defines here, array",
    ]);
  });
});

describe("answers", () => {
  test("a row is answered frozen, its lists and objects too, for its key, and none for a key the register holds no row for", () => {
    const value = [
      legacyRow(ENGINE_A, {
        grants: grants({
          hostPathFields: ["clientCertificatePath"],
          agentCredential: { form: "pair", supersededBy: ["apiKeyId"] },
          maskingExemptColumns: { column: "^a$", reason: "A planted reason." },
        }),
        reasons: { writeReach: "A planted review note." },
      }),
    ];
    const register = parseGrantRegister(value, SERVED);
    const row = register.rowFor({ legacy: LEGACY_KEY, engine: ENGINE_A });

    expect(row).toEqual(value[0] as never);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row?.grants)).toBe(true);
    expect(Object.isFrozen(row?.grants.hostPathFields)).toBe(true);
    expect(Object.isFrozen(row?.grants.agentCredential)).toBe(true);
    expect(Object.isFrozen(row?.grants.agentCredential?.supersededBy)).toBe(true);
    expect(Object.isFrozen(row?.grants.maskingExemptColumns)).toBe(true);
    expect(Object.isFrozen(row?.reasons)).toBe(true);
    expect(Object.isFrozen(value[0])).toBe(false);
    expect(register.rowFor({ legacy: LEGACY_KEY, engine: ENGINE_B })).toBeNull();
  });

  test("a package row is answered only for its exact name, version, digest and engine", () => {
    const key = { name: "@planted/provider-b", version: "1.2.3", digest: digest() };
    const register = parseGrantRegister([packageRow(ENGINE_B, key)], SERVED);

    const row = register.rowFor({ package: key, engine: ENGINE_B });
    if (row === null || !("package" in row)) throw new Error("the package row was not answered as a package row");
    expect(row.package).toEqual(key);
    expect(Object.isFrozen(row.package)).toBe(true);
    for (const other of [
      { package: { ...key, name: "@planted/provider-c" }, engine: ENGINE_B },
      { package: { ...key, version: "1.2.4" }, engine: ENGINE_B },
      { package: { ...key, digest: digest() }, engine: ENGINE_B },
      { package: key, engine: ENGINE_A },
      { legacy: LEGACY_KEY, engine: ENGINE_B } as const,
    ]) {
      expect(register.rowFor(other)).toBeNull();
    }
  });

  test("every package row is answered frozen, in the register's order, and no legacy row is among them", () => {
    const value = [legacyRow(), packageRow(ENGINE_B), legacyRow(ENGINE_B), packageRow(ENGINE_A)];
    const register = parseGrantRegister(value, SERVED);
    const rows = register.packageRows();

    expect(rows).toEqual([value[1], value[3]] as never);
    expect(Object.isFrozen(rows)).toBe(true);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.package)).toBe(true);
      expect(Object.isFrozen(row.grants)).toBe(true);
    }
    expect(register.packageRows()).toBe(rows);
    expect(parseGrantRegister([legacyRow(), legacyRow(ENGINE_B)], SERVED).packageRows()).toEqual([]);
  });

  test("the committed register is read through the same validation, with the engines of its legacy rows served", () => {
    const rows = committed as readonly { readonly engine: string; readonly legacy?: string }[];
    const served = rows.filter((row) => row.legacy !== undefined).map((row) => row.engine);
    const register = readGrantRegister(served);

    for (const engine of served) expect(register.rowFor({ legacy: LEGACY_KEY, engine })?.engine).toBe(engine);
    expect(LEGACY_KEY).toBe("@libredb/studio");
  });
});

describe("the schema reader", () => {
  const PLAIN = { type: "string" };

  /** The problem lines a schema is refused with, without the heading line. */
  function schemaProblemLines(schema: unknown): string[] {
    try {
      schemaRefusals(schema, "x");
    } catch (error) {
      const [heading, ...lines] = (error as Error).message.split("\n");
      expect(heading).toBe("The grant register's schema is refused:");
      return lines;
    }
    throw new Error("the schema was read without a problem");
  }

  test("the reader refuses a schema keyword it does not read, naming it", () => {
    expect(schemaProblemLines({ type: "string", format: "email" })).toEqual([
      'schema-keyword-unread at the top level: the keyword "format" is not one this reader reads',
    ]);
    expect(schemaProblemLines({ type: "object", properties: { a: { type: "string", minimum: 1 } } })).toEqual([
      'schema-keyword-unread at /properties/a: the keyword "minimum" is not one this reader reads',
    ]);
    expect(schemaProblemLines({ $defs: { a: { $id: "x" } } })).toEqual([
      'schema-keyword-unread at /$defs/a: the keyword "$id" is not one this reader reads',
    ]);
    expect(schemaProblemLines({ items: { anyOf: [] } })).toEqual([
      'schema-keyword-unread at /items: the keyword "anyOf" is not one this reader reads',
    ]);
  });

  test("the reader refuses a keyword it reads in a form it does not read, naming the keyword and the form", () => {
    const cases: [unknown, string][] = [
      [7, "schema-value-unread at the top level: a schema is read only as an object"],
      [{ properties: { a: true } }, "schema-value-unread at /properties/a: a schema is read only as an object"],
      [{ $defs: [] }, 'schema-value-unread at the top level: the keyword "$defs" is read only as an object of schemas'],
      [
        { $ref: "https://example.invalid/x" },
        'schema-value-unread at the top level: the keyword "$ref" is read only as a reference to a schema of the root\'s $defs, #/$defs/<name>',
      ],
      [
        { $ref: "#/$defs/missing" },
        'schema-value-unread at the top level: the keyword "$ref" is read only as a reference to a schema of the root\'s $defs, #/$defs/<name>',
      ],
      [
        { type: "number" },
        'schema-value-unread at the top level: the keyword "type" is read only as one or a list of object, array, string, boolean, null',
      ],
      [
        { type: [] },
        'schema-value-unread at the top level: the keyword "type" is read only as one or a list of object, array, string, boolean, null',
      ],
      [{ enum: "a" }, 'schema-value-unread at the top level: the keyword "enum" is read only as a list'],
      [
        { pattern: 1 },
        'schema-value-unread at the top level: the keyword "pattern" is read only as a string that compiles as a Unicode regular expression',
      ],
      [
        { minLength: -1 },
        'schema-value-unread at the top level: the keyword "minLength" is read only as a non-negative integer',
      ],
      [
        { maxLength: 1.5 },
        'schema-value-unread at the top level: the keyword "maxLength" is read only as a non-negative integer',
      ],
      [
        { required: [1] },
        'schema-value-unread at the top level: the keyword "required" is read only as a list of key names',
      ],
      [
        { additionalProperties: PLAIN },
        'schema-value-unread at the top level: the keyword "additionalProperties" is read only as false',
      ],
      [{ uniqueItems: false }, 'schema-value-unread at the top level: the keyword "uniqueItems" is read only as true'],
      [
        { properties: [] },
        'schema-value-unread at the top level: the keyword "properties" is read only as an object of schemas',
      ],
      [
        { oneOf: [] },
        'schema-value-unread at the top level: the keyword "oneOf" is read only as a list of branches that each hold only type "object" and required',
      ],
      [
        { oneOf: [{ type: "object", required: ["a"], properties: {} }] },
        'schema-value-unread at the top level: the keyword "oneOf" is read only as a list of branches that each hold only type "object" and required',
      ],
      [
        { oneOf: [{ type: "string", required: ["a"] }] },
        'schema-value-unread at the top level: the keyword "oneOf" is read only as a list of branches that each hold only type "object" and required',
      ],
    ];
    for (const [schema, line] of cases)
      expect({ schema, lines: schemaProblemLines(schema) }).toEqual({ schema, lines: [line] });
  });

  test("the reader refuses a $ref chain that returns to a schema it left, before it reads a value", () => {
    expect(
      schemaProblemLines({ $ref: "#/$defs/a", $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } } }),
    ).toEqual([
      "schema-ref-cycle at the top level: its $ref chain returns to a schema it left",
      "schema-ref-cycle at /$defs/a: its $ref chain returns to a schema it left",
      "schema-ref-cycle at /$defs/b: its $ref chain returns to a schema it left",
    ]);
    expect(schemaProblemLines({ $defs: { self: { type: "object", $ref: "#/$defs/self" } } })).toEqual([
      "schema-ref-cycle at /$defs/self: its $ref chain returns to a schema it left",
    ]);
  });

  test("the reader refuses a pattern that does not compile as a Unicode regular expression, before it reads a value", () => {
    const form = "a string that compiles as a Unicode regular expression";

    // "(" compiles in no mode; "\\-" compiles without the u flag but not with it, which is the mode a pattern is read in.
    expect(schemaProblemLines({ type: "string", pattern: "(" })).toEqual([
      `schema-value-unread at the top level: the keyword "pattern" is read only as ${form}`,
    ]);
    expect(schemaProblemLines({ type: "string", pattern: "\\-" })).toEqual([
      `schema-value-unread at the top level: the keyword "pattern" is read only as ${form}`,
    ]);
    // The value "x" never reaches the property's pattern, so the refusal comes from the schema, not from a value read.
    expect(schemaProblemLines({ type: "object", properties: { a: { type: "string", pattern: "[" } } })).toEqual([
      `schema-value-unread at /properties/a: the keyword "pattern" is read only as ${form}`,
    ]);
  });

  test("a $ref that reads into the value, as a list of lists, is no cycle", () => {
    const schema = { $ref: "#/$defs/list", $defs: { list: { type: "array", items: { $ref: "#/$defs/list" } } } };

    expect(schemaRefusals(schema, [[], [[]]])).toEqual([]);
    expect(schemaRefusals(schema, [[], ["x"]])).toEqual([
      {
        rule: "wrong-type",
        pointer: "/1/0",
        sentence: "the value is not of the type the schema defines here, array",
      },
    ]);
  });

  test("a pointer escapes ~ and / in a key, and a key on the prototype chain is no property", () => {
    const schema = { type: "object", properties: { "a/b~c": { type: "string" } }, additionalProperties: false };

    expect(schemaRefusals(schema, { "a/b~c": 1 })).toEqual([
      {
        rule: "wrong-type",
        pointer: "/a~1b~0c",
        sentence: "the value is not of the type the schema defines here, string",
      },
    ]);
    expect(schemaRefusals(schema, JSON.parse('{"toString": "x"}'))).toEqual([
      { rule: "unknown-key", pointer: "", sentence: 'the key "toString" is not one the schema defines here' },
    ]);
  });

  test("a string's length is counted in code points, and an object is compared as a JSON value", () => {
    expect(schemaRefusals({ type: "string", maxLength: 1 }, "\u{1F600}")).toEqual([]);
    expect(schemaRefusals({ type: "string", minLength: 2 }, "\u{1F600}")).toHaveLength(1);
    expect(schemaRefusals({ const: { a: [1, { b: null }] } }, { a: [1, { b: null }] })).toEqual([]);
    expect(schemaRefusals({ const: { a: [1] } }, { a: [1, 2] })).toHaveLength(1);
    expect(schemaRefusals({ const: { a: 1 } }, { b: 1 })).toHaveLength(1);
    expect(schemaRefusals({ const: { a: 1 } }, [1])).toHaveLength(1);
    expect(schemaRefusals({ type: "array", uniqueItems: true }, [{ a: 1 }, { a: 1 }])).toEqual([
      { rule: "duplicate", pointer: "/1", sentence: "the item repeats an earlier item of its list" },
    ]);
  });
});
