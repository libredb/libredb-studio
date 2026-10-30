/**
 * The Neo4j agent principal proof, over what three 5.26.31 servers answered each principal
 * (`tests/fixtures/neo4j/5.26.31/agent-boundary/`, recorded by its run.sh): the reader with PUBLIC's LOAD revoked is
 * admitted, and every principal or server the boundary cannot hold is refused by the step that names it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  type GraphClient,
  GraphClientError,
  type GraphRunOptions,
  type GraphRunResult,
} from "@/lib/db/graph/bolt/client";
import {
  NEO4J_AGENT_PROOF_ROW_BOUND,
  NEO4J_AGENT_PROOF_STATEMENTS,
  proveNeo4jAgentPrincipal,
} from "@/lib/db/providers/graph/neo4j/agent-boundary";
import { NEO4J_BUILT_IN_ROUTINES } from "@/lib/db/providers/graph/neo4j/agent-builtins";
import { NEO4J_FIXTURES, neo4jCapture, recordedGraphClient } from "../../../helpers/neo4j-fixtures";

const BOUNDARY = join(NEO4J_FIXTURES, "agent-boundary");
const at = (principal: string) => join(BOUNDARY, principal);
const OPTIONS = { database: "neo4j", timeoutMs: 5000 };
const STATEMENTS: readonly string[] = Object.values(NEO4J_AGENT_PROOF_STATEMENTS);

/** The proof over one principal's captures, or a client of the test's own. */
async function prove(principal: string | Pick<GraphClient, "run">) {
  const client = typeof principal === "string" ? recordedGraphClient(at(principal)) : principal;
  return proveNeo4jAgentPrincipal(client, OPTIONS);
}

async function refusal(principal: string | Pick<GraphClient, "run">): Promise<ExecutionProfileError> {
  try {
    await prove(principal);
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionProfileError);
    return error as ExecutionProfileError;
  }
  throw new Error("the proof admitted the principal");
}

