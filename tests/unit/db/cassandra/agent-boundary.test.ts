/**
 * The agent read-only profile's check of the Cassandra role, against the answers a live Apache Cassandra 5.0.9 with
 * PasswordAuthenticator and CassandraAuthorizer gave, as `tests/fixtures/cassandra/5.0.9/agent-boundary/` records them.
 * Every statement the check sends is pinned by its full text, and each refusal by its code and its words.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  CASSANDRA_AGENT_RELEASE_CQL,
  CASSANDRA_AGENT_SCYLLA_CQL,
  cassandraAgentStatementRefusal,
  cassandraAgentStatements,
  verifyCassandraAgentProfile,
} from "@/lib/db/providers/sql/cassandra/agent-boundary";
import { type CassandraQueryResult, CassandraTransportError } from "@/lib/db/providers/sql/cassandra/transport";

const NONCE = "0123456789abcdef01234567";

function rows(list: Record<string, unknown>[]): CassandraQueryResult {
  const fieldNames = list.length === 0 ? [] : Object.keys(list[0]);
  return { rows: list, fieldNames, columnTypes: {}, pageState: null };
}

/** What a statement that answers no columns answers: a write, or a listing with nothing in it (capture 03). */
const NO_COLUMNS: CassandraQueryResult = { rows: [], fieldNames: null, columnTypes: null, pageState: null };

const roleRow = (role: string, superuser = false) => ({
  role,
  super: superuser,
  login: true,
  options: {},
  datacenters: "ALL",
});
const permissionRow = (role: string, resource: string, permission: string) => ({
  role,
  username: role,
  resource,
  permission,
});

const unauthorized = (message: string) => new CassandraTransportError(message, "permission", 8448);

/** The answers the role agent_ro gets on a server that enforces its grants, keyed by the statement. */
function healthy(
  overrides: Record<string, CassandraQueryResult | Error> = {},
): Record<string, CassandraQueryResult | Error> {
  const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
  return {
    [CASSANDRA_AGENT_RELEASE_CQL]: rows([{ release_version: "5.0.9" }]),
    [CASSANDRA_AGENT_SCYLLA_CQL]: new CassandraTransportError("table versions does not exist", "invalid", 8704),
    [statements.roles]: rows([roleRow("agent_ro")]),
    [statements.permissions]: rows([permissionRow("agent_ro", "<keyspace probe>", "SELECT")]),
    [statements.masks]: NO_COLUMNS,
    [statements.probe]: unauthorized(
      `User agent_ro has no DROP permission on <table probe.libredb_agent_probe_${NONCE}> or any of its parents`,
    ),
    ...overrides,
  };
}

