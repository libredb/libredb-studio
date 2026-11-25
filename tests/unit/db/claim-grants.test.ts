/**
 * Studio's grant of each policy and MCP claim (docs/providers/CONTRACT.md, clauses M-54 and M-82): the more restrictive
 * of an engine's request and Studio's review record of the claim, the claim's restrictive value where no record row
 * exists, by one rule per claim shape. `grantClaims` is read here with hand-made requests and records, each built from
 * the shipped ones with one engine changed or for an id no shipped engine uses, and the bundled grant tables are read
 * against Studio's records for every shipped engine.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { McpClaims, PolicyClaims } from "@libredb/provider-sdk/manifest";
import {
  type ClaimRecords,
  GRANTED_AGENT_CREDENTIAL_FORM,
  GRANTED_DENIED_FILE_ACCESS_REFUSAL,
  GRANTED_HOST_PATH_FIELDS,
  GRANTED_MASKING_EXEMPT_COLUMNS,
  GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED,
  GRANTED_MCP_EXPOSABLE,
  GRANTED_MCP_METADATA_READ_CHANGES_STATE,
  GRANTED_MCP_STATEMENT_READ,
  GRANTED_OPENS_LOCAL_FILE,
  GRANTED_OPENS_SERVER_LEVEL_AT_ADMISSION,
  GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE,
  GRANTED_READ_ROOTS_REQUIRED,
  GRANTED_READS_FILE_ACCESS_POSTURE,
  GRANTED_SEED_AGENT_CREDENTIAL,
  GRANTED_SINGLE_WRITER_FILE,
  GRANTED_SSH_TUNNEL_REFUSAL,
  GRANTED_WRITE_REACH,
  grantClaims,
  HOST_PATH_FIELD_NAMES,
  READ_ONLY_ENFORCED,
  STUDIO_CLAIM_RECORDS,
  UNGRANTED_CLAIM_REFUSALS,
  UNGRANTED_DENIED_FILE_ACCESS_SENTENCE,
  UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
  UNGRANTED_SSH_TUNNEL_SENTENCE,
} from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { SEED_ONLY_FIELDS } from "@/lib/db/connection-fields";
import { BUNDLED_CLAIM_REQUESTS } from "@/lib/db/engine-catalog/claims.generated";
import type { ClaimRequestEntry, ConnectionClaims } from "@/lib/db/engine-catalog/projection";

/** An id no shipped engine uses, for a request no record row covers. */
const UNRECORDED = "acmefoo";

/** postgres's requests, the base every hand-made request changes one claim of. */
const BASE: ClaimRequestEntry = BUNDLED_CLAIM_REQUESTS.postgres;

/** One engine's requests: postgres's with `policy`, `mcp` and `connection` members changed. */
function request(
  policy: Partial<PolicyClaims> = {},
  mcp: Partial<McpClaims> = {},
  connection: Partial<ConnectionClaims> = {},
): ClaimRequestEntry {
  return {
    policy: { ...BASE.policy, ...policy },
    mcp: { ...BASE.mcp, ...mcp },
    connection: { ...BASE.connection, ...connection },
    facets: BASE.facets,
    agent: BASE.agent,
  };
}

/** The seed-only fields `grantClaims` reads the restrictive host path fields from: the shipped ones by default. */
type SeedOnlyRows = Parameters<typeof grantClaims>[2];

/** Studio's records with one row of each named record set for `engine`, every other row as shipped. */
function records(engine: string, rows: { readonly [K in keyof ClaimRecords]?: ClaimRecords[K][string] }): ClaimRecords {
  const changed: Record<string, unknown> = { ...STUDIO_CLAIM_RECORDS };
  for (const [member, row] of Object.entries(rows)) {
    changed[member] = { ...STUDIO_CLAIM_RECORDS[member as keyof ClaimRecords], [engine]: row };
  }
  return changed as unknown as ClaimRecords;
}

/**
 * The grants of one engine `engine` requesting `requested` against `against`, with `seedOnly` as its seed-only rows.
 */
