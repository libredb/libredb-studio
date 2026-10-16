/**
 * Turning a list of named points into as few block reads as the protocol allows.
 *
 * WHY A BLOCK IS SPLIT WHERE THE MAP HAS NO POINT. MEASURED by the issue author of #1723: one
 * undefined register inside a block fails the WHOLE block with exception 02. So reading a wide
 * block to save requests is not a trade of requests against bytes, it is a trade of requests
 * against losing every point in the block. A gap is therefore a split, not something to read over.
 *
 * WHY THE CAP COUNTS REQUESTS AND NOT REGISTERS. MEASURED by the issue author through mbusd at its
 * defaults: a 100 register read took 101.8 ms, most of it the gateway's own pause between requests,
 * and an absent unit cost 2137 ms before exception 0B. What a gateway's serial line pays for is the
 * request, not the register, so a budget counted in registers would be a budget that does not
 * describe the cost.
 *
 * One unit and one table per block, because the function code is chosen by the table (MB 6.1 to
 * 6.4) and the unit id is one byte of the header (TCP 3.1.3): neither can vary inside one request.
 */
import { MAX_BITS_PER_READ, MAX_REGISTERS_PER_READ } from "./constants";
import type { Table } from "./pdu";
import { REGISTERS_OF_TYPE } from "./values";
import type { MapPoint } from "./register-map";

export interface Block {
  readonly unitId: number;
  readonly table: Table;
  readonly address: number;
  readonly quantity: number;
  /** The points this block answers, in map order. A block exists only to serve these. */
  readonly points: readonly MapPoint[];
}

const BIT_TABLES: ReadonlySet<string> = new Set(["coil", "discrete_input"]);

/** How many registers, or bits, one point occupies. A bit point is one bit. */
function spanOf(point: MapPoint): number {
  if (BIT_TABLES.has(point.table)) return 1;
  return REGISTERS_OF_TYPE[point.type] ?? point.registers ?? 1;
}

/**
 * Plans the reads for a set of points. Points are grouped by unit and table, sorted by address,
 * and cut wherever the next point does not begin exactly where the last one ended, or wherever the
 * quantity limit would be passed.
 *
 * Overlapping points are allowed and do not force a split: the data model lets tables overlay one
 * another (MB 4.4), so two points may legitimately describe the same registers, for instance a
 * `uint32` and the two `uint16` halves a device also documents.
 */
export function planReads(points: readonly MapPoint[]): readonly Block[] {
  const groups = new Map<string, MapPoint[]>();
  for (const point of points) {
    const key = `${point.unitId}\u0000${point.table}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [point]);
    else list.push(point);
  }

  const blocks: Block[] = [];
  for (const [key, group] of groups) {
    const [unitRaw, table] = key.split("\u0000") as [string, Table];
    const unitId = Number(unitRaw);
    const max = BIT_TABLES.has(table) ? MAX_BITS_PER_READ : MAX_REGISTERS_PER_READ;
    const sorted = [...group].sort((a, b) => a.address - b.address);

    let current: { address: number; end: number; points: MapPoint[] } | undefined;
    const flush = () => {
      if (current === undefined) return;
      blocks.push({
        unitId,
        table,
        address: current.address,
        quantity: current.end - current.address,
        points: current.points,
      });
      current = undefined;
    };

    for (const point of sorted) {
      const end = point.address + spanOf(point);
      if (current === undefined) {
        current = { address: point.address, end, points: [point] };
        continue;
      }
      const gap = point.address > current.end;
      const wouldPass = Math.max(current.end, end) - current.address > max;
      if (gap || wouldPass) {
        flush();
        current = { address: point.address, end, points: [point] };
        continue;
      }
      current.end = Math.max(current.end, end);
      current.points.push(point);
    }
    flush();
  }
  return blocks;
}
