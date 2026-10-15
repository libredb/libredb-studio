import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { SETTINGS_REGISTRY } from "@/lib/governance/settings-registry";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The one place the DuckDB editor file-access posture is decided (non-admin DuckDB file access).
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

/**
 * The owner of a per-user provider (spec 9.4). Under governance every user of a connection gets a provider of their
 * own: the context names the session's identity provider subject as `owner`, which the provider cache key and the
 * transaction key frame, and `ownerPoolMax`, the pool size of that user's provider. Without governance neither field
 * is set, so the factory keys, pools and shares providers exactly as before.
 */
describe("editorExecutionContext names the owner under governance (spec 9.4)", () => {
  const SUBJECT_MISSING = "Under governance every provider belongs to one user";
  /** An OIDC session: the username for display, the subject for identity. The subject of an LDAP-federated user. */
  const ALICE = { role: "user", username: "alice@example.com", idpSubject: "f:ldap-1:alice" };

  let savedSource: string | undefined;

  beforeEach(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    delete process.env.GOVERNANCE_SOURCE;
  });

  afterEach(() => {
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
  });

  test("under governance the context carries the session's idpSubject as owner and ownerPoolMax 3, and without governance neither field is set", () => {
    // Strict: an owner key that is present but undefined would still be a field the factory reads.
    expect(editorExecutionContext(ALICE, INLINE)).toStrictEqual({ allowExternalFileAccess: false });
    expect(editorExecutionContext({ ...ALICE, role: "admin" }, INLINE)).toStrictEqual({
      allowExternalFileAccess: true,
    });

    process.env.GOVERNANCE_SOURCE = "postgres";
    expect(editorExecutionContext(ALICE, INLINE)).toStrictEqual({
      allowExternalFileAccess: false,
      owner: "f:ldap-1:alice",
      ownerPoolMax: 3,
    });
    // The posture is decided exactly as before: the owner is added to it and changes nothing in it.
    expect(editorExecutionContext({ ...ALICE, role: "admin" }, INLINE)).toStrictEqual({
      allowExternalFileAccess: true,
      owner: "f:ldap-1:alice",
      ownerPoolMax: 3,
    });
    // An invalid GOVERNANCE_SOURCE counts as governance, so the server fails closed.
    process.env.GOVERNANCE_SOURCE = "postgress";
    expect(editorExecutionContext(ALICE, INLINE).owner).toBe("f:ldap-1:alice");
  });

  test("ownerPoolMax is the default of the runtime setting provider.poolMaxPerUser", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    const setting = SETTINGS_REGISTRY.find((definition) => definition.key === "provider.poolMaxPerUser");

    expect(setting?.default).toBe(3);
    expect(editorExecutionContext(ALICE, INLINE).ownerPoolMax).toBe(setting?.default as number);
  });

  test("under governance a session without an identity provider subject is refused, never handed a shared provider", () => {
    process.env.GOVERNANCE_SOURCE = "postgres";

    expect(() => editorExecutionContext({ role: "user" }, INLINE)).toThrow(SUBJECT_MISSING);
    // openid-client accepts `sub: ""`, so an empty subject counts as missing.
    expect(() => editorExecutionContext({ role: "admin", idpSubject: "" }, INLINE)).toThrow(SUBJECT_MISSING);
  });
});
