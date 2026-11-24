import { describe, expect, test } from "bun:test";
import { redactErrorMessage, redactError } from "@/lib/mcp/serializer";

describe("MCP redaction", () => {
  test("redactErrorMessage masks passwords, tokens, and credentials in URIs", () => {
    expect(redactErrorMessage("Failed to connect: password=test_password to host")).toBe(
      "Failed to connect: password=[REDACTED] to host",
    );
    expect(redactErrorMessage("Invalid token: token=test_token_value")).toBe("Invalid token: token=[REDACTED]");
    expect(redactErrorMessage("Connect to postgres://user:test_password@localhost:5432/db failed")).toBe(
      "Connect to postgres://[REDACTED]@localhost:5432/db failed",
    );
    expect(
      redactErrorMessage(
        "Error at https://db.internal:5432/query?token=test_query_token&env=staging with bearer test_bearer_token",
      ),
    ).toBe("Error at https://db.internal:5432/query?token=[REDACTED]&env=staging with bearer [REDACTED]");
    expect(redactErrorMessage("api_key: test_api_key")).toBe("api_key: [REDACTED]");
    expect(
      redactErrorMessage("https://db.invalid/?client_secret=test_client_secret&refresh_token=test_refresh_token"),
    ).toBe("https://db.invalid/?client_secret=[REDACTED]&refresh_token=[REDACTED]");
    expect(redactErrorMessage("")).toBe("Unknown error");
  });

  test("redactErrorMessage is resilient against ReDoS on long repeating character strings with scheme and userinfo", () => {
    const attackPayloadWithoutUserInfo = "http://" + "A".repeat(50000);
    const attackPayloadWithUserInfo = "http://" + "A".repeat(50000) + "@host.internal/db";

    const startWithout = performance.now();
    const resultWithout = redactErrorMessage(attackPayloadWithoutUserInfo);
    const durationWithout = performance.now() - startWithout;

    const startWith = performance.now();
    const resultWith = redactErrorMessage(attackPayloadWithUserInfo);
    const durationWith = performance.now() - startWith;

    expect(resultWithout).toBe(attackPayloadWithoutUserInfo);
    expect(resultWith).toBe("http://[REDACTED]@host.internal/db");
    expect(durationWithout).toBeLessThan(50);
    expect(durationWith).toBeLessThan(50);
  });

  test("redactError sanitizes message and stack of Error instances", () => {
    const rawError = new Error("Database auth failure: password=test_password and token=test_token_value");
    rawError.name = "DatabaseAuthError";

    const safe = redactError(rawError);
    expect(safe).toBeInstanceOf(Error);
    expect(safe.name).toBe("DatabaseAuthError");
    expect(safe.message).not.toContain("test_password");
    expect(safe.message).not.toContain("test_token_value");
    expect(safe.message).toBe("Database auth failure: password=[REDACTED] and token=[REDACTED]");
    if (safe.stack) {
      expect(safe.stack).not.toContain("test_password");
      expect(safe.stack).not.toContain("test_token_value");
    }

    const safeFromString = redactError("Critical failure: password=test_password");
    expect(safeFromString).toBeInstanceOf(Error);
    expect(safeFromString.message).toBe("Critical failure: password=[REDACTED]");
  });
});
