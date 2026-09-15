/**
 * The SQLite object-surface fixture, read and applied (#789).
 *
 * Two callers and one reader. `tests/integration/db/sqlite-provider.test.ts` calls
 * `readFixtureStatements()` and replays the result into an in-memory database, so the
 * objects its object-surface and Source assertions reason about are created BY
 * `01-object-fixture.sql`; running this file as a script replays the same statements into a
 * database FILE a person can open in Studio. A fixture that only a test can apply is the
 * shape standing ruling 5i forbids, and a fixture that lives only as a fenced block in a
 * provider doc is the same defect one step further away from the code.
 *
 * Run it:
 *
 *   bun docker/sqlite-init/build-fixture.ts                          # ./.sqlite-fixture/object-fixture.sqlite
 *   bun docker/sqlite-init/build-fixture.ts /tmp/demo.sqlite         # anywhere else
 *   bun docker/sqlite-init/build-fixture.ts /tmp/l.sqlite 02-libsql-object-fixture.sql
 *
 * It is re-runnable: an existing file at the target path is removed first, together with the
 * `-wal` and `-shm` sidecars a crashed session can leave beside it, so a second run produces
 * a database identical to the first rather than one holding both runs' objects.
 *
 * TWO TRAPS THIS SPLITTER EXISTS FOR, both recorded by D53 before this file closed it.
 *
 * `sql.split(";")` CANNOT read this fixture. A `CREATE TRIGGER` body holds its own
 * semicolons - `BEGIN UPDATE orders SET total = total; END` is one statement carrying two -
 * so a naive split hands the engine `... BEGIN UPDATE orders SET total = total` and then a
 * bare `END`, and the engine refuses both. A trigger statement therefore ends at the first
 * `;` whose statement text already ends in `END`, which is SQLite's own rule for where a
 * trigger body closes.
 *
 * `ANALYZE` appears in neither fixture and must not be added to either. sqld refuses it
 * outright ("SQL not allowed statement"), and `02-libsql-object-fixture.sql` is applied to
 * that server; on the file engine it would also add `sqlite_stat1`, a reserved-name table
 * that every count in both suites is written to exclude.
 */
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

/** Where the two fixtures live, so a caller names a file rather than a path. */
export const FIXTURE_DIRECTORY = import.meta.dir;

/** The fixture the SQLite provider's own suite replays. */
export const SQLITE_FIXTURE_FILE = "01-object-fixture.sql";

/** The fixture the libSQL provider doc's capture was taken from. */
export const LIBSQL_FIXTURE_FILE = "02-libsql-object-fixture.sql";

/** The default target, relative to the repository root. */
export const DEFAULT_FIXTURE_PATH = ".sqlite-fixture/object-fixture.sqlite";

/**
 * Every statement of one fixture file, comments removed, in the file's own order.
 *
 * A line whose first non-blank characters are `--` is a comment and is dropped whole; there
 * is no `--` inside a string literal in either fixture, and a splitter that pretended
 * otherwise would be claiming a lexer it does not have. A trailing comment on a statement
 * line would survive here and SQLite would drop it from `sqlite_schema.sql` anyway, which is
 * measured in `docs/providers/sqlite.md`, so neither fixture writes one.
 *
 * THROWS when the file yields no statement at all. A fixture reader that answers an empty
 * array builds an EMPTY database and every count assertion downstream then reads zero
 * against zero, which passes: the caller is handed a file it cannot see is empty. The same
 * throw covers a path that resolves to the wrong file.
 */
export function readFixtureStatements(file: string = SQLITE_FIXTURE_FILE): string[] {
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
    const candidate = `${buffer}${body.slice(0, -1)}`;
    // A trigger body carries its own `;`, so only the one after `END` closes the statement.
    // Read off the TEXT rather than off a flag, because the same rule decides for a
    // statement that opened and closed a body on one line.
    if (/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(candidate) && !/\bEND\s*$/i.test(candidate)) {
      buffer += `${line}\n`;
      continue;
    }
    const statement = candidate.trim();
    if (statement !== "") statements.push(statement);
    buffer = "";
  }
  if (statements.length === 0) {
    throw new Error(`${resolved} yielded no statement, so applying it would build an empty database`);
  }
  return statements;
}

/** Delete a SQLite database and the two sidecars a WAL session can leave beside it. */
export function removeDatabaseFile(file: string): void {
  for (const target of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* the file not being there is the state this function is asked for */
    }
  }
}

/** Build the fixture at `file` from `fixture`, replacing whatever is there. */
export function buildObjectFixture(file: string, fixture: string = SQLITE_FIXTURE_FILE): void {
  removeDatabaseFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { create: true });
  try {
    for (const statement of readFixtureStatements(fixture)) db.exec(statement);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const target = path.resolve(process.argv[2] ?? DEFAULT_FIXTURE_PATH);
  const fixture = process.argv[3] ?? SQLITE_FIXTURE_FILE;
  buildObjectFixture(target, fixture);
  process.stdout.write(`SQLite object fixture (${fixture}) written to ${target}\n`);
}
