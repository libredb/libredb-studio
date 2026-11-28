import { describe, expect, test } from "bun:test";
import { checkShardRecords, formatShardRecord, shardOf, shardRecordName } from "../runner/shard";

/** `count` sorted file names, as discovery hands them over. */
function selectionOf(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `tests/unit/f${String(index).padStart(2, "0")}.test.ts`);
}

/** What `checkShardRecords` throws, or null. */
function refusal(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("splitting a selection into shards", () => {
  test("a shard is every Nth file of the sorted selection, starting at its own index", () => {
    const selection = selectionOf(10);
    expect(shardOf(selection, { index: 1, count: 4 })).toEqual([selection[0], selection[4], selection[8]]);
    expect(shardOf(selection, { index: 2, count: 4 })).toEqual([selection[1], selection[5], selection[9]]);
    expect(shardOf(selection, { index: 4, count: 4 })).toEqual([selection[3], selection[7]]);
    expect(shardOf(selection, { index: 1, count: 1 })).toEqual(selection);
  });

  test("the N shards are disjoint and together are the selection, for N from 1 to 7 over 0 to 20 files", () => {
    for (let files = 0; files <= 20; files += 1) {
      const selection = selectionOf(files);
      for (let count = 1; count <= 7; count += 1) {
        const shards: string[][] = [];
        for (let index = 1; index <= count; index += 1) {
          // A shard with nothing in it is refused, which is the next case; here it is
          // only counted as empty.
          shards.push(index <= files ? shardOf(selection, { index, count }) : []);
        }
        const all = shards.flat();
        expect(new Set(all).size).toBe(all.length);
        expect([...all].sort()).toEqual(selection);
      }
    }
  });

  test("the split is stable: the same selection gives the same shards", () => {
    const selection = selectionOf(17);
    expect(shardOf([...selection], { index: 3, count: 4 })).toEqual(shardOf(selection, { index: 3, count: 4 }));
  });

  test("a shard that selects nothing is refused by name", () => {
    expect(refusal(() => shardOf(selectionOf(2), { index: 3, count: 4 }))).toBe(
      "shard 3 of 4 selects no file of the 2 selected.",
    );
  });
});

describe("the shard records", () => {
  const selection = selectionOf(5);
  const shards = [1, 2].map((index) => shardOf(selection, { index, count: 2 }));
  const records = new Map([
    [shardRecordName({ index: 1, count: 2 }), formatShardRecord(shards[0] as string[])],
    [shardRecordName({ index: 2, count: 2 }), formatShardRecord(shards[1] as string[])],
  ]);

  function check(entries: Map<string, string>, count = 2): string | null {
    return refusal(() =>
      checkShardRecords({
        count,
        directory: "coverage/raw",
        selection,
        entries: [...entries.keys(), "file-1", "file-2"],
        read: (name) => entries.get(name) as string,
      }),
    );
  }

  test("a record is named by its shard and holds one path per line", () => {
    expect(shardRecordName({ index: 2, count: 4 })).toBe("shard-2-of-4.txt");
    expect(formatShardRecord(["tests/a.test.ts", "tests/b.test.ts"])).toBe("tests/a.test.ts\ntests/b.test.ts\n");
  });

  test("the shard records are read back and checked", () => {
    expect(check(records)).toBeNull();

    const missing = new Map(records);
    missing.delete("shard-2-of-2.txt");
    expect(check(missing)).toBe(
      "coverage/raw holds no shard-2-of-2.txt: shard 2 of 2 recorded no files, so it did not pass or its reports were not downloaded.",
    );

    const otherCount = new Map(records);
    otherCount.set("shard-1-of-3.txt", formatShardRecord([]));
    expect(check(otherCount)).toBe(
      "coverage/raw holds shard-1-of-3.txt, a record of a run split into 3 shards, not 2.",
    );

    const duplicate = new Map(records);
    duplicate.set("shard-2-of-2.txt", formatShardRecord([...(shards[1] as string[]), selection[0] as string]));
    expect(check(duplicate)).toBe(`${selection[0]} is listed twice, in shard-1-of-2.txt and shard-2-of-2.txt.`);

    const uncovered = new Map(records);
    uncovered.set("shard-2-of-2.txt", formatShardRecord((shards[1] as string[]).slice(1)));
    expect(check(uncovered)).toBe(`No shard record lists ${(shards[1] as string[])[0]}, which the selection holds.`);

    const extra = new Map(records);
    extra.set("shard-2-of-2.txt", formatShardRecord([...(shards[1] as string[]), "tests/unit/gone.test.ts"]));
    expect(check(extra)).toBe(
      "shard-2-of-2.txt lists tests/unit/gone.test.ts, which is not in the selection this merge was given.",
    );
  });
});
