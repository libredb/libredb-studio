/**
 * Block planning. The rule under test is that a gap is a split, which exists because one undefined
 * register inside a block fails the whole block with exception 02.
 */
import { describe, expect, test } from "bun:test";
import { planReads } from "@/lib/db/providers/industrial/modbus/plan";
import type { MapPoint } from "@/lib/db/providers/industrial/modbus/register-map";

const reg = (name: string, address: number, type = "uint16", unitId = 1): MapPoint => ({
  name,
  unitId,
  table: "holding_register",
  address,
  type,
  wordOrder: "high_first",
  byteOrder: "high_first",
});
const coil = (name: string, address: number, unitId = 1): MapPoint => ({
  name,
  unitId,
  table: "coil",
  address,
  type: "bool",
});

describe("a gap is a split", () => {
  test("adjacent points become one block", () => {
    const blocks = planReads([reg("a", 10), reg("b", 11), reg("c", 12)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ address: 10, quantity: 3 });
  });

  test("one unmapped register between points makes two blocks", () => {
    const blocks = planReads([reg("a", 10), reg("c", 12)]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => [b.address, b.quantity])).toEqual([
      [10, 1],
      [12, 1],
    ]);
  });

  test("a wide type closes the gap it spans", () => {
    const blocks = planReads([reg("a", 10, "uint32"), reg("b", 12)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ address: 10, quantity: 3 });
  });
});

describe("one unit and one table per block", () => {
  test("two units never share a block", () => {
    const blocks = planReads([reg("a", 10, "uint16", 1), reg("b", 11, "uint16", 3)]);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.unitId).sort()).toEqual([1, 3]);
  });

  test("two tables never share a block", () => {
    const blocks = planReads([reg("a", 10), coil("b", 10)]);
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map((b) => b.table)).size).toBe(2);
  });
});

describe("the quantity limits are respected", () => {
  test("126 adjacent registers become two blocks, because the limit is 125", () => {
    const points = Array.from({ length: 126 }, (_, i) => reg(`p${i}`, i));
    const blocks = planReads(points);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.quantity).toBeLessThanOrEqual(125);
    expect(blocks[1]?.quantity).toBeLessThanOrEqual(125);
    expect(blocks.reduce((n, b) => n + b.points.length, 0)).toBe(126);
  });

  test("2001 adjacent coils become two blocks, because the bit limit is 2000", () => {
    const points = Array.from({ length: 2001 }, (_, i) => coil(`c${i}`, i));
    const blocks = planReads(points);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b.quantity).toBeLessThanOrEqual(2000);
  });

  test("a register block never carries more than 125 even when the map is dense", () => {
    const points = Array.from({ length: 400 }, (_, i) => reg(`p${i}`, i));
    for (const b of planReads(points)) expect(b.quantity).toBeLessThanOrEqual(125);
  });
});

describe("every point is served exactly once", () => {
  test("no point is dropped and none is planned twice", () => {
    const points = [reg("a", 0), reg("b", 1), reg("d", 5), coil("e", 0), reg("f", 300, "uint16", 2)];
    const served = planReads(points).flatMap((b) => b.points.map((p) => p.name));
    expect(served.sort()).toEqual(["a", "b", "d", "e", "f"]);
  });

  test("overlapping points do not force a split, because tables may overlay", () => {
    const blocks = planReads([reg("wide", 10, "uint32"), reg("high", 10), reg("low", 11)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.points.map((p) => p.name).sort()).toEqual(["high", "low", "wide"]);
  });
});
