/**
 * The grant register's legacy rows (packages/grant-register/src/register.json) against the hand-written records Studio
 * still keeps in core: one legacy row for every engine the legacy adapter serves, each member a record answers equal to
 * the engine's row of that record, each review note of such a member equal to the comment above that row, and the
 * grants `grantClaims` computes from the rows equal to the grants it computes from `STUDIO_CLAIM_RECORDS`, for every
 * claim and every engine.
 *
 * The rows were written once from the records and are hand-reviewed data from then on, never a projection of a
 * declaration; while a record and its member's rows both exist, this census holds them equal, so the change that
 * deletes the record reads the register in its place with no grant changed. A member whose record is deleted is on
 * `REGISTER_ONLY`: the register is its only copy, and its review notes are the register's own. It lives in core, not
 * in the package's tests, because a package imports nothing of Studio's.
 *
 * A record row's review note is the text of the comments the TypeScript compiler attaches to the row as leading
 * comments, each comment's text after its `//`, trimmed, joined with one space.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LEGACY_KEY, type RegisterGrants, type RegisterRow, readGrantRegister } from "@libredb/grant-register";
import registerSchema from "@libredb/grant-register/register.schema.json";
import ts from "typescript";
import {
  type ClaimRecords,
  grantClaims,
  HOST_PATH_FIELD_NAMES,
  legacyAgentCredentials,
  STATEMENT_LANGUAGE_NAMES,
  STUDIO_CLAIM_RECORDS,
} from "@/lib/db/claim-grants";
import {
  AGENT_EXECUTION_ENGINES,
  AGENT_STATEMENT_LANGUAGE,
  HOST_PATH_FIELDS,
  OPENS_LOCAL_FILE,
  OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  SERVES_ONE_SESSION,
  SSH_TUNNEL_REFUSAL,
} from "@/lib/db/compatibility";
import { CONNECTION_FIELDS, SEED_AGENT_CREDENTIAL, SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import { BUNDLED_CLAIM_REQUESTS } from "@/lib/db/engine-catalog/claims.generated";
import { ENGINE_FACETS } from "@/lib/db/engine-facets";
import {
  DIGEST_FORM,
  ENGINE_ID_FORM,
  PACKAGE_NAME_FORM,
  PACKAGE_VERSION_FORM,
} from "@/lib/provider-host/providers-lock-format";
import { LEGACY_ENGINE_IDS, LEGACY_SOURCE_NAME } from "@/lib/provider-host/legacy-adapter/identity";
import { LEGACY_OFFERS } from "@/lib/provider-host/legacy-adapter/records";
import { namingPattern } from "../../../scripts/isolation-ratchet";

const ROOT = path.resolve(import.meta.dir, "../../..");
const REGISTER_PACKAGE = "packages/grant-register";

type Member = keyof RegisterGrants;

/**
 * The grant members whose hand-written record core no longer keeps: the grant register's legacy rows are their only
 * copy, read by the grant reader, so no record is compared with them here. A closed list, which only grows as records
 * leave core.
 */
const REGISTER_ONLY = [
  "writeReach",
  "readsFileAccessPosture",
  "deniedFileAccessRefusal",
  "singleWriterFile",
  "readRootsRequired",
  "agentCredentialForm",
  "maskingExemptColumns",
  "exposable",
  "statementRead",
  "metadataReadChangesState",
  "agentCredentialRequired",
] as const satisfies readonly Member[];

/** The members held equal to a record here: every grant member but the register-only ones and `ownWords`. */
type RecordMember = Exclude<Member, "ownWords" | (typeof REGISTER_ONLY)[number]>;

/** Each grant member read from a keyed record: the record's name, its module and its rows. */
const KEYED: Readonly<Record<Exclude<RecordMember, "agentExecution">, readonly [string, string, unknown]>> = {
  opensLocalFile: ["OPENS_LOCAL_FILE", "src/lib/db/compatibility.ts", OPENS_LOCAL_FILE],
  hostPathFields: ["HOST_PATH_FIELDS", "src/lib/db/compatibility.ts", HOST_PATH_FIELDS],
  serverLevelWithoutDatabase: [
    "OPENS_SERVER_LEVEL_WITHOUT_DATABASE",
    "src/lib/db/compatibility.ts",
    OPENS_SERVER_LEVEL_WITHOUT_DATABASE,
  ],
  sshTunnel: ["SSH_TUNNEL_REFUSAL", "src/lib/db/compatibility.ts", SSH_TUNNEL_REFUSAL],
  agentCredential: ["SEED_AGENT_CREDENTIAL", "src/lib/db/connection-fields.ts", SEED_AGENT_CREDENTIAL],
  statementLanguage: ["AGENT_STATEMENT_LANGUAGE", "src/lib/db/compatibility.ts", AGENT_STATEMENT_LANGUAGE],
  servesOneSession: ["SERVES_ONE_SESSION", "src/lib/db/compatibility.ts", SERVES_ONE_SESSION],
};

