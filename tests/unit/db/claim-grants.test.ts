/**
 * Studio's grant of each policy, MCP, connection and agent mode claim (docs/providers/CONTRACT.md, clauses M-54, M-82
 * and M-83): the more restrictive of an engine's request and Studio's review of the claim for the engine, which
 * src/lib/db/claim-grants.ts states, the claim's restrictive value where no review row exists, by one rule per claim
 * shape. `grantEngineClaims`, the one per-engine call of the grant reader, is read here with hand-made requests and
 * register rows, each a shipped engine's legacy row with members changed, or no row for an id no shipped engine uses,
 * and the bundled grant tables are read against the register's legacy rows for every shipped engine.
 * `legacyGrantRows`, which reads the grant register's legacy rows the legacy engines are granted from, is read against
 * a register of two rows of the committed one, and `legacyAgentCredentials`, which narrows a row's agent credential to
 * the text fields a connection form draws, against committed rows and rows changed by hand.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  LEGACY_KEY,
  parseGrantRegister,
  type RegisterGrants,
  type RegisterRow,
  readGrantRegister,
} from "@libredb/grant-register";
import type { StatementRedaction } from "@libredb/provider-sdk/manifest";
import type { McpClaims, PolicyClaims } from "@libredb/provider-sdk/manifest";
import { engineServerDialect } from "@/lib/agent/languages/engines/server";
import {
  AGENT_READING_NAMES,
  type EngineGrants,
  GRANTED_AGENT_EXECUTION_ENGINES,
  GRANTED_AGENT_READINGS,
  GRANTED_AGENT_STATEMENT_LANGUAGE,
  GRANTED_SSH_TUNNEL_REFUSAL,
  GRANTED_WRITE_REACH,
  grantEngineClaims,
  grantedCatalogReadCommand,
  type LanguageDataRequest,
  HOST_PATH_FIELD_NAMES,
  legacyAgentCredentials,
  legacyEngineGrants,
  legacyGrantRows,
  type SqlTextRequest,
  STATEMENT_LANGUAGE_NAME_FORM,
  STUDIO_GRANT_REGISTER,
  type StatementLanguageRequest,
  UNGRANTED_DENIED_FILE_ACCESS_SENTENCE,
  UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
  UNGRANTED_SSH_TUNNEL_SENTENCE,
} from "@/lib/db/claim-grants";
import * as claimGrants from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BODY_CONNECTION_FIELDS, SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import { BUNDLED_CLAIM_REQUESTS } from "@/lib/db/engine-catalog/claims.generated";
import { BUNDLED_SQL_TEXT } from "@/lib/db/engine-catalog/sql-text.generated";
import { CURATED_OPERATION_KINDS } from "@/lib/db/operations/descriptors";
import { forgetServerCatalog, installServerCatalog, serverEngine } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import type { AgentClaims, ClaimRequestEntry, ConnectionClaims, FacetClaims } from "@/lib/db/engine-catalog/projection";
import type { DatabaseType } from "@/lib/types";
import { CLAIM_GRANTS, CORE_GRANT_RECORDS } from "../../helpers/core-grant-records";
import {
  legacyAgentCredentialTable,
  legacyRegisterTable,
  legacyStatementLanguageTable,
} from "../../helpers/legacy-register";
import { admittedFor, admittedManifest, withLoosestClaims } from "../../helpers/package-catalog";
import { type Input, moduleOf, valueInputs } from "../../helpers/value-inputs";
import {
  claim,
  ENGINE_TABLE_INVENTORY,
  type InventoryEntry,
  REVIEW_RECORD_PHRASE,
} from "./engine-declarations/inventory";

/** An id no shipped engine uses, for a request no register row covers. */
const UNRECORDED = "acmefoo";

/** Every shipped engine's legacy row of the committed register, read once for the file. */
const LEGACY_ROWS = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), SHIPPED_DATABASE_TYPES);

/** The legacy row of shipped engine `engine`, from `LEGACY_ROWS`. */
function legacyRow(engine: string): RegisterRow {
  if (!Object.hasOwn(LEGACY_ROWS, engine)) throw new Error(`${engine} has no legacy row`);
  return LEGACY_ROWS[engine];
}

/** postgres's requests, the base every hand-made request changes one claim of. */
const BASE: ClaimRequestEntry = BUNDLED_CLAIM_REQUESTS.postgres;

/** One engine's requests: postgres's with `policy`, `mcp`, `connection`, `facets` and `agent` members changed. */
function request(
  policy: Partial<PolicyClaims> = {},
  mcp: Partial<McpClaims> = {},
  connection: Partial<ConnectionClaims> = {},
  facets: Partial<FacetClaims> = {},
  agent: Partial<AgentClaims> = {},
): ClaimRequestEntry {
  return {
    policy: { ...BASE.policy, ...policy },
    mcp: { ...BASE.mcp, ...mcp },
    connection: { ...BASE.connection, ...connection },
    facets: { ...BASE.facets, ...facets },
    agent: { ...BASE.agent, ...agent },
  };
}

/** The seed-only fields `grantEngineClaims` reads the restrictive host path fields from: the shipped ones by default. */
type SeedOnlyRows = Parameters<typeof grantEngineClaims>[5];

/**
 * The SQL text request of `engine` as the grant reader makes a legacy engine's: its bundled readsSqlText and exempt
 * forms, and its legacy row's redaction and grammar digest.
 *
 * @throws {Error} Naming the id, for an id with no legacy row: a mistyped or removed engine id fails its test rather
 * than reading another engine's request.
 */
function legacySqlText(engine: string): SqlTextRequest {
  if (!Object.hasOwn(LEGACY_ROWS, engine)) {
    throw new Error(`legacySqlText: ${engine} has no legacy row, so it has no legacy SQL text request`);
  }
  const id = engine as DatabaseType;
  const { grants } = legacyRow(id);
  return {
    readsSqlText: BUNDLED_SQL_TEXT[id].readsSqlText,
    confirmExemptForms: BUNDLED_SQL_TEXT[id].grammar.confirmExemptForms,
    redaction: grants.redaction,
    grammarSha256: grants.grammarSha256,
  };
}

/**
 * The SQL text request of `UNRECORDED`, which has no bundled SQL text: its claims at their restrictive values and no
 * grammar digest, so no row grants them.
 */
const UNRECORDED_SQL_TEXT: SqlTextRequest = {
  readsSqlText: true,
  confirmExemptForms: [],
  redaction: { kind: "none" },
  grammarSha256: null,
};

/**
 * The statement language data request `grantOf` hands for `engine`, as the grant reader makes a legacy engine's: its
 * legacy row's language digest, and none for an id with no legacy row.
 */
function languageDataOf(engine: string): LanguageDataRequest {
  return { languageSha256: Object.hasOwn(LEGACY_ROWS, engine) ? legacyRow(engine).grants.languageSha256 : null };
}

/** The SQL text request `grantOf` hands for `engine`: `UNRECORDED_SQL_TEXT` for `UNRECORDED`, its legacy one else. */
function sqlTextOf(engine: string): SqlTextRequest {
  return engine === UNRECORDED ? UNRECORDED_SQL_TEXT : legacySqlText(engine);
}

/** The legacy row of `engine`, or null for an id with none. */
function shippedRow(engine: string): RegisterRow | null {
  return Object.hasOwn(LEGACY_ROWS, engine) ? legacyRow(engine) : null;
}

/**
 * A legacy-keyed register row for `engine`: its legacy row, or postgres's for an id with none, keyed to `engine`, with
 * the grants `changes` names changed.
 */
function rowWith(engine: string, changes: Partial<RegisterGrants> = {}): RegisterRow {
  const base = Object.hasOwn(LEGACY_ROWS, engine) ? legacyRow(engine) : legacyRow("postgres");
  return { legacy: LEGACY_KEY, engine, grants: { ...base.grants, ...changes } };
}

/** Member `member` of each shipped engine's grants, keyed by engine, as every legacy record holds them. */
function legacyGrantTable<M extends keyof EngineGrants>(member: M): Readonly<Record<string, EngineGrants[M]>> {
  return Object.fromEntries(SHIPPED_DATABASE_TYPES.map((type) => [type, legacyEngineGrants(type)[member]]));
}

/**
 * The grants of one engine `engine` requesting `requested` against the register row `row`, its legacy row by default
 * and none for an id with none, with `seedOnly` as its seed-only rows, `sqlTextOf(engine)` as its SQL text request and
 * `languageDataOf(engine)` as its statement language data request.
 */
function grantOf(
  engine: string,
  requested: ClaimRequestEntry,
  row: RegisterRow | null = shippedRow(engine),
  seedOnly: SeedOnlyRows = { ...SEED_ONLY_FIELDS, [UNRECORDED]: null },
) {
  return grantEngineClaims(engine, requested, sqlTextOf(engine), languageDataOf(engine), row, seedOnly);
}

