/**
 * The uncaught-exception exit (src/lib/uncaught-exception.ts): an exception that no code catches makes the server log
 * one redacted line and exit with code 70, so whatever started it starts a fresh process
 * (docs/DISTRIBUTION.md#uncaught-errors-and-restarts).
 *
 * Every install here goes to a stand-in process from tests/helpers/uncaught-exception-stand-in.ts, whose exit records
 * the code and then throws `StandInExit`, so no listener that calls the real `process.exit` is ever attached to this
 * test process. The
 * installation is remembered per process in a global, so each test forgets it afterwards, as a new process would.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import {
  installUncaughtExceptionExit,
  resetUncaughtExceptionExit,
  UNCAUGHT_EXCEPTION_EXIT_CODE,
  uncaughtExceptionLine,
} from "@/lib/uncaught-exception";
import { StandInExit, type StandInProcess, standInProcess } from "../../helpers/uncaught-exception-stand-in";
import { valueImportClosure } from "../../helpers/value-import-closure";

let spies: ReturnType<typeof spyOn>[] = [];

afterEach(() => {
  resetUncaughtExceptionExit();
  for (const spy of spies) spy.mockRestore();
  spies = [];
});

/** Sets NODE_ENV, or removes it for `undefined`; the env typings declare it read-only. */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>;
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

/** Silences console.error and returns what each call printed, joined as the console would. */
function captureConsoleError(): () => string[] {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  spies.push(spy);
  return () => spy.mock.calls.map((call) => call.map(String).join(" "));
}

/**
 * Calls the listener installed on `proc` as Node.js would, and returns the exit it ended with: the stand-in's exit
 * throws, as the real one never returns, so nothing after it runs.
 */
function fire(
  proc: StandInProcess,
  thrown: unknown,
  origin: NodeJS.UncaughtExceptionOrigin = "uncaughtException",
): StandInExit {
  try {
    proc.registrations[0]?.listener(thrown, origin);
  } catch (exit) {
    if (exit instanceof StandInExit) return exit;
    throw exit;
  }
  throw new Error("the listener returned without exiting");
}

describe("UNCAUGHT_EXCEPTION_EXIT_CODE", () => {
  test("is 70, the sysexits EX_SOFTWARE value, which no launcher reads otherwise", () => {
    expect(UNCAUGHT_EXCEPTION_EXIT_CODE).toBe(70);
  });
});

