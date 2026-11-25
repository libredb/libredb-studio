import { describe, expect, test } from "bun:test";
import { GRANTED_MASKING_EXEMPT_COLUMNS } from "@/lib/db/claim-grants";
import { clientCapabilities } from "@/lib/db/client-capabilities";
import { MASKING_EXEMPT_COLUMNS } from "@/lib/db/compatibility";
import { UnknownProviderError } from "@/lib/db/errors";
import { unknownTypeSentence } from "@/lib/db/type-id";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";

/** Capabilities with members other than the exemption, so a test can see every one of them kept. */
const DECLARED = Object.freeze({
  defaultPort: 5432,
  queryLanguage: "sql",
  supportsInlineRowEdit: true,
}) as unknown as ProviderCapabilities;

const WIDE_REASON = "Every column of this engine is said to carry no personal data.";

/** `DECLARED` with `exemption` as the provider's own `maskingExemptColumns`, frozen as a provider constant may be. */
function declaring(exemption: ProviderCapabilities["maskingExemptColumns"]): ProviderCapabilities {
  return Object.freeze({ ...DECLARED, maskingExemptColumns: exemption });
}

describe("clientCapabilities", () => {
  test("answers no masking exemption where Studio's grant holds none, whatever the provider declares", () => {
    expect(GRANTED_MASKING_EXEMPT_COLUMNS.postgres).toBeNull();

    const answered = clientCapabilities("postgres", declaring({ column: ".*", reason: WIDE_REASON }));

    expect(Object.hasOwn(answered, "maskingExemptColumns")).toBe(false);
    expect(answered).toEqual(DECLARED);
  });

  test("answers Studio's grant of the masking exemption where the provider declares none or another", () => {
    expect(GRANTED_MASKING_EXEMPT_COLUMNS.modbus).not.toBeNull();
    // The grant is Studio's record's exemption for every shipped engine, so the answer is the one Studio gave before.
    expect(GRANTED_MASKING_EXEMPT_COLUMNS.modbus).toEqual(MASKING_EXEMPT_COLUMNS.modbus);

    expect(clientCapabilities("modbus", DECLARED).maskingExemptColumns).toBe(GRANTED_MASKING_EXEMPT_COLUMNS.modbus!);
    expect(clientCapabilities("modbus", declaring({ column: ".*", reason: WIDE_REASON })).maskingExemptColumns).toBe(
      GRANTED_MASKING_EXEMPT_COLUMNS.modbus!,
    );
  });

  test("keeps every other capability as the provider declared it and leaves the provider's object as it was", () => {
    const provider = declaring({ column: ".*", reason: WIDE_REASON });
    const before = { ...provider };

    const answered = clientCapabilities("modbus", provider);

    expect(answered).not.toBe(provider);
    expect(answered).toEqual({ ...DECLARED, maskingExemptColumns: GRANTED_MASKING_EXEMPT_COLUMNS.modbus! });
    expect(provider).toEqual(before);
    expect(Object.isFrozen(provider)).toBe(true);
  });

  test("refuses a type that names no provider, by name", () => {
    let thrown: unknown;
    try {
      clientCapabilities("not-a-type" as DatabaseType, DECLARED);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnknownProviderError);
    expect((thrown as Error).message).toBe(unknownTypeSentence("not-a-type"));
  });
});
