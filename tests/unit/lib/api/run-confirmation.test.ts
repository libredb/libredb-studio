import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  CONFIRMATION_FIELD_MESSAGE,
  CONFIRMATION_REQUIRED_MESSAGE,
  CONFIRMATION_TYPED_MESSAGE,
  gateRun,
  type RunGateRequest,
} from "@/lib/api/run-confirmation";
import { forgetUsedRunConfirmations, verifyRunConfirmation } from "@/lib/api/run-confirmation-token";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { INVALID_RUN_CONFIRMATION_SETTING } from "@/lib/config/run-confirmation";
import { TYPED_NAME_MISSING_REFUSAL } from "@/lib/editor/statement-analysis";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { installStandInVocabulary, STAND_IN_TYPE } from "../../../helpers/stand-in-vocabulary";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const clock = () => NOW;

const postgres: DatabaseConnection = {
  id: "gate-1",
  name: "Orders",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "orders",
  createdAt: new Date(0),
};

function request(overrides: Partial<RunGateRequest> = {}): RunGateRequest {
  return {
    route: "query",
    session: { username: "alice", role: "user", iat: 1_700_000_000 },
    connection: postgres,
    catalog: undefined,
    sql: "DELETE FROM t",
    params: undefined,
    confirmation: undefined,
    explain: false,
    ...overrides,
  };
}

/** The token of a 428 answer, read off its body. */
function tokenOf(decision: Awaited<ReturnType<typeof gateRun>>): string {
  if (decision.kind !== "answer") throw new Error("expected an answer");
  return (decision.body.confirmation as { token: string }).token;
}

