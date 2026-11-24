/**
 * A package reads its environment only through `ctx.env.get`, which answers a name `runtime.env` declares and refuses
 * any other by name, without reading it (docs/providers/CONTRACT.md, clause M-22).
 *
 * The host passes the function that reads the process environment; the SDK never reads `process` itself (M-19). Each
 * case reads through a spy over a map of generated values, so it shows which names were read and which never were.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { envReader, UndeclaredEnvironmentError } from "@libredb/provider-sdk/calls";

/** A reader over `values` that records every name it is asked for. */
function spyReader(values: Readonly<Record<string, string>>) {
  const reads: string[] = [];
  const read = (name: string): string | undefined => {
    reads.push(name);
    return Object.hasOwn(values, name) ? values[name] : undefined;
  };
  return { read, reads };
}

const DECLARED = [{ name: "ORACLE_CLIENT_LIB_DIR", purpose: "Where the Oracle client library is installed." }];

describe("ctx.env", () => {
  test("a declared name is read through the host's reader", () => {
    const value = randomUUID();
    const withValue = spyReader({ ORACLE_CLIENT_LIB_DIR: value });
    const withoutValue = spyReader({});

    expect(envReader(DECLARED, withValue.read).get("ORACLE_CLIENT_LIB_DIR")).toBe(value);
    expect(envReader(DECLARED, withoutValue.read).get("ORACLE_CLIENT_LIB_DIR")).toBeUndefined();
    expect(withValue.reads).toEqual(["ORACLE_CLIENT_LIB_DIR"]);
    expect(withoutValue.reads).toEqual(["ORACLE_CLIENT_LIB_DIR"]);
  });

  test("an undeclared name is refused by name and never read", () => {
    const spy = spyReader({ JWT_SECRET: randomUUID() });
    const env = envReader(DECLARED, spy.read);

    expect(() => env.get("JWT_SECRET")).toThrow(UndeclaredEnvironmentError);
    expect(() => env.get("JWT_SECRET")).toThrow(/"JWT_SECRET".*runtime\.env/);
    expect(spy.reads).toEqual([]);
  });

  test("a package that declares no environment reads none", () => {
    const spy = spyReader({ ORACLE_CLIENT_LIB_DIR: randomUUID(), PATH: randomUUID() });
    const env = envReader(undefined, spy.read);

    for (const name of ["ORACLE_CLIENT_LIB_DIR", "PATH", ""])
      expect(() => env.get(name)).toThrow(UndeclaredEnvironmentError);
    expect(spy.reads).toEqual([]);
  });

  test("an UndeclaredEnvironmentError is an Error with its own name", () => {
    let thrown: unknown;
    try {
      envReader(DECLARED, () => undefined).get("HOME");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toBeInstanceOf(UndeclaredEnvironmentError);
    const error = thrown as UndeclaredEnvironmentError;
    expect(error.name).toBe("UndeclaredEnvironmentError");
    expect(error.variable).toBe("HOME");
    expect(error.message).toBe(
      'The provider asked for the environment variable "HOME", which its manifest does not declare in runtime.env, so it was not read.',
    );
  });

  test("the reader keeps its own copy of the declared names", () => {
    const declared = [{ name: "ORACLE_CLIENT_LIB_DIR", purpose: "Where the Oracle client library is installed." }];
    const env = envReader(declared, () => "read");
    declared[0] = { name: "JWT_SECRET", purpose: "Changed after the reader was built." };

    expect(env.get("ORACLE_CLIENT_LIB_DIR")).toBe("read");
    expect(() => env.get("JWT_SECRET")).toThrow(UndeclaredEnvironmentError);
    expect(Object.isFrozen(env)).toBe(true);
  });
});