describe("Studio's grant of each policy and MCP claim", () => {
  test("for every shipped engine, each granted policy and MCP claim is its record's row, and no engine is refused at open", () => {
    const differing = (granted: Readonly<Record<string, unknown>>, record: Readonly<Record<string, unknown>>) =>
      SHIPPED_DATABASE_TYPES.filter((type) => JSON.stringify(granted[type]) !== JSON.stringify(record[type]));
    const tables = [
      [GRANTED_WRITE_REACH, legacyRegisterTable("writeReach")],
      [legacyGrantTable("readsFileAccessPosture"), legacyRegisterTable("readsFileAccessPosture")],
      [legacyGrantTable("deniedFileAccessRefusal"), legacyRegisterTable("deniedFileAccessRefusal")],
      [legacyGrantTable("singleWriterFile"), legacyRegisterTable("singleWriterFile")],
      [legacyGrantTable("readRootsRequired"), legacyRegisterTable("readRootsRequired")],
      [legacyGrantTable("agentCredentialForm"), legacyRegisterTable("agentCredentialForm")],
      [legacyGrantTable("maskingExemptColumns"), legacyRegisterTable("maskingExemptColumns")],
      [legacyGrantTable("exposable"), legacyRegisterTable("exposable")],
      [legacyGrantTable("statementRead"), legacyRegisterTable("statementRead")],
      [legacyGrantTable("metadataReadChangesState"), legacyRegisterTable("metadataReadChangesState")],
      [legacyGrantTable("agentCredentialRequired"), legacyRegisterTable("agentCredentialRequired")],
    ] as const;

    expect(tables.flatMap(([granted, record]) => differing(granted, record))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).ungrantedRefusals !== null)).toEqual([]);
    // Vacuity: the shipped records hold rows that differ from each claim's restrictive value.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_WRITE_REACH[type] !== "open").length).toBeGreaterThan(0);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).exposable).length).toBeGreaterThan(0);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).singleWriterFile).length).toBeGreaterThan(
      0,
    );
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).maskingExemptColumns !== null)).toEqual([
      "modbus",
    ]);
  });

  test("a write reach request is capped at the grant, and read open where no record exists", () => {
    const etcd = (writeReach: PolicyClaims["writeReach"]) => grantOf("etcd", request({ writeReach }));
    const modbus = (writeReach: PolicyClaims["writeReach"]) => grantOf("modbus", request({ writeReach }));

    expect(legacyRegisterTable("writeReach").etcd).toBe("guarded");
    expect(legacyRegisterTable("writeReach").modbus).toBe("none");
    expect(legacyRegisterTable("writeReach").postgres).toBe("open");
    expect(etcd("none").writeReach).toBe("guarded");
    expect(etcd("guarded").writeReach).toBe("guarded");
    expect(etcd("open").writeReach).toBe("open");
    expect(
      grantOf("postgres", request({ writeReach: "open" }), rowWith("postgres", { writeReach: "none" })).writeReach,
    ).toBe("open");
    expect(modbus("none").writeReach).toBe("none");
    expect(modbus("guarded").writeReach).toBe("guarded");
    for (const writeReach of ["none", "guarded", "open"] as const) {
      expect(grantOf(UNRECORDED, request({ writeReach })).writeReach).toBe("open");
    }
  });

  const RESTRICTIVE_TRUE = [
    ["readsFileAccessPosture", "policy"],
    ["readRootsRequired", "policy"],
    ["metadataReadChangesState", "mcp"],
    ["agentCredentialRequired", "mcp"],
  ] as const;
  const COMBINATIONS = [
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
    [false, undefined, true],
    [true, undefined, true],
  ] as const;
  const RESTRICTIVE_TRUE_CASES = RESTRICTIVE_TRUE.flatMap(([claim, segment]) =>
    COMBINATIONS.map(([requested, row, granted]) => [claim, segment, requested, row, granted] as const),
  );

  test.each(RESTRICTIVE_TRUE_CASES)(
    "a claim whose restrictive value is true is granted true where the request or the record is, or no record exists: %s, request %p, record %p",
    (claim, segment, requested, row, granted) => {
      const engine = row === undefined ? UNRECORDED : "postgres";
      const asked = segment === "policy" ? request({ [claim]: requested }) : request({}, { [claim]: requested });
      const against = row === undefined ? null : rowWith(engine, { [claim]: row });

      expect(grantOf(engine, asked, against)[claim]).toBe(granted);
    },
  );

  const RESTRICTIVE_FALSE_COMBINATIONS = [
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
    [true, undefined, false],
  ] as const;
  const RESTRICTIVE_FALSE_CASES = (["exposable", "statementRead"] as const).flatMap((claim) =>
    RESTRICTIVE_FALSE_COMBINATIONS.map(([requested, row, granted]) => [claim, requested, row, granted] as const),
  );

  test.each(RESTRICTIVE_FALSE_CASES)(
    "a claim whose restrictive value is false is granted true only where both the request and the record are: %s, request %p, record %p",
    (claim, requested, row, granted) => {
      const engine = row === undefined ? UNRECORDED : "postgres";
      const against = row === undefined ? null : rowWith(engine, { [claim]: row });

      expect(grantOf(engine, request({}, { [claim]: requested }), against)[claim]).toBe(granted);
    },
  );

  test("a denied file access refusal requested keeps its own sentence, one offered against a record's refusal takes the record's, and one offered where no record exists takes core's own", () => {
    const own = "Connections of this engine refuse a denied file access for a reason of their own.";
    const sqlite = legacyRegisterTable("deniedFileAccessRefusal").sqlite;
    const refusalOf = (engine: string, deniedFileAccessRefusal: string | null) =>
      grantOf(engine, request({ deniedFileAccessRefusal })).deniedFileAccessRefusal;

    expect(sqlite).toEqual(expect.any(String));
    expect(refusalOf("sqlite", own)).toBe(own);
    expect(refusalOf("postgres", own)).toBe(own);
    expect(refusalOf(UNRECORDED, own)).toBe(own);
    expect(refusalOf("sqlite", null)).toBe(sqlite);
    expect(refusalOf(UNRECORDED, null)).toBe(UNGRANTED_DENIED_FILE_ACCESS_SENTENCE);
    expect(refusalOf("postgres", null)).toBeNull();
    expect(UNGRANTED_DENIED_FILE_ACCESS_SENTENCE).toBe(
      "Connections of this engine require an administrator because Studio holds no grant that its provider confines file access for a caller whose file access is denied",
    );
  });

  test("a single-writer file request equal to its grant is read as granted, and any other request leaves the engine refused at every open, by name", () => {
    const of = (engine: string, singleWriterFile: boolean) => grantOf(engine, request({ singleWriterFile }));

    expect(legacyRegisterTable("singleWriterFile").duckdb).toBe(true);
    expect(of("duckdb", true)).toMatchObject({ singleWriterFile: true, ungrantedRefusals: null });
    expect(of("postgres", false)).toMatchObject({ singleWriterFile: false, ungrantedRefusals: null });
    expect(of(UNRECORDED, false)).toMatchObject({ singleWriterFile: false, ungrantedRefusals: null });
    for (const [engine, singleWriterFile] of [
      [UNRECORDED, true],
      ["postgres", true],
      ["duckdb", false],
    ] as const) {
      expect(of(engine, singleWriterFile)).toMatchObject({
        singleWriterFile: false,
        ungrantedRefusals: UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
      });
    }
    expect(UNGRANTED_SINGLE_WRITER_FILE_SENTENCE).toBe(
      "Studio opens no connection of this engine because its request for how many handles one file may hold is not the one Studio granted, and a second read-write handle on one file can lose committed rows",
    );
  });

  test("an agent credential form request equal to the record, pair for its null row, is read as the record's, and any other, or one with no record, as none", () => {
    const of = (engine: string, agentCredentialForm: PolicyClaims["agentCredentialForm"]) =>
      grantOf(engine, request({ agentCredentialForm })).agentCredentialForm;

    expect(legacyRegisterTable("agentCredentialForm").postgres).toBeNull();
    expect(legacyRegisterTable("agentCredentialForm").s3).toBe("dedicated-user");
    expect(of("postgres", "pair")).toBeNull();
    expect(of("s3", "dedicated-user")).toBe("dedicated-user");
    expect(of("libredb", "none")).toBe("none");
    expect(of("postgres", "token")).toBe("none");
    expect(of("s3", "pair")).toBe("none");
    expect(of("bigquery", "token")).toBe("none");
    expect(of(UNRECORDED, "pair")).toBe("none");
    expect(of(UNRECORDED, "token")).toBe("none");
  });

  test("a masking exemption request equal to the record's row is granted, and any other, or one with no record, is read as null", () => {
    const row = legacyRegisterTable("maskingExemptColumns").modbus;
    if (row === null) throw new Error("modbus exempts no column in Studio's record");
    const of = (engine: string, maskingExemptColumns: PolicyClaims["maskingExemptColumns"]) =>
      grantOf(engine, request({ maskingExemptColumns })).maskingExemptColumns;

    expect(of("modbus", { column: row.column, reason: row.reason })).toEqual(row);
    expect(of("modbus", { column: "^(?:address|value)$", reason: row.reason })).toBeNull();
    expect(of("modbus", { column: row.column, reason: "Another reason." })).toBeNull();
    expect(of("modbus", null)).toBeNull();
    expect(of("postgres", { column: row.column, reason: row.reason })).toBeNull();
    expect(of("postgres", null)).toBeNull();
    expect(of(UNRECORDED, { column: row.column, reason: row.reason })).toBeNull();
  });

  test("an engine read as requiring an agent credential its seeds take none of is closed to MCP", () => {
    const open = request({}, { exposable: true, agentCredentialRequired: true });

    // s3 requires an agent credential and its seeds take one, so it stays exposed.
    const s3 = BUNDLED_CLAIM_REQUESTS.s3;
    expect(legacyAgentCredentialTable().s3).not.toBeNull();
    expect(grantOf("s3", { ...s3, mcp: { ...s3.mcp, exposable: true, agentCredentialRequired: true } })).toMatchObject({
      exposable: true,
      agentCredentialRequired: true,
    });
    // postgres's seeds take one too; read as required, it stays exposed.
    expect(grantOf("postgres", open, rowWith("postgres", { agentCredentialRequired: true }))).toMatchObject({
      exposable: true,
      agentCredentialRequired: true,
    });
    // Seeds that take none: closed, whatever the request and the exposure record.
    expect(
      grantOf("postgres", open, rowWith("postgres", { agentCredentialRequired: true, agentCredential: null })),
    ).toMatchObject({ exposable: false, agentCredentialRequired: true });
    expect(legacyAgentCredentialTable().libredb).toBeNull();
    expect(grantOf("libredb", open, rowWith("libredb", { exposable: true }))).toMatchObject({
      exposable: false,
      agentCredentialRequired: true,
    });
    // An engine with no record at all is closed anyway.
    expect(grantOf(UNRECORDED, open).exposable).toBe(false);
  });

  test("a claim value outside its vocabulary is refused by name, naming the claim and the engine", () => {
    const refused = (asked: ClaimRequestEntry, claim: string, value: string) =>
      expect(() => grantOf(UNRECORDED, asked)).toThrow(
        `${UNRECORDED} requests ${claim} ${value}, which is not a value of the claim`,
      );
    const wrong = (value: unknown) => value as never;

    refused(request({ writeReach: wrong("partial") }), "policy.writeReach", '"partial"');
    refused(request({ readsFileAccessPosture: wrong("yes") }), "policy.readsFileAccessPosture", '"yes"');
    refused(request({ deniedFileAccessRefusal: wrong(false) }), "policy.deniedFileAccessRefusal", "false");
    refused(request({ singleWriterFile: wrong(null) }), "policy.singleWriterFile", "null");
    refused(request({ readRootsRequired: wrong(1) }), "policy.readRootsRequired", "1");
    refused(request({ agentCredentialForm: wrong("password") }), "policy.agentCredentialForm", '"password"');
    refused(
      request({ maskingExemptColumns: wrong({ column: "^a$" }) }),
      "policy.maskingExemptColumns",
      '{"column":"^a$"}',
    );
    refused(request({ maskingExemptColumns: wrong("^a$") }), "policy.maskingExemptColumns", '"^a$"');
    refused(request({}, { exposable: wrong(undefined) }), "mcp.exposable", "undefined");
    refused(request({}, { statementRead: wrong("true") }), "mcp.statementRead", '"true"');
    refused(request({}, { metadataReadChangesState: wrong(0) }), "mcp.metadataReadChangesState", "0");
    refused(request({}, { agentCredentialRequired: wrong(null) }), "mcp.agentCredentialRequired", "null");
  });

  test("each engine's readOnlyEnforced grant is true exactly where the granted write reach is not open", () => {
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) => legacyEngineGrants(type).readOnlyEnforced !== (GRANTED_WRITE_REACH[type] !== "open"),
      ),
    ).toEqual([]);
    expect(grantOf("etcd", request({ writeReach: "guarded" })).readOnlyEnforced).toBe(true);
    expect(grantOf("modbus", request({ writeReach: "none" })).readOnlyEnforced).toBe(true);
    expect(grantOf("etcd", request({ writeReach: "open" })).readOnlyEnforced).toBe(false);
    expect(grantOf(UNRECORDED, request({ writeReach: "none" })).readOnlyEnforced).toBe(false);
  });

  test("the granted tables are frozen, each row too, keyed exactly by the shipped engines", () => {
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    const tables = [
      GRANTED_WRITE_REACH,
      GRANTED_SSH_TUNNEL_REFUSAL,
      GRANTED_AGENT_STATEMENT_LANGUAGE,
      GRANTED_AGENT_READINGS,
    ];

    for (const table of tables) {
      expect(frozen(table)).toBe(true);
      expect(Object.keys(table)).toEqual([...SHIPPED_DATABASE_TYPES]);
    }
    // A hand-made row's value is copied and frozen, never handed out.
    const row = { column: "^a$", reason: "Holds no protected value." };
    const granted = grantOf(
      "postgres",
      request({ maskingExemptColumns: { ...row } }),
      rowWith("postgres", {
        maskingExemptColumns: row,
      }),
    );
    expect(granted.maskingExemptColumns).toEqual(row);
    expect(granted.maskingExemptColumns).not.toBe(row);
    expect(Object.isFrozen(granted.maskingExemptColumns)).toBe(true);
    // Each engine's grants are frozen to their leaves, with a row and with none.
    expect(frozen(grantOf("opcua", BUNDLED_CLAIM_REQUESTS.opcua))).toBe(true);
    expect(frozen(grantOf("elasticsearch", BUNDLED_CLAIM_REQUESTS.elasticsearch))).toBe(true);
    expect(frozen(grantOf(UNRECORDED, request()))).toBe(true);
  });
});

