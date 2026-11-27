import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  CONFIRMATION_FIELD_MESSAGE,
  CONFIRMATION_REQUIRED_MESSAGE,
  CONFIRMATION_TYPED_MESSAGE,
  gateRun,
  type RunGateRequest,
} from "@/lib/api/run-confirmation";
import {
  forgetUsedRunConfirmations,
  runConfirmationIssuerForProcess,
  runConfirmationIssuerForSession,
  verifyRunConfirmation,
} from "@/lib/api/run-confirmation-token";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { INVALID_RUN_CONFIRMATION_SETTING } from "@/lib/config/run-confirmation";
import {
  type ConfirmationVerdict,
  confirmationVerdict,
  packageConfirmationVerdict,
  TYPED_NAME_MISSING_REFUSAL,
} from "@/lib/editor/statement-analysis";
import { logger } from "@/lib/logger";
import { type EngineConnection, type EngineRecord, servedEngineRecord } from "@/lib/db/server-catalog";
import { STUDIO_GRANT_REGISTER } from "@/lib/db/claim-grants";
import { grammarSha256 } from "@/lib/db/grammar-digest";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { LEGACY_ENGINE_IDS } from "@/lib/provider-host/legacy-adapter/identity";
import type { DatabaseConnection } from "@/lib/types";
import { parseGrantRegister, type RegisterGrants } from "@libredb/grant-register";
import type { SqlGrammar } from "@libredb/provider-sdk/sql";
import { randomUUID } from "node:crypto";
import {
  admittedFor,
  admittedManifest,
  declaredLanguageSha256,
  type EditableEngine,
  packageRow,
  withStatementLanguageData,
} from "../../../helpers/package-catalog";
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

/** A run request on `postgres`, changed by `overrides`, with the served record of its connection's engine. */
function request(overrides: Partial<RunGateRequest> = {}): RunGateRequest {
  const changed = {
    route: "query",
    issuer: runConfirmationIssuerForSession({ username: "alice", role: "user", iat: 1_700_000_000 }),
    connection: postgres,
    catalog: undefined,
    sql: "DELETE FROM t",
    params: undefined,
    confirmation: undefined,
    explain: false,
    ...overrides,
  } as const;
  return { ...changed, engine: overrides.engine ?? servedEngineRecord(changed.connection.type) };
}

/**
 * The record the server catalog composes for a package serving engine `id`, its minimal manifest changed by `edit`:
 * against Studio's register, which holds no row for it, where `grants` is absent; otherwise against a register holding
 * its row granting `grants`, `grammarSha256` the digest of the grammar it declares and `languageSha256` the digest of
 * the statement language data it declares, or null where it declares none, unless `grants` names another, every other
 * member at its restrictive value.
 */
