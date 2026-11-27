/**
 * How a route answers a failure of a provider package's call (docs/providers/CONTRACT.md, clause C-112,
 * `packageFailureAnswer` in src/lib/api/package-errors.ts): a legacy record's failure and Studio's own failure, a
 * `DatabaseError` or a refusal the host core raises about Studio's own request, are answered as raised; a refusal of
 * what the package answered is the package's defect, answered and logged under `PACKAGE_DEFECT_PREFIX` on both grants,
 * its log line naming each pointer and the closes that failed, and its answer each pointer only where a row grants the
 * package's words;
 * any other value is the package's own error, logged once through core's scrub on both grants and answered by its
 * record's grant: an open's as a not-sent `ConnectionError`, an execute's and a tree read's as Studio's sentence naming
 * its code or as raised. A package's warnings reach the client only as Studio's sentence naming their count. The refused records are
 * built by hand and read by the real accessor (`refusalError`).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type CallRefusal, callRefusalSentence } from "@libredb/provider-sdk/calls";
import { createErrorResponse } from "@/lib/api/errors";
import {
  isPackageFailure,
  PACKAGE_DEFECT_PREFIX,
  packageFailureAnswer,
  packageWarnings,
} from "@/lib/api/package-errors";
import { ConnectionError, StudioOffsetRefusal } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import { PROVIDER_TEXT_WITHHELD } from "@/lib/db/operations/provider-text";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX, HostDefectError, refusalError } from "@/lib/provider-host/access";
import type { DatabaseConnection } from "@/lib/types";
import { parseResponseJSON } from "../../../helpers/mock-next";

const ROUTE = "api/db/query";
const secret = randomUUID();
const scrub = providerTextScrub(
  { id: "conn-1", name: "Keys", type: "postgres", host: "kv.local", password: secret } as DatabaseConnection,
  "any",
);

/** An engine record holding only what `packageFailureAnswer` reads: whether it offers a legacy provider, and its grant. */
function engineOf(legacyProvider: boolean, ownWords: "scrubbed" | "code-only"): EngineRecord {
  return { id: randomUUID(), offers: { legacyProvider }, grants: { ownWords } } as unknown as EngineRecord;
}
const LEGACY = engineOf(true, "scrubbed");
const CODE_ONLY = engineOf(false, "code-only");
const GRANTED = engineOf(false, "scrubbed");

/** The message a code-only engine's client gets for a package's defect: the rules it broke, and no pointer. */
function codeOnlyDefectSentence(...rules: string[]): string {
  return `${PACKAGE_DEFECT_PREFIX} it broke the ${rules.length === 1 ? "rule" : "rules"} ${rules.join(", ")}; the server's log names where.`;
}

/**
 * The error the accessor builds for a call the host refused with `refusals`, after the package was called, with the
 * errors of the closes that failed when given.
 */
function refused(refusals: CallRefusal[], closeFailures?: unknown[]): HostDefectError {
  const error = refusalError(
    { kind: "refused", called: true, refusals, ...(closeFailures === undefined ? {} : { closeFailures }) },
    { caller: new AbortController().signal, deadlineSentence: "The query ran past its timeout." },
  );
  if (!(error instanceof HostDefectError)) throw new Error(`expected a host defect, got ${error.name}`);
  return error;
}

let spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

/** The messages `logger.error` was called with while `run` ran. */
function errorLines(run: () => void): string[] {
  const error = spyOn(logger, "error").mockImplementation(() => undefined);
  try {
    run();
    return error.mock.calls.map(([message]) => String(message));
  } finally {
    error.mockRestore();
  }
}