describe("uncaughtExceptionLine()", () => {
  test("names the code, the class and the message", () => {
    expect(uncaughtExceptionLine(new TypeError("boom"))).toBe(
      "Uncaught exception, exiting with code 70: TypeError: boom",
    );
  });

  test("redacts a connection string, a bearer token and a password pair in the message", () => {
    const line = uncaughtExceptionLine(
      new Error(
        "connect failed for postgres://alice:s3cret@db.example:5432/app with Bearer abc.def.ghi password=hunter2",
      ),
    );

    expect(line).toBe(
      "Uncaught exception, exiting with code 70: Error: connect failed for postgres://[REDACTED]@db.example:5432/app with Bearer [REDACTED] password=[REDACTED]",
    );
    expect(line).not.toContain("s3cret");
    expect(line).not.toContain("abc.def.ghi");
    expect(line).not.toContain("hunter2");
  });

  test("prints the class alone for an empty message, as Error.prototype.toString does", () => {
    const error = new RangeError("");

    expect(uncaughtExceptionLine(error)).toBe(`Uncaught exception, exiting with code 70: ${error.toString()}`);
    expect(uncaughtExceptionLine(error)).toBe("Uncaught exception, exiting with code 70: RangeError");
  });

  test.each([
    ["string", "postgres://alice:s3cret@db.example/app", "string: 'postgres://[REDACTED]@db.example/app'"],
    ["undefined", undefined, "undefined: undefined"],
    ["null", null, "object: null"],
    ["number", 42, "number: 42"],
    ["bigint", BigInt(42), "bigint: 42n"],
    ["symbol", Symbol("thrown"), "symbol: Symbol(thrown)"],
    ["plain object", { code: "E_PROBE", token: "abc" }, "object: { code: 'E_PROBE', token: [REDACTED] }"],
    [
      "null-prototype object",
      Object.assign(Object.create(null), { a: 1 }),
      "object: [Object: null prototype] { a: 1 }",
    ],
  ])("describes a thrown %s by its type, without throwing", (_kind, value, shown) => {
    expect(uncaughtExceptionLine(value)).toBe(`Uncaught exception, exiting with code 70: ${shown}`);
  });

  test("treats an Error made in another realm as an Error, so its stack stays out of the line", () => {
    const error = runInNewContext('new TypeError("boom for postgres://alice:s3cret@h/db")');

    expect(error instanceof Error).toBe(false);
    expect(uncaughtExceptionLine(error)).toBe(
      "Uncaught exception, exiting with code 70: TypeError: boom for postgres://[REDACTED]@h/db",
    );
  });

  test("names a string code and an AggregateError's inner errors, as a dual-stack connection refusal carries them", () => {
    const refused = Object.assign(
      new AggregateError([new Error("connect ECONNREFUSED ::1:9"), new Error("connect ECONNREFUSED 127.0.0.1:9")], ""),
      { code: "ECONNREFUSED" },
    );

    expect(uncaughtExceptionLine(refused)).toBe(
      "Uncaught exception, exiting with code 70: AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:9; connect ECONNREFUSED 127.0.0.1:9",
    );
  });

  test("redacts an inner error's message and describes an inner value that is not an Error", () => {
    const aggregate = new AggregateError(
      [new Error("login failed for postgres://alice:s3cret@h/db"), { errno: -111 }],
      "two",
    );

    expect(uncaughtExceptionLine(aggregate)).toBe(
      "Uncaught exception, exiting with code 70: AggregateError: two; login failed for postgres://[REDACTED]@h/db; { errno: -111 }",
    );
  });

  test("converts a name or message that is not a string, so a Symbol name or a Symbol message does not throw", () => {
    const symbolName = Object.assign(new Error("x"), { name: Symbol("weird") });
    const numberMessage = Object.assign(new Error(), { message: 42 });
    const symbolMessage = Object.assign(new Error(), { message: Symbol("m") });
    const symbolInnerMessage = new AggregateError([Object.assign(new Error(), { message: Symbol("inner") })], "outer");

    expect(uncaughtExceptionLine(symbolName)).toBe("Uncaught exception, exiting with code 70: Symbol(weird): x");
    expect(uncaughtExceptionLine(numberMessage)).toBe("Uncaught exception, exiting with code 70: Error: 42");
    expect(uncaughtExceptionLine(symbolMessage)).toBe("Uncaught exception, exiting with code 70: Error: Symbol(m)");
    expect(uncaughtExceptionLine(symbolInnerMessage)).toBe(
      "Uncaught exception, exiting with code 70: AggregateError: outer; Symbol(inner)",
    );
  });

  test("logs the message as it is, an inner stack it quotes included", () => {
    let unhandled: unknown;
    try {
      new EventEmitter().emit("error", { cause: new Error("socket closed") });
    } catch (error) {
      unhandled = error;
    }

    const line = uncaughtExceptionLine(unhandled);

    expect(line).toStartWith(
      "Uncaught exception, exiting with code 70: Error [ERR_UNHANDLED_ERROR]: Unhandled error. ({\n  cause: Error: socket closed\n      at ",
    );
  });

  test("names an unhandled rejection that Node.js raised as an uncaught exception", () => {
    expect(uncaughtExceptionLine(new Error("late"), "unhandledRejection")).toBe(
      "Unhandled rejection raised as an uncaught exception, exiting with code 70: Error: late",
    );
  });

  test("keeps no stack frame and no line break", () => {
    const printed = captureConsoleError();
    const proc = standInProcess();
    installUncaughtExceptionExit(proc);

    fire(proc, new Error("first\nsecond"));

    expect(printed()).toHaveLength(1);
    expect(printed()[0]).toEndWith(
      " {route=uncaught-exception} Uncaught exception, exiting with code 70: Error: first second",
    );
    expect(printed()[0]).not.toContain("\n");
  });
});

