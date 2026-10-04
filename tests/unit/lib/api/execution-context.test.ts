import { describe, expect, test } from "bun:test";
import { editorExecutionContext } from "@/lib/api/execution-context";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The one place the DuckDB editor file-access posture is decided (B1 / K1).
 *
 * The requester decides it on a connection only its requester uses: an admin keeps the full editor
 * reach and every other role is denied. A seed record is different, because every role the operator's
 * configuration offers it to resolves the SAME record, and one record is one cached handle: DuckDB
 * serves one file through one read-write handle per process, and a second one beside it loses
 * committed writes. So on a seed a non-admin role can use, every requester, admin included, gets the
 * deny posture, and the record keeps one cache key and one handle.
 */

const ADMIN = { role: "admin" };
const USER = { role: "user" };

function seed(roles: string[]): DatabaseConnection {
  return {
    id: "seed:warehouse",
    name: "Warehouse",
    type: "duckdb",
    database: "/srv/data/warehouse.duckdb",
    createdAt: new Date(0),
    managed: true,
    seedId: "warehouse",
    roles,
  } as DatabaseConnection;
}

const INLINE: DatabaseConnection = {
  id: "my-duck",
  name: "My DuckDB",
  type: "duckdb",
  database: "/srv/data/mine.duckdb",
  createdAt: new Date(0),
};

describe("editorExecutionContext on a connection only its requester uses", () => {
  test("an admin keeps the full editor reach on an inline connection", () => {
    expect(editorExecutionContext(ADMIN, INLINE)).toEqual({ allowExternalFileAccess: true });
  });

  test("every other role is denied on an inline connection", () => {
    expect(editorExecutionContext(USER, INLINE)).toEqual({ allowExternalFileAccess: false });
    expect(editorExecutionContext({ role: "analyst" }, INLINE)).toEqual({ allowExternalFileAccess: false });
  });

  test("an admin keeps the full reach on a seed only admins can use", () => {
    expect(editorExecutionContext(ADMIN, seed(["admin"]))).toEqual({ allowExternalFileAccess: true });
  });

  test("an inline connection keeps the requester posture whatever roles its body carries", () => {
    // A body is the caller's own text: roles on it decide nothing, and an inline connection is
    // one requester's, so the audience rule never reads them. Only the seed namespace, which
    // resolveConnection fills from the operator's configuration, carries an audience.
    const claimed = { ...INLINE, roles: ["*"], managed: true } as DatabaseConnection;

    expect(editorExecutionContext(ADMIN, claimed)).toEqual({ allowExternalFileAccess: true });
    expect(editorExecutionContext(USER, claimed)).toEqual({ allowExternalFileAccess: false });
  });
});

describe("editorExecutionContext on a seed a non-admin role can use", () => {
  test.each([[["*"]], [["user"]], [["admin", "user"]], [["user", "admin"]]])(
    "every requester, admin included, gets the deny posture on a seed for %p",
    (roles) => {
      expect(editorExecutionContext(ADMIN, seed(roles))).toEqual({ allowExternalFileAccess: false });
      expect(editorExecutionContext(USER, seed(roles))).toEqual({ allowExternalFileAccess: false });
    },
  );

  test("an unmanaged seed resolves to the same shared record, so it is decided the same way", () => {
    // A `managed: false` seed is copied into each browser with its `seed:` id kept, and
    // resolveConnection still answers that id with the operator's one record.
    const unmanaged = { ...seed(["*"]), managed: false } as DatabaseConnection;

    expect(editorExecutionContext(ADMIN, unmanaged)).toEqual({ allowExternalFileAccess: false });
  });

  test("a record in the seed namespace with no roles on it is decided by the requester", () => {
    const bare = { ...seed(["*"]), roles: undefined } as DatabaseConnection;

    expect(editorExecutionContext(ADMIN, bare)).toEqual({ allowExternalFileAccess: true });
    expect(editorExecutionContext(USER, bare)).toEqual({ allowExternalFileAccess: false });
  });
});
