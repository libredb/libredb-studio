/**
 * The Neo4j agent principal proof: what the server must answer before an agent statement is sent.
 *
 * Neo4j has no read-only session a principal cannot leave: a READ session refuses writes, but `LOAD CSV` is a read
 * clause that fetches files and URLs, and a procedure or function an extension adds runs Java in the server's process
 * from a READ-mode call. So the boundary is the principal, and the server proves it from its own answers, every time,
 * with no verdict kept:
 *
 * 1. `dbms.components()` names Neo4j Enterprise Edition at a version whose built-in routines are pinned
 *    (`agent-builtins.ts`). Community Edition is refused by name: it has no roles, every user holds an administrator's
 *    privileges, and `LOAD CSV` answers even on a read-only database there (captured as `community/load-csv-file`).
 * 2. `SHOW CURRENT USER` names the user and a list of roles, and `SHOW USER PRIVILEGES` lists that user's privileges
 *    across every role it holds, PUBLIC included. A server that answers no roles, or refuses the listing as
 *    unsupported, is answering as Community does, whatever edition it reports, and is refused.
 * 3. Every GRANTED privilege is a read: access, traverse, read, match, show_index, show_constraint, or execute on
 *    procedures or functions. Any other granted action (write, an administrator's, execute_boosted) refuses the
 *    principal. A granted LOAD, on ALL DATA or a CIDR range, refuses it too, unless one of its roles is DENIED LOAD ON
 *    ALL DATA, which wins over any grant (captured as `denied/load-csv-file`). A DENIED row only narrows, so it never
 *    refuses.
 * 4. `SHOW PROCEDURES EXECUTABLE BY CURRENT USER` and `SHOW FUNCTIONS EXECUTABLE BY CURRENT USER` list only names of the
 *    pinned built-in set, so a principal that can execute any extension, APOC included, is refused.
 *
 * Any answer other than the measured shapes refuses the profile (fail closed), and a read cut at its row bound is not
 * read. The five reads run on the connection's database through the handle's own client, before the statement and
 * under its deadline: privileges are checked per transaction against the system graph (a DENY added or lifted on a
 * running driver took effect on its next transaction, measured on 5.26.31), so a privilege widened since the open is
 * caught on the next call.
 */
import { ExecutionProfileError } from "@/lib/db/errors";
import { type GraphClient, GraphClientError, type GraphRunResult } from "@/lib/db/graph/bolt/client";
import { NEO4J_BUILT_IN_ROUTINES } from "./agent-builtins";
import { NEO4J_MONITORING_STATEMENTS } from "./monitoring-reads";

/**
 * The five reads of the proof, each sent on the connection's database; the server routes the administration
 * commands to `system` itself. Fixed text, never the caller's.
 */
export const NEO4J_AGENT_PROOF_STATEMENTS = Object.freeze({
  components: NEO4J_MONITORING_STATEMENTS.components,
  currentUser: "SHOW CURRENT USER YIELD user, roles",
  privileges: "SHOW USER PRIVILEGES YIELD access, action, resource, graph, segment, role, user",
  procedures: "SHOW PROCEDURES EXECUTABLE BY CURRENT USER YIELD name",
  functions: "SHOW FUNCTIONS EXECUTABLE BY CURRENT USER YIELD name",
});

/** The most rows any proof read may answer; a cut answer is not read. */
export const NEO4J_AGENT_PROOF_ROW_BOUND = 1000;

/** The granted actions a reader holds: the `reader` role's and PUBLIC's, LOAD apart. */
const READ_ACTIONS: ReadonlySet<string> = new Set([
  "access",
  "traverse",
  "read",
  "match",
  "show_index",
  "show_constraint",
]);

/** The status code 5.26.31 Community answers `SHOW USER PRIVILEGES` with. */
const UNSUPPORTED_ADMINISTRATION = "Neo.ClientError.Statement.UnsupportedAdministrationCommand";

const NOTHING_ELSE = "Nothing else was sent.";

