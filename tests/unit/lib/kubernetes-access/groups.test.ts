/**
 * The groups store (src/lib/kubernetes-access/groups.ts): the only source of a review's groups.
 *
 * The OIDC callback reads the verified ID token's `groups` claim and records it per issuer and subject; a review
 * takes its groups from that record alone. An absent claim, which Rancher sends every user without group principals,
 * is an empty list. A claim that is not a list of non-empty strings, holds too many groups or one too long, or names a
 * group under Kubernetes' reserved `system:` prefix is refused, so no identity provider can assert a system group
 * through Studio. Records expire with the session lifetime, the newest sign-in of a subject replaces its record, and
 * the store is bounded, evicting the oldest record first.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readGroupsClaim, recordedGroups, recordGroups, resetGroupRecords } from "@/lib/kubernetes-access/groups";

const ISSUER = "https://rancher.example.com/oidc";
const T = Date.parse("2026-10-28T08:00:00.000Z");

beforeEach(() => {
  resetGroupRecords();
  process.env.AUTH_SESSION_TTL_SECONDS = "900";
});

afterEach(() => {
  resetGroupRecords();
  delete process.env.AUTH_SESSION_TTL_SECONDS;
});

describe("the groups claim", () => {
  test("absent or null is an empty list, as Rancher sends a user without group principals", () => {
    expect(readGroupsClaim({ sub: "u-rjs2h" })).toEqual({ ok: true, groups: [] });
    expect(readGroupsClaim({ sub: "u-rjs2h", groups: null })).toEqual({ ok: true, groups: [] });
    expect(readGroupsClaim({ sub: "u-rjs2h", groups: [] })).toEqual({ ok: true, groups: [] });
  });

  test("is kept as a sorted list without duplicates", () => {
    expect(readGroupsClaim({ groups: ["okta_group://dbas", "github_team://7", "okta_group://dbas"] })).toEqual({
      ok: true,
      groups: ["github_team://7", "okta_group://dbas"],
    });
  });

  test("keeps 512 groups of up to 256 bytes", () => {
    const groups = Array.from({ length: 512 }, (_, n) => `g${String(n).padStart(3, "0")}${"x".repeat(252)}`);
    const reading = readGroupsClaim({ groups });
    expect(reading.ok && reading.groups.length).toBe(512);
    expect(readGroupsClaim({ groups: ["é".repeat(128)] }).ok).toBe(true);
  });

  test.each([
    ["a string", "okta_group://dbas", "is not a list of group names"],
    ["an object", { dbas: true }, "is not a list of group names"],
    ["a number in the list", ["okta_group://dbas", 7], "is not a list of group names"],
    ["an empty name", [""], "is not a list of group names"],
    ["more than 512 groups", Array.from({ length: 513 }, (_, n) => `group-${n}`), "more than 512 groups"],
    ["a group over 256 bytes", ["é".repeat(129)], "longer than 256 bytes"],
    ["a reserved Kubernetes group", ["okta_group://dbas", "system:masters"], "starts with system:"],
    ["system:authenticated", ["system:authenticated"], "starts with system:"],
  ])("is refused when it holds %s", (_case, groups, reason) => {
    const reading = readGroupsClaim({ groups });
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(reading.problem).toContain(reason);
      // The problem goes to the log and the audit trail; it names no group.
      expect(reading.problem).not.toContain("dbas");
      expect(reading.problem).not.toContain("masters");
    }
  });

  test("a group that only looks like a system group in another letter case is not reserved", () => {
    expect(readGroupsClaim({ groups: ["System:masters"] })).toEqual({ ok: true, groups: ["System:masters"] });
  });
});

describe("the records", () => {
  test("are read back by issuer and subject only", () => {
    recordGroups(ISSUER, "u-rjs2h", ["okta_group://dbas"], T);
    expect(recordedGroups(ISSUER, "u-rjs2h", T)).toEqual(["okta_group://dbas"]);
    expect(recordedGroups(ISSUER, "u-other", T)).toBeNull();
    expect(recordedGroups("https://other.example.com/oidc", "u-rjs2h", T)).toBeNull();
    expect(recordedGroups(undefined, "u-rjs2h", T)).toBeNull();
    expect(recordedGroups(ISSUER, undefined, T)).toBeNull();
    expect(recordedGroups(ISSUER, "", T)).toBeNull();
  });

  test("an empty list is a record, which tells a user without groups from a missing record", () => {
    recordGroups(ISSUER, "u-local", [], T);
    expect(recordedGroups(ISSUER, "u-local", T)).toEqual([]);
  });

  test("the newest sign-in of a subject replaces its record", () => {
    recordGroups(ISSUER, "u-rjs2h", ["okta_group://dbas"], T);
    recordGroups(ISSUER, "u-rjs2h", ["okta_group://readers"], T + 1000);
    expect(recordedGroups(ISSUER, "u-rjs2h", T + 1000)).toEqual(["okta_group://readers"]);
  });

  test("expire with the session lifetime, because no session they serve outlives it", () => {
    recordGroups(ISSUER, "u-rjs2h", ["okta_group://dbas"], T);
    expect(recordedGroups(ISSUER, "u-rjs2h", T + 899_999)).toEqual(["okta_group://dbas"]);
    expect(recordedGroups(ISSUER, "u-rjs2h", T + 900_000)).toBeNull();
    // An expired record is gone, not merely hidden.
    expect(recordedGroups(ISSUER, "u-rjs2h", T)).toBeNull();
  });

  test("are not served while the session lifetime cannot be read", () => {
    recordGroups(ISSUER, "u-rjs2h", ["okta_group://dbas"], T);
    process.env.AUTH_SESSION_TTL_SECONDS = "forever";
    expect(recordedGroups(ISSUER, "u-rjs2h", T)).toBeNull();
  });

  test("evict the oldest record first when the store is full", () => {
    resetGroupRecords(2);
    recordGroups(ISSUER, "u-1", [], T);
    recordGroups(ISSUER, "u-2", [], T + 1);
    recordGroups(ISSUER, "u-1", ["okta_group://new"], T + 2);
    recordGroups(ISSUER, "u-3", [], T + 3);
    expect(recordedGroups(ISSUER, "u-2", T + 3)).toBeNull();
    expect(recordedGroups(ISSUER, "u-1", T + 3)).toEqual(["okta_group://new"]);
    expect(recordedGroups(ISSUER, "u-3", T + 3)).toEqual([]);
  });

  test("drop expired records before evicting a live one", () => {
    resetGroupRecords(2);
    recordGroups(ISSUER, "u-old", [], T);
    recordGroups(ISSUER, "u-live", [], T + 600_000);
    recordGroups(ISSUER, "u-new", [], T + 900_001);
    expect(recordedGroups(ISSUER, "u-live", T + 900_001)).toEqual([]);
    expect(recordedGroups(ISSUER, "u-new", T + 900_001)).toEqual([]);
  });

  test("keep a copy, so a caller cannot change a record after it is written", () => {
    const groups = ["okta_group://dbas"];
    recordGroups(ISSUER, "u-rjs2h", groups, T);
    groups.push("okta_group://admins");
    expect(recordedGroups(ISSUER, "u-rjs2h", T)).toEqual(["okta_group://dbas"]);
    expect(Object.isFrozen(recordedGroups(ISSUER, "u-rjs2h", T))).toBe(true);
  });
});
