/**
 * Splitting a run into shards, and checking the shards' records before their coverage
 * is merged.
 *
 * CI runs the required suite as several jobs, each `bun run test --coverage --shard=I/N`,
 * and one job that merges them with `--merge-shards=N`. The split is round-robin over
 * the sorted selection: position p (0-based) goes to shard (p mod N) + 1. It is
 * deterministic and count-balanced and needs no weights file; measured on three CI
 * runs, a duration-weighted split was no better at four shards, because the slowest
 * file alone sets the floor (docs/TOOLCHAIN.md, "Coverage measurement").
 *
 * Each shard ships its raw per-file reports, and one merge reads all of them, because
 * the merge is not associative: `scripts/merge-lcov.mjs` takes the record with the most
 * executed lines as the authority for which lines are coverable, so a merge of
 * per-shard merges could elect a different authority than one merge of every report.
 * A shard that passed writes a record of the files it ran; the merge refuses to start
 * unless the records account for every selected file exactly once.
 */

export type Shard = { index: number; count: number };

/** The files shard `index` of `count` runs: every count-th file, from position index - 1. */
export function shardOf(selection: readonly string[], { index, count }: Shard): string[] {
  const files = selection.filter((_, position) => position % count === index - 1);
  if (files.length === 0) {
    throw new Error(`shard ${index} of ${count} selects no file of the ${selection.length} selected.`);
  }
  return files;
}

/** The name of the record a passing shard writes into its coverage directory. */
export function shardRecordName({ index, count }: Shard): string {
  return `shard-${index}-of-${count}.txt`;
}

/** One repository-relative POSIX path per line. */
export function formatShardRecord(files: readonly string[]): string {
  return files.map((file) => `${file}\n`).join("");
}

const RECORD = /^shard-(\d+)-of-(\d+)\.txt$/;

/**
 * Raises, naming the first thing wrong, unless the records of shards 1 to `count` in
 * `directory` list every file of the selection exactly once and nothing else.
 *
 * The caller passes the directory's entries and a reader rather than a path, so the
 * rule is testable without building directories.
 */
export function checkShardRecords({
  count,
  directory,
  selection,
  entries,
  read,
}: {
  count: number;
  directory: string;
  selection: readonly string[];
  entries: readonly string[];
  read: (name: string) => string;
}): void {
  for (const entry of [...entries].sort()) {
    const match = RECORD.exec(entry);
    if (match !== null && Number(match[2]) !== count) {
      throw new Error(`${directory} holds ${entry}, a record of a run split into ${match[2]} shards, not ${count}.`);
    }
  }

  const selected = new Set(selection);
  const listedIn = new Map<string, string>();
  for (let index = 1; index <= count; index += 1) {
    const name = shardRecordName({ index, count });
    if (!entries.includes(name)) {
      throw new Error(
        `${directory} holds no ${name}: shard ${index} of ${count} recorded no files, so it did not pass or its reports were not downloaded.`,
      );
    }
    for (const file of read(name)
      .split("\n")
      .filter((line) => line !== "")) {
      const earlier = listedIn.get(file);
      if (earlier !== undefined) throw new Error(`${file} is listed twice, in ${earlier} and ${name}.`);
      if (!selected.has(file)) {
        throw new Error(`${name} lists ${file}, which is not in the selection this merge was given.`);
      }
      listedIn.set(file, name);
    }
  }

  const unlisted = selection.find((file) => !listedIn.has(file));
  if (unlisted !== undefined) throw new Error(`No shard record lists ${unlisted}, which the selection holds.`);
}
