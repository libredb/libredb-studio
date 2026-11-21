import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { verifyEgressDecisionAtBoot } from "@/lib/config/egress-preflight";
import { egressSetting } from "@/lib/db/egress-decision";
import { logger } from "@/lib/logger";
import { setEgressFlag } from "../../../helpers/egress-flag";

/**
 * DB_HTTP_BLOCK_PRIVATE_HOSTS decides whether a database connection may reach a private destination. A value Studio
 * cannot read would otherwise surface only at the first guarded connection, so a standalone server refuses to boot
 * on it, naming the variable, the value it got and the spellings it accepts.
 */
describe("config/egress-preflight verifyEgressDecisionAtBoot", () => {
  const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  let info: ReturnType<typeof spyOn>;

  beforeEach(() => {
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    setEgressFlag(original);
  });

  /** Run the check with process.exit and console.error stubbed; returns what it did. */
  function run(): { result: boolean; exitCalls: Array<number | undefined>; banner: string; printed: number } {
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = verifyEgressDecisionAtBoot();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      return {
        result,
        exitCalls,
        banner: errorSpy.mock.calls.flat().join("\n"),
        printed: errorSpy.mock.calls.length,
      };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
    }
  }

  test("lets an unset variable through and takes the documented default", () => {
    setEgressFlag(undefined);
    const { result, exitCalls, banner } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(banner).toBe("");
    expect(egressSetting()).toEqual({ blocksPrivateHosts: false, source: "default" });
    expect(info).toHaveBeenCalledTimes(1);
  });

  test.each(["true", "on", "1", "false", "off", "0"])("accepts %p", (value) => {
    setEgressFlag(value);
    const { result, exitCalls, banner } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(banner).toBe("");
    expect(egressSetting()).toMatchObject({ source: "set" });
  });

  test("refuses yes with one banner naming the variable, the value it got and the accepted spellings, then exits 1", () => {
    setEgressFlag("yes");
    const { result, exitCalls, banner, printed } = run();
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(printed).toBe(1);
    expect(banner).toContain("DB_HTTP_BLOCK_PRIVATE_HOSTS is invalid");
    expect(banner).toContain('Got "yes"');
    expect(banner).toContain("true, on or 1");
    expect(banner).toContain("false, off, 0 or unset");
  });

  test("quotes the value through JSON.stringify, so a newline or a quote in it cannot write a line of its own", () => {
    const value = 'yes"\n LibreDB Studio is ready';
    setEgressFlag(value);
    const { exitCalls, banner } = run();
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain(`Got ${JSON.stringify(value)};`);
    expect(banner).not.toContain("\n LibreDB Studio is ready");
    expect(banner.split("\n")).toHaveLength(8);
  });

  test("a refused boot reports no decision", () => {
    setEgressFlag("yes");
    run();
    expect(info).not.toHaveBeenCalled();
  });
});
