/**
 * Unit tests for the Db2 compose service's object-fixture guard, `docker/db2-init/01-object-fixture.sh`.
 *
 * The image runs every file in /var/custom on every container start, so the script decides from a
 * count of `APP.ORDERS` whether the fixture is loaded. Only an answer of 0 may load it and only 1 may
 * skip it: any other answer, an SQL error text included, has to stop the start loudly, because reading
 * it as "already loaded" left a fresh volume with no fixture and a log saying it had one.
 *
 * The script runs as a real subprocess against stubs for `su` and `db2`. The `su` stub runs the
 * command string through `sh`, so the string is held to POSIX. The `db2` stub answers the count with
 * SQL1024N when its standard output is a pipe, the way the real CLP does: a db2 command in a pipeline
 * does not share the connection the shell made (measured on Db2 12.1.0.0).
 */
import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { MISSING_POSIX_FILE_MODES, describeIf, missingPosixShell, posixShell } from "../helpers/posix-tools";

const SCRIPT = join(import.meta.dir, "../../docker/db2-init/01-object-fixture.sh");
const BASH = posixShell("bash");
const CANNOT_RUN = missingPosixShell("bash") ?? missingPosixShell("sh") ?? MISSING_POSIX_FILE_MODES;

const STUB_SU = ["#!/bin/sh", '[ "$1" = "-" ] && [ "$3" = "-c" ] || exit 99', 'exec sh -c "$4"', ""].join("\n");

const STUB_DB2 = [
  "#!/bin/sh",
  'echo "$*" >> "$STUB_LOG"',
  'case "$1" in',
  "  connect)",
  '    if [ "$STUB_CONNECT" = fail ]; then echo "SQL1031N  The database directory cannot be found."; exit 4; fi',
  '    echo "Database server = DB2/LINUXX8664 12.1.0.0"; exit 0 ;;',
  "  -x)",
  '    if [ -p /dev/stdout ]; then echo "SQL1024N  A database connection does not exist.  SQLSTATE=08003"; exit 4; fi',
  '    printf "%s\\n" "$STUB_ANSWER"; exit "$STUB_ANSWER_RC" ;;',
  '  -td@) exit "$STUB_LOAD_RC" ;;',
  "  *) exit 0 ;;",
  "esac",
  "",
].join("\n");

describeIf(CANNOT_RUN, "docker/db2-init/01-object-fixture.sh", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function run(stub: { answer?: string; answerRc?: number; connect?: "fail"; loadRc?: number }) {
    const root = mkdtempSync(join(tmpdir(), "libredb-db2-fixture-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    for (const [name, body] of [
      ["su", STUB_SU],
      ["db2", STUB_DB2],
    ] as const) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    const log = join(root, "db2.log");
    appendFileSync(log, "");
    const result = Bun.spawnSync([BASH!, SCRIPT], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        DB2INSTANCE: "db2inst1",
        DBNAME: "testdb",
        STUB_LOG: log,
        STUB_ANSWER: stub.answer ?? "",
        STUB_ANSWER_RC: String(stub.answerRc ?? 0),
        STUB_CONNECT: stub.connect ?? "",
        STUB_LOAD_RC: String(stub.loadRc ?? 0),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      loaded: calls.some((call) => call.startsWith("-td@ -vf /var/custom-fixture/01-object-fixture.sql")),
      terminated: calls.includes("terminate"),
    };
  }

  test("loads the fixture when the count answers 0, padded as the CLP prints it", () => {
    const result = run({ answer: "          0" });
    expect(result.loaded).toBe(true);
    expect(result.terminated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("fails loudly when the fixture load answers an error", () => {
    const result = run({ answer: "          0", loadRc: 4 });
    expect(result.loaded).toBe(true);
    expect(result.stderr).toContain("db2-init: the fixture load failed");
    expect(result.terminated).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("skips the fixture when the count answers 1", () => {
    const result = run({ answer: "          1" });
    expect(result.loaded).toBe(false);
    expect(result.stdout).toContain("db2-init: fixture already loaded");
    expect(result.terminated).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("fails loudly, with the server's answer on stderr, when the count answers an SQL error", () => {
    const result = run({ answer: 'SQL0204N  "SYSCAT.TABLES" is an undefined name.  SQLSTATE=42704', answerRc: 4 });
    expect(result.loaded).toBe(false);
    expect(result.stdout).not.toContain("fixture already loaded");
    expect(result.stderr).toContain("SQL0204N");
    expect(result.terminated).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("fails loudly when the count answers a number other than 0 or 1", () => {
    const result = run({ answer: "          2" });
    expect(result.loaded).toBe(false);
    expect(result.stderr).toContain("2");
    expect(result.exitCode).not.toBe(0);
  });

  test("fails loudly when the count answers nothing", () => {
    const result = run({ answer: "" });
    expect(result.loaded).toBe(false);
    expect(result.stderr).toContain("db2-init:");
    expect(result.exitCode).not.toBe(0);
  });

  test("fails loudly, with the server's answer on stderr, when the connect fails", () => {
    const result = run({ connect: "fail" });
    expect(result.loaded).toBe(false);
    expect(result.stdout).not.toContain("fixture already loaded");
    expect(result.stderr).toContain("SQL1031N");
    expect(result.exitCode).not.toBe(0);
  });
});
