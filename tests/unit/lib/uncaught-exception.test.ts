/**
 * The uncaught-exception exit (src/lib/uncaught-exception.ts): an exception that no code catches makes the server log
 * one redacted line and exit with code 70, so whatever started it starts a fresh process
 * (docs/DISTRIBUTION.md#uncaught-errors-and-restarts).
 *
 * Every install here goes to a stand-in process from tests/helpers/uncaught-exception-stand-in.ts, whose exit only
 * records the code, so no listener that calls the real `process.exit` is ever attached to this test process. The
 * installation is remembered per process in a global, so each test forgets it afterwards, as a new process would.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  installUncaughtExceptionExit,
  resetUncaughtExceptionExit,
  UNCAUGHT_EXCEPTION_EXIT_CODE,
  uncaughtExceptionLine,
} from "@/lib/uncaught-exception";
import { standInProcess } from "../../helpers/uncaught-exception-stand-in";

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

  test("keeps no stack frame and no line break", () => {
    const printed = captureConsoleError();
    const proc = standInProcess();
    installUncaughtExceptionExit(proc);

    proc.registrations[0]?.listener(new Error("first\nsecond"));

    expect(printed()).toHaveLength(1);
    expect(printed()[0]).toEndWith(
      " {route=uncaught-exception} Uncaught exception, exiting with code 70: Error: first second",
    );
    expect(printed()[0]).not.toContain("\n");
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

      proc.registrations[0]?.listener(error);

      expect(printed()).toHaveLength(1);
      expect(printed()[0]).toContain(`{route=uncaught-exception} ${uncaughtExceptionLine(error)}`);
      expect(printed()[0]).not.toContain("\n    at ");
      expect(printed()[0]).not.toContain("s3cret");
      expect(proc.exits).toEqual([70]);
    } finally {
      setNodeEnv(savedNodeEnv);
    }
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