/** The schema's `hostPathField` enum, the host path field vocabulary a declaration may name. */
function schemaHostPathFields(): readonly string[] {
  const schema = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../packages/provider-sdk/src/manifest/manifest.schema.json"),
      "utf8",
    ),
  ) as { $defs: { hostPathField: { enum: string[] } } };
  return schema.$defs.hostPathField.enum;
}

describe("Studio's grant of each connection claim", () => {
  test("for every shipped engine, each granted connection claim is its record's row, at each gate that reads it", () => {
    const differing = (granted: Readonly<Record<string, unknown>>, record: Readonly<Record<string, unknown>>) =>
      SHIPPED_DATABASE_TYPES.filter((type) => JSON.stringify(granted[type]) !== JSON.stringify(record[type]));
    const tables = [
      [legacyGrantTable("opensLocalFile"), legacyRegisterTable("opensLocalFile")],
      [legacyGrantTable("hostPathFields"), legacyRegisterTable("hostPathFields")],
      [legacyGrantTable("serverLevelAtAdmission"), legacyRegisterTable("serverLevelWithoutDatabase")],
      [legacyGrantTable("serverLevelAtCatalogChoice"), legacyRegisterTable("serverLevelWithoutDatabase")],
      [GRANTED_SSH_TUNNEL_REFUSAL, legacyRegisterTable("sshTunnel")],
      [legacyGrantTable("agentCredential"), legacyAgentCredentialTable()],
    ] as const;

    expect(tables.flatMap(([granted, record]) => differing(granted, record))).toEqual([]);
    // Against an oracle the grant reader builds no part of: elasticsearch's register row, whose superseding fields are
    // both text fields a connection form draws, so narrowing keeps them.
    expect(legacyEngineGrants("elasticsearch").agentCredential).toEqual({
      form: "pair",
      supersededBy: ["apiKeyId", "apiKeySecret"],
    });
    // Vacuity: each record holds rows that differ from its claim's restrictive value.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).opensLocalFile)).toEqual([
      "duckdb",
      "libredb",
      "sqlite",
    ]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).hostPathFields.length > 0)).toEqual([
      "opcua",
    ]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).serverLevelAtCatalogChoice)).toEqual([
      "postgres",
    ]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_SSH_TUNNEL_REFUSAL[type] === null).length).toBe(32);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).agentCredential === null).length).toBe(11);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).serverLevelAtAdmission)).toEqual([
      "postgres",
    ]);
    expect(legacyGrantTable("exposable")).toEqual(legacyRegisterTable("exposable"));
  });

  const LOCAL_FILE_CASES = [
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
    [false, undefined, true],
  ] as const;

  test.each(LOCAL_FILE_CASES)(
    "a local file request is granted true where the request or the record is, or no record exists: request %p, record %p",
    (requested, row, granted) => {
      const engine = row === undefined ? UNRECORDED : "postgres";
      const against = row === undefined ? null : rowWith(engine, { opensLocalFile: row });

      expect(grantOf(engine, request({}, {}, { opensLocalFile: requested }), against).opensLocalFile).toBe(granted);
    },
  );

  test("the host path fields granted are the union of the request and the record, and every host path field among the seed-only fields where no record exists", () => {
    const of = (
      engine: string,
      hostPathFields: ConnectionClaims["hostPathFields"],
      against: RegisterRow | null = shippedRow(engine),
    ) => grantOf(engine, request({}, {}, { hostPathFields }), against).hostPathFields;
    const row = legacyRow("opcua").grants.hostPathFields;

    expect(row).toEqual(["clientCertificatePath", "clientPrivateKeyPath"]);
    // A request adding nothing to the record is the record's own row.
    expect(of("opcua", [])).toBe(row);
    expect(of("opcua", ["clientPrivateKeyPath"])).toBe(row);
    // A request naming a field the record does not: the record's fields first, then the request's others.
    const certificate = rowWith("postgres", { hostPathFields: ["clientCertificatePath"] });
    expect(of("postgres", ["clientPrivateKeyPath"], certificate)).toEqual([
      "clientCertificatePath",
      "clientPrivateKeyPath",
    ]);
    expect(of("postgres", ["clientPrivateKeyPath", "clientCertificatePath"], certificate)).toEqual([
      "clientCertificatePath",
      "clientPrivateKeyPath",
    ]);
    expect(of("postgres", [])).toEqual([]);
    // No record: every host path field among the engine's seed-only fields, OPC UA's two, or none.
    const opcuaSeedOnly = { ...SEED_ONLY_FIELDS, [UNRECORDED]: SEED_ONLY_FIELDS.opcua };
    expect(grantOf(UNRECORDED, request({}, {}, { hostPathFields: [] }), null, opcuaSeedOnly).hostPathFields).toEqual([
      "clientCertificatePath",
      "clientPrivateKeyPath",
    ]);
    expect(of(UNRECORDED, [])).toEqual([]);
    expect(of(UNRECORDED, ["clientPrivateKeyPath"])).toEqual(["clientPrivateKeyPath"]);
    // Every answer frozen.
    expect(Object.isFrozen(of("postgres", ["clientPrivateKeyPath"], certificate))).toBe(true);
    expect(Object.isFrozen(of(UNRECORDED, []))).toBe(true);
  });

  test("the host path field vocabulary is the schema's hostPathField enum", () => {
    expect<readonly string[]>([...HOST_PATH_FIELD_NAMES]).toEqual([...schemaHostPathFields()]);
    expect(Object.isFrozen(HOST_PATH_FIELD_NAMES)).toBe(true);
  });

  const SERVER_LEVEL_CASES = [
    [false, false, false, false],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, true, true],
    [false, undefined, true, false],
    [true, undefined, true, false],
  ] as const;

  test.each(SERVER_LEVEL_CASES)(
    "a server level request is read per gate: true at governance admission where either is or no record exists, true at the choice of database only where both are: request %p, record %p",
    (requested, row, atAdmission, atCatalogChoice) => {
      const engine = row === undefined ? UNRECORDED : "postgres";
      const against = row === undefined ? null : rowWith(engine, { serverLevelWithoutDatabase: row });
      const granted = grantOf(engine, request({}, {}, { serverLevelWithoutDatabase: requested }), against);

      expect([granted.serverLevelAtAdmission, granted.serverLevelAtCatalogChoice]).toEqual([
        atAdmission,
        atCatalogChoice,
      ]);
    },
  );

  test("a refused tunnel request keeps its own sentence, one offered against a refusing record takes the record's, and one offered where no record exists takes core's own", () => {
    const own = "This engine does not run through an SSH tunnel for a reason of its own. Turn the tunnel off.";
    const sqlite = legacyRegisterTable("sshTunnel").sqlite;
    const of = (engine: string, sshTunnel: ConnectionClaims["sshTunnel"]) =>
      grantOf(engine, request({}, {}, { sshTunnel })).sshTunnel;

    expect(sqlite).toEqual(expect.any(String));
    expect(legacyRegisterTable("sshTunnel").postgres).toBeNull();
    expect(of("postgres", { offered: false, refusal: own })).toBe(own);
    expect(of("sqlite", { offered: false, refusal: own })).toBe(own);
    expect(of(UNRECORDED, { offered: false, refusal: own })).toBe(own);
    expect(of("sqlite", { offered: true })).toBe(sqlite);
    expect(of(UNRECORDED, { offered: true })).toBe(UNGRANTED_SSH_TUNNEL_SENTENCE);
    expect(of("postgres", { offered: true })).toBeNull();
    expect(UNGRANTED_SSH_TUNNEL_SENTENCE).toBe(
      "This engine does not run through an SSH tunnel: Studio holds no grant that its provider reaches its server only through the one address a tunnel forwards. Turn the tunnel off.",
    );
  });

  test("a seed agent credential request equal to the record's row is granted as that row, and any other, or one with no record, is read as null", () => {
    const elasticsearch = legacyAgentCredentialTable().elasticsearch;
    if (elasticsearch === null || elasticsearch === undefined)
      throw new Error("elasticsearch takes no agent credential");
    const of = (engine: string, agentCredential: ConnectionClaims["agentCredential"]) =>
      grantOf(engine, request({}, {}, { agentCredential })).agentCredential;
    const pair = { form: "pair" as const, supersededBy: [] };

    expect(elasticsearch.supersededBy).toEqual(["apiKeyId", "apiKeySecret"]);
    expect(of("elasticsearch", { form: "pair", supersededBy: ["apiKeyId", "apiKeySecret"] })).toEqual(elasticsearch);
    expect(of("postgres", pair)).toEqual(legacyAgentCredentialTable().postgres);
    expect(of("postgres", { form: "secret", supersededBy: [] })).toBeNull();
    expect(of("elasticsearch", pair)).toBeNull();
    expect(of("elasticsearch", { form: "pair", supersededBy: ["apiKeySecret", "apiKeyId"] })).toBeNull();
    expect(of("elasticsearch", { form: "pair", supersededBy: ["apiKeyId"] })).toBeNull();
    expect(of("postgres", { form: "pair", supersededBy: ["apiKeyId"] })).toBeNull();
    // A field no row's narrowed credential may hold, a connection field the form draws but never as text, reads null.
    expect(of("postgres", { form: "pair", supersededBy: ["connectionString"] })).toBeNull();
    expect(of("postgres", null)).toBeNull();
    expect(of("sqlite", pair)).toBeNull();
    expect(of(UNRECORDED, pair)).toBeNull();
    expect(of(UNRECORDED, null)).toBeNull();
  });

  test("an engine read as requiring an agent credential whose granted credential is null, or whose granted form is none, is closed to MCP", () => {
    const open = (policy: Partial<PolicyClaims> = {}, connection: Partial<ConnectionClaims> = {}) =>
      request(policy, { exposable: true, agentCredentialRequired: true }, connection);
    const required = rowWith("postgres", { agentCredentialRequired: true });

    // Both granted: exposed as before.
    expect(grantOf("postgres", open(), required)).toMatchObject({ exposable: true, agentCredentialRequired: true });
    // A seed agent credential request the record does not grant: closed.
    expect(
      grantOf("postgres", open({}, { agentCredential: { form: "secret", supersededBy: [] } }), required),
    ).toMatchObject({
      exposable: false,
      agentCredentialRequired: true,
    });
    // A granted form of none refuses every agent acquisition: closed.
    expect(
      grantOf(
        "postgres",
        open({ agentCredentialForm: "none" }),
        rowWith("postgres", {
          agentCredentialRequired: true,
          agentCredentialForm: "dedicated-user",
        }),
      ),
    ).toMatchObject({ exposable: false, agentCredentialForm: "none", agentCredentialRequired: true });
    // Not required: the form and the seed credential leave the exposure as granted.
    expect(grantOf("postgres", request({ agentCredentialForm: "none" }, { exposable: true }))).toMatchObject({
      exposable: true,
      agentCredentialRequired: false,
    });
  });

  test("a connection claim value outside its vocabulary is refused by name, naming the claim and the engine", () => {
    const refused = (connection: Partial<ConnectionClaims>, claim: string, value: string) =>
      expect(() => grantOf(UNRECORDED, request({}, {}, connection))).toThrow(
        `${UNRECORDED} requests ${claim} ${value}, which is not a value of the claim`,
      );
    const wrong = (value: unknown) => value as never;

    refused({ opensLocalFile: wrong("yes") }, "connection.opensLocalFile", '"yes"');
    refused({ serverLevelWithoutDatabase: wrong(null) }, "connection.serverLevelWithoutDatabase", "null");
    refused({ hostPathFields: wrong(["caCertPath"]) }, "connection.hostPathFields", '["caCertPath"]');
    refused({ hostPathFields: wrong("clientCertificatePath") }, "connection.hostPathFields", '"clientCertificatePath"');
    refused({ sshTunnel: wrong({ offered: "no" }) }, "connection.sshTunnel", '{"offered":"no"}');
    refused({ sshTunnel: wrong({ offered: false }) }, "connection.sshTunnel", '{"offered":false}');
    refused({ sshTunnel: wrong(null) }, "connection.sshTunnel", "null");
    refused(
      { agentCredential: wrong({ form: "token", supersededBy: [] }) },
      "connection.agentCredential",
      '{"form":"token","supersededBy":[]}',
    );
    refused({ agentCredential: wrong({ form: "pair" }) }, "connection.agentCredential", '{"form":"pair"}');
    refused(
      { agentCredential: wrong({ form: "pair", supersededBy: [1] }) },
      "connection.agentCredential",
      '{"form":"pair","supersededBy":[1]}',
    );
    refused(
      { agentCredential: wrong({ form: "pair", supersededBy: ["apiKeyId", null] }) },
      "connection.agentCredential",
      '{"form":"pair","supersededBy":["apiKeyId",null]}',
    );
  });

  test("a value outside its vocabulary in Studio's record is refused naming the record, the claim and the engine, never as the engine's request", () => {
    const wrong = (value: unknown) => value as never;

    expect(() => grantOf("postgres", request(), rowWith("postgres", { writeReach: wrong("partial") }))).toThrow(
      'Studio\'s record of policy.writeReach holds "partial" for postgres, which is not a value of the claim',
    );
    expect(() =>
      grantOf("postgres", request(), rowWith("postgres", { hostPathFields: wrong(["caCertPath"]) })),
    ).toThrow(
      'Studio\'s record of connection.hostPathFields holds ["caCertPath"] for postgres, which is not a value of the claim',
    );
    // A request outside the vocabulary still names the request.
    expect(() => grantOf("postgres", request({ writeReach: wrong("partial") }))).toThrow(
      'postgres requests policy.writeReach "partial", which is not a value of the claim',
    );
  });

  test("an engine whose seed-only row is missing is refused by name", () => {
    expect(() => grantOf(UNRECORDED, request(), null, SEED_ONLY_FIELDS)).toThrow(
      `${UNRECORDED} has no seed-only row, so Studio cannot grant its host path fields`,
    );
    // A row on the prototype chain is no row.
    const inherited = Object.create({ [UNRECORDED]: null }) as SeedOnlyRows;
    expect(() => grantOf(UNRECORDED, request(), null, inherited)).toThrow(
      `${UNRECORDED} has no seed-only row, so Studio cannot grant its host path fields`,
    );
  });
});

