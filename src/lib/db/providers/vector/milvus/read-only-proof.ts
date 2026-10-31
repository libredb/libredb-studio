/**
 * The Milvus agent read-only proof, from the answers in tests/fixtures/milvus/3.0.2/agent-boundary/: before the agent
 * read-only profile opens and before every agent request, the server is asked who the agent's user is and what it may
 * do, and its answers decide. Nothing is kept between two proofs, so a role granted a write since the last request is
 * caught at the next one.
 *
 * - **A user Studio can name.** The agent signs in as a user and a password, or a `user:password` token; a connection
 *   with no credential, or a token that names no user, is refused before anything is sent. `root` is refused by name:
 *   3.0.2 lists it no role (`select-user-self-root`), yet it may do anything.
 * - **The user list refused.** ListCredUsers needs a cluster privilege no read-only user holds: 3.0.2 refuses it
 *   PERMISSION_DENIED to every read-only principal (`list-cred-users-*`), and answers it to root, the admin role,
 *   ClusterReadOnly and every caller on a server with authorization off, where every write lands (`write-*-open-*`).
 *   Any other refusal is no proof.
 * - **Read-only grants.** SelectUser of the user itself names its roles, and SelectGrant of each, and of `public`,
 *   which every user holds, names its privileges; 3.0.2 answers both to the user itself (`select-user-self-*`,
 *   `select-grant-own-role-*`), read across every database, never the connection's alone. Every privilege must be
 *   one `MILVUS_READ_PRIVILEGES` holds: a write, Load, Release, a cluster or admin privilege, the admin role and a
 *   privilege group Studio does not know (a custom group's members are not readable to a read-only user,
 *   `list-privilege-groups-*`) refuse the profile, whichever database the grant names.
 *
 * When the user list was answered and every grant reads only, the server does not enforce authorization: the refusal
 * then says so, since narrowing the user would change nothing.
 *
 * Reads only, on the client's three privilege reads (`client.ts`); no write is sent to prove a write is refused, so the
 * stub keeps no write RPC but Load and Release, which the admin's maintenance route alone sends.
 */
import { ExecutionProfileError } from "@/lib/db/errors";
import { type CallOptions, type MilvusClient, MilvusError } from "./client";
import type { MilvusAuth } from "./connection-options";

/** The client methods the proof calls, and no other. */
export type MilvusProofClient = Pick<MilvusClient, "listCredUsers" | "selectUser" | "selectGrant">;

/**
 * Every privilege a read-only user may hold: the groups CollectionReadOnly and DatabaseReadOnly, by name and member
 * by member as 3.0.2 lists them (`list-privilege-groups-root`), and ListDatabases. Every one reads.
 */
export const MILVUS_READ_PRIVILEGES: readonly string[] = Object.freeze([
  "CollectionReadOnly",
  "DatabaseReadOnly",
  "Query",
  "Search",
  "IndexDetail",
  "GetFlushState",
  "GetLoadState",
  "GetLoadingProgress",
  "HasPartition",
  "ShowPartitions",
  "DescribeCollection",
  "DescribeAlias",
  "GetStatistics",
  "ListAliases",
  "GetImportProgress",
  "ListImport",
  "DescribeSnapshot",
  "ListSnapshots",
  "ShowCollections",
  "DescribeDatabase",
  "ListDatabases",
]);

/** The most roles the proof reads the grants of; a user holding more is refused. */
export const MILVUS_PROOF_MAX_ROLES = 16;

const NOTHING_SENT = "No agent request was sent.";
const GIVE_A_READER =
  "Give the agent a user whose roles hold only the CollectionReadOnly and DatabaseReadOnly groups or their read privileges.";

export const MILVUS_PROOF_SENTENCES = {
  noUser: `The agent read-only profile needs Milvus to prove the agent's user reads only, and this connection names no user: give it a user and a password, or a user:password token. ${NOTHING_SENT}`,
  root: `The agent read-only profile refuses Milvus's root user, which may do anything though Milvus lists it no role. ${GIVE_A_READER} ${NOTHING_SENT}`,
  admin: `This Milvus user holds the admin role, which may do anything. ${GIVE_A_READER} ${NOTHING_SENT}`,
  /** `privilege` is a privilege or group name the server listed, never user text. */
  grant: (privilege: string): string =>
    `This Milvus user holds ${JSON.stringify(privilege)} through one of its roles or public, which is not a read Studio admits, so the user may change the server. ${GIVE_A_READER} ${NOTHING_SENT}`,
  unenforced: `Milvus answered this user the list of users, which it refuses every read-only user while authorization is on, so this server does not enforce authorization and any caller may write. Turn authorization on, then give the agent a read-only user. ${NOTHING_SENT}`,
  /** `step` is one of the proof's own reads, never user text. */
  unread: (step: string): string =>
    `Milvus did not answer ${step} as the read-only proof reads it, so the agent's user is not proved read-only and is refused. ${NOTHING_SENT}`,
  tooManyRoles: (count: number): string =>
    `This Milvus user holds ${count} roles, more than the ${MILVUS_PROOF_MAX_ROLES} whose grants the read-only proof reads, so it is not proved read-only and is refused. ${NOTHING_SENT}`,
} as const;

