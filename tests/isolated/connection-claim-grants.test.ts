/**
 * Each connection gate answers Studio's grant of its claim, never Studio's review record of it
 * (docs/providers/CONTRACT.md, clause M-83): the connection dialog's tunnel offer, the fields a provider receives, the
 * provider factory's file and host path admissions, governance row admission, the choice of database, the seed schema
 * and the seed projection's gate.
 *
 * Core's tunnel decision reads no grant table: it reads the engine record's `grants.sshTunnel`, so this file proves
 * only that the decision follows the record's grant, on a record whose grant is planted. That each legacy record's
 * grants are the grant reader's rows is held by the test "each legacy record's grants equal the grant reader's rows for
 * its id" in tests/unit/lib/provider-host/legacy-adapter.test.ts (#2536).
 *
 * Under tests/isolated because it replaces `@/lib/db/claim-grants` with `mock.module()` before it imports any gate,
 * which holds only while this file is the first in its bun process to evaluate them. The grant module is the real one
 * with one shipped engine's row of each granted connection table changed, so every gate below answers differently from
 * its engine's record, and only the grant can be what it read.
 */
import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import path from "node:path";
// Types and two symbols, a module that loads no gate, so importing it before the grant module is replaced is safe.
import { ADMITTED_FILE, ADMITTED_HOST_PATHS, type DatabaseConnection, type WithAdmittedHostPaths } from "@/lib/types";

const realGrants = { ...(await import("@/lib/db/claim-grants")) };
const PLANTED_TUNNEL_REFUSAL = "Postgres takes no SSH tunnel in this test. Turn the tunnel off.";
mock.module("@/lib/db/claim-grants", () => ({
  ...realGrants,
  GRANTED_SSH_TUNNEL_REFUSAL: Object.freeze({
    ...realGrants.GRANTED_SSH_TUNNEL_REFUSAL,
    postgres: PLANTED_TUNNEL_REFUSAL,
    opcua: PLANTED_TUNNEL_REFUSAL,
  }),
  GRANTED_OPENS_LOCAL_FILE: Object.freeze({ ...realGrants.GRANTED_OPENS_LOCAL_FILE, sqlite: false }),
  GRANTED_HOST_PATH_FIELDS: Object.freeze({
    ...realGrants.GRANTED_HOST_PATH_FIELDS,
    postgres: Object.freeze(["clientCertificatePath"] as const),
  }),
  GRANTED_OPENS_SERVER_LEVEL_AT_ADMISSION: Object.freeze({
    ...realGrants.GRANTED_OPENS_SERVER_LEVEL_AT_ADMISSION,
    mysql: true,
  }),
  GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE: Object.freeze({
    ...realGrants.GRANTED_OPENS_SERVER_LEVEL_AT_CATALOG_CHOICE,
    postgres: false,
  }),
  GRANTED_SEED_AGENT_CREDENTIAL: Object.freeze({
    ...realGrants.GRANTED_SEED_AGENT_CREDENTIAL,
    postgres: null,
    mysql: Object.freeze({ form: "pair", supersededBy: Object.freeze(["password"] as const) }),
  }),
}));

const { legacyAgentCredentialTable, legacyRegisterTable } = await import("../helpers/legacy-register");
const { decideTunnel } = await import("@/lib/db/tunnel-decision");
const { LEGACY_ENGINES } = await import("@/lib/provider-host/legacy-adapter/records");
const { offersSshTunnel } = await import("@/lib/db-ui-config");
const { providerFields } = await import("@/lib/db/provider-connection");
const { admittedFileConnection, admittedHostPathConnection } = await import("@/lib/db/provider-files");
const { admitConnectionRows } = await import("@/lib/governance/admission");
const { catalogChoice } = await import("@/lib/db/catalog-scope");
const { SeedConnectionSchema } = await import("@/lib/seed/types");
const { projectSeedConnection } = await import("@/lib/seed/connection-filter");

/** When every connection below was made. */
const createdAt = new Date("2026-11-25T00:00:00.000Z");

