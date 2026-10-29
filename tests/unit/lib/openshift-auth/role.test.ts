import { describe, expect, test } from "bun:test";
import { openShiftSignInRole } from "@/lib/openshift-auth/role";

// Admin comes only from the user's own Kubernetes review (a later change); until then every session is a user, which
// is the fail-closed state, whatever the identity says.
describe("openShiftSignInRole", () => {
  test("answers user for any identity", async () => {
    for (const name of ["dev-a", "os-admin", "kube:admin", "system:cluster-admins"]) {
      expect(
        await openShiftSignInRole({ name, uid: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f" }, "sha256~not-a-real-token-1"),
      ).toBe("user");
    }
  });
});