/** The value Studio's records hold for `member` of `engine`. */
function recordValue(member: RecordMember | "ownWords", engine: string): unknown {
  if (member === "agentExecution") return (AGENT_EXECUTION_ENGINES as readonly string[]).includes(engine);
  if (member === "ownWords") return LEGACY_OFFERS.ownWords;
  const rows = KEYED[member][2] as Readonly<Record<string, unknown>>;
  if (!Object.hasOwn(rows, engine)) throw new Error(`${KEYED[member][0]} holds no row for ${engine}`);
  return rows[engine];
}

/** Every legacy row, in the legacy adapter's order, refusing by name an engine the register holds no row for. */
function legacyRows(): RegisterRow[] {
  const register = readGrantRegister(LEGACY_ENGINE_IDS);
  return LEGACY_ENGINE_IDS.map((engine) => {
    const row = register.rowFor({ legacy: LEGACY_KEY, engine });
    if (row === null) throw new Error(`the grant register holds no legacy row for ${engine}`);
    return row;
  });
}

/** The review note of each row of each record: engine to member to note. */
function recordNotes(): Map<string, Partial<Record<RecordMember, string>>> {
  const notes = new Map<string, Partial<Record<RecordMember, string>>>();
  const byModule = new Map<string, [string, RecordMember][]>();
  for (const [member, [name, module]] of Object.entries(KEYED) as [
    RecordMember,
    readonly [string, string, unknown],
  ][]) {
    byModule.set(module, [...(byModule.get(module) ?? []), [name, member]]);
  }
  const compatibility = byModule.get("src/lib/db/compatibility.ts");
  if (compatibility === undefined) throw new Error("no keyed record is read from src/lib/db/compatibility.ts");
  compatibility.push(["AGENT_EXECUTION_ENGINES", "agentExecution"]);
  for (const [module, records] of byModule) {
    const text = readFileSync(path.join(ROOT, module), "utf8");
    const source = ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
    for (const [name, member] of records) {
      const literal = recordLiteral(source, name);
      const elements: readonly ts.Node[] = ts.isObjectLiteralExpression(literal)
        ? literal.properties
        : literal.elements;
      for (const element of elements) {
        const engine = rowEngine(element, source);
        const comments = ts.getLeadingCommentRanges(text, element.getFullStart()) ?? [];
        if (comments.length === 0) continue;
        const note = comments
          .map((range) =>
            text
              .slice(range.pos, range.end)
              .replace(/^\/\/|^\/\*|\*\/$/g, "")
              .trim(),
          )
          .join(" ");
        notes.set(engine, { ...notes.get(engine), [member]: note });
      }
    }
  }
  return notes;
}

/** The object or array literal a record's declaration holds, through `Object.freeze(...)` and `as const`. */
function recordLiteral(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(source) !== name || declaration.initializer === undefined) continue;
      const literal = firstLiteral(declaration.initializer);
      if (literal !== undefined) return literal;
    }
  }
  throw new Error(`${source.fileName} declares no record literal named ${name}`);
}

function firstLiteral(node: ts.Node): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) return node;
  return ts.forEachChild(node, firstLiteral);
}

