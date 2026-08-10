import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { emitAuditEvent, getServerAuditBuffer } from "@/lib/audit";

/**
 * Threat: a secret reaching the audit trail or the log pipeline, or an attacker-controlled value
 * forging a second log line so a brute-force run reads as something else.
 *
 * The audit channel deliberately does NOT reuse logger.ts's sanitizeLogValue. JSON.stringify
 * escapes newlines and control characters structurally, which is a stronger guarantee than a
 * replace() someone can later narrow, and logger.ts additionally emits a non-parseable
 * "[LEVEL] [ts] {k=v} message" shape and does not redact secrets from error.message or stack.
 */

const ALLOWED_KEYS = new Set([
  "schema",
  "ts",
  "id",
  "event",
  "action",
  "outcome",
  "actor",
  "route",
  "reason",
  "ip",
  "connection",
  "duration_ms",
  "bucket",
  "correlation_id",
]);

function captureLine(emit: () => void): Record<string, unknown> {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  try {
    emit();
    expect(spy).toHaveBeenCalledTimes(1);
    const written = spy.mock.calls[0][0] as string;
    // Exactly one line: a forged newline would make this more than one.
    expect(written.split("\n").length).toBe(1);
    return JSON.parse(written) as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  getServerAuditBuffer().clear();
});