describe("the connection gates", () => {
  test("each connection gate answers Studio's grant of its claim, not the record", () => {
    // The records hold the rows the planted grants differ from.
    expect(legacyRegisterTable("sshTunnel").postgres).toBeNull();
    expect(legacyRegisterTable("sshTunnel").opcua).toBeNull();
    expect(legacyRegisterTable("opensLocalFile").sqlite).toBe(true);
    expect(legacyRegisterTable("hostPathFields").postgres).toEqual([]);
    expect(legacyRegisterTable("serverLevelWithoutDatabase").mysql).toBe(false);
    expect(legacyRegisterTable("serverLevelWithoutDatabase").postgres).toBe(true);
    expect(legacyAgentCredentialTable().postgres).not.toBeNull();
    expect(legacyAgentCredentialTable().mysql?.supersededBy).toEqual([]);

    // Core's tunnel decision refuses the tunnel with the sentence of the record's grant, and the dialog, which reads
    // the granted table, offers none.
    const tunnelled: DatabaseConnection = {
      id: "pg",
      name: "pg",
      type: "postgres",
      createdAt,
      host: "db.internal",
      port: 5432,
      sshTunnel: {
        enabled: true,
        host: "bastion.internal",
        port: 22,
        username: "jump",
        authMethod: "password",
        password: randomUUID(),
      },
    };
    // Core's decision reads the grant from the engine's record, here postgres's with a planted grant, not the table.
    const postgresRecord = LEGACY_ENGINES.get("postgres") as import("@/lib/db/server-catalog").EngineRecord;
    const planted = { ...postgresRecord, grants: { ...postgresRecord.grants, sshTunnel: PLANTED_TUNNEL_REFUSAL } };
    expect(() => decideTunnel(tunnelled, planted)).toThrow(PLANTED_TUNNEL_REFUSAL);
    expect(offersSshTunnel("postgres")).toBe(false);
    expect(offersSshTunnel("mysql")).toBe(true);

    // A refused tunnel hands OPC UA no host and port through the tunnel rule.
    expect(providerFields("opcua")).not.toContain("port");
    expect(providerFields("mysql")).toContain("port");

    // A file the grant does not mark is not admitted as one; the granted host path field is.
    const sqlite: DatabaseConnection = { id: "lite", name: "lite", type: "sqlite", database: "orders.db", createdAt };
    const notAdmitted = admittedFileConnection(sqlite);
    expect(notAdmitted).toBe(sqlite);
    expect(ADMITTED_FILE in notAdmitted).toBe(false);
    const postgres: DatabaseConnection = {
      id: "pg",
      name: "pg",
      type: "postgres",
      clientCertificatePath: "certs/client.pem",
      createdAt,
    };
    const admitted = admittedHostPathConnection(postgres) as WithAdmittedHostPaths;
    expect(admitted[ADMITTED_HOST_PATHS]?.clientCertificatePath).toEndWith(path.join("certs", "client.pem"));

    // Governance skips a mysql definition with no database, as the grant at admission reads mysql.
    const admission = admitConnectionRows(
      [
        {
          connection_id: "3f6c2a91-0d4e-4b7a-9e15-c8a2f7d64b03",
          engine: "mysql",
          definition: { host: "db.example.internal", port: 3306 },
          read_secret: "lsb1.never-opened",
          write_secret: null,
        } as never,
      ],
      {
        allowedEngines: ["mysql"],
        openSecret: () => {
          throw new Error("no envelope is opened for a skipped row");
        },
      },
    );
    expect(admission.skipped.map((skip) => skip.item)).toEqual([
      {
        kind: "connection",
        id: "3f6c2a91-0d4e-4b7a-9e15-c8a2f7d64b03",
        path: "database",
        code: "SERVER_LEVEL_NOT_ALLOWED",
      },
    ]);

    // The choice of database is not honoured on postgres, as the grant at the choice reads it.
    expect(
      catalogChoice({ id: "pg", name: "pg", type: "postgres", createdAt }, { catalogSessions: true } as never),
    ).toBe("engine-not-recorded");

    // The seed schema refuses a postgres agent credential, and the projection's gate a mysql one beside the password.
    const agentPassword = randomUUID();
    const seed = SeedConnectionSchema.safeParse({
      id: "seed-pg",
      name: "Seed PG",
      type: "postgres",
      host: "localhost",
      port: 5432,
      roles: ["admin"],
      agentUser: "agent",
      agentPassword,
    });
    expect(seed.success).toBe(false);
    expect(seed.error?.issues.map((issue) => issue.message)).toContain(
      'Seed connection "seed-pg": agentUser is refused: a postgres seed takes no agent credential, so the agent and MCP could not run under one. Remove agentUser from this connection.',
    );
    const mysql = {
      id: "seed-my",
      name: "Seed MySQL",
      type: "mysql" as const,
      host: "localhost",
      roles: ["*"],
      password: randomUUID(),
      agentUser: "agent",
      agentPassword,
    };
    expect(() => projectSeedConnection(mysql, ["admin"])).toThrow(
      'Seed connection "seed-my" carries an agent credential beside password, which the mysql provider signs in with in preference to a user and password.',
    );
  });
});
