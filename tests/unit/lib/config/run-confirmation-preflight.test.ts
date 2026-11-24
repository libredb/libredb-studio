import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { verifyRunConfirmationAtBoot } from "@/lib/config/run-confirmation-preflight";

/**
 * A LIBREDB_RUN_CONFIRMATION value Studio cannot read would otherwise surface only at the first run, as a refusal of
 * every run, so a standalone server refuses to boot on it, naming the variable, the value it got and the values it
 * accepts.
 */
describe("config/run-confirmation-preflight verifyRunConfirmationAtBoot", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;

  afterEach(() => {
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
  });

  /** Run the check with process.exit and console.error stubbed; returns what it did. */
  function run(value: string | undefined): { result: boolean; exitCalls: Array<number | undefined>; banner: string } {
    if (value === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = value;
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = verifyRunConfirmationAtBoot();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      return { result, exitCalls, banner: errorSpy.mock.calls.flat().join("\n") };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
    }
  }

  test.each([undefined, "", "advisory", "required", "'Required'"])("a valid value boots (%p)", (value) => {
    const { result, exitCalls, banner } = run(value);
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(banner).toBe("");
  });

  test("an invalid value prints the banner and exits 1", () => {
    const { result, exitCalls, banner } = run("strict");
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("LIBREDB_RUN_CONFIRMATION is invalid");
    expect(banner).toContain('Got "strict"');
    expect(banner).toContain("advisory");
    expect(banner).toContain("required");
  });

  test("quotes the value through JSON.stringify, so a newline in it cannot write a line of its own", () => {
    const value = 'strict"\n LibreDB Studio is ready';
    const { exitCalls, banner } = run(value);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain(`Got ${JSON.stringify(value)};`);
    expect(banner).not.toContain("\n LibreDB Studio is ready");
  });
});
