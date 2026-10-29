/**
 * The libSQL agent read-only profile's boundary, proven at open (`agent-boundary.ts`).
 *
 * The proof is three write-shaped statements that change nothing on any outcome, sent with the agent's own token: the
 * server must refuse each with 403 and its own authorization refusal ("Authorization forbidden", measured on sqld
 * 0.24.33). Every other answer refuses the profile, fail closed, a 403 with any other body included. The credential
 * check runs before them: a user name and password (HTTP Basic) and a connection with no token are refused without
 * asking the server. After them, the token's own claims must declare read-only access.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  agentProbeStatements,
  assertAgentConnection,
  assertReadOnlyClaims,
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

/** sqld's own refusal of a read-only token's write, as the transport reports it (measured on sqld 0.24.33). */
const FORBIDDEN = new LibSQLTransportError(
  "libSQL request failed: Authorization forbidden: Current session doesn't not have Write permission to namespace default",
  403,
);

/** A token shaped like a JWT, built here so no literal token sits in the source; the signature is not one. */
function fakeToken(claims: unknown): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "EdDSA", typ: "JWT" })}.${part(claims)}.not-a-real-signature`;
}

describe("agentProbeStatements", () => {
  test("is a DDL and two DML statements on one fresh name, each a no-op on any outcome", () => {
    expect(agentProbeStatements("libredb_agent_probe_0")).toEqual([
      'DROP TABLE IF EXISTS "libredb_agent_probe_0"',
      'DELETE FROM "libredb_agent_probe_0" WHERE 0',
      'INSERT INTO "libredb_agent_probe_0" SELECT 1 WHERE 0',
    ]);
  });
});

describe("verifyAgentProfile", () => {
  const NAME = "libredb_agent_probe_00000000000000000000000000000000";

  test("sends every probe on the fresh name, and admits the profile when sqld refuses each for the token", async () => {
    const sent: string[] = [];

    await verifyAgentProfile(async (sql) => {
      sent.push(sql);
      throw FORBIDDEN;
    }, NAME);

    expect(sent).toEqual([...agentProbeStatements(NAME)]);
  });

  test("refuses the profile when the server ran a probe: a token that writes, or a server that checks none", async () => {
    const error = await refusal(() => verifyAgentProfile(async () => EMPTY, NAME));

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      `libSQL ran the write probe DROP TABLE IF EXISTS "${NAME}" sent with the agent's token, so the token is not read-only or the server checks no token, and the agent read-only profile is refused`,
    );
  });

  test("refuses the profile on a mixed answer set: one probe refused, a later one run", async () => {
    const sent: string[] = [];
    const error = await refusal(() =>
      verifyAgentProfile(async (sql) => {
        sent.push(sql);
        if (sql.startsWith("DROP")) throw FORBIDDEN;
        return EMPTY;
      }, NAME),
    );

    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toContain("the write probe DELETE FROM");
    expect(sent).toHaveLength(2);
  });

  test("refuses the profile on a mixed answer set: one probe refused, a later one failed for a reason of its own", async () => {
    const error = await refusal(() =>
      verifyAgentProfile(async (sql) => {
        if (!sql.startsWith("INSERT")) throw FORBIDDEN;
        throw new LibSQLTransportError("SQLite error: no such table: libredb_agent_probe_0", 200, "SQLITE_UNKNOWN");
      }, NAME),
    );

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("status 200 (SQLite error: no such table: libredb_agent_probe_0)");
  });

  test("refuses a 403 whose body is not sqld's own authorization refusal, as a proxy's would be", async () => {
    for (const message of [
      "libSQL request failed: Forbidden",
      "libSQL request failed: <html>403</html>",
      "Authorization forbidden",
    ]) {
      const error = await refusal(() =>
        verifyAgentProfile(async () => {
          throw new LibSQLTransportError(message, 403);
        }, NAME),
      );

      expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
      expect(error.message).toBe(
        `libSQL answered the agent's write probe with status 403 (${message}), not the authorization refusal a read-only token is refused a write with, so the agent read-only profile is refused`,
      );
    }
  });

  test("refuses the profile when a statement failed for a reason of its own rather than the token's", async () => {
    const error = await refusal(() =>
      verifyAgentProfile(async () => {
        throw new LibSQLTransportError("unsupported statement", 200, "SQL_PARSE_ERROR");
      }, NAME),
    );

    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      "libSQL answered the agent's write probe with status 200 (unsupported statement), not the authorization refusal a read-only token is refused a write with, so the agent read-only profile is refused",
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
      throw FORBIDDEN;
    });

    expect(sent[0]).toMatch(/^DROP TABLE IF EXISTS "libredb_agent_probe_[0-9a-f]{32}"$/);
  });
});

describe("assertReadOnlyClaims", () => {
  test("admits a token whose claims carry a = ro", () => {
    expect(() => assertReadOnlyClaims(fakeToken({ a: "ro", iat: 1 }))).not.toThrow();
  });

  test("refuses a token whose claims grant writes, grant everything, or say nothing it can read", async () => {
    for (const token of [
      fakeToken({ a: "rw" }),
      fakeToken({}),
      fakeToken({ a: ["ro"] }),
      fakeToken(["ro"]),
      fakeToken(null),
      "not-a-real-token",
      "a.b",
      "a.%%%.c",
      `x.${Buffer.from("not json").toString("base64url")}.y`,
    ]) {
      const error = await refusal(() => assertReadOnlyClaims(token));

      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(
        'The libSQL token does not declare read-only access (a JWT whose claims carry "a": "ro"), so the agent read-only profile is refused',
      );
    }
  });

  test("refuses a read-only token that also carries a permission claim, which the server lets widen it to writes", async () => {
    for (const token of [
      fakeToken({ a: "ro", p: { rw: { ns: ["default"] } } }),
      fakeToken({ a: "ro", p: { ro: { ns: ["default"] } } }),
      fakeToken({ a: "ro", p: null }),
      fakeToken({ a: "ro", p: {} }),
    ]) {
      const error = await refusal(() => assertReadOnlyClaims(token));

      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(
        'The libSQL token carries a permission claim ("p"), which the server reads on top of "a": "ro" and can grant writes with, so the agent read-only profile is refused',
      );
    }
  });
});
