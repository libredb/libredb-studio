import assert from "node:assert/strict";
import { DatabaseConfigError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/types";
import { checkLocalFile } from "../../../src/backend/local-file";

const createdAt = new Date(0);
const sqlite = (database?: string): DatabaseConnection => ({ id: "s", name: "s", type: "sqlite", database, createdAt });
const trusted = { allowExternalFileAccess: true };
const restricted = { allowExternalFileAccess: false };

/** The refusal checkLocalFile throws, or undefined when it lets the connection through. */
function refusalOf(connection: DatabaseConnection, posture = trusted): DatabaseConfigError | undefined {
  try {
    checkLocalFile(connection, posture);
    return undefined;
  } catch (error) {
    assert.ok(error instanceof DatabaseConfigError);
    return error;
  }
}

describe("checkLocalFile", () => {
  it("lets an absolute path through in a trusted workspace", () => {
    assert.equal(refusalOf(sqlite("/home/you/app.db")), undefined);
  });

  it("lets an in-memory database through, named or left empty", () => {
    assert.equal(refusalOf(sqlite(":memory:")), undefined);
    assert.equal(refusalOf(sqlite("")), undefined);
    assert.equal(refusalOf(sqlite()), undefined);
  });

  it("refuses a relative path, which would resolve inside the extension's own folder", () => {
    const refused = refusalOf(sqlite("app.db"));
    assert.equal(
      refused?.message,
      "Enter the SQLite database file as an absolute path: a relative path resolves inside the extension's own folder, which an update replaces.",
    );
    assert.equal(refused?.provider, "sqlite");
    assert.ok(refusalOf(sqlite("./data/app.db")));
  });

  it("refuses every file-opening connection in Restricted Mode, in-memory included, naming workspace trust", () => {
    for (const database of ["/home/you/app.db", ":memory:"]) {
      assert.equal(
        refusalOf(sqlite(database), restricted)?.message,
        "Restricted Mode: LibreDB opens no SQLite database until you trust this workspace.",
      );
    }
  });

  it("leaves an engine that reaches a server alone, whatever its database field and the workspace's trust", () => {
    const postgres: DatabaseConnection = { id: "p", name: "p", type: "postgres", database: "app", createdAt };
    assert.equal(refusalOf(postgres), undefined);
    assert.equal(refusalOf(postgres, restricted), undefined);
  });
});
