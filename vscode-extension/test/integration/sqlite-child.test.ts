// SQLite through the forked child, on the runtime LIBREDB_BACKEND_RUNTIME names. An on-disk database runs in a worker
// the provider spawns from the child's own binary, so on the vscode runtime this is the case that needs the worker to
// keep ELECTRON_RUN_AS_NODE; without it VS Code's binary starts as the app and the worker dies. No container: the
// database is a file in a temp directory.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponseError } from "vscode-jsonrpc/node";
import {
  type BackendErrorData,
  type ConnectionParams,
  METHODS,
  type OpenResult,
  type QueryPage,
  type TestConnectionResult,
  type WireConnection,
} from "../../src/protocol";
import { type BackendSession, openSession } from "../backend-session";
import { type BackendRuntime, backendRuntime, forkBackend } from "./runtime";

const EXTENSION_ROOT = join(__dirname, "..", "..");
const TRUSTED = { allowExternalFileAccess: true };
const createdAt = new Date(0).toISOString();

const sqlite = (id: string, database: string): WireConnection => ({
  id,
  name: `it ${id}`,
  type: "sqlite",
  database,
  createdAt,
});
const params = (connection: WireConnection, posture = TRUSTED): ConnectionParams => ({ connection, posture });

async function errorOf(answer: Promise<unknown>): Promise<ResponseError<BackendErrorData | undefined>> {
  try {
    await answer;
  } catch (error) {
    if (error instanceof ResponseError) return error;
    throw error;
  }
  assert.fail("the request was answered, not refused");
}

describe("SQLite in the backend child", () => {
  let runtime: BackendRuntime;
  let session: BackendSession;
  const dir = mkdtempSync(join(tmpdir(), "libredb-it-sqlite-"));

  before(async () => {
    runtime = await backendRuntime();
    console.log(`runtime ${runtime.name}: ${runtime.execPath}`);
    session = openSession(forkBackend(runtime));
    await session.initialize();
  });

  after(async () => {
    assert.equal(await session.connection.sendRequest(METHODS.shutdown), null);
    session.connection.sendNotification("exit");
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (connectionId: string, statement: string) =>
    session.connection.sendRequest<QueryPage>(METHODS.runQuery, {
      connectionId,
      queryId: randomUUID(),
      statement,
      limit: 500,
      offset: 0,
    });

  it("tests, opens and runs statements on a database file in a trusted workspace, through the worker", async () => {
    const connection = sqlite("disk", join(dir, "app.db"));
    const tested = await session.connection.sendRequest<TestConnectionResult>(
      METHODS.testConnection,
      params(connection),
    );
    assert.equal(tested.success, true);
    await session.connection.sendRequest<OpenResult>(METHODS.openConnection, params(connection));
    await run("disk", "create table it_four (n integer)");
    await run("disk", "insert into it_four (n) values (1), (2), (3), (4)");
    const page = await run("disk", "select n from it_four order by n");
    assert.deepEqual(
      page.rows.map((row) => row.n),
      [1, 2, 3, 4],
    );
    assert.ok(existsSync(join(dir, "app.db")));
    assert.doesNotMatch(session.stderr(), /SQLite worker exited/);
  });

  it("refuses a relative path before the provider builds, and leaves no file in the extension's folder", async () => {
    const refused = await errorOf(
      session.connection.sendRequest(METHODS.testConnection, params(sqlite("relative", "it-relative.db"))),
    );
    assert.equal(refused.code, 400);
    assert.equal(
      refused.message,
      "Enter the SQLite database file as an absolute path: a relative path resolves inside the extension's own folder, which an update replaces.",
    );
    assert.deepEqual(refused.data, { code: "CONFIG_ERROR" });
    assert.equal(existsSync(join(EXTENSION_ROOT, "it-relative.db")), false);
  });

  it("refuses a database file in Restricted Mode, naming workspace trust", async () => {
    const restricted = params(sqlite("restricted", join(dir, "restricted.db")), { allowExternalFileAccess: false });
    const refused = await errorOf(session.connection.sendRequest(METHODS.openConnection, restricted));
    assert.equal(refused.message, "Restricted Mode: LibreDB opens no SQLite database until you trust this workspace.");
    assert.deepEqual(refused.data, { code: "CONFIG_ERROR" });
    assert.equal(existsSync(join(dir, "restricted.db")), false);
  });
});
