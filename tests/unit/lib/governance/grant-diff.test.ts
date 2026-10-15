/**
 * Which access a reload of the governance snapshot took away or changed (spec 7.4, 9.4, 14): the subject and connection
 * pairs whose providers Studio tears down once the new snapshot is in place.
 *
 * The snapshots are built directly, as tests/helpers/governance/granted-snapshot.ts builds them, so each case states
 * exactly which grant a subject held before the reload and after it. A record's envelopes stand for the sealed
 * credentials the loader opened it from: a connection whose credential the control plane sealed again carries another.
 */
import { describe, expect, test } from "bun:test";
import type { AdmittedConnection } from "@/lib/governance/admission";
import { changedGrants } from "@/lib/governance/grant-diff";
import { admittedConnection, type GrantSpec, grantedSnapshot } from "../../../helpers/governance/granted-snapshot";

const T0 = Date.parse("2026-10-15T08:00:00.000Z");

/** The same connection with the envelope of `level` sealed again, as the control plane does on a credential change. */
const resealed = (connection: AdmittedConnection, level: "read" | "write"): AdmittedConnection => ({
  ...connection,
  envelopes: { ...connection.envelopes, [level]: `${connection.envelopes[level]}-sealed-again` },
});

const ORDERS = admittedConnection("orders", { write: true });
const BILLING = admittedConnection("billing");
const WIKI = admittedConnection("wiki", { write: true });
const CRM = admittedConnection("crm", { write: true });
const HR = admittedConnection("hr", { write: true });
const LEGACY = admittedConnection("legacy");

describe("changedGrants", () => {
  test("the diff lists exactly the pairs that lost access, changed level, changed envelope or expired", () => {
    const before: GrantSpec[] = [
      // Unchanged, although the connection is renamed below: a name opens nothing.
      { subject: "alice", connection: ORDERS, level: "write" },
      // The grant row is deleted.
      { subject: "alice", connection: BILLING, level: "read" },
      // Downgraded from write to read.
      { subject: "bob", connection: ORDERS, level: "write" },
      // Raised from read to write: the credential the editor opens with changes as well.
      { subject: "bob", connection: WIKI, level: "read" },
      // The read envelope, which every grant opens, is sealed again.
      { subject: "carol", connection: CRM, level: "read" },
      // The write envelope is sealed again: it changes what a write grant opens, and nothing a read grant opens.
      { subject: "dave", connection: HR, level: "read" },
      { subject: "erin", connection: HR, level: "write" },
      // Expires between the two loads, which no notification announces.
      { subject: "frank", connection: ORDERS, level: "read", expiresAt: T0 + 1000 },
      // Had already expired when the first snapshot loaded, so there is nothing of it left to tear down.
      { subject: "gina", connection: ORDERS, level: "read", expiresAt: T0 - 1 },
      // The connection itself is gone: deleted, deactivated or skipped by admission.
      { subject: "ivan", connection: LEGACY, level: "read" },
      // A grant on a connection whose only change is that another person's grant on it went away.
      { subject: "henry", connection: BILLING, level: "read" },
    ];
    const renamedOrders = admittedConnection("orders", { write: true, name: "Orders, renamed" });
    const resealedCrm = resealed(CRM, "read");
    const resealedHr = resealed(HR, "write");
    const after: GrantSpec[] = [
      { subject: "alice", connection: renamedOrders, level: "write" },
      { subject: "bob", connection: renamedOrders, level: "read" },
      { subject: "bob", connection: WIKI, level: "write" },
      { subject: "carol", connection: resealedCrm, level: "read" },
      { subject: "dave", connection: resealedHr, level: "read" },
      { subject: "erin", connection: resealedHr, level: "write" },
      { subject: "frank", connection: renamedOrders, level: "read", expiresAt: T0 + 1000 },
      { subject: "gina", connection: renamedOrders, level: "read", expiresAt: T0 - 1 },
      { subject: "henry", connection: BILLING, level: "read" },
      // A new grant takes nothing away.
      { subject: "judy", connection: renamedOrders, level: "write" },
    ];
    const previous = grantedSnapshot([ORDERS, BILLING, WIKI, CRM, HR, LEGACY], before, T0);
    const next = grantedSnapshot([renamedOrders, BILLING, WIKI, resealedCrm, resealedHr], after, T0 + 5000);

    expect(changedGrants(previous, next, T0 + 5000)).toEqual([
      { subject: "alice", connectionId: "billing" },
      { subject: "bob", connectionId: "orders" },
      { subject: "bob", connectionId: "wiki" },
      { subject: "carol", connectionId: "crm" },
      { subject: "erin", connectionId: "hr" },
      { subject: "frank", connectionId: "orders" },
      { subject: "ivan", connectionId: "legacy" },
    ]);
  });

  test("expiry is judged at each snapshot's own time: the previous one's load and the caller's clock", () => {
    const grants: GrantSpec[] = [{ subject: "alice", connection: ORDERS, level: "read", expiresAt: T0 + 1000 }];
    const previous = grantedSnapshot([ORDERS], grants, T0);
    const next = grantedSnapshot([ORDERS], grants, T0 + 500);

    // Still granted at the caller's clock, so nothing is torn down yet.
    expect(changedGrants(previous, next, T0 + 999)).toEqual([]);
    // Expired by the caller's clock, although the next snapshot loaded before the expiry.
    expect(changedGrants(previous, next, T0 + 1000)).toEqual([{ subject: "alice", connectionId: "orders" }]);
  });

  test("a reload that changes nothing a connection is opened with lists nothing", () => {
    const grants: GrantSpec[] = [
      { subject: "alice", connection: ORDERS, level: "write" },
      { subject: "bob", connection: BILLING, level: "read" },
    ];

    expect(
      changedGrants(
        grantedSnapshot([ORDERS, BILLING], grants, T0),
        grantedSnapshot([ORDERS, BILLING], grants, T0 + 1),
        T0 + 1,
      ),
    ).toEqual([]);
  });
});
