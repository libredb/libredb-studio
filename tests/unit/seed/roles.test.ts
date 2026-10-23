import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { seedRolesOf } from "@/lib/seed/roles";

describe("seedRolesOf", () => {
  const originalEnv = process.env.OIDC_ROLE_PREFIX;

  beforeEach(() => {
    delete process.env.OIDC_ROLE_PREFIX;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OIDC_ROLE_PREFIX = originalEnv;
    } else {
      delete process.env.OIDC_ROLE_PREFIX;
    }
  });

  test("returns only principal.role when OIDC_ROLE_PREFIX is unset", () => {
    delete process.env.OIDC_ROLE_PREFIX;
    expect(seedRolesOf({ role: "user", claimRoles: ["team-billing", "team-dev"] })).toEqual(["user"]);
    expect(seedRolesOf({ role: "admin", claimRoles: ["team-billing"] })).toEqual(["admin"]);
  });

  test("returns only principal.role when OIDC_ROLE_PREFIX is empty", () => {
    process.env.OIDC_ROLE_PREFIX = "";
    expect(seedRolesOf({ role: "user", claimRoles: ["team-billing"] })).toEqual(["user"]);
  });

  test("combines principal.role with claim roles matching prefix", () => {
    process.env.OIDC_ROLE_PREFIX = "team-";
    const result = seedRolesOf({
      role: "user",
      claimRoles: ["team-billing", "team-dev"],
    });
    expect(result).toEqual(["user", "team-billing", "team-dev"]);
  });

  test("filters out claim roles that do not match current prefix (e.g. prefix changed or removed)", () => {
    process.env.OIDC_ROLE_PREFIX = "dept-";
    const result = seedRolesOf({
      role: "user",
      claimRoles: ["team-billing", "dept-eng", "team-ops"],
    });
    expect(result).toEqual(["user", "dept-eng"]);
  });

  test("prefix matching is strictly case-sensitive", () => {
    process.env.OIDC_ROLE_PREFIX = "Team-";
    const result = seedRolesOf({
      role: "user",
      claimRoles: ["Team-Alpha", "team-alpha"],
    });
    expect(result).toEqual(["user", "Team-Alpha"]);
  });

  test("excludes reserved names (*, admin, user) case-insensitively even if matching prefix", () => {
    process.env.OIDC_ROLE_PREFIX = "a";
    const result = seedRolesOf({
      role: "user",
      claimRoles: ["admin", "Admin", "ADMIN", "analytics"],
    });
    expect(result).toEqual(["user", "analytics"]);

    process.env.OIDC_ROLE_PREFIX = "";
    // If prefix is empty it's already tested, but test prefix '*' or 'u'
    process.env.OIDC_ROLE_PREFIX = "u";
    expect(seedRolesOf({ role: "admin", claimRoles: ["user", "USER", "users"] })).toEqual(["admin", "users"]);

    process.env.OIDC_ROLE_PREFIX = "*";
    expect(seedRolesOf({ role: "user", claimRoles: ["*", "*star"] })).toEqual(["user", "*star"]);
  });

  test("drops empty strings and strings exceeding 64 bytes in UTF-8", () => {
    process.env.OIDC_ROLE_PREFIX = "t-";
    const longRole = "t-" + "x".repeat(63); // 65 bytes
    const maxRole = "t-" + "x".repeat(62); // 64 bytes
    const multiByteOver = "t-" + "ü".repeat(32); // 2 + 64 = 66 bytes (>64 bytes, 34 chars)
    const multiByteValid = "t-" + "ü".repeat(31); // 2 + 62 = 64 bytes
    const result = seedRolesOf({
      role: "user",
      claimRoles: ["", "t-", longRole, maxRole, multiByteOver, multiByteValid],
    });
    expect(result).toEqual(["user", "t-", maxRole, multiByteValid]);
  });

  test("drops non-string or malformed items in claimRoles", () => {
    process.env.OIDC_ROLE_PREFIX = "t-";
    const result = seedRolesOf({
      role: "user",
      claimRoles: [123, null, undefined, {}, false, "t-valid"] as unknown as string[],
    });
    expect(result).toEqual(["user", "t-valid"]);
  });

  test("handles non-array or missing claimRoles gracefully", () => {
    process.env.OIDC_ROLE_PREFIX = "t-";
    expect(seedRolesOf({ role: "user" })).toEqual(["user"]);
    expect(seedRolesOf({ role: "user", claimRoles: null })).toEqual(["user"]);
    expect(seedRolesOf({ role: "user", claimRoles: "t-invalid" as unknown as string[] })).toEqual(["user"]);
    expect(seedRolesOf({ role: "user", claimRoles: 42 as unknown as string[] })).toEqual(["user"]);
  });

  test("deduplicates claim roles and duplicate of principal.role", () => {
    process.env.OIDC_ROLE_PREFIX = "t-";
    const result = seedRolesOf({
      role: "t-billing",
      claimRoles: ["t-billing", "t-dev", "t-dev"],
    });
    expect(result).toEqual(["t-billing", "t-dev"]);
  });
});
