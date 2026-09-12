/**
 * The DuckDB object-surface and object-source fixture, read and applied (#789).
 *
 * Two callers and one reader. `tests/integration/db/duckdb-provider.test.ts` calls
 * `readFixtureStatements(":memory:")` and replays the result into an in-memory database, so
 * the objects its object-surface and Source assertions reason about are created BY
 * `01-object-fixture.sql`; running this file as a script replays the same statements into a
 * database FILE a person can open in Studio. Before #789 the DDL lived only inside the
 * suite, which is the shape standing ruling 5i forbids: a live measurement nobody outside
 * the test run can re-run.
 *
 * Run it:
 *
 *   bun docker/duckdb-init/build-fixture.ts                    # ./.duckdb-fixture/object-fixture.duckdb
 *   bun docker/duckdb-init/build-fixture.ts /tmp/demo.duckdb   # anywhere else
 *
 * It is re-runnable: an existing file at the target path is removed first, together with
 * the `.wal` sidecar a crashed session can leave beside it and the warehouse sibling below,
 * so a second run produces a database identical to the first rather than one holding both
 * runs' objects.
 *
 * THE SECOND CATALOG IS WHY THIS FILE SUBSTITUTES A PLACEHOLDER RATHER THAN JUST SPLITTING.
 * The fixture's `ATTACH '{{warehouse}}' AS warehouse` is a second REAL catalog, and the two
 * callers need two different targets: the suite wants `:memory:`, which lives and dies with
 * the process, and a file build wants a sibling file, or every `warehouse` object vanishes
 * when the builder exits and a person opening the result finds one catalog where the tests
 * saw two.
 *
 * ONE LIMIT, STATED HERE RATHER THAN DISCOVERED: DuckDB does NOT persist an attachment
 * inside a database file. So opening the built file shows the `memory` half only, and the
 * second catalog is reached with `ATTACH '<target>.warehouse.duckdb' AS warehouse` in a
 * query tab. The sibling is still built, because the alternative - dropping the second
 * catalog from the file build - would give a person a fixture that cannot show the two
 * container levels this engine's whole object model is about.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import * as fs from "fs";
import * as path from "path";

/** Where the fixture lives, so a caller names a file rather than a path. */
export const FIXTURE_DIRECTORY = import.meta.dir;

/** The fixture the DuckDB provider's own suite replays. */
export const DUCKDB_FIXTURE_FILE = "01-object-fixture.sql";

/** The default target, relative to the repository root. */
export const DEFAULT_FIXTURE_PATH = ".duckdb-fixture/object-fixture.duckdb";

/**
 * The token `ATTACH` names its target with, and the one thing in this fixture that is not
 * literal SQL.
 *
 * Spelled once and exported, so the substitution and the guard that it happened cannot
 * disagree about what they are looking for.
 */
export const WAREHOUSE_PLACEHOLDER = "{{warehouse}}";

/** The second catalog's target for a file build, derived from the target's own path. */
export function warehouseSibling(file: string): string {
  return `${file}.warehouse.duckdb`;
}

/**
 * Every statement of the fixture, comments removed, in the file's own order, with the
 * second catalog's target substituted in.
 *
 * A line whose first non-blank characters are `--` is dropped whole; there is no `--`
 * inside a string literal in this fixture, and a splitter that pretended otherwise would be
 * claiming a lexer it does not have. A statement ends at a line ending in `;`, which is
 * enough here for a reason DuckDB gives rather than luck: this engine has no trigger and no
 * stored procedure, so no statement in the fixture carries a body holding its own
 * semicolon. That is the trap `docker/sqlite-init/build-fixture.ts` needs a trigger rule
 * for, and it cannot arise on this engine.
 *
 * THREE THROWS, each over a zero that would otherwise pass silently:
 *
 * - no statement at all, which builds an EMPTY database and makes every count assertion
 *   downstream read zero against zero. The same throw covers a path resolving to the wrong
 *   file;
 * - no substitution, which would send DuckDB the literal string `{{warehouse}}` as a file
 *   PATH. Measured on v1.5.5: that ATTACH succeeds and creates a file called
 *   `{{warehouse}}` in the working directory, so the failure is silent litter rather than
 *   an error, and the suite would still see two catalogs;
 * - an empty warehouse target, because `ATTACH '' AS warehouse` is the same shape one step
 *   further along.
 */
export function readFixtureStatements(warehouse: string, file: string = DUCKDB_FIXTURE_FILE): string[] {
  if (warehouse.trim() === "") {
    throw new Error("the warehouse target is blank, so the fixture's second catalog would attach nothing");
  }
  const resolved = path.isAbsolute(file) ? file : path.join(FIXTURE_DIRECTORY, file);
  const text = fs.readFileSync(resolved, "utf8");
  const statements: string[] = [];
  let buffer = "";
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("--")) continue;
    const body = line.trimEnd();
    if (!body.endsWith(";")) {
      buffer += `${line}\n`;
      continue;
    }
    const statement = `${buffer}${body.slice(0, -1)}`.trim();
    if (statement !== "") statements.push(statement);
    buffer = "";
  }
  if (statements.length === 0) {
    throw new Error(`${resolved} yielded no statement, so applying it would build an empty database`);
  }
  const substituted = statements.map((statement) => statement.split(WAREHOUSE_PLACEHOLDER).join(warehouse));
  if (substituted.every((statement, index) => statement === statements[index])) {
    throw new Error(
      `${resolved} carries no ${WAREHOUSE_PLACEHOLDER} to substitute, so the second catalog would attach a file ` +
        "named after the placeholder itself",
    );
  }
  return substituted;
}

/** Delete a DuckDB database, the `.wal` sidecar, and the warehouse sibling beside it. */
export function removeDatabaseFile(file: string): void {
  for (const target of [file, `${file}.wal`, warehouseSibling(file), `${warehouseSibling(file)}.wal`]) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* the file not being there is the state this function is asked for */
    }
  }
}

/** Build the fixture at `file`, replacing whatever is there, with its warehouse sibling. */
export async function buildObjectFixture(file: string): Promise<void> {
  removeDatabaseFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const instance = await DuckDBInstance.create(file);
  const connection = await instance.connect();
  try {
    for (const statement of readFixtureStatements(warehouseSibling(file))) await connection.run(statement);
    // Both catalogs, so neither file is left holding an uncheckpointed write-ahead log a
    // reader would have to replay. The first is spelled bare rather than by name: a DuckDB
    // file's catalog is named after its own stem, so the connected catalog here is
    // `object-fixture` and never the `memory` the in-process suite sees.
    await connection.run("CHECKPOINT");
    await connection.run("CHECKPOINT warehouse");
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

if (import.meta.main) {
  const target = path.resolve(process.argv[2] ?? DEFAULT_FIXTURE_PATH);
  await buildObjectFixture(target);
  process.stdout.write(
    `DuckDB object fixture written to ${target}\n` +
      `Second catalog: ${warehouseSibling(target)} (ATTACH '${warehouseSibling(target)}' AS warehouse)\n`,
  );
}
