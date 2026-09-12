/**
 * The LibreDB object-surface fixture (#789).
 *
 * LibreDB is embedded: there is no image to pull and no service in
 * `database-compose.yml`, so this file IS the fixture, the way
 * `docker/redis-init/01-object-fixture.redis` is for Redis. It is a module rather
 * than a shell script for one reason: `tests/integration/db/libredb-provider.test.ts`
 * imports `buildObjectFixture` and builds the very same database the commands below
 * build, so the objects the object-surface tests reason about are created BY the
 * fixture rather than by hand in the test.
 *
 * Run it to get a durable file a person can open in Studio:
 *
 *   bun docker/libredb-init/01-object-fixture.ts                     # ./.libredb-fixture/object-fixture.libredb
 *   bun docker/libredb-init/01-object-fixture.ts /tmp/demo.libredb   # anywhere else
 *
 * It is re-runnable: an existing file at the target path (and its `.lock` sidecar)
 * is removed first, so a second run produces a database identical to the first
 * rather than one holding both runs' keys.
 *
 * WHAT IT HOLDS, and why each piece is here. The store's three object kinds are the
 * two the persisted catalog names and the one this server derives from a key scan,
 * so the fixture carries an instance of each, plus the two edges the declaration has
 * to get right:
 *
 *   relational `employees`   2 rows      a cataloged table with a real column schema
 *   relational `vacancies`   0 rows      a cataloged table holding nothing, which the
 *                                        catalog still names: proof a count of 0 is the
 *                                        engine answering none rather than a missing read
 *   relational `applicants`  0 rows      a second empty table, named so it sorts BEFORE
 *                                        `employees` while the enumerator reaches it AFTER:
 *                                        a listing that forgot to sort answers these two in
 *                                        the wrong order, and nothing else in this fixture
 *                                        can tell a sorted listing from an unsorted one
 *   document   `articles`    2 documents a cataloged collection
 *   document   `notes`       1 document  a cataloged collection whose name is ALSO a bare
 *                                        key (below), so one string addresses two objects
 *                                        of two different kinds
 *   kv         `cache:a/b`   2 keys      an uncataloged prefix grouping
 *   kv         `standalone`  1 key       a bare key, its own grouping
 *   kv         `notes`       1 key       the collision above, from the raw side
 *
 * A document collection is registered in the catalog on its FIRST WRITE and not when
 * `doc()` hands back a collection handle (measured on @libredb/libredb 0.2.2), so
 * every collection here is written to. A relational table is cataloged when `table()`
 * records its schema, which is why `vacancies` can be cataloged with no rows at all.
 */
import { open, kv, doc, table } from "@libredb/libredb";
import * as fs from "fs";
import * as path from "path";

/** Delete a LibreDB database and the exclusive-lock sidecar `open()` keeps beside it. */
export function removeDatabaseFile(file: string): void {
  for (const target of [file, `${file}.lock`]) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* the file not being there is the state this function is asked for */
    }
  }
}

/**
 * Build the fixture at `file`, replacing whatever is there.
 *
 * Synchronous throughout, because the package's API is: `open` returns a handle and
 * every lens call on it is a direct call.
 */
export function buildObjectFixture(file: string): void {
  removeDatabaseFile(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = open({ path: file });
  try {
    const store = kv(db);
    store.set("cache:a", "1");
    store.set("cache:b", "2");
    store.set("standalone", "single-value");
    store.set("notes", "a bare key whose name a cataloged collection also answers to");

    const employees = table(db, "employees", {
      primaryKey: "id",
      columns: { id: "string", name: "string", salary: "number", active: "boolean" },
    });
    employees.insert({ id: "e1", name: "Ada", salary: 100, active: true });
    employees.insert({ id: "e2", name: "Grace", salary: 120, active: false });

    // Cataloged and empty on purpose. Nothing is inserted into either.
    //
    // `scanGroups` reaches a cataloged namespace the key scan never saw only AFTER the
    // groups the scan did see, and the scan itself walks the keyspace in byte order. So an
    // empty table whose name sorts before `employees` is reached after it, and the only
    // thing that can put the two in order is the sort in the enumerator. Without this row
    // every natural order in this fixture is already the sorted one, and deleting that sort
    // changes nothing anybody can observe.
    table(db, "applicants", { primaryKey: "id", columns: { id: "string", name: "string" } });
    table(db, "vacancies", { primaryKey: "id", columns: { id: "string", title: "string" } });

    const articles = doc(db, "articles");
    articles.put("a1", { title: "Hello", body: "world" });
    articles.put("a2", { title: "Second", body: "post" });

    doc(db, "notes").put("n1", { text: "the collection half of the name collision" });
  } finally {
    db.close();
  }
}

/** The default target, relative to the repository root. */
export const DEFAULT_FIXTURE_PATH = ".libredb-fixture/object-fixture.libredb";

if (import.meta.main) {
  const target = path.resolve(process.argv[2] ?? DEFAULT_FIXTURE_PATH);
  buildObjectFixture(target);
  process.stdout.write(`LibreDB object fixture written to ${target}\n`);
}
