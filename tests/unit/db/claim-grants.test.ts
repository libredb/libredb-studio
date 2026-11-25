/**
 * Studio's grant of each policy and MCP claim (docs/providers/CONTRACT.md, clauses M-54 and M-82): the more restrictive
 * of an engine's request and Studio's review record of the claim, the claim's restrictive value where no record row
 * exists, by one rule per claim shape. `grantClaims` is read here with hand-made requests and records, each built from
 * the shipped ones with one engine changed or for an id no shipped engine uses, and the bundled grant tables are read
 * against Studio's records for every shipped engine.
 */
import { describe, expect, test } from "bun:test";
import type { McpClaims, PolicyClaims } from "@libredb/provider-sdk/manifest";
import {
  type ClaimRecords,
  GRANTED_AGENT_CREDENTIAL_FORM,
  GRANTED_DENIED_FILE_ACCESS_REFUSAL,
  GRANTED_MASKING_EXEMPT_COLUMNS,
  GRANTED_MCP_AGENT_CREDENTIAL_REQUIRED,
  GRANTED_MCP_EXPOSABLE,
  GRANTED_MCP_METADATA_READ_CHANGES_STATE,
  GRANTED_MCP_STATEMENT_READ,
  GRANTED_READ_ROOTS_REQUIRED,
  GRANTED_READS_FILE_ACCESS_POSTURE,
  GRANTED_SINGLE_WRITER_FILE,
  GRANTED_WRITE_REACH,
  grantClaims,
  READ_ONLY_ENFORCED,
  STUDIO_CLAIM_RECORDS,
  UNGRANTED_CLAIM_REFUSALS,
  UNGRANTED_DENIED_FILE_ACCESS_SENTENCE,
  UNGRANTED_SINGLE_WRITER_FILE_SENTENCE,
} from "@/lib/db/claim-grants";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BUNDLED_CLAIM_REQUESTS } from "@/lib/db/engine-catalog/claims.generated";
import type { ClaimRequestEntry } from "@/lib/db/engine-catalog/projection";

/** An id no shipped engine uses, for a request no record row covers. */
const UNRECORDED = "acmefoo";

/** postgres's requests, the base every hand-made request changes one claim of. */
const BASE: ClaimRequestEntry = BUNDLED_CLAIM_REQUESTS.postgres;

/** One engine's requests: postgres's with `policy` and `mcp` members changed. */
function request(policy: Partial<PolicyClaims> = {}, mcp: Partial<McpClaims> = {}): ClaimRequestEntry {
  return { ...BASE, policy: { ...BASE.policy, ...policy }, mcp: { ...BASE.mcp, ...mcp } };
}

/** Studio's records with one row of each named record set for `engine`, every other row as shipped. */
function records(engine: string, rows: { readonly [K in keyof ClaimRecords]?: ClaimRecords[K][string] }): ClaimRecords {
  const changed: Record<string, unknown> = { ...STUDIO_CLAIM_RECORDS };
  for (const [member, row] of Object.entries(rows)) {
    changed[member] = { ...STUDIO_CLAIM_RECORDS[member as keyof ClaimRecords], [engine]: row };
  }
  return changed as unknown as ClaimRecords;
}

/** The grants of one engine `engine` requesting `requested` against `against`. */
function grantOf(engine: string, requested: ClaimRequestEntry, against: ClaimRecords = STUDIO_CLAIM_RECORDS) {
  const grants = grantClaims({ [engine]: requested }, against);
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
    expect(STUDIO_CLAIM_RECORDS.seedAgentCredential.s3).not.toBeNull();
    expect(grantOf("s3", open)).toMatchObject({ exposable: true, agentCredentialRequired: true });
    // postgres's seeds take one too; read as required, it stays exposed.
    expect(grantOf("postgres", open, records("postgres", { agentCredentialRequired: true }))).toMatchObject({
      exposable: true,
      agentCredentialRequired: true,
    });
    // Seeds that take none: closed, whatever the request and the exposure record.
    expect(
      grantOf("postgres", open, records("postgres", { agentCredentialRequired: true, seedAgentCredential: null })),
    ).toMatchObject({ exposable: false, agentCredentialRequired: true });
    expect(STUDIO_CLAIM_RECORDS.seedAgentCredential.libredb).toBeNull();
    expect(grantOf("libredb", open, records("libredb", { exposable: true }))).toMatchObject({
      exposable: false,
      agentCredentialRequired: true,
    });
    // An engine with no record at all is closed anyway.
    expect(grantOf(UNRECORDED, open).exposable).toBe(false);
  });

  test("a claim value outside its vocabulary is refused by name, naming the claim and the engine", () => {
    const refused = (asked: ClaimRequestEntry, claim: string, value: string) =>
      expect(() => grantClaims({ [UNRECORDED]: asked }, STUDIO_CLAIM_RECORDS)).toThrow(
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
