/**
 * `POST /api/db/test-connection` (the dialog's Test button) on a connection whose SSH tunnel is on, through the real
 * factory (FND-2 slice 5).
 *
 * `tests/api/db/test-connection.test.ts` stands in for the whole factory, so it cannot see which tunnel core dials.
 * This file keeps the real factory and stands in for the SSH tunnel module alone, so `createSSHTunnel`'s call count is
 * the bastion dial an end user's Test click causes.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { servedEngineRecord } from "@/lib/db/server-catalog";

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

// The spread form, not a hand-written stub: only the session readers are replaced (backlog D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => ({ kind: "authenticated", session: await mockGetSession() })),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => body.connection),
    resolveServedConnection: mock(async (body: { connection: { type: string } }) => ({
      connection: body.connection,
      engine: servedEngineRecord(body.connection.type),
    })),
    SeedConnectionError,
  };
});

const mockCreateSSHTunnel = mock(async (_id: string, _ssh: unknown, remoteHost: string, remotePort: number) => ({
  localHost: "127.0.0.1",
  localPort: 54321,
  remoteHost,
  remotePort,
  close: mock(async () => {}),
}));

mock.module("@/lib/ssh/tunnel", () => ({
  createSSHTunnel: mockCreateSSHTunnel,
  closeSSHTunnel: mock(async () => {}),
  releaseUnopenedTunnel: mock(async () => {}),
  tunnelProviderOpened: mock(() => {}),
  getTunnelInfo: mock(() => undefined),
}));

const { POST } = await import("@/app/api/db/test-connection/route");

describe("POST /api/db/test-connection with an SSH tunnel core refuses (FND-2 slice 5)", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockCreateSSHTunnel.mockClear();
  });

  afterEach(() => {
    clearRateLimitState();
  });

  test("a Kafka connection whose tunnel is on is refused before any tunnel is dialled", async () => {
    const req = createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: {
        connection: {
          id: "kafka-tunnelled",
          name: "Events",
          type: "kafka",
          host: "broker.internal",
          port: 9092,
          sshTunnel: {
            enabled: true,
            host: "bastion.example.com",
            port: 22,
            username: "jump",
            authMethod: "password",
            password: crypto.randomUUID(),
          },
        },
      },
    });

    const res = await POST(req as never);
    const body = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(400);
    expect(body.code).toBe("CONFIG_ERROR");
    expect(body.error).toBe(
      "Kafka does not run through an SSH tunnel: the tunnel forwards one address, and a Kafka client reads from every broker the cluster advertises, at the address the broker advertises. Connect to the brokers directly.",
    );
    expect(mockCreateSSHTunnel).not.toHaveBeenCalled();
  });
});