/** The schema's form and enum the agent mode claims are read in. */
function schemaAgentModeVocabularies(): { readonly statementLanguageForm: string; readonly agentReadings: string[] } {
  const schema = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dir, "../../../packages/provider-sdk/src/manifest/manifest.schema.json"),
      "utf8",
    ),
  ) as { $defs: { statementLanguage: { pattern: string }; agentReading: { enum: string[] } } };
  return {
    statementLanguageForm: schema.$defs.statementLanguage.pattern,
    agentReadings: schema.$defs.agentReading.enum,
  };
}

describe("Studio's grant of each agent mode claim", () => {
  test("for every shipped engine, each granted agent mode claim is its record's row", () => {
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) => GRANTED_AGENT_STATEMENT_LANGUAGE[type] !== legacyStatementLanguageTable()[type],
      ),
    ).toEqual([]);
    expect(GRANTED_AGENT_STATEMENT_LANGUAGE).toEqual(legacyStatementLanguageTable());
    // Vacuity: the record holds languages and nulls.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_AGENT_STATEMENT_LANGUAGE[type] === null)).toEqual([
      "bigquery",
      "databend",
      "snowflake",
      "spark",
    ]);
    expect(GRANTED_AGENT_STATEMENT_LANGUAGE.mongodb).toBe("mongo");
    expect(
      SHIPPED_DATABASE_TYPES.filter(
        (type) =>
          JSON.stringify(GRANTED_AGENT_READINGS[type]) !== JSON.stringify(legacyRegisterTable("agentReadings")[type]),
      ),
    ).toEqual([]);
    // Vacuity: the legacy rows hold full, partial and empty readings.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_AGENT_READINGS[type].length === 0)).toEqual([
      "mqtt",
      "mtconnect",
      "opcua",
      "sparkplug",
    ]);
    expect(GRANTED_AGENT_READINGS.kafka).toEqual(["health"]);
    expect(GRANTED_AGENT_READINGS.postgres).toEqual([...CURATED_OPERATION_KINDS]);
  });

  const STATEMENT_LANGUAGE_CASES = [
    ["postgres", "sql", "sql", "sql"],
    ["postgres", "mongo", "sql", null],
    ["postgres", null, "sql", null],
    ["postgres", "sql", null, null],
    ["postgres", null, null, null],
    [UNRECORDED, "sql", undefined, null],
    [UNRECORDED, null, undefined, null],
  ] as const;

  test.each(STATEMENT_LANGUAGE_CASES)(
    "a statement language request equal to the record's row is granted as that row, and any other, or one with no record, is read as null: %s, request %p, record %p",
    (engine, requested, row, granted) => {
      const against = row === undefined ? null : rowWith(engine, { statementLanguage: row });

      expect(
        grantOf(engine, request({}, {}, {}, {}, { statementLanguage: requested }), against).statementLanguage,
      ).toBe(granted);
    },
  );

  test("a statement language request of the schema's form is granted only as its register row's name, and one outside the form is refused by name", () => {
    const languageOf = (engine: string, requested: string, row: RegisterGrants["statementLanguage"] | undefined) =>
      grantOf(
        engine,
        request({}, {}, {}, {}, { statementLanguage: requested as never }),
        row === undefined ? null : rowWith(engine, { statementLanguage: row }),
      ).statementLanguage;

    // A language Studio has no module for is a request like any other: no row, or a row granting another, reads null.
    expect(languageOf(UNRECORDED, "acmeql", undefined)).toBeNull();
    expect(languageOf("kafka", "acmeql", "kafkaread")).toBeNull();
    expect(languageOf("kafka", "acmeql", null)).toBeNull();
    // A request equal to the row is granted the row's own name.
    expect(languageOf("kafka", "kafkaread", "kafkaread")).toBe("kafkaread");
    // One outside the form is refused by name, never read at a default.
    expect(() => languageOf(UNRECORDED, "Acme QL", undefined)).toThrow(
      `${UNRECORDED} requests agent.statementLanguage "Acme QL", which is not a value of the claim`,
    );
  });

  test("the agent readings granted are the intersection of the request and the engine's register row, in the row's order, and empty where no row exists", () => {
    const of = (engine: string, agentReadings: FacetClaims["agentReadings"], row = shippedRow(engine)) =>
      grantOf(engine, request({}, {}, {}, { agentReadings }), row).agentReadings;
    const readings = ["storage", "health"] as const;
    const two = rowWith("postgres", { agentReadings: readings });

    // The row's order, whatever the request's.
    expect(of("postgres", ["health", "storage"], two)).toEqual(["storage", "health"]);
    // A request holding every reading of the row reads a copy of the row, frozen, never the row's own list.
    const all = of("postgres", [...CURATED_OPERATION_KINDS], two);
    expect(all).toEqual(["storage", "health"]);
    expect(all).not.toBe(readings);
    expect(Object.isFrozen(all)).toBe(true);
    // A reading the row lacks is never gained, and one the request drops is never kept.
    expect(of("postgres", ["sessions", "health"], two)).toEqual(["health"]);
    expect(of("postgres", ["sessions"], two)).toEqual([]);
    expect(of("postgres", [], two)).toEqual([]);
    expect(of("kafka", [...CURATED_OPERATION_KINDS])).toEqual(["health"]);
    expect(of("mqtt", [...CURATED_OPERATION_KINDS])).toEqual([]);
    // No row: the empty list, whatever the request.
    expect(of(UNRECORDED, [...CURATED_OPERATION_KINDS])).toEqual([]);
    expect(Object.isFrozen(of(UNRECORDED, ["health"]))).toBe(true);
    // No register row: the empty list, even for an engine whose legacy row offers readings.
    expect(of("postgres", ["health"], null)).toEqual([]);
  });

  test("the statement language form is the schema's statementLanguage pattern, the agent reading vocabulary is the schema's agentReading enum, and the readings are CURATED_OPERATION_KINDS", () => {
    const schema = schemaAgentModeVocabularies();

    expect(STATEMENT_LANGUAGE_NAME_FORM.source).toBe(schema.statementLanguageForm);
    expect(STATEMENT_LANGUAGE_NAME_FORM.flags).toBe("");
    expect<readonly string[]>([...AGENT_READING_NAMES]).toEqual(schema.agentReadings);
    expect<readonly string[]>([...AGENT_READING_NAMES]).toEqual([...CURATED_OPERATION_KINDS]);
    expect(Object.isFrozen(AGENT_READING_NAMES)).toBe(true);
  });

  test("StatementLanguageRequest is a bundled engine's requested statement language as its literal type", () => {
    const postgres: StatementLanguageRequest<"postgres"> = "sql";
    const bigquery: StatementLanguageRequest<"bigquery"> = null;
    // @ts-expect-error The request's literal type, never the claim's whole vocabulary.
    const postgresAsMongo: StatementLanguageRequest<"postgres"> = "mongo";
    // @ts-expect-error An engine that requests no language reads null alone.
    const bigqueryAsSql: StatementLanguageRequest<"bigquery"> = "sql";

    expect([postgres, bigquery]).toEqual([
      BUNDLED_CLAIM_REQUESTS.postgres.agent.statementLanguage,
      BUNDLED_CLAIM_REQUESTS.bigquery.agent.statementLanguage,
    ]);
    // The two refused assignments hold whatever they were handed at run time; typecheck is what refuses them.
    expect<unknown[]>([postgresAsMongo, bigqueryAsSql]).toEqual(["mongo", "sql"]);
  });

  test("an agent mode claim value outside its vocabulary is refused by name, naming the claim and the engine", () => {
    const wrong = (value: unknown) => value as never;
    const refusedLanguage = (value: unknown, written: string) =>
      expect(() => grantOf(UNRECORDED, request({}, {}, {}, {}, { statementLanguage: wrong(value) }))).toThrow(
        `${UNRECORDED} requests agent.statementLanguage ${written}, which is not a value of the claim`,
      );

    refusedLanguage("postgre-sql", '"postgre-sql"');
    refusedLanguage("SQL", '"SQL"');
    refusedLanguage(`a${"b".repeat(32)}`, `"a${"b".repeat(32)}"`);
    refusedLanguage(false, "false");
    refusedLanguage(undefined, "undefined");
    const refusedReadings = (value: unknown, written: string) =>
      expect(() => grantOf(UNRECORDED, request({}, {}, {}, { agentReadings: wrong(value) }))).toThrow(
        `${UNRECORDED} requests facets.agentReadings ${written}, which is not a value of the claim`,
      );

    refusedReadings(["health", "locks"], '["health","locks"]');
    refusedReadings("health", '"health"');
    refusedReadings(null, "null");
    refusedReadings([1], "[1]");
  });
});