function packageEngine(
  id: string,
  edit: (engine: EditableEngine) => void = () => undefined,
  grants?: Partial<RegisterGrants>,
): EngineRecord {
  const manifest = admittedManifest(id, edit);
  const pkg = admittedFor(`${id}-package`, manifest);
  const declared = (manifest.engines[0] as { sqlText: { grammar: unknown } }).sqlText.grammar;
  const register =
    grants === undefined
      ? STUDIO_GRANT_REGISTER
      : parseGrantRegister(
          [
            packageRow(pkg, id, {
              grammarSha256: grammarSha256(declared),
              languageSha256: manifest.engines[0]?.statementLanguageData ? declaredLanguageSha256(manifest) : null,
              ...grants,
            }),
          ],
          LEGACY_ENGINE_IDS,
        );
  const engine = composeServerCatalog([pkg], [], register).engines.get(id);
  if (engine === undefined) throw new Error(`the composed catalog holds no record of ${id}`);
  return engine;
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

  test("the advisory warning names the issuer's user and the route's log label", async () => {
    const issuer = runConfirmationIssuerForProcess("vscode-extension");
    expect(await gateRun(request({ route: "vscode/query/run", issuer }), clock)).toEqual({
      kind: "run",
      unconfirmed: true,
    });
    expect(await gateRun(request({ route: "multi-query" }), clock)).toEqual({ kind: "run", unconfirmed: true });
    expect(warn.mock.calls).toEqual([
      [
        "A statement that needs a confirmation ran without one",
        { route: "vscode/query/run", type: "postgres", user: "vscode-extension" },
      ],
      [
        "A statement that needs a confirmation ran without one",
        { route: "api/db/multi-query", type: "postgres", user: "alice" },
      ],
    ]);
  });

  test("a read with no token runs for a session with no issue time", async () => {
    const issuer = runConfirmationIssuerForSession({ username: "alice", role: "user" });
    const decisions = await Promise.all(
      [undefined, "ask"].map((confirmation) => gateRun(request({ issuer, sql: "SELECT 1", confirmation }), clock)),
    );
    expect(decisions).toEqual([
      { kind: "run", unconfirmed: false },
      { kind: "run", unconfirmed: false },
    ]);
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
          issuer: asked.issuer,
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

/* oxlint-disable no-await-in-loop -- each gate call runs after the one before, so a token is spent in its order. */
describe("the gate on an engine a provider package serves", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;
  let warn: ReturnType<typeof spyOn>;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
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

  /** A connection of the package's engine, its type an id Studio does not ship. */
  const kv = {
    id: "pkg-gate",
    name: "Keys",
    type: "acmegate",
    host: "kv.internal",
    createdAt: new Date(0),
  } as unknown as EngineConnection;

  /**
   * The server catalog's record of the package's engine, its minimal manifest changed by `edit`, its register row
   * reviewing the grammar it declares and granting `grants`, every other claim at its restrictive value.
   */
  const declared = (edit: (engine: EditableEngine) => void = () => undefined, grants: Partial<RegisterGrants> = {}) =>
    packageEngine("acmegate", edit, grants);

  function packageRequest(overrides: Partial<RunGateRequest> = {}): RunGateRequest {
    return request({ connection: kv, engine: declared(), ...overrides });
  }

  test("a package engine no register row reviews asks about every statement, a read included, and a production connection asks its name", async () => {
    const unreviewed = [
      packageEngine("acmegate"),
      packageEngine("acmegate", undefined, { grammarSha256: grammarSha256({ planted: randomUUID() }) }),
      packageEngine("acmegate", undefined, { grammarSha256: null }),
    ];
    for (const engine of unreviewed) {
      expect(engine.grants.reviewedGrammar).toBe(false);
      // A read and a run that never closes ask as a write does, and none is reported unreadable: nothing is read.
      for (const sql of ["SELECT 1", "SELECT 'never closed", "DELETE FROM t"]) {
        expect([sql, await gateRun(packageRequest({ engine, sql }), clock)]).toMatchObject([
          sql,
          {
            kind: "answer",
            status: 428,
            body: { confirmation: { unreadable: false, typedConfirmation: null, classificationFailed: false } },
          },
        ]);
      }
      const production = { ...kv, environment: "production" } as EngineConnection;
      expect(
        await gateRun(packageRequest({ engine, connection: production, sql: "SELECT 1", confirmation: "ask" }), clock),
      ).toMatchObject({
        status: 428,
        body: {
          error: CONFIRMATION_TYPED_MESSAGE,
          confirmation: { typedConfirmation: { type: "connection-name", expected: "Keys", targets: [] } },
        },
      });
      expect(
        await gateRun(packageRequest({ engine, connection: { ...production, name: "" }, sql: "SELECT 1" }), clock),
      ).toEqual({ kind: "answer", status: 400, body: { error: TYPED_NAME_MISSING_REFUSAL } });
    }
  });

  test("a package run is classified under the declared grammar its register row reviewed: a read runs, a write asks, a production connection asks its name", async () => {
    for (const sql of ["SELECT 1", "-- a note\nSELECT id FROM t"]) {
      expect(await gateRun(packageRequest({ sql }), clock)).toEqual({ kind: "run", unconfirmed: false });
    }
    // A write, a write in a later statement of the split, and text the declared grammar cannot close each ask.
    for (const [sql, unreadable] of [
      ["DELETE FROM t", false],
      ["SELECT 1; DROP TABLE x", false],
      ["SELECT 'never closed", true],
    ] as const) {
      const asked = await gateRun(packageRequest({ sql }), clock);
      expect(asked).toMatchObject({
        kind: "answer",
        status: 428,
        body: {
          error: CONFIRMATION_REQUIRED_MESSAGE,
          code: ApiErrorCode.CONFIRMATION_REQUIRED,
          confirmation: { unreadable, typedConfirmation: null, classificationFailed: false },
        },
      });
      // The token binds the package's connection by its fields, and runs the request it was issued for once.
      const retry = packageRequest({ sql, confirmation: { token: tokenOf(asked) } });
      expect(await gateRun(retry, clock)).toEqual({ kind: "run", unconfirmed: false });
      expect(await gateRun(retry, clock)).toMatchObject({ kind: "answer", status: 400 });
    }

    const production = { ...kv, environment: "production" } as EngineConnection;
    expect(
      await gateRun(packageRequest({ connection: production, sql: "DELETE FROM t", confirmation: "ask" }), clock),
    ).toMatchObject({
      status: 428,
      body: {
        error: CONFIRMATION_TYPED_MESSAGE,
        confirmation: { typedConfirmation: { type: "connection-name", expected: "Keys", targets: [] } },
      },
    });
    expect(
      await gateRun(packageRequest({ connection: { ...production, name: "" }, sql: "DELETE FROM t" }), clock),
    ).toEqual({ kind: "answer", status: 400, body: { error: TYPED_NAME_MISSING_REFUSAL } });
    // A read still runs on production.
    expect(await gateRun(packageRequest({ connection: production, sql: "SELECT 1" }), clock)).toEqual({
      kind: "run",
      unconfirmed: false,
    });
  });

  test("a package's loosening claims are counted only as its register row grants them for the grammar it reviewed: a granted text-not-SQL claim and exempt form spare, ungranted ones still ask", async () => {
    const form = ["ALTER", "SESSION", "SET"];
    /**
     * The declaration claims its text is not SQL and exempts ALTER SESSION SET, and states the statement language data
     * its row reviews, without which no package row grants text-not-SQL.
     */
    const loose = (declaration: EditableEngine) => {
      withStatementLanguageData(declaration);
      const sqlText = declaration.sqlText as { readsSqlText: boolean; grammar: { confirmExemptForms: string[][] } };
      sqlText.readsSqlText = false;
      sqlText.grammar.confirmExemptForms = [form];
    };
    const both = { readsSqlText: false, confirmExemptForms: [form] };
    const granted = declared(loose, both);
    expect(granted.statementGrammar?.confirmExemptForms).toEqual([form]);
    expect(granted.grants).toMatchObject({ reviewedGrammar: true, readsSqlText: false, confirmExemptForms: [form] });
    // Both claims granted: the form runs, and the text is neither checked for an unreadable run nor split.
    const spared = ["ALTER SESSION SET search_path = x", "SELECT 'never closed", "SELECT 1; DROP TABLE x"];
    for (const sql of [...spared, "SELECT 1"]) {
      expect([sql, await gateRun(packageRequest({ engine: granted, sql }), clock)]).toEqual([
        sql,
        { kind: "run", unconfirmed: false },
      ]);
    }
    expect(await gateRun(packageRequest({ engine: granted, sql: "DELETE FROM t" }), clock)).toMatchObject({
      kind: "answer",
      status: 428,
    });
    // A claim the row does not grant, and a claim only the row lists, is read at its restrictive value.
    for (const engine of [declared(loose), declared(withStatementLanguageData, both)]) {
      for (const sql of [...spared, "DELETE FROM t"]) {
        expect([sql, await gateRun(packageRequest({ engine, sql }), clock)]).toMatchObject([
          sql,
          { kind: "answer", status: 428 },
        ]);
      }
    }
  });

  test("a package's explain claim is read both ways: an analyzed write and a planned write each ask, whatever it declares", async () => {
    // Neither value of `explainExecutesWithAnalyze` asks about every statement the other asks about: true reads the
    // write under EXPLAIN ANALYZE, false reads a plain EXPLAIN's text as it stands. So the gate asks where either asks.
    for (const executes of [false, true]) {
      const engine = declared((declaration) => {
        const sqlText = declaration.sqlText as { grammar: { explainExecutesWithAnalyze: boolean } };
        sqlText.grammar.explainExecutesWithAnalyze = executes;
      });
      for (const sql of [
        "EXPLAIN ANALYZE DELETE FROM t",
        "EXPLAIN (ANALYZE) DELETE FROM t",
        "EXPLAIN UPDATE t SET x = 1",
        "EXPLAIN WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
      ]) {
        expect([executes, sql, await gateRun(packageRequest({ engine, sql }), clock)]).toMatchObject([
          executes,
          sql,
          { kind: "answer", status: 428 },
        ]);
      }
      for (const sql of ["EXPLAIN ANALYZE SELECT 1", "EXPLAIN DELETE FROM t"]) {
        expect([executes, sql, await gateRun(packageRequest({ engine, sql }), clock)]).toEqual([
          executes,
          sql,
          { kind: "run", unconfirmed: false },
        ]);
      }
    }
  });

  test("a package reader that throws asks, marked classificationFailed, and logs the engine, never the statement", async () => {
    const broken = { ...declared().statementGrammar, script: undefined } as unknown as SqlGrammar;
    const engine = { ...declared(), statementGrammar: broken };
    const asked = await gateRun(packageRequest({ engine, sql: "SELECT secret_value" }), clock);
    expect(asked).toMatchObject({ status: 428, body: { confirmation: { classificationFailed: true } } });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls[0])).not.toContain("secret_value");
    expect(error.mock.calls[0]?.[2]).toMatchObject({ route: "api/db/query", type: "acmegate" });
  });
});
/* oxlint-enable no-await-in-loop */

