import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { TrustMaterial } from "@/lib/db/types";
import { requireTrustMaterial, TRUST_MATERIAL_MISSING } from "@/lib/db/utils/require-trust-material";

/**
 * A provider whose TLS library does not read Node's trust store takes the trust material from its build context, never
 * from the environment or the file, so one built without it refuses by name rather than dialling with less trust than
 * the operator configured (FND-2 slice 4).
 */
describe("requireTrustMaterial (FND-2 slice 4)", () => {
  test("answers the material it is handed", () => {
    const material: TrustMaterial = Object.freeze({ certificates: Object.freeze([]) });
    expect(requireTrustMaterial(material)).toBe(material);
  });

  test("refuses an absent material by name, TRUST_MATERIAL_MISSING", () => {
    expect(() => requireTrustMaterial(undefined)).toThrow(new DatabaseConfigError(TRUST_MATERIAL_MISSING));
    expect(() => requireTrustMaterial(undefined)).toThrow(DatabaseConfigError);
    expect(TRUST_MATERIAL_MISSING).toBe(
      "This provider was built without the trust material Studio reads from the file NODE_EXTRA_CA_CERTS names, so it dials nothing",
    );
  });
});
