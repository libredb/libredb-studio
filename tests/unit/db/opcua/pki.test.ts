/**
 * Where the client's key pair comes from, and why there is no fallback (#1677 O-S4, section 6 item 5).
 *
 * MEASURED ON THE PRODUCT IMAGE: `ghcr.io/libredb/libredb-studio:0.18.2` runs as uid 1001 whose
 * passwd entry is `/nonexistent`; `os.homedir()` answers `/nonexistent`, the directory does not
 * exist, and a `mkdir` there fails EACCES. So the library's default PKI location does not merely
 * misbehave in production, it cannot be created.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import { clientIdentitySource } from "@/lib/db/providers/industrial/opcua/pki";

// The PKI root itself is core's decision since FND-2 slice 3: `opcuaPkiRoot` in `src/lib/db/provider-files.ts`, held by
// `tests/unit/lib/db/provider-files.test.ts` (the variable, the default under Studio's data directory, the refusal of a
// relative value).

describe("the client's own identity", () => {
  test("a supplied certificate and key are the supplied case", () => {
    expect(
      clientIdentitySource({
        certificatePath: "/run/secrets/c.pem",
        privateKeyPath: "/run/secrets/k.pem",
      }),
    ).toBe("supplied");
  });

  test("neither supplied is the generated case", () => {
    expect(clientIdentitySource({})).toBe("generated");
    expect(clientIdentitySource({ certificatePath: "", privateKeyPath: "  " })).toBe("generated");
  });

  /** One without the other cannot open a secured channel, so it is a mistake rather than a default. */
  test("one without the other is refused", () => {
    expect(() => clientIdentitySource({ certificatePath: "/c.pem" })).toThrow(DatabaseConfigError);
    expect(() => clientIdentitySource({ privateKeyPath: "/k.pem" })).toThrow(/together or not at all/);
  });
});
