/**
 * Each connection gate that still reads a granted table answers Studio's grant of its claim, never Studio's review
 * record of it (docs/providers/CONTRACT.md, clause M-83): the connection dialog's tunnel offer. Governance row
 * admission, the seed schema and the seed projection's gate read the grants of the connection's engine record, which
 * tests/unit/lib/governance/admission.test.ts, tests/unit/seed/types.test.ts and
 * tests/unit/seed/connection-filter.test.ts hold without a mock.
 *
 * Core's tunnel decision reads no grant table: it reads the engine record's `grants.sshTunnel`, so this file proves
 * only that the decision follows the record's grant, on a record whose grant is planted. The fields a provider
 * receives, the provider factory's file and host path admissions and the choice of database read the grants of the
 * connection's installed engine record too, which tests/unit/lib/db/record-grant-readers.test.ts holds without a mock.
 * That each legacy record's grants are the grant reader's rows is held by the test "each legacy record's grants equal
 * the grant reader's rows for its id" in tests/unit/lib/provider-host/legacy-adapter.test.ts (#2536).
 *
 * Under tests/isolated because it replaces `@/lib/db/claim-grants` with `mock.module()` before it imports any gate,
 * which holds only while this file is the first in its bun process to evaluate them. The grant module is the real one
 * with one shipped engine's row of each granted connection table changed, so every gate below answers differently from
 * its engine's record, and only the grant can be what it read.
 */
import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
// Types only, a module that loads no gate, so importing it before the grant module is replaced is safe.
import type { DatabaseConnection } from "@/lib/types";

const realGrants = { ...(await import("@/lib/db/claim-grants")) };
const PLANTED_TUNNEL_REFUSAL = "Postgres takes no SSH tunnel in this test. Turn the tunnel off.";
mock.module("@/lib/db/claim-grants", () => ({
  ...realGrants,
  GRANTED_SSH_TUNNEL_REFUSAL: Object.freeze({
    ...realGrants.GRANTED_SSH_TUNNEL_REFUSAL,
    postgres: PLANTED_TUNNEL_REFUSAL,
  }),
}));

const { legacyRegisterTable } = await import("../helpers/legacy-register");
const { decideTunnel } = await import("@/lib/db/tunnel-decision");
const { LEGACY_ENGINES } = await import("@/lib/provider-host/legacy-adapter/records");
const { offersSshTunnel } = await import("@/lib/db-ui-config");

/** When every connection below was made. */
const createdAt = new Date("2026-11-25T00:00:00.000Z");

describe("the connection gates", () => {
  test("each connection gate answers Studio's grant of its claim, not the record", () => {
    // The records hold the rows the planted grants differ from.
    expect(legacyRegisterTable("sshTunnel").postgres).toBeNull();

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
  });
});