/** The agent's captures, with one statement answered by the test. */
function agentWith(
  statement: string,
  answer: GraphRunResult | Error,
): Pick<GraphClient, "run"> & {
  calls: string[];
} {
  const recorded = recordedGraphClient(at("agent"));
  const calls: string[] = [];
  return {
    calls,
    async run(text: string, options: GraphRunOptions) {
      calls.push(text);
      if (text === statement) {
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return recorded.run(text, options);
    },
  };
}

const rowsOf = (principal: string, capture: string) =>
  neo4jCapture(capture, at(principal)).result?.rows as Record<string, unknown>[];

describe("the pinned built-in routines", () => {
  test("are exactly what the administrator of a stock 5.26.31 Enterprise server lists", () => {
    const names = (capture: string) =>
      rowsOf("admin", capture)
        .map((row) => row.name as string)
        .sort();
    expect([...NEO4J_BUILT_IN_ROUTINES["5.26.31"].procedures]).toEqual(names("show-procedures-all"));
    expect([...NEO4J_BUILT_IN_ROUTINES["5.26.31"].functions]).toEqual(names("show-functions-all"));
  });

  test("the proof's statements are the captured ones, each read under the proof's own row bound", () => {
    for (const capture of ["components", "current-user", "privileges", "procedures", "functions"]) {
      const { statement, options } = neo4jCapture(`proof-${capture}`, at("agent"));
      expect(STATEMENTS).toContain(statement as string);
      expect(options).toEqual({ database: "neo4j", maxRows: NEO4J_AGENT_PROOF_ROW_BOUND });
    }
  });
});

describe("proveNeo4jAgentPrincipal", () => {
  test("admits a reader whose roles hold no LOAD and no write, on the connection's database, in five reads", async () => {
    const client = recordedGraphClient(at("agent"));
    await proveNeo4jAgentPrincipal(client, OPTIONS);
    expect(client.calls.map((call) => call.statement)).toEqual([...STATEMENTS]);
    for (const call of client.calls) {
      expect(call.options).toEqual({ ...OPTIONS, maxRows: NEO4J_AGENT_PROOF_ROW_BOUND });
    }
  });

  test("passes the caller's signal on to every read", async () => {
    const signal = new AbortController().signal;
    const client = recordedGraphClient(at("agent"));
    await proveNeo4jAgentPrincipal(client, { ...OPTIONS, signal });
    expect(client.calls.every((call) => call.options.signal === signal)).toBe(true);
  });

  test("admits a principal a role denies LOAD ON ALL DATA, though another role grants it, since a denial wins", async () => {
    await prove("denied");
    expect(neo4jCapture("load-csv-file", at("denied")).error?.code).toBe("Neo.ClientError.Security.Forbidden");
  });

  test("admits a principal denied the extension's procedures and functions, which then lists only built-ins", async () => {
    await prove("ext_denied");
  });

  test("refuses Community Edition by name, after the components read alone", async () => {
    const client = recordedGraphClient(at("community"));
    const error = await refusal(client);
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toBe(
      "The agent read-only profile needs Neo4j Enterprise Edition, and this server is Neo4j Community Edition, which has no roles and gives every user an administrator's privileges, so no user on it can be proved read-only, and LOAD CSV, a read clause, reaches files and URLs even on a read-only database there. Connect an Enterprise server as a user that only reads. Nothing else was sent.",
    );
    expect(client.calls.map((call) => call.statement)).toEqual([NEO4J_AGENT_PROOF_STATEMENTS.components]);
  });

  test("refuses a server that claims Enterprise but answers no roles, as Community does", async () => {
    const community = recordedGraphClient(at("community"));
    const enterprise = recordedGraphClient(at("agent"));
    const lying: Pick<GraphClient, "run"> = {
      run: (text, options) =>
        text === NEO4J_AGENT_PROOF_STATEMENTS.components ? enterprise.run(text, options) : community.run(text, options),
    };
    const error = await refusal(lying);
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("reports Enterprise Edition but answers SHOW CURRENT USER with no roles");
  });

  test("refuses a server that claims Enterprise but refuses SHOW USER PRIVILEGES as unsupported", async () => {
    const community = recordedGraphClient(at("community"));
    const error = await refusal(
      agentWith(
        NEO4J_AGENT_PROOF_STATEMENTS.privileges,
        await community.run(NEO4J_AGENT_PROOF_STATEMENTS.privileges, { ...OPTIONS, maxRows: 10 }).catch((e) => e),
      ),
    );
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("reports Enterprise Edition but refuses SHOW USER PRIVILEGES as unsupported");
  });

  test.each([
    ["an edition field missing", { name: "Neo4j Kernel", versions: ["5.26.31"] }, "unread"],
    ["an edition that is not a string", { name: "Neo4j Kernel", versions: ["5.26.31"], edition: 1 }, "unread"],
    ["no versions", { name: "Neo4j Kernel", edition: "enterprise" }, "unread"],
    ["an edition no one ships", { name: "Neo4j Kernel", versions: ["5.26.31"], edition: "aura" }, "edition"],
    [
      "a version with no pinned routines",
      { name: "Neo4j Kernel", versions: ["5.26.32"], edition: "enterprise" },
      "version",
    ],
  ])("refuses a components answer with %s", async (_label, row, kind) => {
    const error = await refusal(
      agentWith(NEO4J_AGENT_PROOF_STATEMENTS.components, {
        fields: ["name", "versions", "edition"],
        rows: [row],
        truncated: false,
      }),
    );
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    const expected = {
      unread: "could not read the server's answer to CALL dbms.components()",
      edition: 'reports the edition "aura"',
      version: "pins the built-in procedures and functions of Neo4j 5.26.31, and this server is 5.26.32",
    }[kind as "unread" | "edition" | "version"];
    expect(error.message).toContain(expected);
  });

  test.each([0, 2])("refuses a components answer with %i kernel rows", async (count) => {
    const kernel = rowsOf("agent", "proof-components")[0];
    const rows = Array.from({ length: count }, () => kernel);
    const error = await refusal(
      agentWith(NEO4J_AGENT_PROOF_STATEMENTS.components, { fields: ["name"], rows, truncated: false }),
    );
    expect(error.message).toContain("could not read the server's answer to CALL dbms.components()");
  });

  test("refuses the stock reader, whose LOAD comes from PUBLIC", async () => {
    const error = await refusal("reader_stock");
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only profile needs a user that cannot LOAD, since LOAD CSV is a read clause that reaches files and URLs, and this one holds LOAD on ALL DATA through the role PUBLIC. Revoke LOAD from PUBLIC and from every role the user holds, or DENY LOAD ON ALL DATA to one of its roles. Nothing else was sent.",
    );
  });

  test("refuses a principal that gains LOAD through a second role", async () => {
    expect((await refusal("loader")).message).toContain("holds LOAD on ALL DATA through the role csv_loader");
    expect(neo4jCapture("load-csv-file", at("loader")).outcome).toBe("pass");
  });

  test("refuses LOAD on a CIDR range as LOAD", async () => {
    expect((await refusal("cidr")).message).toContain("holds LOAD on CIDR('10.0.0.0/8') through the role cidr_loader");
  });

  test.each([
    ["editor", "write on NODE(*) through the role editor"],
    ["boosted", "execute_boosted on PROCEDURE(*) through the role boosted"],
  ])("refuses %s, whose roles hold more than a read", async (principal, words) => {
    const error = await refusal(principal);
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain(words);
    expect(error.message).toContain("needs a user that only reads");
  });

  test("refuses the administrator, on the first privilege past a read it lists", async () => {
    const error = await refusal("admin");
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain("through the role admin");
  });

  test("refuses a reader that can execute the test extension's procedure, by name", async () => {
    const error = await refusal("ext_agent");
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only profile needs a user that can execute only Neo4j 5.26.31's built-in procedures and functions, and this one can execute the procedure libredbtest.touch, which is not one of them: an extension runs Java inside the server, where a read can reach the network or the file system. DENY EXECUTE PROCEDURE and DENY EXECUTE USER DEFINED FUNCTION on the extension's names to one of the user's roles, or remove the extension. Nothing else was sent.",
    );
  });

  test("refuses a function outside the built-ins once the procedures are clean", async () => {
    const functions = rowsOf("ext_agent", "proof-functions");
    const error = await refusal(
      agentWith(NEO4J_AGENT_PROOF_STATEMENTS.functions, { fields: ["name"], rows: functions, truncated: false }),
    );
    expect(error.message).toContain("can execute the function libredbtest.touchFn");
  });

  test("refuses the widened principal on the proof after the grant, having admitted it before", async () => {
    await prove("widened-before");
    expect((await refusal("widened-after")).message).toContain("holds LOAD on ALL DATA through the role csv_loader");
  });

  test.each(STATEMENTS)("refuses when %s fails, naming it", async (statement) => {
    const error = await refusal(agentWith(statement, new Error("socket closed")));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain(`could not read the server's answer to ${statement.split(" YIELD")[0]}`);
  });

  test("reads another server error on SHOW USER PRIVILEGES as unread, never as Community", async () => {
    const forbidden = new GraphClientError("auth", "not allowed", "Neo.ClientError.Security.Forbidden");
    const error = await refusal(agentWith(NEO4J_AGENT_PROOF_STATEMENTS.privileges, forbidden));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    expect(error.message).toContain("could not read the server's answer to SHOW USER PRIVILEGES");
    expect(error.message).not.toContain("Community");
  });

  test.each(STATEMENTS)("refuses when %s is cut at the row bound", async (statement) => {
    const error = await refusal(agentWith(statement, { fields: ["name"], rows: [], truncated: true }));
    expect(error.message).toContain(`could not read the server's answer to ${statement.split(" YIELD")[0]}`);
  });

  test("a cancel is the cancel, not a refusal", async () => {
    const cancelled = new Error("cancelled");
    const signal = AbortSignal.abort();
    const client: Pick<GraphClient, "run"> = {
      async run() {
        throw cancelled;
      },
    };
    await expect(proveNeo4jAgentPrincipal(client, { ...OPTIONS, signal })).rejects.toBe(cancelled);
  });

  test.each<[string, Record<string, unknown>[]]>([
    ["a user row naming another user", [{ user: "someone", roles: ["PUBLIC"] }]],
    ["roles that are not strings", [{ user: "agent", roles: [1] }]],
    ["no user", [{ roles: ["PUBLIC"] }]],
    [
      "a second row",
      [
        { user: "agent", roles: ["PUBLIC"] },
        { user: "agent", roles: ["PUBLIC", "admin"] },
      ],
    ],
  ])("refuses SHOW CURRENT USER answering %s", async (_label, rows) => {
    const answer = { fields: ["user", "roles"], rows, truncated: false };
    const message = (await refusal(agentWith(NEO4J_AGENT_PROOF_STATEMENTS.currentUser, answer))).message;
    expect(message).toMatch(/could not read the server's answer to (SHOW CURRENT USER|SHOW USER PRIVILEGES)/);
  });

  test.each([
    ["another user's row", { user: "someone" }],
    ["an access that is neither GRANTED nor DENIED", { access: "MAYBE" }],
    ["no action", { action: undefined }],
    ["no segment", { segment: undefined }],
    ["no role", { role: undefined }],
  ])("refuses a privilege listing with %s", async (_label, change) => {
    const [first, ...rest] = rowsOf("agent", "proof-privileges");
    const rows = [{ ...first, ...change }, ...rest];
    const answer = { fields: Object.keys(rows[1]), rows, truncated: false };
    const error = await refusal(agentWith(NEO4J_AGENT_PROOF_STATEMENTS.privileges, answer));
    expect(error.message).toContain("could not read the server's answer to SHOW USER PRIVILEGES");
  });

  test("a denial of LOAD on a CIDR range does not override a grant on ALL DATA", async () => {
    const rows = [
      ...rowsOf("loader", "proof-privileges"),
      {
        access: "DENIED",
        action: "load",
        resource: "file",
        graph: "*",
        segment: "CIDR('10.0.0.0/8')",
        role: "x",
        user: "loader",
      },
    ];
    const loader = recordedGraphClient(at("loader"));
    const client: Pick<GraphClient, "run"> = {
      run: (text, options) =>
        text === NEO4J_AGENT_PROOF_STATEMENTS.privileges
          ? Promise.resolve({ fields: Object.keys(rows[0]), rows, truncated: false })
          : loader.run(text, options),
    };
    expect((await refusal(client)).message).toContain("holds LOAD on ALL DATA through the role csv_loader");
  });

  test("a current-user row with no roles field at all is answered as Community answers", async () => {
    const answer = { fields: ["user"], rows: [{ user: "agent" }], truncated: false };
    const error = await refusal(agentWith(NEO4J_AGENT_PROOF_STATEMENTS.currentUser, answer));
    expect(error.message).toContain("answers SHOW CURRENT USER with no roles");
  });

  test("refuses an execute privilege on anything but procedures or functions", async () => {
    const rows = [
      ...rowsOf("agent", "proof-privileges"),
      {
        access: "GRANTED",
        action: "execute",
        resource: "database",
        graph: "*",
        segment: "DATABASE",
        role: "x",
        user: "agent",
      },
    ];
    const answer = { fields: Object.keys(rows[0]), rows, truncated: false };
    const error = await refusal(agentWith(NEO4J_AGENT_PROOF_STATEMENTS.privileges, answer));
    expect(error.message).toContain("holds execute on DATABASE through the role x");
  });

  test("a denied action never refuses, whatever it is", async () => {
    const rows = [
      ...rowsOf("agent", "proof-privileges"),
      {
        access: "DENIED",
        action: "write",
        resource: "graph",
        graph: "*",
        segment: "NODE(*)",
        role: "x",
        user: "agent",
      },
    ];
    await prove(
      agentWith(NEO4J_AGENT_PROOF_STATEMENTS.privileges, { fields: Object.keys(rows[0]), rows, truncated: false }),
    );
  });

  test.each([NEO4J_AGENT_PROOF_STATEMENTS.procedures, NEO4J_AGENT_PROOF_STATEMENTS.functions])(
    "refuses a name in %s that is not a string",
    async (statement) => {
      const error = await refusal(agentWith(statement, { fields: ["name"], rows: [{ name: 7 }], truncated: false }));
      expect(error.message).toContain(`could not read the server's answer to ${statement.split(" YIELD")[0]}`);
    },
  );
});
