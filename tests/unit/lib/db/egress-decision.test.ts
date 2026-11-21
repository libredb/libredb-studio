import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { egressDecision, egressSetting, forgetEgressDecision, INVALID_EGRESS_SETTING } from "@/lib/db/egress-decision";
import { DatabaseConfigError } from "@/lib/db/errors";
import { logger } from "@/lib/logger";
import { setEgressFlag } from "../../../helpers/egress-flag";

/**
 * DB_HTTP_BLOCK_PRIVATE_HOSTS decides whether a database connection may reach loopback, private and the other
 * non-public destinations. Core reads it once per process and keeps the outcome, so the decision logged is the one
 * every guard keeps; a later write of the variable moves nothing until the process restarts.
 */
describe("the egress decision, taken once per process (FND-2 slice 2a)", () => {
  const original = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS;
  const slot = Symbol.for("libredb-studio.egress-decision");
  let info: ReturnType<typeof spyOn>;

  beforeEach(() => {
    forgetEgressDecision();
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    setEgressFlag(original);
  });

  test.each(["true", "TRUE", " on ", "1"])("%p blocks private destinations, as the operator set it", (value) => {
    setEgressFlag(value);
    expect(egressDecision()).toEqual({ blocksPrivateHosts: true, source: "set" });
  });

  test.each(["false", "Off", "0"])("%p keeps them reachable, as the operator set it", (value) => {
    setEgressFlag(value);
    expect(egressDecision()).toEqual({ blocksPrivateHosts: false, source: "set" });
  });

  test.each([undefined, "", "   "])("%p keeps them reachable, the documented default", (value) => {
    setEgressFlag(value);
    expect(egressDecision()).toEqual({ blocksPrivateHosts: false, source: "default" });
  });

  test.each(["yes", "no", "2", "tru", '"true"'])(
    "%p is refused by name, and the setting answers the value it got",
    (value) => {
      setEgressFlag(value);
      expect(egressSetting()).toEqual({ invalid: value });
      expect(() => egressDecision()).toThrow(new DatabaseConfigError(INVALID_EGRESS_SETTING));
      expect(() => egressDecision()).toThrow(DatabaseConfigError);
    },
  );

  test("the first read decides for the life of the process, and the outcome lives on globalThis", () => {
    setEgressFlag(undefined);
    expect(egressDecision()).toEqual({ blocksPrivateHosts: false, source: "default" });
    // A direct write, not the helper: the point is that a write after the first read moves nothing.
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
    expect(egressDecision()).toEqual({ blocksPrivateHosts: false, source: "default" });
    expect((globalThis as Record<symbol, unknown>)[slot]).toEqual({ blocksPrivateHosts: false, source: "default" });
  });

  test("a refused setting stays refused, and a valid value written later does not rescue it", () => {
    setEgressFlag("yes");
    expect(() => egressDecision()).toThrow(INVALID_EGRESS_SETTING);
    // A direct write, not the helper: the refusal is kept as a decision is.
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "true";
    expect(() => egressDecision()).toThrow(INVALID_EGRESS_SETTING);
    expect(egressSetting()).toEqual({ invalid: "yes" });
    expect(info).not.toHaveBeenCalled();
  });

  test("the decision is reported once, naming the variable, the decision and whether it is the documented default", () => {
    setEgressFlag(undefined);
    egressDecision();
    egressSetting();
    egressDecision();
    expect(info.mock.calls).toEqual([
      [
        "Private database destinations are reachable",
        {
          route: "egress-decision",
          variable: "DB_HTTP_BLOCK_PRIVATE_HOSTS",
          blocksPrivateHosts: false,
          source: "default",
        },
      ],
    ]);

    setEgressFlag("on");
    egressDecision();
    egressDecision();
    expect(info.mock.calls.at(-1)).toEqual([
      "Private database destinations are blocked",
      { route: "egress-decision", variable: "DB_HTTP_BLOCK_PRIVATE_HOSTS", blocksPrivateHosts: true, source: "set" },
    ]);

    setEgressFlag("false");
    egressSetting();
    expect(info.mock.calls.at(-1)).toEqual([
      "Private database destinations are reachable",
      { route: "egress-decision", variable: "DB_HTTP_BLOCK_PRIVATE_HOSTS", blocksPrivateHosts: false, source: "set" },
    ]);
    expect(info).toHaveBeenCalledTimes(3);
  });

  test("a refused setting reports no decision", () => {
    setEgressFlag("yes");
    expect(egressSetting()).toEqual({ invalid: "yes" });
    expect(() => egressDecision()).toThrow(INVALID_EGRESS_SETTING);
    expect(info).not.toHaveBeenCalled();
  });

  test("forgetting the decision makes the next read decide again, as a new process", () => {
    setEgressFlag("true");
    expect(egressDecision().blocksPrivateHosts).toBe(true);
    process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS = "false";
    forgetEgressDecision();
    expect((globalThis as Record<symbol, unknown>)[slot]).toBeUndefined();
    expect(egressDecision()).toEqual({ blocksPrivateHosts: false, source: "set" });
  });
});
