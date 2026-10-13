/**
 * The declarations, pinned. A provider that answered `true` to one of these by accident would offer
 * the user a surface it cannot serve, and the failure would appear only in the user interface.
 */
import { describe, expect, test } from "bun:test";
import {
  MODBUS_SURFACE,
  NO_REVOCATION_SENTENCE,
  READ_ONLY_HINT,
} from "@/lib/db/providers/industrial/modbus/provider-surface";

describe("every capability this provider does not have is declared false", () => {
  /**
   * Each flag is asserted by name rather than as one array of eight falses. An array of identical
   * values carries no information about WHICH flag is which: it would stay green if two of them
   * were swapped in the declaration, and it names no flag when it fails. The per key form fails
   * with the flag's own name, which is the thing a reader needs.
   */
  test.each([
    ["supportsExplain"],
    ["supportsCreateTable"],
    ["supportsInlineRowEdit"],
    ["supportsTransactions"],
    ["supportsResultPagination"],
    ["supportsMaintenance"],
    ["supportsConnectionString"],
    ["keyScan"],
  ])("%s is declared false", (key) => {
    expect(MODBUS_SURFACE[key as keyof typeof MODBUS_SURFACE]).toBe(false);
  });

  test("the refusals are exactly those ten, so a new one cannot slip in unnoticed", () => {
    const falses = Object.entries(MODBUS_SURFACE)
      .filter(([, v]) => v === false)
      .map(([k]) => k)
      .sort();
    expect(falses).toEqual([
      "agentExecute",
      "keyScan",
      "mcpExposable",
      "supportsConnectionString",
      "supportsCreateTable",
      "supportsExplain",
      "supportsInlineRowEdit",
      "supportsMaintenance",
      "supportsResultPagination",
      "supportsTransactions",
    ]);
  });

  test("read only is enforced and MCP is not offered", () => {
    expect(MODBUS_SURFACE.enforcesReadOnly).toBe(true);
    expect(MODBUS_SURFACE.mcpExposable).toBe(false);
    expect(MODBUS_SURFACE.agentExecute).toBe(false);
  });

  test("one transaction in flight is published, as the TCP guide requires", () => {
    expect(MODBUS_SURFACE.numberMaxOfClientTransaction).toBe(1);
  });

  test("the ports are the registered ones", () => {
    expect(MODBUS_SURFACE.defaultPort).toBe(502);
    expect(MODBUS_SURFACE.securePort).toBe(802);
  });

  test("one container level, named Unit", () => {
    expect(MODBUS_SURFACE.containerLevels).toHaveLength(1);
    expect(MODBUS_SURFACE.containerLevels[0]?.label).toBe("Unit");
  });

  test("a point is a relation", () => {
    expect(MODBUS_SURFACE.pointRole).toBe("relation");
  });
});

describe("the sentences the product has to say out loud", () => {
  test("the read only hint says the device enforces nothing", () => {
    expect(READ_ONLY_HINT).toContain("device enforces nothing");
    expect(READ_ONLY_HINT).toContain("can write to it");
  });

  test("the mbaps sentence says revocation is not checked, and names both runtimes", () => {
    expect(NO_REVOCATION_SENTENCE).toContain("does not check revocation");
    expect(NO_REVOCATION_SENTENCE).toContain("Node");
    expect(NO_REVOCATION_SENTENCE).toContain("Bun");
  });
});

describe("this file imports nothing shared", () => {
  test("the declaration is a plain frozen object, so no shared record was widened to make it", () => {
    expect(Object.isFrozen(MODBUS_SURFACE)).toBe(true);
  });
});
