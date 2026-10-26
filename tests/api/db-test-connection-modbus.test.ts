/**
 * What Test Connection answers for a Modbus address, over the REAL route.
 *
 * This exists because of a measured defect. `connect()` parsed the register map and opened nothing,
 * and this route reports a health failure after a successful connect as a DEGRADED SUCCESS
 * (`route.ts:146-160`), so an address with no device behind it answered:
 *
 *     HTTP 200 {"success":true,"degraded":true,"message":"Connected, but this server answered no
 *               health data: The connection to 127.0.0.1:9 failed: connect ECONNREFUSED"}
 *
 * and the route's own note says the dialog gates its save on that answer, so the connection was
 * saved. MTConnect answered 503 in the same run, so it was not the route's general behaviour: it
 * was this provider's connect not reaching the device.
 *
 * The provider dials in `connect()` now, and these tests hold the answer at both ends.
 */
import { describe, expect, mock, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }) as unknown);
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));
mock.module("@/lib/seed/resolve-connection", () => ({
  resolveConnection: mock(async (body: { connection?: unknown }) => body.connection),
  SeedConnectionError: class extends Error {},
}));

const route = await import("@/app/api/db/test-connection/route");
const FLAG = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
const MAP = JSON.stringify([{ name: "v", unitId: 1, table: "holding_register", address: 0, type: "uint16" }]);

async function testConnection(port: number, registerMap: string) {
  const response = await route.POST(
    createMockRequest("/api/db/test-connection", {
      method: "POST",
      body: { connection: { id: "m", name: "device", type: "modbus", host: "127.0.0.1", port, registerMap } },
    }) as never,
  );
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

/** A port that ACCEPTS a connection and never answers: the shape that produced a clean success. */
async function silentPort(): Promise<{ server: Server; port: number }> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

/** A device that answers one read, so the success case is a real round trip. */
async function device(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on("data", (adu: Buffer) => {
      const head = Buffer.alloc(7);
      head.writeUInt16BE(adu.readUInt16BE(0), 0);
      head.writeUInt16BE(0, 2);
      head.writeUInt16BE(5, 4);
      head[6] = adu[6] ?? 1;
      socket.write(Buffer.concat([head, Buffer.from([adu[7] ?? 3, 2, 0, 230])]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

describe("Test Connection on a Modbus address", () => {
  // Port 9 is the discard port and nothing listens on it here, so this is an address with no device.
  for (const [label, registerMap] of [
    ["with no register map", "[]"],
    ["with a one-point map", MAP],
  ] as const) {
    test(`an address with no device is refused ${label}, and the refusal names it`, async () => {
      delete process.env[FLAG];
      const { status, body } = await testConnection(9, registerMap);
      // 503 and CONNECTION_ERROR, which is the shape every other engine already answered with.
      expect(status).toBe(503);
      expect(body.code).toBe("CONNECTION_ERROR");
      expect(String(body.error)).toContain("127.0.0.1:9");
      // And NOT the old answer: a success, degraded or otherwise, is what saved the connection.
      expect(body.success).toBeUndefined();
      expect(body.degraded).toBeUndefined();
    });
  }

  /**
   * MEASURED: a port that accepts and never answers, with an empty map, answered
   * `{"success":true,"message":"Connection successful"}` in 0 to 9 ms, three runs identical. The
   * dial succeeded because TCP was accepted, and health could not fail because there was nothing
   * to read. An empty map is a NEW connection's default state, so that was the answer a user got
   * before writing a map, on a wrong port as readily as on a right one.
   */
  test("a silent port with no map says nothing was read, rather than Connection successful", async () => {
    delete process.env[FLAG];
    const { server, port } = await silentPort();
    try {
      const { status, body } = await testConnection(port, "[]");
      expect(status).toBe(200);
      // The caution rides in `warnings`, which is where the route puts it; the sentence a user
      // reads is composed from it client-side by `cautionSentence` in
      // `src/hooks/use-connection-form.ts` and rendered by the banner `ConnectionModal.tsx` draws
      // for `testResult.tone === "warning"`, with an
      // amber tone rather than a green tick. That composition was READ, not executed here.
      const warnings = body.warnings as { message: string }[] | undefined;
      expect(warnings?.length).toBe(1);
      expect(warnings?.[0]?.message).toContain("nothing was read from the device");
      expect(warnings?.[0]?.message).toContain("no register map");
    } finally {
      server.close();
    }
  });

  test("a REAL device with no map carries the same caution, because nothing was read there either", async () => {
    // The caution is about the MAP, not the port. Without this case it would read as a wrong-port
    // alarm, and the next person would try to make it fire only on a bad address.
    delete process.env[FLAG];
    const { server, port } = await device();
    try {
      const { body } = await testConnection(port, "[]");
      const warnings = body.warnings as { message: string }[] | undefined;
      expect(warnings?.[0]?.message).toContain("nothing was read from the device");
    } finally {
      server.close();
    }
  });

  test("an address that answers is a plain success, with no degraded flag", async () => {
    delete process.env[FLAG];
    const { server, port } = await device();
    try {
      const { status, body } = await testConnection(port, MAP);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.degraded).toBeUndefined();
      // And no caution: there is a map, a point was read, so nothing is being withheld.
      expect(String(body.message)).toBe("Connection successful");
      // And no caution: there is a map, a point was read, so nothing is being withheld.
      expect(body.warnings).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