function reader(answers: Record<string, CassandraQueryResult | Error>) {
  const asked: string[] = [];
  const read = async (cql: string): Promise<CassandraQueryResult> => {
    asked.push(cql);
    const answer = answers[cql];
    if (answer === undefined) throw new Error(`unexpected statement: ${cql}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { asked, read };
}

async function refusal(
  answers: Record<string, CassandraQueryResult | Error>,
  role = "agent_ro",
  keyspace = "probe",
): Promise<ExecutionProfileError> {
  const { read } = reader(answers);
  try {
    await verifyCassandraAgentProfile(read, { role, keyspace, nonce: NONCE });
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
  throw new Error("the check admitted the role");
}

describe("the statements the check sends", () => {
  test("are pinned by their full text", () => {
    expect(CASSANDRA_AGENT_RELEASE_CQL).toBe("SELECT release_version FROM system.local");
    expect(CASSANDRA_AGENT_SCYLLA_CQL).toBe("SELECT key FROM system.versions");
    expect(cassandraAgentStatements("agent_ro", "probe", NONCE)).toEqual({
      roles: "LIST ROLES OF 'agent_ro'",
      permissions: "LIST ALL PERMISSIONS OF 'agent_ro'",
      masks:
        "SELECT keyspace_name, table_name, column_name, function_keyspace, function_name FROM system_schema.column_masks WHERE keyspace_name = 'probe'",
      probe: `DROP TABLE IF EXISTS "probe".libredb_agent_probe_${NONCE}`,
    });
  });

  test("quote a role and a keyspace as the server reads them, a quote doubled", () => {
    // Measured: `LIST ROLES OF 'Agent''Quote'` lists the role Agent'Quote, and the literal is case-sensitive.
    expect(cassandraAgentStatements("Agent'Quote", 'Mixed"Case', NONCE)).toEqual({
      roles: "LIST ROLES OF 'Agent''Quote'",
      permissions: "LIST ALL PERMISSIONS OF 'Agent''Quote'",
      masks:
        "SELECT keyspace_name, table_name, column_name, function_keyspace, function_name FROM system_schema.column_masks WHERE keyspace_name = 'Mixed\"Case'",
      probe: `DROP TABLE IF EXISTS "Mixed""Case".libredb_agent_probe_${NONCE}`,
    });
  });

  test("never list every role: the listing is always of the connection's own role", () => {
    const { roles } = cassandraAgentStatements("agent_ro", "probe", NONCE);
    expect(roles.startsWith("LIST ROLES OF ")).toBe(true);
  });

  test("run in order: the server, its kind, the roles, the permissions, the masks, then the probe", async () => {
    const { asked, read } = reader(healthy());
    await verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE });
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    expect(asked).toEqual([
      CASSANDRA_AGENT_RELEASE_CQL,
      CASSANDRA_AGENT_SCYLLA_CQL,
      statements.roles,
      statements.permissions,
      statements.masks,
      statements.probe,
    ]);
  });
});

describe("a role the check admits", () => {
  test("holding SELECT on the bound keyspace alone", async () => {
    const { read } = reader(healthy());
    await expect(
      verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE }),
    ).resolves.toBe(undefined);
  });

  test("holding SELECT on tables of the bound keyspace alone", async () => {
    const statements = cassandraAgentStatements("agent_table", "probe", NONCE);
    const { read } = reader({
      ...healthy(),
      [statements.roles]: rows([roleRow("agent_table")]),
      [statements.permissions]: rows([permissionRow("agent_table", "<table probe.customers>", "SELECT")]),
      [statements.masks]: NO_COLUMNS,
      [statements.probe]: unauthorized("User agent_table has no DROP permission"),
    });
    await expect(
      verifyCassandraAgentProfile(read, { role: "agent_table", keyspace: "probe", nonce: NONCE }),
    ).resolves.toBe(undefined);
  });

  test("on a keyspace whose name has upper case, as the listing spells it", async () => {
    const statements = cassandraAgentStatements("agent_mixed", "MixedCase", NONCE);
    const { read } = reader({
      ...healthy(),
      [statements.roles]: rows([roleRow("agent_mixed")]),
      [statements.permissions]: rows([
        permissionRow("agent_mixed", "<keyspace MixedCase>", "SELECT"),
        permissionRow("agent_mixed", "<table MixedCase.Things>", "SELECT"),
      ]),
      [statements.masks]: NO_COLUMNS,
      [statements.probe]: unauthorized("User agent_mixed has no DROP permission"),
    });
    await expect(
      verifyCassandraAgentProfile(read, { role: "agent_mixed", keyspace: "MixedCase", nonce: NONCE }),
    ).resolves.toBe(undefined);
  });

  test("whose keyspace holds a column masked by a built-in function", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const { read } = reader(
      healthy({
        [statements.masks]: rows([
          {
            keyspace_name: "probe",
            table_name: "masked",
            column_name: "builtin_masked",
            function_keyspace: "system",
            function_name: "mask_default",
          },
        ]),
      }),
    );
    await expect(
      verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE }),
    ).resolves.toBe(undefined);
  });
});

describe("the engine gate", () => {
  test("refuses a server that is not a Cassandra 5.0 release", async () => {
    const error = await refusal(healthy({ [CASSANDRA_AGENT_RELEASE_CQL]: rows([{ release_version: "3.0.8" }]) }));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      'The agent read-only execution profile is proven on Apache Cassandra 5.0 only; this server reports release_version "3.0.8", so its enforcement is unmeasured and the connection is refused.',
    );
  });

  test("refuses a release it cannot read", async () => {
    const error = await refusal(healthy({ [CASSANDRA_AGENT_RELEASE_CQL]: NO_COLUMNS }));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("reports release_version null");
  });

  test("refuses ScyllaDB, which answers its own system.versions", async () => {
    const error = await refusal(
      healthy({
        [CASSANDRA_AGENT_RELEASE_CQL]: rows([{ release_version: "5.0.9" }]),
        [CASSANDRA_AGENT_SCYLLA_CQL]: rows([{ key: "local" }]),
      }),
    );
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      "The agent read-only execution profile is proven on Apache Cassandra 5.0 only; this server answers system.versions, which ScyllaDB keeps and Apache Cassandra does not, so its enforcement is unmeasured and the connection is refused.",
    );
  });

  test("refuses a server that answers system.versions with anything but the absence of the table", async () => {
    const error = await refusal(healthy({ [CASSANDRA_AGENT_SCYLLA_CQL]: unauthorized("no SELECT permission") }));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("could not tell");
  });

  test("lets a failure to reach the server leave as it came", async () => {
    const lost = new CassandraTransportError("Connection timeout", "unreachable", null);
    const { read } = reader(healthy({ [CASSANDRA_AGENT_RELEASE_CQL]: lost }));
    await expect(verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE })).rejects.toBe(
      lost,
    );
  });

  test("lets a client timeout on the kind read leave as it came", async () => {
    const lost = new CassandraTransportError("timed out", "client-timeout", null);
    const { read } = reader(healthy({ [CASSANDRA_AGENT_SCYLLA_CQL]: lost }));
    await expect(verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE })).rejects.toBe(
      lost,
    );
  });
});

describe("what the connection must name", () => {
  test("a role: a connection that authenticates none is refused before anything is read", async () => {
    const { asked, read } = reader(healthy());
    const error = await verifyCassandraAgentProfile(read, { role: "", keyspace: "probe", nonce: NONCE }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ExecutionProfileError);
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_NARROW");
    expect((error as Error).message).toBe(
      "The agent read-only execution profile needs the connection to sign in as a role holding only SELECT on its keyspace; this connection names no role, so no read-only boundary can be proven. Set the agent user and password to such a role.",
    );
    expect(asked).toEqual([]);
  });

  test("a keyspace: a connection bound to none is refused before anything is read", async () => {
    const { asked, read } = reader(healthy());
    const error = await verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "", nonce: NONCE }).catch(
      (failure: unknown) => failure,
    );
    expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect((error as Error).message).toBe(
      "The agent read-only execution profile reads one keyspace, the connection's own, and this connection names none, so the role's reach cannot be bounded. Set the keyspace on the connection.",
    );
    expect(asked).toEqual([]);
  });
});

describe("the role listing", () => {
  test("refuses a superuser", async () => {
    const statements = cassandraAgentStatements("agent_super", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_super", true)]),
        // Measured: a superuser's own permission listing answers no columns at all (capture 03).
        [statements.permissions]: NO_COLUMNS,
        [statements.masks]: NO_COLUMNS,
      },
      "agent_super",
    );
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Cassandra role agent_super: it is a superuser (agent_super), whom no grant restricts. Connect as a role that is no superuser, holds no superuser role, and holds only SELECT on the keyspace probe or on its tables.",
    );
  });

  test("refuses a role granted a superuser role, two levels down", async () => {
    const statements = cassandraAgentStatements("agent_inherit_super", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_inherit_super"), roleRow("super_inner", true)]),
        [statements.permissions]: rows([permissionRow("agent_inherit_super", "<keyspace probe>", "SELECT")]),
        [statements.masks]: NO_COLUMNS,
      },
      "agent_inherit_super",
    );
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain("it is a superuser (super_inner), whom no grant restricts");
  });

  test("refuses a listing that does not name the role itself", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(healthy({ [statements.roles]: rows([roleRow("someone_else")]) }));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile could not read the Cassandra role agent_ro's own roles and permissions in the shape the server answers them, so its reach is unproven and the connection is refused.",
    );
  });

  test("refuses a role row whose superuser flag is not a boolean", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(healthy({ [statements.roles]: rows([{ ...roleRow("agent_ro"), super: "false" }]) }));
    expect(error.message).toContain("could not read the Cassandra role agent_ro's own roles and permissions");
  });

  test("refuses a role row without a role name", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(healthy({ [statements.roles]: rows([{ ...roleRow("agent_ro"), role: null }]) }));
    expect(error.message).toContain("could not read the Cassandra role agent_ro's own roles and permissions");
  });

  test("refuses a server that will not list the role to itself: no authenticator signs anyone in there", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.roles]: unauthorized("You have to be logged in and not anonymous to perform this request"),
      }),
    );
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a server that enforces its roles' grants (PasswordAuthenticator and CassandraAuthorizer); this server refused to list the role agent_ro's own roles to it, which such a server answers, so its enforcement is unproven and the connection is refused.",
    );
  });

  test("lets a lost connection during the listing leave as it came", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const lost = new CassandraTransportError("All host(s) tried for query failed", "unreachable", null);
    const { read } = reader(healthy({ [statements.roles]: lost }));
    await expect(verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE })).rejects.toBe(
      lost,
    );
  });
});

describe("the permission listing", () => {
  test("refuses AllowAllAuthorizer, which will not list a permission (capture 07)", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.permissions]: new CassandraTransportError(
          "LIST PERMISSIONS operation is not supported by AllowAllAuthorizer",
          "invalid",
          8704,
        ),
      }),
    );
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a server that enforces its roles' grants (PasswordAuthenticator and CassandraAuthorizer); this server refused to list the role agent_ro's own permissions to it, which such a server answers, so its enforcement is unproven and the connection is refused.",
    );
  });

  test("refuses MODIFY on a second keyspace, naming the grant and its revoke", async () => {
    const statements = cassandraAgentStatements("agent_modify", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_modify")]),
        [statements.permissions]: rows([
          permissionRow("agent_modify", "<keyspace other>", "MODIFY"),
          permissionRow("agent_modify", "<keyspace probe>", "SELECT"),
        ]),
        [statements.masks]: NO_COLUMNS,
      },
      "agent_modify",
    );
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Cassandra role agent_modify: it holds MODIFY on <keyspace other> (granted to agent_modify), and the profile admits only SELECT on the keyspace probe or on its tables. Connect as a role that is no superuser, holds no superuser role, and holds only SELECT on the keyspace probe or on its tables.",
    );
  });

  test("refuses MODIFY a granted role holds, naming the role that holds it", async () => {
    const statements = cassandraAgentStatements("agent_inherit", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_inherit"), roleRow("writer_inner"), roleRow("writer_middle")]),
        [statements.permissions]: rows([
          permissionRow("agent_inherit", "<keyspace probe>", "SELECT"),
          permissionRow("writer_inner", "<keyspace probe>", "MODIFY"),
        ]),
        [statements.masks]: NO_COLUMNS,
      },
      "agent_inherit",
    );
    expect(error.message).toContain("it holds MODIFY on <keyspace probe> (granted to writer_inner)");
  });

  test("refuses SELECT on every keyspace", async () => {
    const statements = cassandraAgentStatements("agent_allks", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_allks")]),
        [statements.permissions]: rows([permissionRow("agent_allks", "<all keyspaces>", "SELECT")]),
        [statements.masks]: NO_COLUMNS,
      },
      "agent_allks",
    );
    expect(error.message).toContain("it holds SELECT on <all keyspaces> (granted to agent_allks)");
  });

  test("refuses EXECUTE on a function, which runs code on the server", async () => {
    const statements = cassandraAgentStatements("agent_exec", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_exec")]),
        [statements.permissions]: rows([
          permissionRow("agent_exec", "<keyspace probe>", "SELECT"),
          permissionRow("agent_exec", "<function probe.plus_one(int)>", "EXECUTE"),
        ]),
        [statements.masks]: NO_COLUMNS,
      },
      "agent_exec",
    );
    expect(error.message).toContain("it holds EXECUTE on <function probe.plus_one(int)> (granted to agent_exec)");
  });

  test("refuses every permission but SELECT, a read such as UNMASK or DESCRIBE included", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.permissions]: rows([
          permissionRow("agent_ro", "<keyspace probe>", "SELECT"),
          permissionRow("agent_ro", "<keyspace probe>", "UNMASK"),
          permissionRow("agent_ro", "<all roles>", "DESCRIBE"),
        ]),
      }),
    );
    expect(error.message).toContain(
      "it holds UNMASK on <keyspace probe> (granted to agent_ro); it holds DESCRIBE on <all roles> (granted to agent_ro)",
    );
  });

  test("refuses SELECT on a keyspace whose name only starts like the bound one", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.permissions]: rows([
          permissionRow("agent_ro", "<keyspace probe>", "SELECT"),
          permissionRow("agent_ro", "<keyspace probe2>", "SELECT"),
          permissionRow("agent_ro", "<table probe2.t>", "SELECT"),
          permissionRow("agent_ro", "<table PROBE.t>", "SELECT"),
        ]),
      }),
    );
    expect(error.message).toContain("it holds SELECT on <keyspace probe2> (granted to agent_ro)");
    expect(error.message).toContain("it holds SELECT on <table probe2.t> (granted to agent_ro)");
    expect(error.message).toContain("it holds SELECT on <table PROBE.t> (granted to agent_ro)");
  });

  test("refuses a table resource of any shape but one table name in the bound keyspace", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.permissions]: rows([
          permissionRow("agent_ro", "<keyspace probe>", "SELECT"),
          permissionRow("agent_ro", "<table probe.>", "SELECT"),
          permissionRow("agent_ro", "<table probe.a.b>", "SELECT"),
          permissionRow("agent_ro", "<table probe.t", "SELECT"),
        ]),
      }),
    );
    expect(error.message).toContain("it holds SELECT on <table probe.> (granted to agent_ro)");
    expect(error.message).toContain("it holds SELECT on <table probe.a.b> (granted to agent_ro)");
    expect(error.message).toContain("it holds SELECT on <table probe.t (granted to agent_ro)");
  });

  test("refuses a role holding no permission at all as too narrow", async () => {
    const statements = cassandraAgentStatements("agent_none", "probe", NONCE);
    const error = await refusal(
      {
        ...healthy(),
        [statements.roles]: rows([roleRow("agent_none")]),
        [statements.permissions]: NO_COLUMNS,
        [statements.masks]: NO_COLUMNS,
      },
      "agent_none",
    );
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_NARROW");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a role holding SELECT on the keyspace probe or on its tables, and the role agent_none holds none, so it cannot read it. Grant it SELECT ON KEYSPACE probe.",
    );
  });

  test("refuses a permission row it cannot read", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.permissions]: rows([{ ...permissionRow("agent_ro", "<keyspace probe>", "SELECT"), permission: 1 }]),
      }),
    );
    expect(error.message).toContain("could not read the Cassandra role agent_ro's own roles and permissions");
  });

  test("names every finding once, the superuser and the grants together", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.roles]: rows([roleRow("agent_ro", true)]),
        [statements.permissions]: rows([permissionRow("agent_ro", "<keyspace other>", "MODIFY")]),
      }),
    );
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Cassandra role agent_ro: it is a superuser (agent_ro), whom no grant restricts; it holds MODIFY on <keyspace other> (granted to agent_ro), and the profile admits only SELECT on the keyspace probe or on its tables. Connect as a role that is no superuser, holds no superuser role, and holds only SELECT on the keyspace probe or on its tables.",
    );
  });
});

describe("the column masks", () => {
  test("refuse a column masked by a function outside the system keyspace, which a SELECT runs (capture 02)", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.masks]: rows([
          {
            keyspace_name: "probe",
            table_name: "masked",
            column_name: "builtin_masked",
            function_keyspace: "system",
            function_name: "mask_default",
          },
          {
            keyspace_name: "probe",
            table_name: "masked",
            column_name: "udf_masked",
            function_keyspace: "probe",
            function_name: "redact",
          },
        ]),
      }),
    );
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Cassandra role agent_ro: the column probe.masked.udf_masked is masked with the user-defined function probe.redact, which a SELECT of it runs on the server without EXECUTE. Connect as a role that is no superuser, holds no superuser role, and holds only SELECT on the keyspace probe or on its tables, and mask its columns with the system keyspace's functions only.",
    );
  });

  test("judge a mask by its function's keyspace, never its name: a user function named like a built-in is refused", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.masks]: rows([
          {
            keyspace_name: "probe",
            table_name: "masked",
            column_name: "c",
            function_keyspace: "probe",
            function_name: "mask_default",
          },
        ]),
      }),
    );
    expect(error.message).toContain(
      "the column probe.masked.c is masked with the user-defined function probe.mask_default",
    );
  });

  test("refuse a mask row whose function keyspace cannot be read", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.masks]: rows([
          { keyspace_name: "probe", table_name: "t", column_name: "c", function_keyspace: null, function_name: "f" },
        ]),
      }),
    );
    expect(error.message).toContain("the column probe.t.c is masked with the user-defined function null.f");
  });

  test("a mask read the server refuses leaves the check failed, never admitted", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const refused = unauthorized("no SELECT permission on <table system_schema.column_masks>");
    const { read } = reader(healthy({ [statements.masks]: refused }));
    await expect(verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE })).rejects.toBe(
      refused,
    );
  });
});

describe("the enforcement probe", () => {
  test("refuses a server that accepts the drop of a table no one holds", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(healthy({ [statements.probe]: NO_COLUMNS }));
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a server that enforces its roles' grants, and this one does not: it accepted a DROP TABLE IF EXISTS the role agent_ro holds no DROP for (the table does not exist, so nothing changed). Turn on CassandraAuthorizer, and connect as a role holding only SELECT on the keyspace probe.",
    );
  });

  test("refuses a probe answered with anything but Unauthorized", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({ [statements.probe]: new CassandraTransportError("keyspace probe does not exist", "invalid", 8704) }),
    );
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(
      "The agent read-only execution profile needs a server that refuses the role agent_ro a DROP it holds no grant for, as Unauthorized; this server answered keyspace probe does not exist instead, so its enforcement is unproven and the connection is refused.",
    );
  });

  test("lets a timeout on the probe leave as it came", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const lost = new CassandraTransportError("timed out", "client-timeout", null);
    const { read } = reader(healthy({ [statements.probe]: lost }));
    await expect(verifyCassandraAgentProfile(read, { role: "agent_ro", keyspace: "probe", nonce: NONCE })).rejects.toBe(
      lost,
    );
  });
});

describe("a check read the server pages", () => {
  const paged = (result: CassandraQueryResult): CassandraQueryResult => ({ ...result, pageState: "0400000001" });
  const unread = (what: string) =>
    `The agent read-only execution profile could not read the Cassandra role agent_ro's whole ${what} in one page, so a finding past it would go unseen, and the connection is refused.`;

  test("refuses a role listing that is not the last page", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(healthy({ [statements.roles]: paged(rows([roleRow("agent_ro")])) }));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(unread("roles listing"));
  });

  test("refuses a permission listing that is not the last page", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(
      healthy({
        [statements.permissions]: paged(rows([permissionRow("agent_ro", "<keyspace probe>", "SELECT")])),
      }),
    );
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(unread("permissions listing"));
  });

  test("refuses a mask read that is not the last page, even when the page it read holds no finding", async () => {
    const statements = cassandraAgentStatements("agent_ro", "probe", NONCE);
    const error = await refusal(healthy({ [statements.masks]: paged(NO_COLUMNS) }));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(unread("column masks of the keyspace probe"));
  });
});