describe("the register's legacy rows the grant reader reads", () => {
  /** A register of two rows structured-cloned from the committed register, postgres's and mysql's. */
  const twoRowRegister = () => {
    const committed = readGrantRegister(SHIPPED_DATABASE_TYPES);
    const rows = ["postgres", "mysql"].map((engine) => committed.rowFor({ legacy: LEGACY_KEY, engine }));
    return parseGrantRegister(structuredClone(rows), ["postgres", "mysql"]);
  };

  test("legacyGrantRows answers each engine's legacy row of the register in the engines' order, frozen", () => {
    const register = twoRowRegister();
    const rows = legacyGrantRows(register, ["mysql", "postgres"]);

    expect(Object.keys(rows)).toEqual(["mysql", "postgres"]);
    expect(rows.mysql).toBe(register.rowFor({ legacy: LEGACY_KEY, engine: "mysql" }) as never);
    expect(rows.postgres).toBe(register.rowFor({ legacy: LEGACY_KEY, engine: "postgres" }) as never);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows.postgres)).toBe(true);
    // Vacuity: the rows read are the committed register's, not empty grants.
    expect(rows.postgres?.grants.writeReach).toBe(GRANTED_WRITE_REACH.postgres);
  });

  test("grantEngineClaims refuses by name a register row of another engine", () => {
    expect(() => grantOf("mysql", request(), rowWith("postgres"))).toThrow(
      "grantEngineClaims was handed the register row of postgres for mysql",
    );
    // Vacuity: the same row keyed to the engine it is handed for is read.
    expect(grantOf("mysql", request(), rowWith("mysql")).writeReach).toBe(legacyRegisterTable("writeReach").mysql);
  });

  test("the test helpers refuse by name an id with no legacy row, never reading another engine's SQL text request", () => {
    expect(() => legacySqlText("postgress")).toThrow(
      "legacySqlText: postgress has no legacy row, so it has no legacy SQL text request",
    );
    expect(() => grantOf("postgress", request())).toThrow(
      "legacySqlText: postgress has no legacy row, so it has no legacy SQL text request",
    );
  });

  test("legacyEngineGrants refuses by name an id the legacy adapter does not serve", () => {
    expect(() => legacyEngineGrants(UNRECORDED)).toThrow(
      `the grant reader holds no legacy grants for ${UNRECORDED}: the legacy adapter serves no engine of that id`,
    );
    expect(() => legacyEngineGrants("toString")).toThrow(
      "the grant reader holds no legacy grants for toString: the legacy adapter serves no engine of that id",
    );
    // Vacuity: a served engine's grants are its legacy row's, granted against its request.
    expect(legacyEngineGrants("etcd")).toEqual(grantOf("etcd", BUNDLED_CLAIM_REQUESTS.etcd));
  });

  test("legacyGrantRows refuses an engine the register holds no legacy row for, naming it", () => {
    expect(() => legacyGrantRows(twoRowRegister(), ["postgres", "mysql", "sqlite"])).toThrow(
      "the grant register holds no legacy row for sqlite, an engine the legacy adapter serves",
    );
  });

  test("legacyAgentCredentials answers each engine's agent credential of its legacy row, each superseding field found among the fields it is handed, frozen", () => {
    const rows = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), ["elasticsearch", "postgres", "sqlite"]);
    const credentials = legacyAgentCredentials(
      Object.fromEntries(Object.entries(rows).map(([engine, row]) => [engine, row.grants])),
      BODY_CONNECTION_FIELDS,
    );

    expect(Object.keys(credentials)).toEqual(["elasticsearch", "postgres", "sqlite"]);
    expect(credentials.elasticsearch).toEqual({ form: "pair", supersededBy: ["apiKeyId", "apiKeySecret"] });
    expect(credentials.postgres).toEqual({ form: "pair", supersededBy: [] });
    expect(credentials.sqlite).toBeNull();
    expect(Object.isFrozen(credentials)).toBe(true);
    expect(Object.isFrozen(credentials.elasticsearch)).toBe(true);
    expect(Object.isFrozen(credentials.elasticsearch?.supersededBy)).toBe(true);
    expect(Object.isFrozen(credentials.postgres?.supersededBy)).toBe(true);
  });

  /** `engine`'s committed grants with its agent credential superseded by `field`. */
  function supersededBy(engine: "elasticsearch" | "postgres", field: string): RegisterGrants {
    const committed = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), ["elasticsearch", "postgres"]);
    return { ...(committed[engine] as RegisterRow).grants, agentCredential: { form: "pair", supersededBy: [field] } };
  }

  test("legacyAgentCredentials reads no engine's connection row: a drawn text field of another engine narrows, which the agent credential census refuses", () => {
    // The census in tests/unit/db/agent-credential-capability.test.ts holds every legacy row's superseding fields
    // among its engine's own connection fields; the load narrows against the vocabulary alone.
    expect(legacyAgentCredentials({ postgres: supersededBy("postgres", "apiKeyId") }, BODY_CONNECTION_FIELDS)).toEqual({
      postgres: { form: "pair", supersededBy: ["apiKeyId"] },
    });
  });

  test("legacyAgentCredentials refuses by name a superseding field the fields it is handed do not hold", () => {
    expect(() =>
      legacyAgentCredentials({ elasticsearch: supersededBy("elasticsearch", "notAField") }, BODY_CONNECTION_FIELDS),
    ).toThrow(
      'the grant register\'s row for elasticsearch names "notAField" among the fields superseding its agent credential, which is not a text field a connection form draws',
    );
    // A connection field the dialog's own layout draws, never a text field the renderer saves.
    expect(() =>
      legacyAgentCredentials({ elasticsearch: supersededBy("elasticsearch", "host") }, BODY_CONNECTION_FIELDS),
    ).toThrow(
      'the grant register\'s row for elasticsearch names "host" among the fields superseding its agent credential, which is not a text field a connection form draws',
    );
  });

  test("GRANTED_AGENT_EXECUTION_ENGINES is the engines whose legacy rows grant agent execution, in catalog order, frozen, and each legacy engine's grants carry its row's one-session reason", () => {
    const rows = legacyGrantRows(readGrantRegister(SHIPPED_DATABASE_TYPES), SHIPPED_DATABASE_TYPES);
    const grantsOf = (engine: string) => (rows[engine] as RegisterRow).grants;

    expect(GRANTED_AGENT_EXECUTION_ENGINES).toEqual(
      SHIPPED_DATABASE_TYPES.filter((engine) => grantsOf(engine).agentExecution),
    );
    expect(Object.isFrozen(GRANTED_AGENT_EXECUTION_ENGINES)).toBe(true);
    expect(() => (GRANTED_AGENT_EXECUTION_ENGINES as DatabaseType[]).push("postgres")).toThrow(TypeError);
    const oneSession = SHIPPED_DATABASE_TYPES.filter((engine) => legacyEngineGrants(engine).servesOneSession !== null);
    expect(SHIPPED_DATABASE_TYPES.map((engine) => legacyEngineGrants(engine).servesOneSession)).toEqual(
      SHIPPED_DATABASE_TYPES.map((engine) => grantsOf(engine).servesOneSession),
    );
    // Vacuity: each holds some shipped engines and leaves others out.
    for (const list of [GRANTED_AGENT_EXECUTION_ENGINES, oneSession]) {
      expect(list.length).toBeGreaterThan(0);
      expect(list.length).toBeLessThan(SHIPPED_DATABASE_TYPES.length);
    }
  });
});

