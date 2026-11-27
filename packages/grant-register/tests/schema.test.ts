/**
 * The grant register's schema: closed at every object, every grant member required, and read by the package's reader
 * exactly as ajv reads it. ajv runs here only, in the tests: the reader reads the schema without compiling code, so it
 * runs where ajv cannot (src/schema-subset.ts). Every engine id here is synthetic and every digest generated at run
 * time.
 */
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import schema from "../src/register.schema.json";
import { parseGrantRegister } from "../src/index";
import { schemaRefusals } from "../src/schema-subset";
import { digest, ENGINE_A, grants, legacyRow, omit, packageRow } from "./helpers/rows";

type Node = Record<string, unknown>;

const GRANT_MEMBERS = Object.keys(grants());

/** Every schema node of the register's schema with its pointer, branches of `oneOf` apart. */
function nodes(node: Node, pointer: string, out: [string, Node][] = []): [string, Node][] {
  out.push([pointer, node]);
  for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, Node>)) {
    nodes(child, `${pointer}/properties/${key}`, out);
  }
  if (node.items !== undefined) nodes(node.items as Node, `${pointer}/items`, out);
  for (const [key, child] of Object.entries((node.$defs ?? {}) as Record<string, Node>)) {
    nodes(child, `${pointer}/$defs/${key}`, out);
  }
  return out;
}

/** The refusal lines of `value`, without the heading line, or none where it is read. */
function refusalLines(value: unknown): string[] {
  try {
    parseGrantRegister(value, [ENGINE_A]);
    return [];
  } catch (error) {
    return (error as Error).message.split("\n").slice(1);
  }
}

describe("the schema is closed", () => {
  test("the schema is closed: an unknown member of a row or of its grants is refused", () => {
    const planted = { planted: true };
    const cases: [unknown, string][] = [
      [[legacyRow(ENGINE_A, planted)], "/0"],
      [[legacyRow(ENGINE_A, { grants: grants(planted) })], "/0/grants"],
      [[packageRow(ENGINE_A, planted)], "/0/package"],
      [
        [legacyRow(ENGINE_A, { grants: grants({ maskingExemptColumns: { column: "^a$", reason: "r", ...planted } }) })],
        "/0/grants/maskingExemptColumns",
      ],
      [
        [legacyRow(ENGINE_A, { grants: grants({ agentCredential: { form: "pair", supersededBy: [], ...planted } }) })],
        "/0/grants/agentCredential",
      ],
      [[legacyRow(ENGINE_A, { reasons: { writeReach: "r", ...planted } })], "/0/reasons"],
    ];
    for (const [value, pointer] of cases) {
      expect({ pointer, lines: refusalLines(value) }).toEqual({
        pointer,
        lines: [`unknown-key at ${pointer}: the key "planted" is not one the schema defines here`],
      });
    }
  });

  test("every object schema is closed and every grant member is required", () => {
    const all = nodes(schema as Node, "");
    const objects = all.filter(
      ([, node]) =>
        node.properties !== undefined ||
        node.type === "object" ||
        (node.type as unknown[] | undefined)?.includes?.("object"),
    );

    expect(objects.map(([pointer]) => pointer).sort()).toEqual(
      [
        "/$defs/row",
        "/$defs/packageKey",
        "/$defs/grants",
        "/$defs/grants/properties/maskingExemptColumns",
        "/$defs/grants/properties/agentCredential",
        "/$defs/reasons",
      ].sort(),
    );
    for (const [pointer, node] of objects) {
      expect({ pointer, closed: node.additionalProperties }).toEqual({ pointer, closed: false });
    }
    const defs = (schema as Node).$defs as Record<string, Node>;
    expect(Object.keys(defs.grants?.properties as object)).toEqual(GRANT_MEMBERS);
    expect(defs.grants?.required).toEqual(GRANT_MEMBERS);
    expect(Object.keys(defs.reasons?.properties as object)).toEqual(GRANT_MEMBERS);
    expect(defs.reasons?.required).toBeUndefined();
    for (const [member, node] of Object.entries(defs.grants?.properties as Record<string, Node>)) {
      expect({ member, described: typeof node.description === "string" }).toEqual({ member, described: true });
    }
    expect(defs.packageKey?.required).toEqual(["name", "version", "digest"]);
    expect(defs.row?.required).toEqual(["engine", "grants"]);
  });
});