/** The engine a record row is for: an object member's name, or a list element's string. */
function rowEngine(element: ts.Node, source: ts.SourceFile): string {
  if (ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) {
    return element.name.getText(source).replace(/^["']|["']$/g, "");
  }
  if (ts.isStringLiteral(element)) return element.text;
  throw new Error(`a record row of ${source.fileName} is neither a member nor a string: ${element.getText(source)}`);
}

describe("the legacy rows", () => {
  test("every legacy row's grants equal the engine's row of each record Studio still keeps in core, for every engine the legacy adapter serves", () => {
    const rows = legacyRows();
    const compared: readonly (RecordMember | "ownWords")[] = [
      ...(Object.keys(KEYED) as RecordMember[]),
      "agentExecution",
      "ownWords",
    ];

    expect(rows.map((row) => row.engine)).toEqual([...LEGACY_ENGINE_IDS]);
    for (const row of rows) {
      for (const member of compared) {
        expect({ engine: row.engine, member, value: row.grants[member] }).toEqual({
          engine: row.engine,
          member,
          value: recordValue(member, row.engine) as never,
        });
      }
      expect({ engine: row.engine, members: Object.keys(row.grants).sort() }).toEqual({
        engine: row.engine,
        members: [...compared, ...REGISTER_ONLY].sort(),
      });
    }
  });

  test("every row comment of the records Studio still keeps in core is the reason the register holds for that engine and member", () => {
    const notes = recordNotes();
    const compared = new Set<string>([...Object.keys(KEYED), "agentExecution"]);

    expect([...notes.keys()].filter((engine) => !LEGACY_ENGINE_IDS.includes(engine))).toEqual([]);
    for (const row of legacyRows()) {
      const reasons = Object.fromEntries(Object.entries(row.reasons ?? {}).filter(([member]) => compared.has(member)));
      expect({ engine: row.engine, reasons }).toEqual({
        engine: row.engine,
        reasons: notes.get(row.engine) ?? {},
      });
    }
  });

  test("the grants computed from the legacy rows equal Studio's grant of every claim for every engine the legacy adapter serves", () => {
    const rows = legacyRows();
    // Typed by RegisterGrants, so the compiler holds each member's register type assignable to Studio's record.
    const record = <M extends keyof RegisterGrants>(member: M): Readonly<Record<string, RegisterGrants[M]>> =>
      Object.fromEntries(rows.map((row) => [row.engine, row.grants[member]]));
    const fromRows: ClaimRecords = {
      writeReach: record("writeReach"),
      readsFileAccessPosture: record("readsFileAccessPosture"),
      deniedFileAccessRefusal: record("deniedFileAccessRefusal"),
      singleWriterFile: record("singleWriterFile"),
      readRootsRequired: record("readRootsRequired"),
      agentCredentialForm: record("agentCredentialForm"),
      maskingExemptColumns: record("maskingExemptColumns"),
      exposable: record("exposable"),
      statementRead: record("statementRead"),
      metadataReadChangesState: record("metadataReadChangesState"),
      agentCredentialRequired: record("agentCredentialRequired"),
      opensLocalFile: record("opensLocalFile"),
      hostPathFields: record("hostPathFields"),
      serverLevelWithoutDatabase: record("serverLevelWithoutDatabase"),
      sshTunnel: record("sshTunnel"),
      agentCredential: legacyAgentCredentials(
        Object.fromEntries(rows.map((row) => [row.engine, row.grants])),
        CONNECTION_FIELDS,
      ),
      statementLanguage: record("statementLanguage"),
      agentReadings: ENGINE_FACETS,
    };
    const fromRegister = grantClaims(BUNDLED_CLAIM_REQUESTS, fromRows, SEED_ONLY_FIELDS);
    const fromRecords = grantClaims(BUNDLED_CLAIM_REQUESTS, STUDIO_CLAIM_RECORDS, SEED_ONLY_FIELDS);

    expect(Object.keys(fromRecords)).toHaveLength(21);
    for (const member of Object.keys(fromRecords) as (keyof typeof fromRecords)[]) {
      expect(Object.keys(fromRegister[member])).toEqual([...LEGACY_ENGINE_IDS]);
      for (const engine of LEGACY_ENGINE_IDS) {
        const at = engine as keyof typeof BUNDLED_CLAIM_REQUESTS;
        expect({ member, engine, grant: fromRegister[member][at] }).toEqual({
          member,
          engine,
          grant: fromRecords[member][at] as never,
        });
      }
    }
  });
});

describe("the register's forms", () => {
  const defs = registerSchema.$defs;

  test("the register's legacy key is the legacy adapter's source name, and its key patterns are the lock's", () => {
    expect(LEGACY_KEY).toBe(LEGACY_SOURCE_NAME);
    expect(defs.row.properties.legacy.const).toBe(LEGACY_SOURCE_NAME);
    const forms = [
      [defs.packageKey.properties.name, PACKAGE_NAME_FORM],
      [defs.packageKey.properties.version, PACKAGE_VERSION_FORM],
      [defs.packageKey.properties.digest, DIGEST_FORM],
      [defs.row.properties.engine, ENGINE_ID_FORM],
    ] as const;
    for (const [property, form] of forms) {
      expect({ pattern: property.pattern, maxLength: property.maxLength }).toEqual({
        pattern: form.pattern.source,
        maxLength: form.maxLength,
      });
    }
  });

  test("the register's vocabularies are the grant reader's", () => {
    expect(defs.grants.properties.statementLanguage.enum).toEqual([...STATEMENT_LANGUAGE_NAMES, null]);
    expect(defs.grants.properties.hostPathFields.items.enum).toEqual([...HOST_PATH_FIELD_NAMES]);
  });

  test("the register package names an engine only on a legacy row's engine line or in a row's review note", () => {
    const declared = readdirSync(path.join(ROOT, "src/lib/db/engine-declarations"))
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.slice(0, -".json".length));
    const pattern = namingPattern(declared);
    const directory = path.join(ROOT, REGISTER_PACKAGE);
    const files = readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .filter((file) => !file.startsWith("tests/"))
      .sort();
    const naming: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(path.join(directory, file), "utf8").split("\n")) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) naming.push(`${file}: ${line.trim()}`);
      }
    }

    // A review note is the record row's comment word for word, or the register's own note of a register-only member,
    // so it may name another engine; no grant value, schema line or reader line does.
    const notes = new Set(
      legacyRows().flatMap((row) =>
        Object.entries(row.reasons ?? {}).flatMap(([member, note]) => {
          const line = `src/register.json: ${JSON.stringify(member)}: ${JSON.stringify(note)}`;
          return [line, `${line},`];
        }),
      ),
    );

    expect(naming.filter((line) => !notes.has(line))).toEqual(
      LEGACY_ENGINE_IDS.map((engine) => `src/register.json: "engine": "${engine}",`),
    );
  });
});
