/**
 * How the query route answers an error of a provider package's call (docs/providers/CONTRACT.md, clauses C-112 and
 * C-113, `packageCallError` in src/lib/api/package-errors.ts): a refusal the host core raises about Studio's own
 * request is Studio's defect, answered and logged as Studio's internal error, while a refusal of what the package
 * answered, and any other value the package rejects with, is the package's failure, answered with Studio's sentence
 * naming its code. A package's warnings reach the client only as Studio's sentence naming their count. The refused
 * records are built by hand and read by the real accessor (`refusalError`).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { CallRefusal } from "@libredb/provider-sdk/calls";
import { createErrorResponse } from "@/lib/api/errors";
import { packageCallError, packageWarnings } from "@/lib/api/package-errors";
import { providerTextScrub } from "@/lib/db/operations/provider-text";
import { logger } from "@/lib/logger";
import { HOST_DEFECT_PREFIX, refusalError } from "@/lib/provider-host/access";
import type { DatabaseConnection } from "@/lib/types";
import { parseResponseJSON } from "../../../helpers/mock-next";

const ROUTE = "api/db/query";
const scrub = providerTextScrub(
  { id: "conn-1", name: "Keys", type: "postgres", host: "kv.local", password: randomUUID() } as DatabaseConnection,
  "any",
);

/** The error the accessor builds for a call the host refused with `refusals`, after the package was called. */
function refused(refusals: CallRefusal[]): Error {
  return refusalError(
    { kind: "refused", called: true, refusals },
    { caller: new AbortController().signal, deadlineSentence: "The query ran past its timeout." },
  );
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
});
