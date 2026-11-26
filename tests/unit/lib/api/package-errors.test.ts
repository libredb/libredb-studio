/**
 * How the query route answers an error of a provider package's call (docs/providers/CONTRACT.md, clause C-112,
 * `packageCallError` in src/lib/api/package-errors.ts): a refusal the host core raises about Studio's own
 * request is Studio's defect, answered and logged as Studio's internal error, while a refusal of what the package
 * answered, and any other value the package rejects with, is the package's failure, answered with Studio's sentence
 * naming its code. A package's warnings reach the client only as Studio's sentence naming their count. The refused
 * records are built by hand and read by the real accessor (`refusalError`).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type CallRefusal, callRefusalSentence } from "@libredb/provider-sdk/calls";
import { createErrorResponse } from "@/lib/api/errors";
import { PACKAGE_DEFECT_PREFIX, packageCallError, packageWarnings } from "@/lib/api/package-errors";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX, HostDefectError, refusalError } from "@/lib/provider-host/access";
import type { DatabaseConnection } from "@/lib/types";
import { parseResponseJSON } from "../../../helpers/mock-next";

const ROUTE = "api/db/query";
const scrub = providerTextScrub(
  { id: "conn-1", name: "Keys", type: "postgres", host: "kv.local", password: randomUUID() } as DatabaseConnection,
  "any",
);

/** The error the accessor builds for a call the host refused with `refusals`, after the package was called. */
function refused(refusals: CallRefusal[]): HostDefectError {
  const error = refusalError(
    { kind: "refused", called: true, refusals },
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
  spies.push(error);
  run();
  return error.mock.calls.map(([message]) => String(message));
}

describe("packageCallError", () => {
  test("a host defect Studio raised while serving a package call answers and logs as Studio's own internal error", async () => {
    // A scope sent to a session that offers no console.endScope is a request only Studio builds.
    const defect = refused([{ rule: "request-scope-not-offered", pointer: "/scope" }]);
    expect(defect.message.startsWith(HOST_DEFECT_PREFIX)).toBe(true);

    for (const call of ["open", "execute"] as const) {
      let answered: unknown;
      const lines = errorLines(() => {
        answered = packageCallError(call, defect, scrub, ROUTE);
      });
      expect(answered).toBe(defect);
      expect(lines).toEqual([]);
    }

    // The route answers it as any error of Studio's own: its sentence, code INTERNAL_ERROR, and its own log line.
    let response: Response | undefined;
    const lines = errorLines(() => {
      response = createErrorResponse(packageCallError("execute", defect, scrub, ROUTE), { route: ROUTE, scrub });
    });
    const body = await parseResponseJSON<Record<string, unknown>>(response as Response);
    expect([response?.status, body.code, body.error]).toEqual([500, "INTERNAL_ERROR", defect.message]);
    expect(lines).toEqual(["Unhandled error"]);
  });

  test("a refusal of what the package answered is the package's failure, answered with Studio's sentence", () => {
    // A batch key the package wrote reaches the pointer of the refusal, so the client never reads it.
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const malformed = refused([{ rule: "batch-malformed", pointer: `/${key}` }]);
    expect(malformed.message).toContain(key);

    let answered: unknown;
    const lines = errorLines(() => {
      answered = packageCallError("execute", malformed, scrub, ROUTE);
    });
    expect((answered as Error).message).toBe(
      "The provider package's execute failed (INTERNAL_ERROR); the server's log holds its words.",
    );
    expect(lines).toEqual(["A provider package's execute failed"]);
  });

  test("the log line of a refusal of what the package answered names the package as its author, never Studio", () => {
    const key = `k${randomUUID().replaceAll("-", "")}`;
    const malformed = refused([{ rule: "batch-malformed", pointer: `/${key}` }]);
    const error = spyOn(logger, "error").mockImplementation(() => undefined);
    spies.push(error);

    packageCallError("execute", malformed, scrub, ROUTE);

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
      answered = packageCallError("execute", posing, scrub, ROUTE);
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

  test("logs a warning outside the contract's members as the package's defect, under the route alone", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    spies.push(warn);
    const words = `words the package wrote ${randomUUID()}`;
    expect(packageWarnings("execute", [{ message: "ok", detail: words }], scrub, ROUTE)).toEqual([
      { message: "The provider package returned 1 warning; the server's log holds their words." },
    ]);
    expect(warn.mock.calls).toEqual([
      [
        "A provider package's execute returned a warning that is not a message with an optional code and severity; this is its defect.",
        { route: ROUTE },
      ],
    ]);
  });

  test("refuses warnings that are not a list as the package's defect, none of them walked", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    spies.push(warn);
    const secret = randomUUID();
    let walked = 0;
    const iterable = {
      length: `pw ${secret}`,
      *[Symbol.iterator]() {
        walked += 1;
        yield { message: secret };
      },
    };
    expect(() => packageWarnings("execute", iterable, scrub, ROUTE)).toThrow(
      "The provider package answered warnings that are not a list; this is its defect.",
    );
    expect(walked).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  test("names the count of the warnings it walked, never the length the package answers", () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    spies.push(warn);
    const secret = randomUUID();
    const proxied = new Proxy([], {
      get: (target, key) => (key === "length" ? `pw ${secret}` : Reflect.get(target, key)),
    });
    expect(packageWarnings("execute", proxied, scrub, ROUTE)).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });
});
