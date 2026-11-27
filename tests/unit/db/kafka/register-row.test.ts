/**
 * Kafka's legacy row in the grant register (packages/grant-register/src/register.json): the review note on its language
 * data digest states the read boundary the Kafka agent execution design review verified. The note is Kafka's own text,
 * so it is held here, beside Kafka's other tests, and leaves with them; the census over every legacy row's language
 * digest and review note is tests/unit/db/grant-register-legacy-rows.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { LEGACY_KEY, readGrantRegister } from "@libredb/grant-register";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";

describe("kafka's legacy row", () => {
  test("the review note on kafka's language digest is the read boundary it reviewed", () => {
    const kafka = readGrantRegister(LEGACY_ENGINE_IDS).rowFor({ legacy: LEGACY_KEY, engine: "kafka" });
    if (kafka === null) throw new Error("the grant register holds no legacy row for kafka");

    // The review note is the read boundary the Kafka agent execution design review verified, which the data's one
    // engine-neutral descriptor no longer states.
    const note = kafka.reasons?.languageSha256 ?? "";
    expect(note.startsWith("Kafka: the provider's structural closed table: one read of a closed table of four")).toBe(
      true,
    );
    expect(note).toContain("every answer is projected to names, counts and offsets");
    expect(note.endsWith("a result past the byte budget is refused, never truncated.")).toBe(true);
  });
});