describe("the statement fence: one statement, a SELECT, before anything is sent", () => {
  const PREFIX = "The agent read-only execution profile sends one CQL statement, a SELECT, and nothing else";
  const NOT_SELECT = `${PREFIX}; this statement does not begin with SELECT, so it was not sent. A Cassandra role can always change its own password, which no grant stops, so only a SELECT reaches the server.`;
  const MORE = `${PREFIX}; this text goes on after its first statement's semicolon, so it was not sent. Send one SELECT at a time.`;
  const UNREADABLE = `${PREFIX}; this text ends inside a comment, a string or a quoted name, so where it ends cannot be read, and it was not sent.`;
  const TAGGED = `${PREFIX}; this text holds a tagged dollar-quoted run ($tag$ ... $tag$), which CQL does not have, so where its strings end cannot be read, and it was not sent.`;
  const EMPTY = `${PREFIX}; this text holds no statement, so nothing was sent.`;

  test.each([
    ["a plain SELECT", "SELECT id FROM probe.customers"],
    ["a lowercase select", "select id from probe.customers"],
    ["a mixed-case select with no space before its star", "SeLeCt*FROM probe.customers"],
    ["a leading -- comment", "-- the customers\nSELECT id FROM probe.customers"],
    ["a leading // comment", "// the customers\nSELECT id FROM probe.customers"],
    ["a leading block comment", "/* the customers */ SELECT id FROM probe.customers"],
    ["a block comment right after the keyword", "SELECT/* x */id FROM probe.customers"],
    ["one trailing semicolon", "SELECT id FROM probe.customers;"],
    ["a trailing semicolon followed by whitespace and comments", "SELECT id FROM probe.customers ; -- done\n /* x */ "],
    ["a semicolon inside a string literal", "SELECT id FROM probe.customers WHERE name = 'a; DROP TABLE probe.x'"],
    ["a doubled quote inside a string literal", "SELECT id FROM probe.customers WHERE name = 'it''s; fine'"],
    ["a semicolon inside a quoted name", 'SELECT "a;b" FROM probe.customers'],
    ["a semicolon inside a $$ string", "SELECT id FROM probe.customers WHERE name = $$a; DROP TABLE probe.x$$"],
    ["a string inside a subscript", "SELECT m['a;b'] FROM probe.t"],
    ["comment markers inside a string", "SELECT id FROM probe.customers WHERE url = 'http://x/* -- '"],
  ])("admits %s", (_, sql) => {
    expect(cassandraAgentStatementRefusal(sql)).toBeNull();
  });

  test.each([
    ["ALTER ROLE of the role itself", "ALTER ROLE agent_ro WITH PASSWORD = 'not-a-real-password'", NOT_SELECT],
    ["a lowercase alter role", "alter role agent_ro with password = 'not-a-real-password'", NOT_SELECT],
    ["BEGIN BATCH", "BEGIN BATCH INSERT INTO probe.t (id) VALUES (1); APPLY BATCH", NOT_SELECT],
    ["INSERT", "INSERT INTO probe.customers (id, name) VALUES (9, 'x')", NOT_SELECT],
    ["UPDATE", "UPDATE probe.customers SET name = 'x' WHERE id = 1", NOT_SELECT],
    ["DELETE", "DELETE FROM probe.customers WHERE id = 1", NOT_SELECT],
    ["TRUNCATE", "TRUNCATE probe.customers", NOT_SELECT],
    ["DROP", "DROP TABLE probe.customers", NOT_SELECT],
    ["GRANT", "GRANT MODIFY ON KEYSPACE probe TO agent_ro", NOT_SELECT],
    ["USE", "USE other", NOT_SELECT],
    ["LIST ROLES", "LIST ROLES", NOT_SELECT],
    ["a word that only starts like SELECT", "SELECTED id FROM probe.customers", NOT_SELECT],
    ["a word that starts with SELECT and an underscore", "SELECT_x FROM probe.customers", NOT_SELECT],
    ["a SELECT hidden in a leading -- comment", "-- SELECT\nALTER ROLE agent_ro WITH PASSWORD = 'x'", NOT_SELECT],
    ["a SELECT hidden in a leading // comment", "// SELECT\nDELETE FROM probe.customers WHERE id = 1", NOT_SELECT],
    ["a SELECT hidden in a leading block comment", "/* SELECT */ DELETE FROM probe.customers WHERE id = 1", NOT_SELECT],
    ["a statement starting with a semicolon", "; SELECT id FROM probe.customers", NOT_SELECT],
    ["a string where the keyword should be", "'SELECT' id FROM probe.customers", NOT_SELECT],
    ["a quoted name where the keyword should be", '"SELECT" id FROM probe.customers', NOT_SELECT],
    ["a $$ string where the keyword should be", "$$SELECT$$ FROM probe.customers", NOT_SELECT],
    ["a string before the keyword", "'x' SELECT id FROM probe.customers", NOT_SELECT],
    ["a quoted name before the keyword", '"x" SELECT id FROM probe.customers', NOT_SELECT],
    ["a $$ string before the keyword", "$$x$$ SELECT id FROM probe.customers", NOT_SELECT],
    ["a hash, which CQL reads as code", "# x\nSELECT id FROM probe.customers", NOT_SELECT],
    ["a SELECT followed by a second statement", "SELECT id FROM probe.customers; DROP TABLE probe.customers", MORE],
    ["a SELECT followed by ALTER ROLE", "SELECT id FROM probe.customers;ALTER ROLE agent_ro WITH PASSWORD = 'x'", MORE],
    ["a SELECT followed by a second SELECT", "SELECT id FROM probe.a; SELECT id FROM probe.b", MORE],
    ["two semicolons", "SELECT id FROM probe.customers;;", MORE],
    ["a string after the semicolon", "SELECT id FROM probe.customers; 'x'", MORE],
    ["a semicolon inside a subscript", "SELECT [1; 2] FROM probe.t", MORE],
    ["an unterminated block comment", "SELECT id FROM probe.customers /* ; DROP TABLE probe.x", UNREADABLE],
    ["an unterminated string", "SELECT id FROM probe.customers WHERE name = 'x; DROP", UNREADABLE],
    ["an unterminated quoted name", 'SELECT "x FROM probe.customers', UNREADABLE],
    ["a tagged dollar-quoted run", "SELECT $t$x; DROP TABLE probe.x; $t$ FROM probe.t", TAGGED],
    ["nothing", "", EMPTY],
    ["whitespace only", " \n\t ", EMPTY],
    ["comments only", "-- SELECT\n/* SELECT */ // x\n", EMPTY],
  ])("refuses %s", (_, sql, reason) => {
    expect(cassandraAgentStatementRefusal(sql)).toBe(reason);
  });
});
