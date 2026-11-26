/**
 * The button a user presses: Test Connection on a connection the browser supplies inline that sets a field only the
 * operator's seed file may set (`SEED_ONLY_FIELD_NAMES` in src/lib/db/connection-fields.ts, docs/SECURITY.md control
 * 3.48). The route resolves the connection with the real `resolveServedConnection`, which refuses it by name with 400, so
 * nothing is opened. The session is mocked to an administrator, and the factory is replaced so an open would show here.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as actualFactory from "@/lib/db/factory";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { createMockProvider } from "../../helpers/mock-provider";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

/** Test Connection's one-shot open, answering a legacy record's provider built and not connected. */
const mockOpenEngineOnce = mock(async (...args: unknown[]) => {
  void args;
  return { form: "provider", provider: createMockProvider() };
});

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
  readSession: mock(async () => ({ kind: "authenticated", session: { role: "admin", username: "admin" } })),
}));
mock.module("@/lib/db/factory", () => ({
  ...actualFactory,
  openEngineOnce: mockOpenEngineOnce,
}));

const { POST: testConnectionPost } = await import("@/app/api/db/test-connection/route");

const workDir = mkdtempSync(join(tmpdir(), "libredb-seed-only-inline-"));

beforeEach(() => {
  clearRateLimitState();
  mockOpenEngineOnce.mockClear();
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("Test Connection refuses an inline connection that sets a seed-only field, before any provider is built", () => {
  for (const field of ["securityPolicyUri", "clientCertificatePath", "clientPrivateKeyPath"] as const) {
    test(`an inline OPC UA connection carrying ${field} answers 400 with the field's sentence, and no provider is built`, async () => {
      const connection = {
        id: "inline-plant",
        name: "Plant",
        type: "opcua",
        host: "opc.tcp://127.0.0.1:1/",
        [field]:
          field === "securityPolicyUri" ? "http://opcfoundation.org/UA/SecurityPolicy#None" : join(workDir, "c.pem"),
      };
      const response = await testConnectionPost(
        createMockRequest("/api/db/test-connection", { method: "POST", body: { connection } }) as never,
      );
      expect(response.status).toBe(400);
      expect(await parseResponseJSON<Record<string, unknown>>(response)).toMatchObject({
        error: `${field} is set only on a seed connection, by the operator's seed file: a connection a browser or a client supplies cannot set it. Remove ${field} from this connection.`,
        statusCode: 400,
      });
      expect(mockOpenEngineOnce).not.toHaveBeenCalled();
    });
  }

  test("the same inline connection without the seed-only fields reaches the factory", async () => {
    const connection = { id: "inline-plant", name: "Plant", type: "opcua", host: "opc.tcp://127.0.0.1:1/" };
    await testConnectionPost(
      createMockRequest("/api/db/test-connection", { method: "POST", body: { connection } }) as never,
    );
    expect(mockOpenEngineOnce).toHaveBeenCalledTimes(1);
  });
});