describe("Studio's grant of each SQL text claim", () => {
  /** A grammar digest of the form a row states, new on every call. */
  const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
  /** A SQL text request: postgres's but for the members `changes` names. */
  const sqlText = (changes: Partial<SqlTextRequest> = {}): SqlTextRequest => ({
    ...legacySqlText("postgres"),
    ...changes,
  });
  /** The SQL text grants of postgres requesting `requested` against `row`, its other requests its bundled ones. */
  const sqlTextGrants = (requested: SqlTextRequest, row: RegisterRow | null) => {
    const { redaction, readsSqlText, confirmExemptForms, decidesAlone, reviewedGrammar } = grantEngineClaims(
      "postgres",
      BASE,
      requested,
      languageDataOf("postgres"),
      row,
      SEED_ONLY_FIELDS,
    );
    return { redaction, readsSqlText, confirmExemptForms, decidesAlone, reviewedGrammar };
  };
  const NAMES: StatementRedaction = { kind: "sql", nameQuote: '"' };
  const RESTRICTIVE = {
    redaction: { kind: "none" },
    readsSqlText: true,
    confirmExemptForms: [],
    decidesAlone: false,
    reviewedGrammar: false,
  } as const;

  test("a SQL text claim is granted from the engine's register row only for the grammar that row reviewed, and at its restrictive value otherwise", () => {
    const reviewed = digest();
    const loose = { readsSqlText: false, redaction: NAMES, grammarSha256: reviewed };
    const row = rowWith("postgres", {
      redaction: { kind: "sql", nameQuote: '"' },
      readsSqlText: false,
      confirmExemptForms: [
        ["ALTER", "SESSION", "SET"],
        ["DROP", "PLANTED"],
      ],
      decidesAlone: true,
      grammarSha256: reviewed,
    });
    const forms = [["drop", "planted"], ["ALTER", "SESSION", "UNSET"], ["ALTER", "SESSION", "SET"], ["DROP"]];

    // The grammar the row reviewed: each claim is the more restrictive of the request and the row.
    const granted = sqlTextGrants(sqlText({ ...loose, confirmExemptForms: forms }), row);
    expect(granted).toEqual({
      redaction: NAMES,
      readsSqlText: false,
      // The requested forms the row lists, compared word by word upper-cased, in the request's order.
      confirmExemptForms: [
        ["drop", "planted"],
        ["ALTER", "SESSION", "SET"],
      ],
      decidesAlone: true,
      reviewedGrammar: true,
    });
    expect(Object.isFrozen(granted.redaction)).toBe(true);
    expect(Object.isFrozen(granted.confirmExemptForms)).toBe(true);
    expect(granted.confirmExemptForms.every((form) => Object.isFrozen(form))).toBe(true);
    expect(granted.confirmExemptForms[0]).not.toBe(forms[0]);
    // A request more restrictive than the row: the request's.
    expect(sqlTextGrants(sqlText({ ...loose, readsSqlText: true, confirmExemptForms: [] }), row)).toMatchObject({
      readsSqlText: true,
      confirmExemptForms: [],
    });
    for (const redaction of [
      { kind: "sql", nameQuote: null },
      { kind: "sql", nameQuote: "`" },
      { kind: "none" },
      { kind: "command", reader: "redactionReader" },
    ] as const) {
      expect(sqlTextGrants(sqlText({ ...loose, redaction }), row).redaction).toEqual({ kind: "none" });
    }
    // A row more restrictive than the request: the row's.
    const tight = rowWith("postgres", {
      ...row.grants,
      readsSqlText: true,
      decidesAlone: false,
      confirmExemptForms: [],
    });
    expect(sqlTextGrants(sqlText({ ...loose, confirmExemptForms: forms }), tight)).toEqual({
      redaction: NAMES,
      readsSqlText: true,
      confirmExemptForms: [],
      decidesAlone: false,
      reviewedGrammar: true,
    });
    // Another grammar, a row that reviews none, and no row: every claim at its restrictive value.
    const all = sqlText({ ...loose, confirmExemptForms: forms });
    expect(sqlTextGrants(sqlText({ ...all, grammarSha256: digest() }), row)).toEqual(RESTRICTIVE);
    expect(sqlTextGrants(sqlText({ ...all, grammarSha256: null }), row)).toEqual(RESTRICTIVE);
    const unreviewing = rowWith("postgres", { ...row.grants, grammarSha256: null });
    expect(sqlTextGrants(sqlText({ ...all, grammarSha256: null }), unreviewing)).toEqual(RESTRICTIVE);
    expect(sqlTextGrants(all, unreviewing)).toEqual(RESTRICTIVE);
    expect(sqlTextGrants(all, null)).toEqual(RESTRICTIVE);
  });

  test("an exempt form the request lists twice, in any letter case, is granted once, at its first place in the request", () => {
    const reviewed = digest();
    const row = rowWith("postgres", {
      confirmExemptForms: [
        ["ALTER", "SESSION", "SET"],
        ["DROP", "PLANTED"],
      ],
      grammarSha256: reviewed,
    });
    const forms = [
      ["DROP", "PLANTED"],
      ["ALTER", "SESSION", "SET"],
      ["drop", "planted"],
      ["DROP", "PLANTED"],
    ];
    expect(
      sqlTextGrants(sqlText({ grammarSha256: reviewed, confirmExemptForms: forms }), row).confirmExemptForms,
    ).toEqual([
      ["DROP", "PLANTED"],
      ["ALTER", "SESSION", "SET"],
    ]);
  });

  test("a package row may grant redaction sql or none, and a command reader requested by a package is read as none", () => {
    const reviewed = digest();
    const pkg = { name: "@acme/provider-acmesql", version: "1.0.0", digest: `sha256:${digest()}` };
    const packageRow = (redaction: RegisterGrants["redaction"]) => ({
      package: pkg,
      engine: UNRECORDED,
      grants: { ...legacyRow("postgres").grants, redaction, grammarSha256: reviewed },
    });
    const rowOf = (redaction: RegisterGrants["redaction"]) =>
      parseGrantRegister([packageRow(redaction)], SHIPPED_DATABASE_TYPES).rowFor({ package: pkg, engine: UNRECORDED });
    const redactionOf = (requested: StatementRedaction, row: RegisterRow | null) =>
      grantEngineClaims(
        UNRECORDED,
        BASE,
        sqlText({ redaction: requested, grammarSha256: reviewed }),
        languageDataOf(UNRECORDED),
        row,
        { ...SEED_ONLY_FIELDS, [UNRECORDED]: null },
      ).redaction;

    expect(redactionOf(NAMES, rowOf(NAMES))).toEqual(NAMES);
    expect(redactionOf({ kind: "none" }, rowOf({ kind: "none" }))).toEqual({ kind: "none" });
    expect(redactionOf(NAMES, rowOf({ kind: "none" }))).toEqual({ kind: "none" });
    expect(redactionOf({ kind: "command", reader: "redactionReader" }, rowOf(NAMES))).toEqual({ kind: "none" });
    // The register admits no package row granting a command reader, so no package's command request equals a row.
    expect(() => rowOf({ kind: "command", reader: "redactionReader" })).toThrow("package-command-redaction");
  });

  test("a SQL text request value outside its claim's vocabulary is refused by name, naming the claim and the engine", () => {
    const cases: readonly [Partial<Record<keyof SqlTextRequest, unknown>>, string][] = [
      [{ redaction: { kind: "sql", nameQuote: "'" } }, 'sqlText.redaction {"kind":"sql","nameQuote":"\'"}'],
      [{ redaction: { kind: "sql" } }, 'sqlText.redaction {"kind":"sql"}'],
      [{ redaction: { kind: "command", reader: 1 } }, 'sqlText.redaction {"kind":"command","reader":1}'],
      [{ redaction: { kind: "masked" } }, 'sqlText.redaction {"kind":"masked"}'],
      [{ redaction: null }, "sqlText.redaction null"],
      [{ readsSqlText: "no" }, 'sqlText.readsSqlText "no"'],
      [{ confirmExemptForms: [["ALTER", 1]] }, 'sqlText.grammar.confirmExemptForms [["ALTER",1]]'],
      [{ confirmExemptForms: ["ALTER"] }, 'sqlText.grammar.confirmExemptForms ["ALTER"]'],
      [{ confirmExemptForms: null }, "sqlText.grammar.confirmExemptForms null"],
      [{ grammarSha256: "ABC" }, 'sqlText.grammarSha256 "ABC"'],
      [{ grammarSha256: 1 }, "sqlText.grammarSha256 1"],
    ];
    for (const [changes, refusal] of cases) {
      expect(() =>
        grantEngineClaims(
          "postgres",
          BASE,
          sqlText(changes as Partial<SqlTextRequest>),
          languageDataOf("postgres"),
          legacyRow("postgres"),
          SEED_ONLY_FIELDS,
        ),
      ).toThrow(`postgres requests ${refusal}, which is not a value of the claim`);
    }
  });
});