describe("packageFailureAnswer", () => {
  test("packageFailureAnswer answers a legacy record's failure as raised, a Studio failure as itself, a package's host defect as its defect on both grants, and a package's open failure as a not-sent connection error by grant", () => {
    // A legacy record's failure is Studio's own provider's: as raised, nothing logged here.
    const legacyFailure = new Error(`legacy ${randomUUID()}`);
    const studioRefusal = new StudioOffsetRefusal(randomUUID());
    const studioDefect = refused([{ rule: "request-scope-not-offered", pointer: "/scope" }]);
    for (const call of ["open", "execute"] as const) {
      let answers: unknown[] = [];
      const lines = errorLines(() => {
        answers = [
          packageFailureAnswer(LEGACY, call, legacyFailure, scrub, ROUTE),
          ...[CODE_ONLY, GRANTED].flatMap((engine) => [
            packageFailureAnswer(engine, call, studioRefusal, scrub, ROUTE),
            packageFailureAnswer(engine, call, studioDefect, scrub, ROUTE),
          ]),
        ];
      });
      expect(answers).toEqual([legacyFailure, studioRefusal, studioDefect, studioRefusal, studioDefect]);
      expect(answers[2]).toBe(studioDefect);
      expect(lines).toEqual([]);
    }

    // A refusal of what the package answered is its defect on both grants, answered and logged in Studio's words: the
    // pointer, which may hold a key the package chose, reaches the client only where a row grants the package's words.
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const malformed = refused([{ rule: "execute-answer-unreadable", pointer: `/warnings/0/${key}`, name: key }]);
    const sentence = `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(malformed.refusals[0] as CallRefusal)}`;
    for (const [engine, client] of [
      [CODE_ONLY, codeOnlyDefectSentence("execute-answer-unreadable")],
      [GRANTED, sentence],
    ] as const) {
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      const answered = packageFailureAnswer(engine, "execute", malformed, scrub, ROUTE);
      expect(answered).not.toBeInstanceOf(HostDefectError);
      expect((answered as Error).message).toBe(client);
      expect(error.mock.calls.map(([message, logged]) => [message, (logged as Error).message])).toEqual([
        ["A provider package's execute failed", sentence],
      ]);
      error.mockRestore();
    }

    // The same defect of an open sent no statement: a not-sent connection error in the same words, on both grants.
    const widened = refused([{ rule: "refinement-widens", pointer: "/calls/console/cancel" }]);
    const widenedSentence = `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(widened.refusals[0] as CallRefusal)}`;
    for (const [engine, client] of [
      [CODE_ONLY, codeOnlyDefectSentence("refinement-widens")],
      [GRANTED, widenedSentence],
    ] as const) {
      let answered: unknown;
      let logged: unknown[][] = [];
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        answered = packageFailureAnswer(engine, "open", widened, scrub, ROUTE);
        logged = error.mock.calls.map(([message, value]) => [message, (value as Error).message]);
      } finally {
        error.mockRestore();
      }
      expect(answered).toBeInstanceOf(ConnectionError);
      expect([(answered as Error).message, errorOutcome(answered)]).toEqual([client, "not-sent"]);
      expect(logged).toEqual([["A provider package's open failed", widenedSentence]]);
    }

    // A package's own open failure: not-sent, Studio's sentence where no row grants its words, its words through the
    // scrub where one does, a credential withheld on both, logged once on both.
    const words = `refused ${randomUUID()}`;
    for (const [engine, thrown, message] of [
      [
        CODE_ONLY,
        new Error(words),
        "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words.",
      ],
      [GRANTED, new Error(words), words],
      [GRANTED, new Error(`${words} as ${secret}`), PROVIDER_TEXT_WITHHELD],
      [GRANTED, words, "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words."],
    ] as const) {
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      const answered = packageFailureAnswer(engine, "open", thrown, scrub, ROUTE);
      expect(answered).toBeInstanceOf(ConnectionError);
      expect([(answered as Error).message, errorOutcome(answered)]).toEqual([message, "not-sent"]);
      expect(error.mock.calls.map(([line]) => line)).toEqual(["A provider package's open failed"]);
      expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      error.mockRestore();
    }

    // A package's own execute failure: Studio's sentence where no row grants its words, as raised where one does.
    const thrown = new Error(words);
    for (const [engine, expected] of [
      [CODE_ONLY, "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words."],
      [GRANTED, words],
    ] as const) {
      let answered: unknown;
      const lines = errorLines(() => {
        answered = packageFailureAnswer(engine, "execute", thrown, scrub, ROUTE);
      });
      expect((answered as Error).message).toBe(expected);
      expect(errorOutcome(answered)).toBe("unknown");
      expect(lines).toEqual(["A provider package's execute failed"]);
    }
  });

  test("a code-only package's defect names each rule it broke once, and the close failures of a refused answer go to its one log line only, through core's scrub", () => {
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const closeWords = `close failed ${randomUUID()}`;
    const malformed = refused(
      [
        { rule: "execute-answer-unreadable", pointer: "/executionTimeMs" },
        { rule: "execute-answer-unreadable", pointer: `/warnings/0/${key}`, name: key },
        { rule: "batch-malformed", pointer: "/rows" },
      ],
      [new Error(closeWords), new Error(`as ${secret} said`), "a thrown text"],
    );
    const sentences = malformed.refusals.map((refusal) => callRefusalSentence(refusal)).join(" ");
    const logged = `${PACKAGE_DEFECT_PREFIX} ${sentences} Closing the result sources it handed over failed too: ${closeWords}; ${PROVIDER_TEXT_WITHHELD}; a thrown text.`;
    for (const [engine, client] of [
      [CODE_ONLY, codeOnlyDefectSentence("execute-answer-unreadable", "batch-malformed")],
      [GRANTED, `${PACKAGE_DEFECT_PREFIX} ${sentences}`],
    ] as const) {
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const answered = packageFailureAnswer(engine, "execute", malformed, scrub, ROUTE);
        expect((answered as Error).message).toBe(client);
        expect(error.mock.calls.map(([message, value]) => [message, (value as Error).message])).toEqual([
          ["A provider package's execute failed", logged],
        ]);
        expect(JSON.stringify(error.mock.calls.map(([, value]) => String(value)))).not.toContain(secret);
      } finally {
        error.mockRestore();
      }
    }
  });

  test("a tree answer the core refused is the package's defect on both grants, and a package's tree error is answered by its grant", () => {
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const malformed = refused([{ rule: "tree-answer-unreadable", pointer: `/objects/0/${key}`, name: key }]);
    const sentence = `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(malformed.refusals[0] as CallRefusal)}`;

    // A tree read sends no statement that changes anything, and may still have run: answered as an execute's is.
    for (const [engine, client] of [
      [CODE_ONLY, codeOnlyDefectSentence("tree-answer-unreadable")],
      [GRANTED, sentence],
    ] as const) {
      let answered: unknown;
      let logged: unknown[][] = [];
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        answered = packageFailureAnswer(engine, "tree read", malformed, scrub, ROUTE);
        logged = error.mock.calls.map(([message, value]) => [message, (value as Error).message]);
      } finally {
        error.mockRestore();
      }
      expect(answered).not.toBeInstanceOf(HostDefectError);
      expect(answered).not.toBeInstanceOf(ConnectionError);
      expect([(answered as Error).message, errorOutcome(answered)]).toEqual([client, "unknown"]);
      expect(logged).toEqual([["A provider package's tree read failed", sentence]]);
    }

    // A package's own tree error: Studio's sentence where no row grants its words, as raised where one does, logged
    // once through core's scrub on both.
    const thrown = new Error(`refused as ${secret}`);
    for (const [engine, expected] of [
      [CODE_ONLY, "The provider package's tree read failed (INTERNAL_ERROR); the server's log holds its words."],
      [GRANTED, thrown.message],
    ] as const) {
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        const answered = packageFailureAnswer(engine, "tree read", thrown, scrub, ROUTE);
        expect((answered as Error).message).toBe(expected);
        expect(errorOutcome(answered)).toBe("unknown");
        expect(error.mock.calls.map(([line]) => line)).toEqual(["A provider package's tree read failed"]);
        expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
      } finally {
        error.mockRestore();
      }
    }

    // A legacy record's refused tree answer is Studio's own provider's: as raised, nothing logged here.
    expect(
      errorLines(() => expect(packageFailureAnswer(LEGACY, "tree read", malformed, scrub, ROUTE)).toBe(malformed)),
    ).toEqual([]);
  });

  test("a granted package's refused member name reaches its client and the log only through core's scrub, on an execute and a tree read", () => {
    // A password holding a slash and a tilde, which a JSON Pointer writes as ~1 and ~0, so it is found as written there too.
    const slashed = `${randomUUID()}/~${randomUUID()}`;
    const slashedScrub = providerTextScrub(
      { id: "conn-2", name: "Keys", type: "postgres", host: "kv.local", password: slashed } as DatabaseConnection,
      "any",
    );
    const escaped = slashed.replaceAll("~", "~0").replaceAll("/", "~1");
    const clean: CallRefusal = { rule: "tree-answer-unreadable", pointer: "/objects/0/name" };
    for (const [call, refusals, connectionScrub, password] of [
      [
        "execute",
        [{ rule: "execute-answer-unreadable", pointer: `/warnings/0/${secret}`, name: secret }],
        scrub,
        secret,
      ],
      ["tree read", [{ rule: "tree-answer-unreadable", pointer: `/objects/0/${secret}`, name: secret }], scrub, secret],
      [
        "tree read",
        [clean, { rule: "tree-answer-unreadable", pointer: `/counts/${escaped}/count` }],
        slashedScrub,
        slashed,
      ],
    ] as const) {
      const malformed = refused([...refusals]);
      const expected = `${PACKAGE_DEFECT_PREFIX} ${refusals.length === 2 ? `${callRefusalSentence(clean)} ` : ""}${PROVIDER_TEXT_WITHHELD}`;
      let answered: unknown;
      let logged: unknown[][] = [];
      const error = spyOn(logger, "error").mockImplementation(() => undefined);
      try {
        answered = packageFailureAnswer(GRANTED, call, malformed, connectionScrub, ROUTE);
        logged = error.mock.calls.map(([message, value]) => [message, (value as Error).message]);
      } finally {
        error.mockRestore();
      }
      expect((answered as Error).message).toBe(expected);
      expect(logged).toEqual([[`A provider package's ${call} failed`, expected]]);
      expect(JSON.stringify([(answered as Error).message, logged])).not.toContain(password.slice(0, 36));
    }
  });

  test("isPackageFailure holds exactly for the failures packageFailureAnswer answers and logs as the package's", () => {
    const defect = refused([{ rule: "batch-malformed", pointer: "/rows" }]);
    const studioDefect = refused([{ rule: "request-scope-not-offered", pointer: "/scope" }]);
    const own = new Error(randomUUID());
    expect([
      isPackageFailure(LEGACY, own),
      isPackageFailure(CODE_ONLY, new StudioOffsetRefusal(randomUUID())),
      isPackageFailure(GRANTED, studioDefect),
      isPackageFailure(CODE_ONLY, defect),
      isPackageFailure(GRANTED, own),
      isPackageFailure(CODE_ONLY, "a thrown text"),
    ]).toEqual([false, false, false, true, true, true]);
  });

  test("a host defect Studio raised while serving a package call answers and logs as Studio's own internal error", async () => {
    // A scope sent to a session that offers no console.endScope is a request only Studio builds.
    const defect = refused([{ rule: "request-scope-not-offered", pointer: "/scope" }]);
    expect(defect.message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);

    // The route answers it as any error of Studio's own: its sentence, code INTERNAL_ERROR, and its own log line.
    let response: Response | undefined;
    const lines = errorLines(() => {
      response = createErrorResponse(packageFailureAnswer(CODE_ONLY, "execute", defect, scrub, ROUTE), {
        route: ROUTE,
        scrub,
      });
    });
    const body = await parseResponseJSON<Record<string, unknown>>(response as Response);
    expect([response?.status, body.code, body.error]).toEqual([500, "INTERNAL_ERROR", defect.message]);
    expect(lines).toEqual(["Unhandled error"]);
  });

  test("the log line of a refusal of what the package answered names the package as its author, never Studio", () => {
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const malformed = refused([{ rule: "batch-malformed", pointer: `/${key}` }]);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    spies.push(error);

    packageFailureAnswer(CODE_ONLY, "execute", malformed, scrub, ROUTE);

    expect(error.mock.calls.length).toBe(1);
    const logged = error.mock.calls[0]?.[1] as Error;
    expect(logged.message).toBe(
      `${PACKAGE_DEFECT_PREFIX} ${callRefusalSentence(malformed.refusals[0] as CallRefusal)}`,
    );
    expect(logged.message).not.toContain("defect of Studio");
    expect(error.mock.calls[0]?.[2]).toEqual({ route: ROUTE });
  });

  test("a value the package rejects with is the package's failure, whatever its message says", () => {
    const posing = new Error(`${HOST_DEFECT_PREFIX} the package wrote this`);

    let answered: unknown;
    const lines = errorLines(() => {
      answered = packageFailureAnswer(CODE_ONLY, "execute", posing, scrub, ROUTE);
    });
    expect(answered).not.toBe(posing);
    expect((answered as Error).message).not.toContain("the package wrote this");
    expect(lines).toEqual(["A provider package's execute failed"]);
  });
});

describe("packageWarnings", () => {
  test("answers nothing for no warning, and Studio's sentence naming the count for one, logged once", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    spies.push(warn);
    expect(packageWarnings("execute", [], scrub, ROUTE)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();

    const words = `words the package wrote ${randomUUID()}`;
    expect(packageWarnings("execute", [{ message: words, code: 7 }], scrub, ROUTE)).toEqual([
      { message: "The provider package returned 1 warning; the server's log holds their words." },
    ]);
    expect(warn.mock.calls).toEqual([
      ["A provider package's execute returned a warning", { route: ROUTE, warning: { message: words, code: 7 } }],
    ]);
  });
});