describe("one gate for every engine, reading the record's confirmation reader", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;
  let error: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.LIBREDB_RUN_CONFIRMATION = "required";
    forgetUsedRunConfirmations();
    error = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    error.mockRestore();
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
  });

  /** A connection of `type` named `Gate`, off production. */
  const connectionOf = (type: string) =>
    ({ id: `gate-${type}`, name: "Gate", type, host: "gate.internal", createdAt: new Date(0) }) as EngineConnection;

  /** What the gate does with a verdict, under the required mode and a request that asks. */
  const outcomeOf = (verdict: () => ConfirmationVerdict): string => {
    try {
      const { decision } = verdict();
      return decision === "run" ? "run" : decision === "confirm" ? "428" : "400";
    } catch {
      return "428";
    }
  };

  /** What the gate answered, read the same way. */
  const outcome = (decision: Awaited<ReturnType<typeof gateRun>>): string =>
    decision.kind === "run" ? "run" : String(decision.status);

  test("gateRun reads the record's confirmation reader: a legacy engine's verdict is confirmationVerdict's and a package engine's reads its declared grammar with the claims its record grants", async () => {
    // Its register row reviews the grammar it declares and grants neither loosening claim.
    const loose = packageEngine(
      "acmegate",
      (engine) => {
        const sqlText = engine.sqlText as { readsSqlText: boolean; grammar: { confirmExemptForms: string[][] } };
        sqlText.readsSqlText = false;
        sqlText.grammar.confirmExemptForms = [["ALTER", "SESSION", "SET"]];
      },
      {},
    );
    const run = (engine: EngineRecord, sql: string) =>
      gateRun(request({ connection: connectionOf(engine.id), engine, sql, confirmation: "ask" }), clock).then(outcome);

    // Studio's statement vocabulary rows read a legacy engine's statements by its id.
    expect(await run(servedEngineRecord("redis"), "FLUSHALL")).toBe("428");
    expect(await run(servedEngineRecord("snowflake"), "ALTER SESSION SET QUERY_TAG = 'x'")).toBe("run");
    // A package's engine is read under the grammar its declaration states, and neither ungranted claim is counted.
    expect(await run(loose, "ALTER SESSION SET QUERY_TAG = 'x'")).toBe("428");
    expect(await run(loose, "SELECT 1")).toBe("run");
    expect(await run(loose, "FLUSHALL")).toBe("run");

    // Every statement of the table, on every record, answers what that record's reader answers.
    const statements = [
      "SELECT 1",
      "DELETE FROM t",
      "SELECT 1; DROP TABLE x",
      "SELECT 'never closed",
      "FLUSHALL",
      "ALTER SESSION SET QUERY_TAG = 'x'",
    ];
    const legacy = ["postgres", "redis", "snowflake"].map((type) => servedEngineRecord(type));
    for (const engine of [...legacy, loose, packageEngine("acmeplain")]) {
      for (const sql of statements) {
        const { name, environment } = connectionOf(engine.id);
        const expected = engine.offers.statementVocabulary
          ? outcomeOf(() => confirmationVerdict(sql, engine.id as DatabaseConnection["type"], name, environment))
          : outcomeOf(() => packageConfirmationVerdict(sql, engine.statementGrammar, engine.grants, name, environment));
        // oxlint-disable-next-line no-await-in-loop -- each gate call runs after the one before.
        expect([engine.id, sql, await run(engine, sql)]).toEqual([engine.id, sql, expected]);
      }
    }
    expect(error).not.toHaveBeenCalled();
  });

  test("a record that offers a legacy provider and not Studio's statement vocabulary is read under its declared grammar, never by its id", async () => {
    // Its register row reviews the grammar it declares.
    const crafted = packageEngine("acmegate", undefined, {});
    const declared = { ...crafted, offers: { ...crafted.offers, legacyProvider: true, statementVocabulary: false } };
    const run = (sql: string) =>
      gateRun(
        request({ connection: connectionOf("acmegate"), engine: declared, sql, confirmation: "ask" }),
        clock,
      ).then(outcome);

    // The declared grammar reads FLUSHALL as a read and DELETE as a write; a gate that read the id "acmegate" through
    // Studio's statement vocabulary rows instead would ask about FLUSHALL.
    expect(await run("FLUSHALL")).toBe("run");
    expect(await run("DELETE FROM t")).toBe("428");
    expect(error).not.toHaveBeenCalled();
  });

  test("a record that offers Studio's statement vocabulary and no legacy provider is a host defect, raised rather than read as a classification failure", async () => {
    const crafted = {
      ...packageEngine("acmegate"),
      offers: { ...packageEngine("acmegate").offers, statementVocabulary: true },
    };
    await expect(
      gateRun(request({ connection: connectionOf("acmegate"), engine: crafted, sql: "SELECT 1" }), clock),
    ).rejects.toThrow('The engine "acmegate" offers no legacy provider');
    expect(error).not.toHaveBeenCalled();
  });
});