const STEPS = {
  list: "the user list",
  user: "the user's roles",
  grants: "a role's grants",
} as const;

/** The user the agent signs in as, or the refusal of a credential that names none: raised before anything is sent. */
export function milvusAgentUser(auth: MilvusAuth): string {
  const user =
    auth.kind === "password"
      ? auth.user
      : auth.kind === "token" && auth.token.indexOf(":") > 0
        ? auth.token.slice(0, auth.token.indexOf(":"))
        : "";
  if (user === "") throw new ExecutionProfileError(MILVUS_PROOF_SENTENCES.noUser, "PROFILE_SERVER_UNENFORCED");
  return user;
}

function unread(step: string): ExecutionProfileError {
  return new ExecutionProfileError(MILVUS_PROOF_SENTENCES.unread(step), "PROFILE_UNSUPPORTED_TARGET");
}

function tooBroad(message: string): ExecutionProfileError {
  return new ExecutionProfileError(message, "PROFILE_PRIVILEGES_TOO_BROAD");
}

/** A server refusal of a proof read: a MilvusError the server answered, not one the transport raised. */
function serverRefused(error: unknown): error is MilvusError {
  return (
    error instanceof MilvusError &&
    (error.category === "permission-denied" || error.category === "status" || error.category === "unauthenticated")
  );
}

/** Whether the server answered the user list: false only when it refused it PERMISSION_DENIED. */
async function listsUsers(client: MilvusProofClient, call: CallOptions): Promise<boolean> {
  try {
    await client.listCredUsers(call);
    return true;
  } catch (error) {
    if (error instanceof MilvusError && error.category === "permission-denied") return false;
    if (serverRefused(error)) throw unread(STEPS.list);
    throw error;
  }
}

async function rolesOf(client: MilvusProofClient, user: string, call: CallOptions): Promise<readonly string[]> {
  let answer: Awaited<ReturnType<MilvusProofClient["selectUser"]>>;
  try {
    answer = await client.selectUser({ user: { name: user }, include_role_info: true }, call);
  } catch (error) {
    if (serverRefused(error)) throw unread(STEPS.user);
    throw error;
  }
  const [only, ...more] = answer.results;
  if (only === undefined || more.length > 0 || only.user?.name !== user) throw unread(STEPS.user);
  return only.roles.map((role) => role.name);
}

/**
 * The database a grant read names: every one. 3.0.2 answers a SelectGrant naming no database with the grants on
 * `default` and `*` alone (`select-grant-own-role-default-only-*`), so a role writing any other database would pass;
 * named `*`, it answers the role's grants in every database (`select-grant-own-role-elsewhere`, `-rwother`).
 */
const EVERY_DATABASE = "*";

async function privilegesOf(client: MilvusProofClient, role: string, call: CallOptions): Promise<readonly string[]> {
  let answer: Awaited<ReturnType<MilvusProofClient["selectGrant"]>>;
  try {
    answer = await client.selectGrant({ entity: { role: { name: role }, db_name: EVERY_DATABASE } }, call);
  } catch (error) {
    if (serverRefused(error)) throw unread(STEPS.grants);
    throw error;
  }
  return answer.entities.map((grant) => {
    const privilege = grant.grantor?.privilege?.name;
    if (typeof privilege !== "string" || privilege === "") throw unread(STEPS.grants);
    return privilege;
  });
}

/**
 * Proves `user` reads only, one read after another: the user list, then the user's roles, then each role's grants and
 * `public`'s. Throws the refusal at the first answer that does not prove it; a transport failure is raised as the
 * client's own error, never read as a verdict.
 */
export async function proveMilvusReadOnly(client: MilvusProofClient, user: string, call: CallOptions): Promise<void> {
  if (user === "root") throw tooBroad(MILVUS_PROOF_SENTENCES.root);
  const answeredUserList = await listsUsers(client, call);
  const roles = await rolesOf(client, user, call);
  if (roles.includes("admin")) throw tooBroad(MILVUS_PROOF_SENTENCES.admin);
  if (roles.length > MILVUS_PROOF_MAX_ROLES) {
    throw new ExecutionProfileError(MILVUS_PROOF_SENTENCES.tooManyRoles(roles.length), "PROFILE_UNSUPPORTED_TARGET");
  }
  for (const role of [...roles.filter((name) => name !== "public"), "public"]) {
    // oxlint-disable-next-line no-await-in-loop -- the proof's reads go one after another, as every request does.
    for (const privilege of await privilegesOf(client, role, call)) {
      if (!MILVUS_READ_PRIVILEGES.includes(privilege)) throw tooBroad(MILVUS_PROOF_SENTENCES.grant(privilege));
    }
  }
  if (answeredUserList) throw new ExecutionProfileError(MILVUS_PROOF_SENTENCES.unenforced, "PROFILE_SERVER_UNENFORCED");
}