describe("emitAuditEvent", () => {
  test("writes exactly one JSON object carrying only allowlisted keys", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "login_failure",
        action: "login",
        target: "POST /api/auth/login",
        user: "admin@libredb.org",
        result: "failure",
        reason: "bad_credentials",
        ip: "203.0.113.9",
      }),
    );

    for (const key of Object.keys(line)) {
      expect({ key, allowed: ALLOWED_KEYS.has(key) }).toEqual({ key, allowed: true });
    }
    expect(line.schema).toBe("libredb.audit.v1");
    expect(line.event).toBe("login_failure");
    expect(line.action).toBe("login");
    expect(line.outcome).toBe("failure");
    expect(line.actor).toBe("admin@libredb.org");
    expect(line.route).toBe("POST /api/auth/login");
    expect(line.reason).toBe("bad_credentials");
    expect(line.ip).toBe("203.0.113.9");
  });

  test("holds an agent event's correlation id to the same key allowlist and the same bound", () => {
    // The agent execution path (#328) is the only writer that sets
    // correlationId, so without a case that emits one the new key would sit
    // outside the invariant this file exists to enforce. A correlation id is
    // server-generated, but it is a string field like every other, so it goes
    // through the same allowlist and the same MAX_AUDIT_FIELD_LENGTH bound.
    const line = captureLine(() =>
      emitAuditEvent({
        type: "agent_operation",
        action: "sql.query.read",
        target: "agent/operations/decision",
        user: "agent:user",
        result: "success",
        correlationId: "c".repeat(10_000),
      }),
    );

    for (const key of Object.keys(line)) {
      expect({ key, allowed: ALLOWED_KEYS.has(key) }).toEqual({ key, allowed: true });
    }
    expect(line.event).toBe("agent_operation");
    expect(String(line.correlation_id).length).toBe(254);
  });

  test("cannot be made to forge a second log line through the actor field", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "login_failure",
        action: "login",
        target: "POST /api/auth/login",
        user: '\n{"schema":"libredb.audit.v1","event":"login_success","actor":"root"}',
        result: "failure",
        reason: "bad_credentials",
      }),
    );

    expect(line.event).toBe("login_failure");
    expect(String(line.actor)).toContain("login_success");
  });

  test("carries no field that could hold a credential, a token or a connection string", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "login_failure",
        action: "login",
        target: "POST /api/auth/login",
        user: "admin@libredb.org",
        result: "failure",
        reason: "bad_credentials",
        // These are the shapes a careless call site would try to attach. The AuditEvent fields
        // that could carry them (details) are not part of the emitted allowlist, and reason is a
        // closed union so no error string can reach the record.
        details: "password=hunter2 token=eyJhbGciOiJIUzI1NiJ9.x.y postgres://u:p@db:5432/app",
      }),
    );

    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("postgres://");
    expect(line.details).toBeUndefined();
  });

  test("truncates the actor so a 10 KB submitted email cannot bloat every line", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "login_failure",
        action: "login",
        target: "POST /api/auth/login",
        user: "a".repeat(10_000),
        result: "failure",
        reason: "bad_credentials",
      }),
    );

    expect(String(line.actor).length).toBe(254);
  });

  test("omits the reason, the ip, the connection, the duration and the bucket when they are absent", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "logout",
        action: "logout",
        target: "POST /api/auth/logout",
        user: "anonymous",
        result: "success",
      }),
    );

    expect("reason" in line).toBe(false);
    expect("ip" in line).toBe(false);
    expect("connection" in line).toBe(false);
    expect("duration_ms" in line).toBe(false);
    expect("bucket" in line).toBe(false);
  });

  test("carries the bucket when a rate-limit trip supplies one", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "rate_limit_exceeded",
        action: "throttled",
        target: "POST /api/auth/login",
        user: "admin@libredb.org",
        result: "failure",
        reason: "rate_limited",
        bucket: "login_account",
      }),
    );

    expect(line.bucket).toBe("login_account");
  });

  test("omits an unknown ip rather than recording the placeholder as an address", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "permission_denied",
        action: "denied",
        target: "POST /api/db/query",
        user: "anonymous",
        result: "failure",
        reason: "no_session",
        ip: "unknown",
      }),
    );

    expect("ip" in line).toBe(false);
  });

  test("carries the connection and the duration when a caller supplies them", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "query_execution",
        action: "query",
        target: "POST /api/db/query",
        connectionName: "sample-employees",
        user: "user@libredb.org",
        result: "success",
        duration: 42,
      }),
    );

    expect(line.connection).toBe("sample-employees");
    expect(line.duration_ms).toBe(42);
  });

  test("also pushes the event to the buffer the admin UI reads, sharing its id", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const stored = emitAuditEvent({
        type: "login_success",
        action: "login",
        target: "POST /api/auth/login",
        user: "admin@libredb.org",
        result: "success",
      });
      const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;

      expect(getServerAuditBuffer().getAll()).toHaveLength(1);
      expect(getServerAuditBuffer().getAll()[0].id).toBe(stored.id);
      expect(line.id).toBe(stored.id);
      expect(line.ts).toBe(stored.timestamp);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Threat: a connection string reaches the log pipeline the moment a real call site (Tasks 6-9)
   * passes one through connectionName, ip, action, route or the actor. Each field gets its own
   * test so that dropping the sanitizer from exactly one field turns exactly one test red and
   * names it, rather than a single call-site test that a future refactor could satisfy by
   * accident.
   */
  describe("credential redaction is pinned per field", () => {
    const CONNECTION_STRING = "postgres://dbadmin:supersecret@10.0.0.5:5432/prod";

    test("redacts an embedded connection-string password from the connection field, keeping the host", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: CONNECTION_STRING,
          user: "user@libredb.org",
          result: "success",
        }),
      );

      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("supersecret");
      expect(serialized).toContain("10.0.0.5");
    });

    test("redacts an embedded connection-string password from the actor field", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "login_failure",
          action: "login",
          target: "POST /api/auth/login",
          user: CONNECTION_STRING,
          result: "failure",
          reason: "bad_credentials",
        }),
      );

      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("supersecret");
      expect(String(line.actor)).toContain("10.0.0.5");
    });

    test("redacts an embedded connection-string password carried through the ip field", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "permission_denied",
          action: "denied",
          target: "POST /api/db/query",
          user: "anonymous",
          result: "failure",
          reason: "no_session",
          ip: CONNECTION_STRING,
        }),
      );

      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("supersecret");
      expect(String(line.ip)).toContain("10.0.0.5");
    });

    test("redacts an embedded connection-string password carried through the action field", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "login_failure",
          action: CONNECTION_STRING,
          target: "POST /api/auth/login",
          user: "admin@libredb.org",
          result: "failure",
          reason: "bad_credentials",
        }),
      );

      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("supersecret");
      expect(String(line.action)).toContain("10.0.0.5");
    });

    test("redacts an embedded connection-string password carried through the route field", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "login_failure",
          action: "login",
          target: CONNECTION_STRING,
          user: "admin@libredb.org",
          result: "failure",
          reason: "bad_credentials",
        }),
      );

      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("supersecret");
      expect(String(line.route)).toContain("10.0.0.5");
    });
  });

  /**
   * Threat: the admin API's audit endpoint is a display-only passthrough over
   * `getServerAuditBuffer()` (see src/app/api/admin/audit/route.ts) — whatever is retained here is
   * what that endpoint serves. A connection string with an embedded password must not survive in
   * the buffer just because it was scrubbed on the way to stdout; the two destinations share one
   * sanitized event, not two independent rules.
   */
  test("a connection string with an embedded password is not readable from the buffer the admin API serves", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      emitAuditEvent({
        type: "query_execution",
        action: "query",
        target: "POST /api/db/query",
        connectionName: "postgres://dbadmin:supersecret@10.0.0.5:5432/prod",
        user: "user@libredb.org",
        result: "success",
      });

      const buffered = getServerAuditBuffer().getAll();
      expect(buffered).toHaveLength(1);
      const serializedBuffer = JSON.stringify(buffered);
      expect(serializedBuffer).not.toContain("supersecret");
      expect(serializedBuffer).toContain("10.0.0.5");
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * Threat: per RFC 3986, a URI's userinfo ends at the LAST `@` before the host, not the first —
   * and `P@ssw0rd` shapes are ordinary. A pattern that stops at the first `@` leaves the tail of
   * the password sitting in front of the host, where it reads as if it belongs to nothing. Each
   * case uses a password distinct from `supersecret` (the constant reused by the per-field tests
   * above) so a regression here cannot pass by accident because some other test's fixture happens
   * to satisfy it.
   */
  describe("the credential pattern resolves the userinfo boundary correctly", () => {
    test("redacts a plain single-@ connection string, keeping the host", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://user:pass@host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("postgres://[REDACTED]@host:5432/db");
    });

    test("fully redacts a password containing an embedded @, leaving no fragment before the host", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://user:p@ss@host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("postgres://[REDACTED]@host:5432/db");
    });

    test("fully redacts a password containing multiple embedded @ characters", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://user:p@s@s@host/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("postgres://[REDACTED]@host/db");
    });

    test("leaves a connection string with no userinfo untouched", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("postgres://host:5432/db");
    });

    test("does not mangle a bare email address with no scheme", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "login_failure",
          action: "login",
          target: "POST /api/auth/login",
          user: "admin@libredb.org",
          result: "failure",
          reason: "bad_credentials",
        }),
      );

      expect(line.actor).toBe("admin@libredb.org");
    });

    /**
     * Revised in fix round 4: a slash inside a password (`postgres://user:pa/ss@host/db`) and an
     * `@` inside a path (`https://example.com/user@example/profile`) are structurally identical —
     * no syntax-only rule can tell them apart, which is exactly why the round-3 version of this
     * test expected the path-embedded `@` to survive untouched. Round 4 deliberately abandoned
     * that precision: sanitizeAuditField now collapses everything between the scheme and the LAST
     * `@` unconditionally, so a harmless URL shaped like this one gets its path mangled too. That
     * is the intended, accepted cost — mangling a URL costs an operator nothing; a slash-bearing
     * password that used to defeat redaction entirely costs them everything.
     */
    test("collapses an @ inside the path too, because that risk cannot be told apart from a slash inside a password", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "login_failure",
          action: "login",
          target: "https://example.com/user@example/profile",
          user: "admin@libredb.org",
          result: "failure",
          reason: "bad_credentials",
        }),
      );

      expect(line.route).toBe("https://[REDACTED]@example/profile");
    });

    test("redacts a password containing a slash, which a boundary excluding / could never reach", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://user:pa/ss@host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("postgres://[REDACTED]@host:5432/db");
    });

    test("redacts a password containing ? and #, which a URI parser would mistake for query and fragment delimiters", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://user:pa?ss#word@host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("postgres://[REDACTED]@host:5432/db");
    });

    test("degrades to the marker alone when no host is recoverable after the credential", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "postgres://user:pa/ss@",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("[REDACTED]");
    });

    /**
     * Threat: after CodeQL flagged the original backtracking regex as polynomial-time (alert
     * #112, js/polynomial-redos), it was replaced with a loop over `indexOf("://", ...)`. These
     * two cases pin the loop's own correctness: a "://" occurrence with no valid scheme
     * immediately before it must not defeat redaction of a LATER, valid one in the same value, and
     * a scheme-character run that starts with digits must still find the letter RFC 3986 requires
     * a scheme to start with, rather than rejecting the whole run because its first character
     * fails.
     */
    test("keeps searching past a delimiter with no valid scheme immediately before it", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "1://postgres://user:pass@host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("1://postgres://[REDACTED]@host:5432/db");
    });

    test("finds the scheme's mandatory leading letter after skipping digits within the same run", () => {
      const line = captureLine(() =>
        emitAuditEvent({
          type: "query_execution",
          action: "query",
          target: "POST /api/db/query",
          connectionName: "123abc://user:pass@host:5432/db",
          user: "user@libredb.org",
          result: "success",
        }),
      );

      expect(line.connection).toBe("123abc://[REDACTED]@host:5432/db");
    });
  });

  test("bounds an oversized ip so a spoofed forwarded-for chain cannot bloat every line", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "permission_denied",
        action: "denied",
        target: "POST /api/db/query",
        user: "anonymous",
        result: "failure",
        reason: "no_session",
        ip: `1.2.3.4,${"x".repeat(50_000)}`,
      }),
    );

    expect(String(line.ip).length).toBe(254);
  });

  /**
   * Threat: exactly the CodeQL js/polynomial-redos proof-of-concept shape (alert #112) - a long
   * run of one repeated letter with no "://" anywhere - reaching the credential redactor through
   * an attacker-controlled field with no length bound applied before it runs. The old backtracking
   * regex was O(n^2) here; 300,000 characters would not return within a CI-sane timeout if that
   * regression came back. It is proven with a wall-clock budget, not just a correctness assertion,
   * because a quadratic function still returns the CORRECT string - it just takes minutes to do it.
   */
  test("stays fast on a long run with no URI delimiter anywhere, the ReDoS proof-of-concept shape", () => {
    const started = performance.now();
    const line = captureLine(() =>
      emitAuditEvent({
        type: "permission_denied",
        action: "denied",
        target: "POST /api/db/query",
        user: "anonymous",
        result: "failure",
        reason: "no_session",
        ip: "A".repeat(300_000),
      }),
    );
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(500);
    expect(String(line.ip).length).toBe(254);
  });

  test("omits duration_ms instead of letting a non-finite duration flip the field from a number to null", () => {
    const line = captureLine(() =>
      emitAuditEvent({
        type: "query_execution",
        action: "query",
        target: "POST /api/db/query",
        connectionName: "sample-employees",
        user: "user@libredb.org",
        result: "success",
        duration: Number.NaN,
      }),
    );

    expect("duration_ms" in line).toBe(false);
  });
});