describe("the module's imports", () => {
  test("stay few, since register() loads the module before every other boot step", () => {
    const closure = valueImportClosure("src/lib/uncaught-exception.ts");

    expect(closure.modules).toEqual([
      "src/lib/logger.ts",
      "src/lib/mcp/serializer.ts",
      "src/lib/non-finite.ts",
      "src/lib/query-events/queued.ts",
      "src/lib/uncaught-exception.ts",
    ]);
    expect(closure.packages).toEqual(["node:util"]);
    expect(closure.unresolved).toEqual([]);
  });
});

describe("installUncaughtExceptionExit()", () => {
  test("attaches one uncaughtException listener and nothing else", () => {
    const proc = standInProcess();

    installUncaughtExceptionExit(proc);

    expect(proc.registrations.map((registration) => registration.event)).toEqual(["uncaughtException"]);
    expect(proc.exits).toEqual([]);
  });

  test("a second install, on the same process or another, attaches nothing", () => {
    const first = standInProcess();
    const second = standInProcess();

    installUncaughtExceptionExit(first);
    installUncaughtExceptionExit(first);
    installUncaughtExceptionExit(second);

    expect(first.registrations).toHaveLength(1);
    expect(second.registrations).toEqual([]);
  });

  test("the listener logs the line once, with no stack even under NODE_ENV=development, then exits with 70", () => {
    const savedNodeEnv = process.env.NODE_ENV;
    setNodeEnv("development");
    try {
      const printed = captureConsoleError();
      const proc = standInProcess();
      installUncaughtExceptionExit(proc);
      const error = new TypeError("connect failed for postgres://alice:s3cret@db.example:5432/app");

      expect(fire(proc, error).code).toBe(70);

      expect(printed()).toHaveLength(1);
      expect(printed()[0]).toContain(`{route=uncaught-exception} ${uncaughtExceptionLine(error)}`);
      expect(printed()[0]).not.toContain("\n    at ");
      expect(printed()[0]).not.toContain("s3cret");
      expect(proc.exits).toEqual([70]);
    } finally {
      setNodeEnv(savedNodeEnv);
    }
  });

  test("logs the line before it exits, since nothing after the exit runs", () => {
    const proc = standInProcess();
    installUncaughtExceptionExit(proc);
    const printedAtExit: number[] = [];
    const printed = captureConsoleError();
    const exit = proc.exit.bind(proc);
    proc.exit = (code) => {
      printedAtExit.push(printed().length);
      exit(code);
    };

    fire(proc, new TypeError("boom"));

    expect(printedAtExit).toEqual([1]);
  });

  test("logs an unhandled rejection that Node.js raised as an uncaught exception by that origin, then exits with 70", () => {
    const printed = captureConsoleError();
    const proc = standInProcess();
    installUncaughtExceptionExit(proc);

    fire(proc, new Error("late"), "unhandledRejection");

    expect(printed()).toHaveLength(1);
    expect(printed()[0]).toEndWith(
      " {route=uncaught-exception} Unhandled rejection raised as an uncaught exception, exiting with code 70: Error: late",
    );
    expect(proc.exits).toEqual([70]);
  });

  test("still exits with 70 when the line cannot be built, as for a revoked Proxy", () => {
    const printed = captureConsoleError();
    const proc = standInProcess();
    installUncaughtExceptionExit(proc);
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(fire(proc, proxy).code).toBe(70);
    expect(proc.exits).toEqual([70]);
    expect(printed()).toEqual([]);
  });

  test("resetUncaughtExceptionExit() forgets the installation, as a new process would", () => {
    const first = standInProcess();
    const second = standInProcess();

    installUncaughtExceptionExit(first);
    resetUncaughtExceptionExit();
    installUncaughtExceptionExit(second);

    expect(first.registrations).toHaveLength(1);
    expect(second.registrations).toHaveLength(1);
  });
});