describe("the run confirmation gate (FND-5)", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env.LIBREDB_RUN_CONFIRMATION;
    forgetUsedRunConfirmations();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    error = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
  });

  test("an absent field in advisory runs and is marked unconfirmed", async () => {
    expect(await gateRun(request(), clock)).toEqual({ kind: "run", unconfirmed: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([
      "A statement that needs a confirmation ran without one",
      { route: "api/db/query", type: "postgres", user: "alice" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("DELETE");
  });

  test("a read runs in either mode, unmarked and unlogged, with or without the field", async () => {
    for (const mode of ["advisory", "required"]) {
      process.env.LIBREDB_RUN_CONFIRMATION = mode;
      for (const confirmation of [undefined, "ask"]) {
        expect(await gateRun(request({ sql: "SELECT 1", confirmation }), clock)).toEqual({
          kind: "run",
          unconfirmed: false,
        });
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("ask answers 428 in advisory", async () => {
    const decision = await gateRun(request({ confirmation: "ask" }), clock);
    expect(decision).toEqual({
      kind: "answer",
      status: 428,
      body: {
        error: CONFIRMATION_REQUIRED_MESSAGE,
        code: ApiErrorCode.CONFIRMATION_REQUIRED,
        confirmation: {
          token: expect.any(String),
          expiresAt: new Date(NOW + 300_000).toISOString(),
          unreadable: false,
          typedConfirmation: null,
          classificationFailed: false,
        },
      },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("absent answers 428 in required", async () => {
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    const decision = await gateRun(request(), clock);
    expect(decision).toMatchObject({ kind: "answer", status: 428, body: { code: "CONFIRMATION_REQUIRED" } });
  });

  test("the 428's token runs the request once, and the verifier accepts it for that request", async () => {
    const asked = request({ confirmation: "ask" });
    const token = tokenOf(await gateRun(asked, clock));
    const confirmed = request({ confirmation: { token } });
    expect(await gateRun(confirmed, clock)).toEqual({ kind: "run", unconfirmed: false });
    expect(await gateRun(confirmed, clock)).toEqual({
      kind: "answer",
      status: 400,
      body: { error: "this confirmation has already been used", code: ApiErrorCode.CONFIRMATION_INVALID },
    });
    // The verifier itself, outside the gate, binds the same request.
    forgetUsedRunConfirmations();
    expect(
      await verifyRunConfirmation(
        token,
        {
          session: asked.session,
          connection: asked.connection,
          catalog: asked.catalog,
          route: asked.route,
          statement: asked.sql,
          params: asked.params,
          verdict: { decision: "confirm", unreadable: false, typedConfirmation: null, classificationFailed: false },
        },
        clock,
      ),
    ).toEqual({ valid: true });
  });

  test("a present token is verified in both modes, even for a statement that needs none", async () => {
    for (const mode of ["advisory", "required"]) {
      process.env.LIBREDB_RUN_CONFIRMATION = mode;
      expect(await gateRun(request({ sql: "SELECT 1", confirmation: { token: crypto.randomUUID() } }), clock)).toEqual({
        kind: "answer",
        status: 400,
        body: { error: "this confirmation could not be verified", code: ApiErrorCode.CONFIRMATION_INVALID },
      });
    }
  });

  test("a refused reading runs unconfirmed in advisory without the field, and is refused when asked or required", async () => {
    const remove = installStandInVocabulary({
      read: () => undefined,
      typedConfirmation: () => ({ type: "connection-name", targets: ["every key"] }),
    });
    try {
      const nameless = { ...postgres, type: STAND_IN_TYPE, name: "" };
      const refused = { kind: "answer" as const, status: 400, body: { error: TYPED_NAME_MISSING_REFUSAL } };
      expect(await gateRun(request({ connection: nameless, sql: "wipe" }), clock)).toEqual({
        kind: "run",
        unconfirmed: true,
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await gateRun(request({ connection: nameless, sql: "wipe", confirmation: "ask" }), clock)).toEqual(
        refused,
      );
      expect(
        await gateRun(request({ connection: nameless, sql: "wipe", confirmation: { token: "x" } }), clock),
      ).toEqual(refused);
      process.env.LIBREDB_RUN_CONFIRMATION = "required";
      expect(await gateRun(request({ connection: nameless, sql: "wipe" }), clock)).toEqual(refused);
    } finally {
      remove();
    }
  });

  test("the row's typed confirmation rides on the 428", async () => {
    const remove = installStandInVocabulary({
      read: () => undefined,
      typedConfirmation: () => ({ type: "connection-name", targets: ["every key"] }),
    });
    try {
      const decision = await gateRun(
        request({ connection: { ...postgres, type: STAND_IN_TYPE }, sql: "wipe", confirmation: "ask" }),
        clock,
      );
      expect(decision).toMatchObject({
        status: 428,
        body: {
          confirmation: { typedConfirmation: { type: "connection-name", expected: "Orders", targets: ["every key"] } },
        },
      });
    } finally {
      remove();
    }
  });

  test("a reader that throws asks, marked classificationFailed, and logs no text", async () => {
    const secret = crypto.randomUUID();
    const remove = installStandInVocabulary({
      read: () => {
        throw new RangeError(`the reader choked on ${secret}`);
      },
    });
    try {
      const connection = { ...postgres, type: STAND_IN_TYPE };
      const decision = await gateRun(request({ connection, sql: secret, confirmation: "ask" }), clock);
      expect(decision).toMatchObject({
        status: 428,
        body: { confirmation: { classificationFailed: true, unreadable: false, typedConfirmation: null } },
      });
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]).toEqual([
        "The confirmation gate could not read a statement, so it asks for a confirmation",
        undefined,
        { route: "api/db/query", type: STAND_IN_TYPE, errorName: "RangeError" },
      ]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      // Its token confirms the failed reading, and the resend runs.
      const token = tokenOf(decision);
      expect(await gateRun(request({ connection, sql: secret, confirmation: { token } }), clock)).toEqual({
        kind: "run",
        unconfirmed: false,
      });
    } finally {
      remove();
    }
  });

  test("an explain request is not classified", async () => {
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    for (const confirmation of [undefined, "ask"]) {
      expect(await gateRun(request({ explain: true, confirmation }), clock)).toEqual({
        kind: "run",
        unconfirmed: false,
      });
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    "Ask",
    "",
    true,
    null,
    1,
    [],
    {},
    { token: 1 },
    { token: "" },
    { typed: "b" },
    { token: "a", typed: 1 },
    { token: "a", typed: null },
    { token: "a", typed: "b", extra: "c" },
  ])("a malformed confirmation field is refused (%p)", async (confirmation) => {
    expect(await gateRun(request({ confirmation }), clock)).toEqual({
      kind: "answer",
      status: 400,
      body: { error: CONFIRMATION_FIELD_MESSAGE },
    });
  });

  test("a malformed field is refused on an explain request too", async () => {
    expect(await gateRun(request({ explain: true, confirmation: 1 }), clock)).toMatchObject({ status: 400 });
  });

  test("an unreadable mode setting is refused by name, never read as advisory", async () => {
    process.env.LIBREDB_RUN_CONFIRMATION = "strict";
    await expect(gateRun(request(), clock)).rejects.toThrow(INVALID_RUN_CONFIRMATION_SETTING);
  });
});

describe("the production escalation and the typed check (6c)", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;
  let name: string;
  let production: DatabaseConnection;

  const NOT_ASKED = "this statement asks for no typed confirmation";
  const MISMATCH = "the typed confirmation does not match what this statement asks to be typed";
  const ANOTHER_READING = "this confirmation was issued for another reading of the statement";
  const invalid = (reason: string) => ({
    kind: "answer" as const,
    status: 400,
    body: { error: reason, code: ApiErrorCode.CONFIRMATION_INVALID },
  });
  const RUNS = { kind: "run" as const, unconfirmed: false };

  beforeEach(() => {
    delete process.env.LIBREDB_RUN_CONFIRMATION;
    forgetUsedRunConfirmations();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    error = spyOn(logger, "error").mockImplementation(() => {});
    name = crypto.randomUUID();
    production = { ...postgres, name, environment: "production" };
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
  });

  test("the typed 428's sentence names the token and typed", () => {
    expect(CONFIRMATION_TYPED_MESSAGE).toBe(
      "This statement needs a typed confirmation before it runs: send the same request again with the confirmation token in this answer and, as typed, the value its typedConfirmation expects.",
    );
  });

  test("a write on production answers 428 naming the name, to absent or ask in either mode", async () => {
    const asked = {
      kind: "answer" as const,
      status: 428,
      body: {
        error: CONFIRMATION_TYPED_MESSAGE,
        code: ApiErrorCode.CONFIRMATION_REQUIRED,
        confirmation: {
          token: expect.any(String),
          expiresAt: new Date(NOW + 300_000).toISOString(),
          unreadable: false,
          typedConfirmation: { type: "connection-name" as const, expected: name, targets: [] },
          classificationFailed: false,
        },
      },
    };
    for (const mode of ["advisory", "required"]) {
      process.env.LIBREDB_RUN_CONFIRMATION = mode;
      // oxlint-disable-next-line no-await-in-loop -- each mode is set in the environment before its run.
      expect(await gateRun(request({ connection: production }), clock)).toEqual(asked);
      // oxlint-disable-next-line no-await-in-loop -- each mode is set in the environment before its run.
      expect(await gateRun(request({ connection: production, confirmation: "ask" }), clock)).toEqual(asked);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("advisory spares no write on production that sends no field, and still spares one off production", async () => {
    expect(await gateRun(request({ connection: production }), clock)).toMatchObject({ kind: "answer", status: 428 });
    expect(warn).not.toHaveBeenCalled();
    const staging = { ...production, environment: "staging" as const };
    expect(await gateRun(request({ connection: staging }), clock)).toEqual({ kind: "run", unconfirmed: true });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("a token without typed on production answers 428 with a new token, and the sent one is not spent", async () => {
    const token = tokenOf(await gateRun(request({ connection: production, confirmation: "ask" }), clock));
    const again = await gateRun(request({ connection: production, confirmation: { token } }), clock);
    expect(again).toMatchObject({
      kind: "answer",
      status: 428,
      body: {
        error: CONFIRMATION_TYPED_MESSAGE,
        confirmation: { typedConfirmation: { type: "connection-name", expected: name, targets: [] } },
      },
    });
    expect(tokenOf(again)).not.toBe(token);
    expect(await gateRun(request({ connection: production, confirmation: { token, typed: name } }), clock)).toEqual(
      RUNS,
    );
  });

  test("another typed value is refused, and the token is not spent", async () => {
    const token = tokenOf(await gateRun(request({ connection: production, confirmation: "ask" }), clock));
    for (const typed of [crypto.randomUUID(), name.toUpperCase(), ` ${name}`, ""]) {
      // oxlint-disable-next-line no-await-in-loop -- one token, refused value after value, must stay unspent.
      expect(await gateRun(request({ connection: production, confirmation: { token, typed } }), clock)).toEqual(
        invalid(MISMATCH),
      );
    }
    expect(await gateRun(request({ connection: production, confirmation: { token, typed: name } }), clock)).toEqual(
      RUNS,
    );
  });

  test("the name with its token runs once, then the token is used", async () => {
    const token = tokenOf(await gateRun(request({ connection: production, confirmation: "ask" }), clock));
    const confirmed = request({ connection: production, confirmation: { token, typed: name } });
    expect(await gateRun(confirmed, clock)).toEqual(RUNS);
    expect(await gateRun(confirmed, clock)).toEqual(invalid("this confirmation has already been used"));
  });

  test("a read on production runs with no field and with ask", async () => {
    for (const mode of ["advisory", "required"]) {
      process.env.LIBREDB_RUN_CONFIRMATION = mode;
      for (const confirmation of [undefined, "ask"]) {
        // oxlint-disable-next-line no-await-in-loop -- each mode is set in the environment before its run.
        expect(await gateRun(request({ connection: production, sql: "SELECT 1", confirmation }), clock)).toEqual(RUNS);
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test("a token minted off production is another reading once the connection is production, and the reverse", async () => {
    const development = { ...production, environment: "development" as const };
    const offProduction = tokenOf(await gateRun(request({ connection: development, confirmation: "ask" }), clock));
    expect(
      await gateRun(request({ connection: production, confirmation: { token: offProduction, typed: name } }), clock),
    ).toEqual(invalid(ANOTHER_READING));
    const onProduction = tokenOf(await gateRun(request({ connection: production, confirmation: "ask" }), clock));
    expect(
      await gateRun(request({ connection: development, confirmation: { token: onProduction, typed: name } }), clock),
    ).toEqual(invalid(NOT_ASKED));
  });

  test("after a rename, the old name does not match and the new one is another reading", async () => {
    const token = tokenOf(await gateRun(request({ connection: production, confirmation: "ask" }), clock));
    const renamed = { ...production, name: crypto.randomUUID() };
    expect(await gateRun(request({ connection: renamed, confirmation: { token, typed: name } }), clock)).toEqual(
      invalid(MISMATCH),
    );
    expect(
      await gateRun(request({ connection: renamed, confirmation: { token, typed: renamed.name } }), clock),
    ).toEqual(invalid(ANOTHER_READING));
  });

  test("a row's own typed ask is checked too, on any environment", async () => {
    const lease = "694d77aa9e38260f";
    const etcd = { ...postgres, type: "etcd" as const, environment: "development" as const };
    const sql = `lease revoke ${lease}`;
    const asked = await gateRun(request({ connection: etcd, sql, confirmation: "ask" }), clock);
    expect(asked).toMatchObject({
      status: 428,
      body: {
        error: CONFIRMATION_TYPED_MESSAGE,
        confirmation: { typedConfirmation: { type: "text", expected: lease } },
      },
    });
    const token = tokenOf(asked);
    expect(await gateRun(request({ connection: etcd, sql, confirmation: { token } }), clock)).toMatchObject({
      status: 428,
    });
    expect(await gateRun(request({ connection: etcd, sql, confirmation: { token, typed: lease } }), clock)).toEqual(
      RUNS,
    );
  });

  test("typed on a statement that asks none is refused, in both modes", async () => {
    const asked = tokenOf(await gateRun(request({ confirmation: "ask" }), clock));
    for (const mode of ["advisory", "required"]) {
      process.env.LIBREDB_RUN_CONFIRMATION = mode;
      // oxlint-disable-next-line no-await-in-loop -- each mode is set in the environment before its run.
      expect(await gateRun(request({ confirmation: { token: asked, typed: "x" } }), clock)).toEqual(invalid(NOT_ASKED));
      expect(
        // oxlint-disable-next-line no-await-in-loop -- each mode is set in the environment before its run.
        await gateRun(request({ sql: "SELECT 1", confirmation: { token: crypto.randomUUID(), typed: "x" } }), clock),
      ).toEqual(invalid(NOT_ASKED));
    }
    // Not spent by the refusal.
    expect(await gateRun(request({ confirmation: { token: asked } }), clock)).toEqual(RUNS);
  });

  test("a reader that throws on production asks for the name, and a nameless production connection is refused", async () => {
    const remove = installStandInVocabulary({
      read: () => {
        throw new RangeError("the reader choked");
      },
    });
    try {
      const connection = { ...production, type: STAND_IN_TYPE };
      expect(await gateRun(request({ connection, sql: "wipe", confirmation: "ask" }), clock)).toMatchObject({
        status: 428,
        body: {
          error: CONFIRMATION_TYPED_MESSAGE,
          confirmation: {
            classificationFailed: true,
            unreadable: false,
            typedConfirmation: { type: "connection-name", expected: name, targets: [] },
          },
        },
      });
      expect(
        await gateRun(request({ connection: { ...connection, name: "" }, sql: "wipe", confirmation: "ask" }), clock),
      ).toEqual({ kind: "answer", status: 400, body: { error: TYPED_NAME_MISSING_REFUSAL } });
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      remove();
    }
  });

  test("a write on a nameless production connection is refused when asked and, in advisory, when no field is sent", async () => {
    const refused = { kind: "answer" as const, status: 400, body: { error: TYPED_NAME_MISSING_REFUSAL } };
    expect(await gateRun(request({ connection: { ...production, name: "" }, confirmation: "ask" }), clock)).toEqual(
      refused,
    );
    expect(await gateRun(request({ connection: { ...production, name: "" } }), clock)).toEqual(refused);
    expect(warn).not.toHaveBeenCalled();
  });
});