describe("the reader and ajv", () => {
  // Strict, as the SDK's validator is, but for two options the schema's form needs: a member may be a string or null
  // (`allowUnionTypes`), and each `oneOf` branch requires a key the row's own `properties` defines beside it, which
  // `strictRequired` looks for in the branch alone.
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, strictRequired: false, allErrors: true });
  const validate = ajv.compile(schema);

  /** Each fixture: a name and a register, built from one valid legacy row and one valid package row. */
  function fixtures(): [string, unknown][] {
    const out: [string, unknown][] = [
      ["a valid legacy row", [legacyRow()]],
      ["a valid package row", [packageRow()]],
      ["an empty register", []],
      ["a register that is an object", {}],
      ["a row that is a list", [[]]],
      ["a row with neither key", [{ engine: ENGINE_A, grants: grants() }]],
      ["a row with both keys", [{ ...packageRow(), legacy: "@libredb/studio" }]],
      ["another legacy key", [legacyRow(ENGINE_A, { legacy: "@libredb/other" })]],
      ["an engine id in capitals", [legacyRow("EngineA")]],
      ["an engine id of 33 characters", [legacyRow(`e${"a".repeat(32)}`)]],
      ["an engine id of 32 characters", [legacyRow(`e${"a".repeat(31)}`)]],
      ["a row without grants", [{ legacy: "@libredb/studio", engine: ENGINE_A }]],
      ["a row without an engine", [{ legacy: "@libredb/studio", grants: grants() }]],
      ["a digest in capitals", [packageRow(ENGINE_A, { digest: digest().toUpperCase() })]],
      ["a digest without its algorithm", [packageRow(ENGINE_A, { digest: digest().slice(7) })]],
      ["a digest too short", [packageRow(ENGINE_A, { digest: digest().slice(0, 70) })]],
      ["a digest with a newline", [packageRow(ENGINE_A, { digest: `${digest()}\n` })]],
      ["a version range", [packageRow(ENGINE_A, { version: "^1.2.3" })]],
      ["a prerelease version", [packageRow(ENGINE_A, { version: "1.2.3-rc.1" })]],
      ["a version with a leading zero", [packageRow(ENGINE_A, { version: "01.2.3" })]],
      ["an unscoped name", [packageRow(ENGINE_A, { name: "provider-b" })]],
      ["a name in capitals", [packageRow(ENGINE_A, { name: "@Planted/provider-b" })]],
      ["a name of 215 characters", [packageRow(ENGINE_A, { name: `a${"b".repeat(214)}` })]],
      ["a package without a digest", [{ ...packageRow(), package: { name: "p", version: "1.0.0" } }]],
      ["a package that is a string", [{ ...packageRow(), package: "p" }]],
      ["two rows", [legacyRow(), packageRow()]],
      ["an empty reasons object", [legacyRow(ENGINE_A, { reasons: {} })]],
      [
        "a reason for every member",
        [legacyRow(ENGINE_A, { reasons: Object.fromEntries(GRANT_MEMBERS.map((m) => [m, "r"])) })],
      ],
      ["an empty reason", [legacyRow(ENGINE_A, { reasons: { writeReach: "" } })]],
      ["a reason that is not a string", [legacyRow(ENGINE_A, { reasons: { writeReach: 1 } })]],
      ["reasons that are a list", [legacyRow(ENGINE_A, { reasons: [] })]],
    ];
    const values: Record<string, unknown[]> = {
      writeReach: ["guarded", "none", "wide", null, true],
      readsFileAccessPosture: [true, null, "true", 0],
      deniedFileAccessRefusal: ["A sentence.", "", 1, false],
      singleWriterFile: [true, null],
      readRootsRequired: [true, "false"],
      agentCredentialForm: ["token", "service-account-key", "dedicated-user", "none", "pair", 1],
      maskingExemptColumns: [
        { column: "^a$", reason: "r" },
        { column: "^a$" },
        { column: "", reason: "r" },
        { column: "^a$", reason: 1 },
        [],
        "^a$",
      ],
      exposable: [false, null],
      statementRead: [true, 1],
      metadataReadChangesState: [true, []],
      agentCredentialRequired: [true, {}],
      opensLocalFile: [true, "yes"],
      hostPathFields: [
        ["clientCertificatePath", "clientPrivateKeyPath"],
        ["clientPrivateKeyPath"],
        ["clientCertificatePath", "clientCertificatePath"],
        ["host"],
        [1],
        "clientCertificatePath",
        null,
      ],
      serverLevelWithoutDatabase: [true, null],
      sshTunnel: ["A sentence.", "", [], true],
      agentCredential: [
        { form: "pair", supersededBy: [] },
        { form: "dedicated-pair", supersededBy: ["apiKeyId", "apiKeySecret"] },
        { form: "secret", supersededBy: [] },
        { form: "secret", supersededBy: ["a", "a"] },
        { form: "secret", supersededBy: [""] },
        { form: "secret", supersededBy: [1] },
        { form: "token", supersededBy: [] },
        { form: "pair" },
        { supersededBy: [] },
        "pair",
      ],
      statementLanguage: ["sql", "sparkplugread", "mongo", "SQL", "", 1],
      agentReadings: [["health"], [], ["sessions", "health"], ["health", "health"], ["locks"], "health", null],
      catalogReadCommandShaped: [true, null],
      servesOneSession: ["A sentence.", "", 1],
      agentExecution: [true, null],
      ownWords: ["code-only", "scrubbed ", null],
    };
    for (const member of GRANT_MEMBERS) {
      out.push([`grants without ${member}`, [legacyRow(ENGINE_A, { grants: omit(grants(), member) })]]);
      for (const value of values[member] ?? []) {
        out.push([
          `${member} ${JSON.stringify(value)} on a legacy row`,
          [legacyRow(ENGINE_A, { grants: grants({ [member]: value }) })],
        ]);
        out.push([
          `${member} ${JSON.stringify(value)} on a package row`,
          [packageRow(ENGINE_A, {}, { grants: grants({ [member]: value }) })],
        ]);
      }
    }
    return out;
  }

  test("the reader and ajv agree on every fixture: what the schema admits the reader admits, and what it refuses the reader refuses", () => {
    const all = fixtures();
    let admitted = 0;
    for (const [name, value] of all) {
      const byAjv = validate(value) === true;
      const byReader = schemaRefusals(schema, value).length === 0;
      if (byAjv) admitted += 1;
      expect({ name, byReader }).toEqual({ name, byReader: byAjv });
    }
    expect(admitted).toBeGreaterThan(30);
    expect(all.length - admitted).toBeGreaterThan(80);
  });
});
