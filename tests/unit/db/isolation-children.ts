/**
 * The child processes of the per-engine isolation tests (connection-form, connection-string, execution-ui and
 * sql-writing).
 *
 * Each of those tests replaces some engines' declarations in a fresh `bun test` process and holds every other engine
 * to its golden. One child per engine renders every engine once per engine, which grows with the square of the
 * engine count, and eight children at once took a whole runner slot's share of a four-core CI machine, so other
 * files' tests ran out of time. Two things keep the cost down instead:
 *
 * - `separatingGroups` replaces a group of engines per child rather than one. For every bit of an engine's index
 *   there is the group of engines with that bit set and the group with it clear; two different engines differ in
 *   some bit, so for every ordered pair (a, b) some child replaces a and leaves b real. A leak from a into b
 *   therefore changes b's output in that child, as it did with one child per engine, and the child count is twice
 *   the bit count (12 for 42 engines) rather than the engine count.
 * - `ISOLATION_CONCURRENCY` runs a quarter of the machine's cores at once, at least one: the runner already runs one
 *   test file per core, so the children of one file share that file's slot rather than take the others'.
 */
import { availableParallelism } from "node:os";

export const ISOLATION_CONCURRENCY = Math.max(1, Math.floor(availableParallelism() / 4));

/** The groups of `ids` that separate every ordered pair: for each index bit, the ids with it set and the ids with it clear. */
export function separatingGroups(ids: readonly string[]): string[][] {
  const groups: string[][] = [];
  for (let bit = 0; 1 << bit < ids.length; bit++) {
    groups.push(ids.filter((_, index) => (index >> bit) & 1));
    groups.push(ids.filter((_, index) => !((index >> bit) & 1)));
  }
  return groups;
}

/** Runs `run` over `items`, `ISOLATION_CONCURRENCY` at a time. */
export async function runPool<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: ISOLATION_CONCURRENCY }, async () => {
      // oxlint-disable-next-line no-await-in-loop -- a pool of workers, each taking the next item when its child exits.
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await run(item);
    }),
  );
}
