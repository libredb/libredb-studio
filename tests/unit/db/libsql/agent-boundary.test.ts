/**
 * The libSQL agent read-only profile's boundary, proven at open (`agent-boundary.ts`).
 *
 * The proof is one write-shaped statement that changes nothing on any outcome, sent with the agent's own token: the
 * server must refuse it with 403, the status sqld answers a read-only token's write with ("Authorization forbidden",
 * measured on sqld 0.24.33). Every other answer refuses the profile, fail closed. The credential check runs before it:
 * a user name and password (HTTP Basic) and a connection with no token are refused without asking the server.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  assertAgentConnection,
  probeTableName,
  verifyAgentProfile,
} from "@/lib/db/providers/sql/libsql/agent-boundary";
import { type LibSQLStatementResult, LibSQLTransportError } from "@/lib/db/providers/sql/libsql/transport";
import type { DatabaseConnection } from "@/lib/db/types";

const EMPTY: LibSQLStatementResult = {
  rows: [],
  fieldNames: [],
  columnTypes: {},
  affectedRowCount: 0,
  lastInsertRowId: null,
  executionTimeMs: 0,
};

function connection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "libsql-agent",
    name: "libSQL agent",
    type: "libsql",
    host: "127.0.0.1",
    port: 18081,
    password: "not-a-real-token",
    createdAt: new Date("2026-10-29T00:00:00.000Z"),
    ...overrides,
  };
}

async function refusal(run: () => Promise<unknown> | unknown): Promise<ExecutionProfileError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("assertAgentConnection", () => {
  test("admits a connection that sends a bearer token", () => {
    expect(() => assertAgentConnection(connection())).not.toThrow();
  });

  test("refuses a user name and password, which sqld checks as HTTP Basic and grants every statement", async () => {
    const error = await refusal(() =>
      assertAgentConnection(connection({ user: "admin", password: "not-a-real-password" })),
    );

    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "A libSQL connection that signs in with a user name and password (HTTP Basic) has no read-only form, so the agent read-only profile is refused: use a read-only token instead",
    );
  });

  test("refuses a connection with no token, which only a server that checks no credential admits", async () => {
    for (const password of [undefined, ""]) {
      const error = await refusal(() => assertAgentConnection(connection({ password })));

      expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
      expect(error.message).toBe(
        "A libSQL connection with no token reaches only a server that checks no credential, so the agent read-only profile is refused: use a read-only token",
      );
    }
  });

  test("an empty user is no user, as the transport reads it", () => {
    expect(() => assertAgentConnection(connection({ user: "" }))).not.toThrow();
  });
});

describe("probeTableName", () => {
  test("is a fresh name each time, which no table can already hold", () => {
    const first = probeTableName();
    const second = probeTableName();

    expect(first).toMatch(/^libredb_agent_probe_[0-9a-f]{32}$/);
    expect(second).toMatch(/^libredb_agent_probe_[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});

describe("verifyAgentProfile", () => {
  const NAME = "libredb_agent_probe_00000000000000000000000000000000";

  test("sends one DROP TABLE IF EXISTS on the fresh name, and admits the 403 a read-only token is answered", async () => {
    const sent: string[] = [];

    await verifyAgentProfile(async (sql) => {
      sent.push(sql);
      throw new LibSQLTransportError(
        "libSQL request failed: Authorization forbidden: Current session doesn't not have Write permission to namespace default",
        403,
      );
    }, NAME);

    expect(sent).toEqual([`DROP TABLE IF EXISTS "${NAME}"`]);
  });

  test("refuses the profile when the server ran the write: a token that writes, or a server that checks none", async () => {
    const error = await refusal(() => verifyAgentProfile(async () => EMPTY, NAME));

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "libSQL ran a write sent with the agent's token, so the token is not read-only or the server checks no token, and the agent read-only profile is refused",
    );
  });

  test("refuses the profile when the statement failed for a reason of its own rather than the token's", async () => {
    const error = await refusal(() =>
      verifyAgentProfile(async () => {
        throw new LibSQLTransportError("unsupported statement", 200, "SQL_PARSE_ERROR");
      }, NAME),
    );

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      "libSQL answered the agent's write probe with status 200 (unsupported statement), not the 403 a read-only token is refused a write with, so the agent read-only profile is refused",
    );
  });

  test("refuses the profile on a 401, a 400 or a 5xx: none of them says the token is read-only", async () => {
    for (const status of [400, 401, 500, 503]) {
      const error = await refusal(() =>
        verifyAgentProfile(async () => {
          throw new LibSQLTransportError("libSQL request failed: nope", status);
        }, NAME),
      );

      expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
      expect(error.message).toContain(`with status ${status} (libSQL request failed: nope)`);
    }
  });

  test("lets a request that got no answer leave as it is, for the connect to report", async () => {
    const unreachable = new LibSQLTransportError("libSQL request failed: connection refused", 0);
    const other = new Error("boom");

    await expect(verifyAgentProfile(async () => Promise.reject(unreachable), NAME)).rejects.toBe(unreachable);
    await expect(verifyAgentProfile(async () => Promise.reject(other), NAME)).rejects.toBe(other);
  });

  test("names a fresh table when given none", async () => {
    const sent: string[] = [];

    await verifyAgentProfile(async (sql) => {
      sent.push(sql);
      throw new LibSQLTransportError("forbidden", 403);
    });

    expect(sent[0]).toMatch(/^DROP TABLE IF EXISTS "libredb_agent_probe_[0-9a-f]{32}"$/);
  });
});