describe("Studio's grant of an engine's statement language data", () => {
  /** A language data digest of the form a row states, new on every call. */
  const digest = () => createHash("sha256").update(randomUUID()).digest("hex");
  const NAMES: StatementRedaction = { kind: "sql", nameQuote: '"' };
  const FORMS = [["DROP", "PLANTED"]];

  /**
   * The grants of kafka, whose legacy row grants its language `kafkaread`, `readsSqlText: false` and `decidesAlone`
   * for the grammar it reviewed, requesting language data whose digest is `requested` against its legacy row stating
   * `reviewed`. Its redaction and exempt forms are requested and granted so the test sees they stay under the grammar
   * digest alone.
   */
  const kafkaGrants = (requested: unknown, reviewed: string | null) => {
    const { statementLanguage, decidesAlone, readsSqlText, redaction, confirmExemptForms, reviewedGrammar } =
      grantEngineClaims(
        "kafka",
        BUNDLED_CLAIM_REQUESTS.kafka,
        { ...legacySqlText("kafka"), redaction: NAMES, confirmExemptForms: FORMS },
        { languageSha256: requested as string | null },
        rowWith("kafka", { languageSha256: reviewed, redaction: NAMES, confirmExemptForms: FORMS }),
        SEED_ONLY_FIELDS,
      );
    return { statementLanguage, decidesAlone, readsSqlText, redaction, confirmExemptForms, reviewedGrammar };
  };
  const GRANTED = {
    statementLanguage: "kafkaread",
    decidesAlone: true,
    readsSqlText: false,
    redaction: NAMES,
    confirmExemptForms: FORMS,
    reviewedGrammar: true,
  };
  const UNREVIEWED = { ...GRANTED, statementLanguage: null, decidesAlone: false, readsSqlText: true };

  test("the language and decidesAlone are granted for declared language data only under the digest the row reviewed", () => {
    const reviewed = digest();

    // The data the row reviewed: the language, decidesAlone and readsSqlText false are the row's.
    expect(kafkaGrants(reviewed, reviewed)).toEqual(GRANTED);
    // Other data, data the row reviewed as absent, and no data under a row that reviewed some: none of the three.
    expect(kafkaGrants(reviewed, digest())).toEqual(UNREVIEWED);
    expect(kafkaGrants(reviewed, null)).toEqual(UNREVIEWED);
    expect(kafkaGrants(null, reviewed)).toEqual(UNREVIEWED);
    // No data, reviewed as stating none: the grant reads as it did before the review of language data existed.
    expect(kafkaGrants(null, null)).toEqual(GRANTED);
    const { statementLanguage, decidesAlone, readsSqlText } = legacyEngineGrants("kafka");
    expect({ statementLanguage, decidesAlone, readsSqlText }).toEqual({
      statementLanguage: "kafkaread",
      decidesAlone: true,
      readsSqlText: false,
    });
    // No row: every claim at its restrictive value, whatever the data.
    const unrowed = grantEngineClaims(
      UNRECORDED,
      request({}, {}, {}, {}, { statementLanguage: "acmeql" as never }),
      UNRECORDED_SQL_TEXT,
      { languageSha256: reviewed },
      null,
      { ...SEED_ONLY_FIELDS, [UNRECORDED]: null },
    );
    expect([unrowed.statementLanguage, unrowed.decidesAlone, unrowed.readsSqlText]).toEqual([null, false, true]);
    // A request digest outside the form is refused by name, naming the request member and the engine.
    for (const [value, shown] of [
      ["ABC", '"ABC"'],
      [1, "1"],
      [reviewed.toUpperCase(), JSON.stringify(reviewed.toUpperCase())],
    ] as const) {
      expect(() => kafkaGrants(value, reviewed)).toThrow(
        `kafka requests statementLanguageData.languageSha256 ${shown}, which is not a value of the claim`,
      );
    }
  });

  test("an engine with no SQL text is granted readsSqlText false and decidesAlone under its reviewed language digest alone, and nothing under a changed byte, a null digest, a row reviewing a grammar or a row granting neither", () => {
    const reviewed = digest();
    /** `reviewed` with its last hex digit changed: the digest of data one byte off. */
    const changed = `${reviewed.slice(0, -1)}${reviewed.endsWith("0") ? "1" : "0"}`;
    /**
     * The SQL text grants of kafka stating no SQL text, as the server catalog's composer requests it for such an
     * engine (`UNRECORDED_SQL_TEXT`, no grammar digest), and language data of digest `requested`, against kafka's
     * legacy row reviewing no grammar, `reviewed` as its language digest, a redaction and an exempt form, and
     * `changes`; or against no row where `changes` is null.
     */
    const noSqlTextGrants = (requested: string | null, changes: Partial<RegisterGrants> | null) => {
      const row =
        changes === null
          ? null
          : rowWith("kafka", {
              grammarSha256: null,
              languageSha256: reviewed,
              redaction: NAMES,
              confirmExemptForms: FORMS,
              ...changes,
            });
      const { decidesAlone, readsSqlText, redaction, confirmExemptForms, reviewedGrammar } = grantEngineClaims(
        "kafka",
        BUNDLED_CLAIM_REQUESTS.kafka,
        UNRECORDED_SQL_TEXT,
        { languageSha256: requested },
        row,
        SEED_ONLY_FIELDS,
      );
      return { decidesAlone, readsSqlText, redaction, confirmExemptForms, reviewedGrammar };
    };
    const RESTRICTIVE = {
      decidesAlone: false,
      readsSqlText: true,
      redaction: { kind: "none" },
      confirmExemptForms: [],
      reviewedGrammar: false,
    } as const;
    // Vacuity: kafka's legacy row grants both claims, so the base the cases change grants them.
    const { readsSqlText, decidesAlone } = legacyRow("kafka").grants;
    expect({ readsSqlText, decidesAlone }).toEqual({ readsSqlText: false, decidesAlone: true });

    // The language data the row reviewed: readsSqlText and decidesAlone as the row grants them, and the claims that
    // stay under a grammar digest, the redaction and the exempt forms, restrictive, with no grammar reviewed.
    expect(noSqlTextGrants(reviewed, {})).toEqual({ ...RESTRICTIVE, decidesAlone: true, readsSqlText: false });
    expect(noSqlTextGrants(reviewed, { decidesAlone: false })).toEqual({ ...RESTRICTIVE, readsSqlText: false });
    expect(noSqlTextGrants(reviewed, { readsSqlText: true })).toEqual({ ...RESTRICTIVE, decidesAlone: true });
    // A row granting neither, data one byte off, no data under a row that reviewed some, no data reviewed as stating
    // none, a row that reviews a grammar the engine does not state, and no row: every claim at its restrictive value.
    expect(noSqlTextGrants(reviewed, { readsSqlText: true, decidesAlone: false })).toEqual(RESTRICTIVE);
    expect(noSqlTextGrants(changed, {})).toEqual(RESTRICTIVE);
    expect(noSqlTextGrants(null, {})).toEqual(RESTRICTIVE);
    expect(noSqlTextGrants(null, { languageSha256: null })).toEqual(RESTRICTIVE);
    expect(noSqlTextGrants(reviewed, { grammarSha256: digest() })).toEqual(RESTRICTIVE);
    expect(noSqlTextGrants(reviewed, null)).toEqual(RESTRICTIVE);
    // A request that carries a grammar digest under a row that reviews none: the engine states SQL text no row
    // reviewed, so nothing is granted.
    const stating = grantEngineClaims(
      "kafka",
      BUNDLED_CLAIM_REQUESTS.kafka,
      { ...UNRECORDED_SQL_TEXT, grammarSha256: digest() },
      { languageSha256: reviewed },
      rowWith("kafka", { grammarSha256: null, languageSha256: reviewed }),
      SEED_ONLY_FIELDS,
    );
    expect([stating.readsSqlText, stating.decidesAlone, stating.reviewedGrammar]).toEqual([true, false, false]);
  });
});

describe("Studio's grant of the agent overlay's command-shaped catalog read", () => {
  /** The claim's dotted member, as a refusal names it. */
  const CLAIM = "agent.overlay.dialect.catalogRead.commandShaped";

  /** Whether `type`'s server overlay requests its catalog read as a command: the request the fence hands the grant. */
  const requested = (type: DatabaseType): boolean => {
    const read = engineServerDialect(type).catalogRead;
    return read !== "unsupported" && read.commandShaped === true;
  };

  test("the command-shaped catalog read is granted only where the request and the engine's register row both are, and a request that is not a boolean is refused by name", () => {
    const granting = grantOf("postgres", request(), rowWith("postgres", { catalogReadCommandShaped: true }));
    const refusing = grantOf("postgres", request(), rowWith("postgres", { catalogReadCommandShaped: false }));
    const rowless = grantOf(UNRECORDED, request(), null);

    // The grants carry the row's review of the claim, false where no row exists.
    expect([granting, refusing, rowless].map((grants) => grants.catalogReadCommandShaped)).toEqual([
      true,
      false,
      false,
    ]);
    const cases = [
      [true, granting, true],
      [false, granting, false],
      [true, refusing, false],
      [false, refusing, false],
      [true, rowless, false],
      [false, rowless, false],
    ] as const;
    for (const [asked, grants, granted] of cases) {
      expect({
        asked,
        row: grants.catalogReadCommandShaped,
        granted: grantedCatalogReadCommand("postgres", asked, grants),
      }).toEqual({ asked, row: grants.catalogReadCommandShaped, granted });
    }
    for (const value of [undefined, "yes", 1, null]) {
      expect(() => grantedCatalogReadCommand("postgres", value, granting)).toThrow(
        `postgres requests ${CLAIM} ${JSON.stringify(value)}, which is not a value of the claim`,
      );
    }
  });

  test("for every shipped engine, the granted command-shaped catalog read is its server overlay's request, and its register row grants it exactly where the overlay requests it", () => {
    const granted = SHIPPED_DATABASE_TYPES.filter((type) =>
      grantedCatalogReadCommand(type, requested(type), legacyEngineGrants(type)),
    );
    const asked = SHIPPED_DATABASE_TYPES.filter(requested);

    expect(granted).toEqual(asked);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => legacyEngineGrants(type).catalogReadCommandShaped)).toEqual(asked);
    // Vacuity: the claim is granted on some shipped engines and not on others.
    expect(granted).toEqual(["elasticsearch", "opensearch"]);
    expect(requested("postgres")).toBe(false);
  });
});