export interface Neo4jAgentProofOptions {
  /** The connection's database: the one every agent statement runs on. */
  readonly database: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

interface Privilege {
  readonly access: "GRANTED" | "DENIED";
  readonly action: string;
  readonly segment: string;
  readonly role: string;
}

function unsupported(message: string): ExecutionProfileError {
  return new ExecutionProfileError(`${message} ${NOTHING_ELSE}`, "PROFILE_UNSUPPORTED_TARGET");
}

function tooBroad(message: string): ExecutionProfileError {
  return new ExecutionProfileError(`${message} ${NOTHING_ELSE}`, "PROFILE_PRIVILEGES_TOO_BROAD");
}

/** The read's name as a refusal names it: the statement up to its YIELD. */
function readName(statement: string): string {
  return statement.split(" YIELD")[0] as string;
}

function unread(statement: string): ExecutionProfileError {
  return unsupported(
    `The agent read-only profile could not read the server's answer to ${readName(statement)}, so this user is not proved read-only and is refused.`,
  );
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Proves the connection's user reads only, from the server's own answers; throws the refusal, never a verdict to keep. */
export async function proveNeo4jAgentPrincipal(
  client: Pick<GraphClient, "run">,
  options: Neo4jAgentProofOptions,
): Promise<void> {
  const read = async (statement: string): Promise<GraphRunResult> => {
    let result: GraphRunResult;
    try {
      result = await client.run(statement, {
        database: options.database,
        timeoutMs: options.timeoutMs,
        maxRows: NEO4J_AGENT_PROOF_ROW_BOUND,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // A cancel or a deadline is the call's own end, reported as itself.
      if (options.signal?.aborted) throw error;
      if (
        statement === NEO4J_AGENT_PROOF_STATEMENTS.privileges &&
        error instanceof GraphClientError &&
        error.code === UNSUPPORTED_ADMINISTRATION
      ) {
        throw unsupported(
          "The agent read-only profile needs Neo4j Enterprise Edition, and this server reports Enterprise Edition but refuses SHOW USER PRIVILEGES as unsupported, as Community Edition does, so it is refused.",
        );
      }
      throw unread(statement);
    }
    if (result.truncated) throw unread(statement);
    return result;
  };

  const version = provedEdition(await read(NEO4J_AGENT_PROOF_STATEMENTS.components));
  const user = provedUser(await read(NEO4J_AGENT_PROOF_STATEMENTS.currentUser));
  const privileges = provedPrivileges(await read(NEO4J_AGENT_PROOF_STATEMENTS.privileges), user);
  assertOnlyReads(privileges);
  const builtIn = NEO4J_BUILT_IN_ROUTINES[version] as (typeof NEO4J_BUILT_IN_ROUTINES)[string];
  assertBuiltIn(await read(NEO4J_AGENT_PROOF_STATEMENTS.procedures), builtIn.procedures, "procedure", version);
  assertBuiltIn(await read(NEO4J_AGENT_PROOF_STATEMENTS.functions), builtIn.functions, "function", version);
}

/** The kernel row's version, when the edition is Enterprise and the version's routines are pinned. */
function provedEdition(result: GraphRunResult): string {
  const statement = NEO4J_AGENT_PROOF_STATEMENTS.components;
  const kernels = result.rows.filter((row) => row.name === "Neo4j Kernel");
  const kernel = kernels.length === 1 ? kernels[0] : undefined;
  const versions = kernel?.versions;
  const version = Array.isArray(versions) ? versions[0] : undefined;
  const edition = kernel?.edition;
  if (!isString(version) || !isString(edition)) throw unread(statement);
  if (edition === "community") {
    throw unsupported(
      "The agent read-only profile needs Neo4j Enterprise Edition, and this server is Neo4j Community Edition, which has no roles and gives every user an administrator's privileges, so no user on it can be proved read-only, and LOAD CSV, a read clause, reaches files and URLs even on a read-only database there. Connect an Enterprise server as a user that only reads.",
    );
  }
  if (edition !== "enterprise") {
    throw unsupported(
      `The agent read-only profile needs Neo4j Enterprise Edition, and this server reports the edition ${JSON.stringify(edition)}, so it is refused.`,
    );
  }
  if (!Object.hasOwn(NEO4J_BUILT_IN_ROUTINES, version)) {
    throw unsupported(
      `The agent read-only profile pins the built-in procedures and functions of Neo4j ${Object.keys(NEO4J_BUILT_IN_ROUTINES).join(", ")}, and this server is ${version}, whose built-ins it cannot tell from an extension's, so it is refused.`,
    );
  }
  return version;
}

/** The current user's name, when the server answered one row with a list of roles. */
function provedUser(result: GraphRunResult): string {
  const statement = NEO4J_AGENT_PROOF_STATEMENTS.currentUser;
  const [row] = result.rows;
  if (result.rows.length !== 1 || row === undefined || !isString(row.user)) throw unread(statement);
  if (row.roles === null || row.roles === undefined) {
    throw unsupported(
      "The agent read-only profile needs Neo4j Enterprise Edition, and this server reports Enterprise Edition but answers SHOW CURRENT USER with no roles, as Community Edition does, so it is refused.",
    );
  }
  if (!Array.isArray(row.roles) || !row.roles.every(isString)) throw unread(statement);
  return row.user;
}

/** Every privilege row, each of the measured shape and the current user's. */
function provedPrivileges(result: GraphRunResult, user: string): readonly Privilege[] {
  const statement = NEO4J_AGENT_PROOF_STATEMENTS.privileges;
  return result.rows.map((row) => {
    const { access, action, segment, role } = row;
    if (
      (access !== "GRANTED" && access !== "DENIED") ||
      !isString(action) ||
      !isString(segment) ||
      !isString(role) ||
      row.user !== user
    ) {
      throw unread(statement);
    }
    return { access, action, segment, role };
  });
}

function isRoutineSegment(segment: string): boolean {
  return segment.startsWith("PROCEDURE(") || segment.startsWith("FUNCTION(");
}

/** Refuses any granted action past a read, and any LOAD no denial of ALL DATA overrides. */
function assertOnlyReads(privileges: readonly Privilege[]): void {
  const loadDenied = privileges.some(
    (privilege) => privilege.access === "DENIED" && privilege.action === "load" && privilege.segment === "ALL DATA",
  );
  for (const privilege of privileges) {
    if (privilege.access === "DENIED") continue;
    const { action, segment, role } = privilege;
    if (action === "load") {
      if (loadDenied) continue;
      throw tooBroad(
        `The agent read-only profile needs a user that cannot LOAD, since LOAD CSV is a read clause that reaches files and URLs, and this one holds LOAD on ${segment} through the role ${role}. Revoke LOAD from PUBLIC and from every role the user holds, or DENY LOAD ON ALL DATA to one of its roles.`,
      );
    }
    if (READ_ACTIONS.has(action) || (action === "execute" && isRoutineSegment(segment))) continue;
    throw tooBroad(
      `The agent read-only profile needs a user that only reads, and this one holds ${action} on ${segment} through the role ${role}. Use a user whose roles grant only reads, as the reader role does.`,
    );
  }
}

/** Refuses any executable routine outside the pinned built-in set. */
function assertBuiltIn(
  result: GraphRunResult,
  builtIn: readonly string[],
  kind: "procedure" | "function",
  version: string,
): void {
  const statement =
    kind === "procedure" ? NEO4J_AGENT_PROOF_STATEMENTS.procedures : NEO4J_AGENT_PROOF_STATEMENTS.functions;
  const known = new Set(builtIn);
  for (const row of result.rows) {
    const { name } = row;
    if (!isString(name)) throw unread(statement);
    if (known.has(name)) continue;
    throw tooBroad(
      `The agent read-only profile needs a user that can execute only Neo4j ${version}'s built-in procedures and functions, and this one can execute the ${kind} ${name}, which is not one of them: an extension runs Java inside the server, where a read can reach the network or the file system. DENY EXECUTE PROCEDURE and DENY EXECUTE USER DEFINED FUNCTION on the extension's names to one of the user's roles, or remove the extension.`,
    );
  }
}