function grantOf(
  engine: string,
  requested: ClaimRequestEntry,
  against: ClaimRecords = STUDIO_CLAIM_RECORDS,
  seedOnly: SeedOnlyRows = { ...SEED_ONLY_FIELDS, [UNRECORDED]: null },
) {
  const grants = grantClaims({ [engine]: requested }, against, seedOnly);
  return Object.fromEntries(Object.entries(grants).map(([table, rows]) => [table, rows[engine]])) as {
    readonly [K in keyof typeof grants]: (typeof grants)[K][string];
  };
}

describe("Studio's grant of each policy and MCP claim", () => {
  test("for every shipped engine, each granted policy and MCP claim is its record's row, and no engine is refused at open", () => {
    const differing = (granted: Readonly<Record<string, unknown>>, record: Readonly<Record<string, unknown>>) =>
      SHIPPED_DATABASE_TYPES.filter((type) => JSON.stringify(granted[type]) !== JSON.stringify(record[type]));
    const tables = [
      [GRANTED_WRITE_REACH, STUDIO_CLAIM_RECORDS.writeReach],
      [GRANTED_READS_FILE_ACCESS_POSTURE, STUDIO_CLAIM_RECORDS.readsFileAccessPosture],
      [GRANTED_DENIED_FILE_ACCESS_REFUSAL, STUDIO_CLAIM_RECORDS.deniedFileAccessRefusal],
      [GRANTED_SINGLE_WRITER_FILE, STUDIO_CLAIM_RECORDS.singleWriterFile],
      [GRANTED_READ_ROOTS_REQUIRED, STUDIO_CLAIM_RECORDS.readRootsRequired],
      [GRANTED_AGENT_CREDENTIAL_FORM, STUDIO_CLAIM_RECORDS.agentCredentialForm],
      [GRANTED_MASKING_EXEMPT_COLUMNS, STUDIO_CLAIM_RECORDS.maskingExemptColumns],
      [GRANTED_MCP_EXPOSABLE, STUDIO_CLAIM_RECORDS.exposable],
      [GRANTED_MCP_STATEMENT_READ, STUDIO_CLAIM_RECORDS.statementRead],
      [GRANTED_MCP_METADATA_READ_CHANGES_STATE, STUDIO_CLAIM_RECORDS.metadataReadChangesState],
      [GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED, STUDIO_CLAIM_RECORDS.agentCredentialRequired],
    ] as const;

    expect(tables.flatMap(([granted, record]) => differing(granted, record))).toEqual([]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => UNGRANTED_CLAIM_REFUSALS[type] !== null)).toEqual([]);
    // Vacuity: the shipped records hold rows that differ from each claim's restrictive value.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_WRITE_REACH[type] !== "open").length).toBeGreaterThan(0);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_MCP_EXPOSABLE[type]).length).toBeGreaterThan(0);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_SINGLE_WRITER_FILE[type]).length).toBeGreaterThan(0);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_MASKING_EXEMPT_COLUMNS[type] !== null)).toEqual(["modbus"]);
  });

  test("a write reach request is capped at the grant, and read open where no record exists", () => {
    const etcd = (writeReach: PolicyClaims["writeReach"]) => grantOf("etcd", request({ writeReach }));
    const modbus = (writeReach: PolicyClaims["writeReach"]) => grantOf("modbus", request({ writeReach }));

    expect(STUDIO_CLAIM_RECORDS.writeReach.etcd).toBe("guarded");
    expect(STUDIO_CLAIM_RECORDS.writeReach.modbus).toBe("none");
    expect(STUDIO_CLAIM_RECORDS.writeReach.postgres).toBe("open");
    expect(etcd("none").writeReach).toBe("guarded");
    expect(etcd("guarded").writeReach).toBe("guarded");
    expect(etcd("open").writeReach).toBe("open");
    expect(
      grantOf("postgres", request({ writeReach: "open" }), records("postgres", { writeReach: "none" })).writeReach,
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
      const against = row === undefined ? STUDIO_CLAIM_RECORDS : records(engine, { [claim]: row });

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
      const against = row === undefined ? STUDIO_CLAIM_RECORDS : records(engine, { [claim]: row });

      expect(grantOf(engine, request({}, { [claim]: requested }), against)[claim]).toBe(granted);
    },
  );

  test("a denied file access refusal requested keeps its own sentence, one offered against a record's refusal takes the record's, and one offered where no record exists takes core's own", () => {
    const own = "Connections of this engine refuse a denied file access for a reason of their own.";
    const sqlite = STUDIO_CLAIM_RECORDS.deniedFileAccessRefusal.sqlite;
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

    expect(STUDIO_CLAIM_RECORDS.singleWriterFile.duckdb).toBe(true);
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

    expect(STUDIO_CLAIM_RECORDS.agentCredentialForm.postgres).toBeNull();
    expect(STUDIO_CLAIM_RECORDS.agentCredentialForm.s3).toBe("dedicated-user");
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
    const row = STUDIO_CLAIM_RECORDS.maskingExemptColumns.modbus;
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
    expect(STUDIO_CLAIM_RECORDS.agentCredential.s3).not.toBeNull();
    expect(grantOf("s3", { ...s3, mcp: { ...s3.mcp, exposable: true, agentCredentialRequired: true } })).toMatchObject({
      exposable: true,
      agentCredentialRequired: true,
    });
    // postgres's seeds take one too; read as required, it stays exposed.
    expect(grantOf("postgres", open, records("postgres", { agentCredentialRequired: true }))).toMatchObject({
      exposable: true,
      agentCredentialRequired: true,
    });
    // Seeds that take none: closed, whatever the request and the exposure record.
    expect(
      grantOf("postgres", open, records("postgres", { agentCredentialRequired: true, agentCredential: null })),
    ).toMatchObject({ exposable: false, agentCredentialRequired: true });
    expect(STUDIO_CLAIM_RECORDS.agentCredential.libredb).toBeNull();
    expect(grantOf("libredb", open, records("libredb", { exposable: true }))).toMatchObject({
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

  test("READ_ONLY_ENFORCED is true exactly where the granted write reach is not open", () => {
    expect(
      SHIPPED_DATABASE_TYPES.filter((type) => READ_ONLY_ENFORCED[type] !== (GRANTED_WRITE_REACH[type] !== "open")),
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
      GRANTED_READS_FILE_ACCESS_POSTURE,
      GRANTED_DENIED_FILE_ACCESS_REFUSAL,
      GRANTED_SINGLE_WRITER_FILE,
      GRANTED_READ_ROOTS_REQUIRED,
      GRANTED_AGENT_CREDENTIAL_FORM,
      GRANTED_MASKING_EXEMPT_COLUMNS,
      GRANTED_MCP_EXPOSABLE,
      GRANTED_MCP_STATEMENT_READ,
      GRANTED_MCP_METADATA_READ_CHANGES_STATE,
      GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED,
      READ_ONLY_ENFORCED,
      UNGRANTED_CLAIM_REFUSALS,
      GRANTED_OPENS_LOCAL_FILE,
      GRANTED_HOST_PATH_FIELDS,
      GRANTED_OPENS_SERVER_LEVEL_AT_ADMISSION,
      GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE,
      GRANTED_SSH_TUNNEL_REFUSAL,
      GRANTED_SEED_AGENT_CREDENTIAL,
    ];

    for (const table of tables) {
      expect(frozen(table)).toBe(true);
      expect(Object.keys(table)).toEqual([...SHIPPED_DATABASE_TYPES]);
    }
    // A hand-made record's row is copied and frozen, never handed out.
    const row = { column: "^a$", reason: "Holds no protected value." };
    const granted = grantOf(
      "postgres",
      request({ maskingExemptColumns: { ...row } }),
      records("postgres", {
        maskingExemptColumns: row,
      }),
    );
    expect(granted.maskingExemptColumns).toEqual(row);
    expect(granted.maskingExemptColumns).not.toBe(row);
    expect(Object.isFrozen(granted.maskingExemptColumns)).toBe(true);
    // A record row on the prototype chain is no row: the claim is read as having none.
    const inherited = Object.create({ [UNRECORDED]: "none" }) as Record<string, "none">;
    expect(
      grantOf(UNRECORDED, request({ writeReach: "none" }), { ...STUDIO_CLAIM_RECORDS, writeReach: inherited })
        .writeReach,
    ).toBe("open");
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
      [GRANTED_OPENS_LOCAL_FILE, STUDIO_CLAIM_RECORDS.opensLocalFile],
      [GRANTED_HOST_PATH_FIELDS, STUDIO_CLAIM_RECORDS.hostPathFields],
      [GRANTED_OPENS_SERVER_LEVEL_AT_ADMISSION, STUDIO_CLAIM_RECORDS.serverLevelWithoutDatabase],
      [GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE, STUDIO_CLAIM_RECORDS.serverLevelWithoutDatabase],
      [GRANTED_SSH_TUNNEL_REFUSAL, STUDIO_CLAIM_RECORDS.sshTunnel],
      [GRANTED_SEED_AGENT_CREDENTIAL, STUDIO_CLAIM_RECORDS.agentCredential],
    ] as const;

    expect(tables.flatMap(([granted, record]) => differing(granted, record))).toEqual([]);
    // The granted rows are the record's own: the host path fields and the seed agent credential are its objects.
    expect(GRANTED_HOST_PATH_FIELDS.opcua).toBe(STUDIO_CLAIM_RECORDS.hostPathFields.opcua);
    expect(GRANTED_SEED_AGENT_CREDENTIAL.elasticsearch).toBe(STUDIO_CLAIM_RECORDS.agentCredential.elasticsearch);
    // Vacuity: each record holds rows that differ from its claim's restrictive value.
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_OPENS_LOCAL_FILE[type])).toEqual([
      "duckdb",
      "libredb",
      "sqlite",
    ]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_HOST_PATH_FIELDS[type].length > 0)).toEqual(["opcua"]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE[type])).toEqual([
      "postgres",
    ]);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_SSH_TUNNEL_REFUSAL[type] === null).length).toBe(32);
    expect(SHIPPED_DATABASE_TYPES.filter((type) => GRANTED_SEED_AGENT_CREDENTIAL[type] === null).length).toBe(11);
    expect(GRANTED_MCP_EXPOSABLE).toEqual(STUDIO_CLAIM_RECORDS.exposable);
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
      const against = row === undefined ? STUDIO_CLAIM_RECORDS : records(engine, { opensLocalFile: row });

      expect(grantOf(engine, request({}, {}, { opensLocalFile: requested }), against).opensLocalFile).toBe(granted);
    },
  );

  test("the host path fields granted are the union of the request and the record, and every host path field among the seed-only fields where no record exists", () => {
    const of = (engine: string, hostPathFields: ConnectionClaims["hostPathFields"], against = STUDIO_CLAIM_RECORDS) =>
      grantOf(engine, request({}, {}, { hostPathFields }), against).hostPathFields;
    const row = STUDIO_CLAIM_RECORDS.hostPathFields.opcua;

    expect(row).toEqual(["clientCertificatePath", "clientPrivateKeyPath"]);
    // A request adding nothing to the record is the record's own row.
    expect(of("opcua", [])).toBe(row);
    expect(of("opcua", ["clientPrivateKeyPath"])).toBe(row);
    // A request naming a field the record does not: the record's fields first, then the request's others.
    const certificate = records("postgres", { hostPathFields: ["clientCertificatePath"] });
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
    expect(
      grantOf(UNRECORDED, request({}, {}, { hostPathFields: [] }), STUDIO_CLAIM_RECORDS, opcuaSeedOnly).hostPathFields,
    ).toEqual(["clientCertificatePath", "clientPrivateKeyPath"]);
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
      const against = row === undefined ? STUDIO_CLAIM_RECORDS : records(engine, { serverLevelWithoutDatabase: row });
      const granted = grantOf(engine, request({}, {}, { serverLevelWithoutDatabase: requested }), against);

      expect([granted.serverLevelAtAdmission, granted.serverLevelAtCatalogChoice]).toEqual([
        atAdmission,
        atCatalogChoice,
      ]);
    },
  );

  test("a refused tunnel request keeps its own sentence, one offered against a refusing record takes the record's, and one offered where no record exists takes core's own", () => {
    const own = "This engine does not run through an SSH tunnel for a reason of its own. Turn the tunnel off.";
    const sqlite = STUDIO_CLAIM_RECORDS.sshTunnel.sqlite;
    const of = (engine: string, sshTunnel: ConnectionClaims["sshTunnel"]) =>
      grantOf(engine, request({}, {}, { sshTunnel })).sshTunnel;

    expect(sqlite).toEqual(expect.any(String));
    expect(STUDIO_CLAIM_RECORDS.sshTunnel.postgres).toBeNull();
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
    const elasticsearch = STUDIO_CLAIM_RECORDS.agentCredential.elasticsearch;
    if (elasticsearch === null || elasticsearch === undefined)
      throw new Error("elasticsearch takes no agent credential");
    const of = (engine: string, agentCredential: ConnectionClaims["agentCredential"]) =>
      grantOf(engine, request({}, {}, { agentCredential })).agentCredential;
    const pair = { form: "pair" as const, supersededBy: [] };

    expect(elasticsearch.supersededBy).toEqual(["apiKeyId", "apiKeySecret"]);
    expect(of("elasticsearch", { form: "pair", supersededBy: ["apiKeyId", "apiKeySecret"] })).toBe(elasticsearch);
    expect(of("postgres", pair)).toBe(STUDIO_CLAIM_RECORDS.agentCredential.postgres);
    expect(of("postgres", { form: "secret", supersededBy: [] })).toBeNull();
    expect(of("elasticsearch", pair)).toBeNull();
    expect(of("elasticsearch", { form: "pair", supersededBy: ["apiKeySecret", "apiKeyId"] })).toBeNull();
    expect(of("elasticsearch", { form: "pair", supersededBy: ["apiKeyId"] })).toBeNull();
    expect(of("postgres", { form: "pair", supersededBy: ["apiKeyId"] })).toBeNull();
    expect(of("postgres", null)).toBeNull();
    expect(of("sqlite", pair)).toBeNull();
    expect(of(UNRECORDED, pair)).toBeNull();
    expect(of(UNRECORDED, null)).toBeNull();
  });

  test("an engine read as requiring an agent credential whose granted credential is null, or whose granted form is none, is closed to MCP", () => {
    const open = (policy: Partial<PolicyClaims> = {}, connection: Partial<ConnectionClaims> = {}) =>
      request(policy, { exposable: true, agentCredentialRequired: true }, connection);
    const required = records("postgres", { agentCredentialRequired: true });

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
        records("postgres", {
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
  });

  test("a value outside its vocabulary in Studio's record is refused naming the record, the claim and the engine, never as the engine's request", () => {
    const wrong = (value: unknown) => value as never;

    expect(() => grantOf("postgres", request(), records("postgres", { writeReach: wrong("partial") }))).toThrow(
      'Studio\'s record of policy.writeReach holds "partial" for postgres, which is not a value of the claim',
    );
    expect(() =>
      grantOf("postgres", request(), records("postgres", { hostPathFields: wrong(["caCertPath"]) })),
    ).toThrow(
      'Studio\'s record of connection.hostPathFields holds ["caCertPath"] for postgres, which is not a value of the claim',
    );
    // A request outside the vocabulary still names the request.
    expect(() => grantOf("postgres", request({ writeReach: wrong("partial") }))).toThrow(
      'postgres requests policy.writeReach "partial", which is not a value of the claim',
    );
  });

  test("an engine whose seed-only row is missing is refused by name", () => {
    expect(() => grantOf(UNRECORDED, request(), STUDIO_CLAIM_RECORDS, SEED_ONLY_FIELDS)).toThrow(
      `${UNRECORDED} has no seed-only row, so Studio cannot grant its host path fields`,
    );
    // A row on the prototype chain is no row.
    const inherited = Object.create({ [UNRECORDED]: null }) as SeedOnlyRows;
    expect(() => grantOf(UNRECORDED, request(), STUDIO_CLAIM_RECORDS, inherited)).toThrow(
      `${UNRECORDED} has no seed-only row, so Studio cannot grant its host path fields`,
    );
  });
});