describe("the claims of an admitted provider package's engine", () => {
  test("an admitted package with no grant record reads every claim at its restrictive value", () => {
    const manifest = admittedManifest("acmeloose", withLoosestClaims);
    installServerCatalog(composeServerCatalog([admittedFor("acme-loose", manifest)], [], STUDIO_GRANT_REGISTER));
    const answer = serverEngine("acmeloose");
    if (answer.kind !== "served") throw new Error(`answered ${answer.kind}`);

    // Studio's register holds no row for the package, so each claim is granted at its restrictive value.
    expect(answer.engine.grants).toEqual({
      writeReach: "open",
      readsFileAccessPosture: true,
      deniedFileAccessRefusal: UNGRANTED_DENIED_FILE_ACCESS_SENTENCE,
      singleWriterFile: false,
      readRootsRequired: true,
      agentCredentialForm: "none",
      maskingExemptColumns: null,
      exposable: false,
      statementRead: false,
      metadataReadChangesState: true,
      agentCredentialRequired: true,
      readOnlyEnforced: false,
      ungrantedRefusals: UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
      opensLocalFile: true,
      hostPathFields: [],
      serverLevelAtAdmission: true,
      serverLevelAtCatalogChoice: false,
      sshTunnel: UNGRANTED_SSH_TUNNEL_SENTENCE,
      agentCredential: null,
      statementLanguage: null,
      agentReadings: [],
      ownWords: "code-only",
      servesOneSession: null,
      agentExecution: false,
      catalogReadCommandShaped: false,
      redaction: { kind: "none" },
      readsSqlText: true,
      confirmExemptForms: [],
      decidesAlone: false,
      reviewedGrammar: false,
    });
    expect(Object.isFrozen(answer.engine.grants)).toBe(true);
    forgetServerCatalog();
  });
});

describe("the grant reader's inputs", () => {
  /** The grant reader, read by its repository path. */
  const GRANT_READER = "src/lib/db/claim-grants.ts";

  /**
   * Every value the grant reader imports, `<name> from <specifier>`, with its role. The request and the register are
   * its inputs, and the served set and the field-name vocabulary name no grant of any engine. A new value import fails
   * until it is listed here with its role.
   */
  const GRANT_READER_INPUTS: Readonly<Record<string, string>> = {
    "BUNDLED_CLAIM_REQUESTS from ./engine-catalog/claims.generated": "the request: every bundled engine's claims",
    "BUNDLED_SQL_TEXT from ./engine-catalog/sql-text.generated":
      "the request: every bundled engine's SQL text, read for its readsSqlText and its exempt forms",
    "SEED_ONLY_FIELDS from ./connection-fields":
      "the request: each declaration's seed-only fields, read where no review row exists",
    "LEGACY_KEY from @libredb/grant-register": "the register: the key of a legacy row",
    "readGrantRegister from @libredb/grant-register": "the register: its reader",
    "SHIPPED_DATABASE_TYPES from ./compatibility":
      "the legacy adapter's served set: the engines the register's legacy rows are read for",
    "BODY_CONNECTION_FIELDS from ./connection-fields":
      "the field names a row's superseding fields are narrowed to, keyed by no engine",
  };

  /** Each input not on `GRANT_READER_INPUTS`, by name. */
  function unlisted(inputs: readonly Input[]): readonly string[] {
    return inputs.map(({ input }) => input).filter((input) => !Object.hasOwn(GRANT_READER_INPUTS, input));
  }

  /** Each input from a module holding a claim table of `inventory`, the engine table inventory, with the table's name. */
  function claimTableInputs(
    inputs: readonly Input[],
    inventory: readonly InventoryEntry[] = ENGINE_TABLE_INVENTORY,
  ): readonly string[] {
    const tables = inventory.filter((entry) => entry.destination.includes(REVIEW_RECORD_PHRASE));
    return inputs.flatMap(({ input, module }) =>
      tables.filter((table) => moduleOf(table.module) === module).map((table) => `${input}: ${table.name}`),
    );
  }

  const readerText = () => readFileSync(path.join(import.meta.dir, "../../..", GRANT_READER), "utf8");

  test("the grant reader's only inputs are the request and the register: it imports no module that exports an engine-keyed record", () => {
    const inputs = valueInputs(GRANT_READER, readerText());

    expect(unlisted(inputs)).toEqual([]);
    expect(inputs.map(({ input }) => input).sort()).toEqual(Object.keys(GRANT_READER_INPUTS).sort());
    expect(claimTableInputs(inputs)).toEqual([]);
  });

  test("the inputs scan finds a value import, a re-export and a dynamic import by name, and passes over a type-only import", () => {
    const planted = (line: string) => valueInputs(GRANT_READER, `${line}\n${readerText()}`);
    // No claim table is left in the inventory, so the scan reads one planted in an inventory of its own.
    const table = { module: "src/lib/db/planted-claims.ts", name: "PLANTED_REDACTION", destination: claim("policy") };
    const inventory = [...ENGINE_TABLE_INVENTORY, table];
    const input = "PLANTED_REDACTION from ./planted-claims";

    const imported = planted('import { PLANTED_REDACTION } from "./planted-claims";');
    expect(unlisted(imported)).toEqual([input]);
    expect(claimTableInputs(imported, inventory)).toEqual([`${input}: PLANTED_REDACTION`]);
    expect(claimTableInputs(imported)).toEqual([]);

    const reexported = planted('export { PLANTED_REDACTION } from "./planted-claims";');
    expect(unlisted(reexported)).toEqual([input]);
    expect(claimTableInputs(reexported, inventory)).toEqual([`${input}: PLANTED_REDACTION`]);

    expect(unlisted(planted('import type { PlantedRedaction } from "./planted-claims";'))).toEqual([]);
    expect(unlisted(planted('const r = await import("./confirmation-claim-review");'))).toEqual([
      'import("./confirmation-claim-review")',
    ]);
    // Vacuity: the real module's parse holds the request.
    expect(valueInputs(GRANT_READER, readerText()).map(({ input }) => input)).toContain(
      "BUNDLED_CLAIM_REQUESTS from ./engine-catalog/claims.generated",
    );
  });
});

/**
 * Whether `value` is keyed by engine by its shape, frozen or not: a non-empty list or set whose every member is a
 * shipped engine id, a non-empty map whose every key is one, or a non-empty object whose every own key is one.
 */
function engineKeyed(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const shipped = new Set<string>(SHIPPED_DATABASE_TYPES);
  const ids: unknown[] = Array.isArray(value)
    ? value
    : value instanceof Set
      ? [...value]
      : value instanceof Map
        ? [...value.keys()]
        : Reflect.ownKeys(value);
  return ids.length > 0 && ids.every((id) => typeof id === "string" && shipped.has(id));
}

/** The names of `exports` whose value is keyed by engine by its shape, sorted. */
function engineKeyedExports(exports: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(exports)
    .filter(([, value]) => engineKeyed(value))
    .map(([name]) => name)
    .sort();
}

describe("the grant reader's engine-keyed exports", () => {
  test("claim-grants exports only the projections the browser reads, each named in the exit list", () => {
    const exported = engineKeyedExports(claimGrants);
    const listed = CORE_GRANT_RECORDS.filter((entry) => entry.module === CLAIM_GRANTS);
    const exports = claimGrants as Record<string, unknown>;
    const functions = listed.filter((entry) => typeof exports[entry.name] === "function");

    // The engine-keyed values are the listed entries that are no function, and each function entry is a function the
    // module exports: a reader of a legacy engine's grants by id.
    expect(exported).toEqual(
      listed
        .filter((entry) => !functions.includes(entry))
        .map((entry) => entry.name)
        .sort(),
    );
    expect(functions.map((entry) => entry.name)).toEqual(["legacyEngineGrants"]);
    expect(
      listed.filter((entry) => entry.removedBy.some((removal) => !("milestone" in removal))).map((entry) => entry.name),
    ).toEqual([]);
    // Vacuity: the shape finds a table and the list, and passes over a vocabulary that holds no engine id.
    expect(exported).toContain("GRANTED_WRITE_REACH");
    expect(exported).toContain("GRANTED_AGENT_EXECUTION_ENGINES");
    expect(engineKeyed(claimGrants.AGENT_READING_NAMES)).toBe(false);
    // The shape is read whether or not the value is frozen, and a value keyed by some engines is keyed by engine too:
    // a table, a list, a set and a map are each found, and a value holding a name that is no engine id is not.
    expect(
      engineKeyedExports({
        frozenTable: Object.freeze({ ...claimGrants.GRANTED_WRITE_REACH }),
        table: { ...claimGrants.GRANTED_WRITE_REACH },
        someEngines: { postgres: 1 },
        list: [...claimGrants.GRANTED_AGENT_EXECUTION_ENGINES],
        set: new Set(["postgres"]),
        map: new Map([["postgres", 1]]),
        mixed: { postgres: 1, rowFor: 2 },
        mixedList: ["postgres", "sql"],
        empty: {},
        emptyList: [],
        reader: claimGrants.legacyEngineGrants,
        sentence: "postgres",
      }),
    ).toEqual(["frozenTable", "list", "map", "set", "someEngines", "table"]);
  });
});
