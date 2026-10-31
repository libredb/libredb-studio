/**
 * The etcd agent read-only proof, from the answers in tests/fixtures/etcd/v3.7.2/agent-boundary/: when the agent
 * read-only profile opens, and again before every agent command, the server is asked whether authentication is on and
 * what the connection's user may do, and its answers decide. Nothing is kept between two proofs, so a permission
 * granted since the last command is caught at the next one (`midrun.json`: the same token reads the role's new WRITE
 * at once and writes with it).
 *
 * - **Authentication on.** With it off etcd answers every request from anyone, writes included (`auth-off.json`), so
 *   `AuthStatus` must answer enabled.
 * - **A user of the agent's own, neither root nor holding the root role.** `root` and a user granted the `root` role
 *   may do anything (`root.json`, `root-role.json`); both are refused, `root` by name before anything is sent.
 * - **Every permission of every role READ.** etcd permissions are key ranges, so a write probe on a key the proof
 *   picks cannot see a user that writes only its own range: `readwrite-range.json` and `write-range.json` are refused a
 *   put on a random key and admitted one in their range. So the proof reads the user's roles with `UserGet` on itself
 *   and each role's permissions with `RoleGet`, both of which etcd v3.7.2 answers a user who is not root for itself
 *   and its own roles (`reader-range.json`), and every permission must be READ: WRITE or READWRITE on any range refuses
 *   the profile. A user whose roles cannot be read is refused, never assumed a reader.
 *
 * Some calls etcd answers a reader that change the server all the same: v3.7.2 grants and revokes a lease for every
 * authenticated user, a READ-only one included (`reader-all.json`, `leaseGrant`). The proof cannot rule those out, so
 * the closed table (`agent-statement.ts`) stays the boundary on top of it, never instead of it: it sends no lease
 * grant, no lease revoke and no write of any kind.
 */
import { ExecutionProfileError } from "@/lib/db/errors";
import { type EtcdClient, EtcdError } from "./client";
import { ROOT_ROLE } from "./permissions";

/** The calls the proof makes, and nothing else. */
export type EtcdProofClient = Pick<EtcdClient, "authStatus" | "userGet" | "roleGet">;

/** The user etcd's auth store permits every key without a grant. */
const ROOT_USER = "root";

const NOTHING_SENT = "No agent command was sent.";
const GIVE_A_READER =
  "Give the agent an etcd user of its own whose roles grant READ permissions only, and turn authentication on.";

export const ETCD_PROOF_SENTENCES = {
  noUser: `The agent read-only profile needs etcd to prove the agent's user reads only, and this connection names no user, by password or by certificate. ${GIVE_A_READER} ${NOTHING_SENT}`,
  rootUser: `The agent read-only profile refuses etcd's root user, which may read and write every key. ${GIVE_A_READER} ${NOTHING_SENT}`,
  authOff: `etcd answered that authentication is off, so it answers every request from anyone, writes included, and no user is held to its permissions. ${GIVE_A_READER} ${NOTHING_SENT}`,
  rootRole: `This etcd user holds the root role, which may read and write every key. ${GIVE_A_READER} ${NOTHING_SENT}`,
  writer: `A role of this etcd user grants WRITE or READWRITE on a key range, so the user may change keys. ${GIVE_A_READER} ${NOTHING_SENT}`,
  unread: `etcd refused this user the read of its own roles or of their permissions, so the agent's user is not proved read-only and is refused. ${NOTHING_SENT}`,
} as const;

/** The etcd user the agent signs in as, or the refusal of one that cannot be proved: raised before anything is sent. */
export function etcdAgentUser(principal: { readonly name: string } | undefined): string {
  if (principal === undefined || principal.name === "") {
    throw new ExecutionProfileError(ETCD_PROOF_SENTENCES.noUser, "PROFILE_SERVER_UNENFORCED");
  }
  if (principal.name === ROOT_USER) {
    throw new ExecutionProfileError(ETCD_PROOF_SENTENCES.rootUser, "PROFILE_PRIVILEGES_TOO_BROAD");
  }
  return principal.name;
}

/** A refusal of the user's own reads as the proof's refusal; any other failure is raised as it came. */
function unreadable(error: unknown): never {
  if (error instanceof EtcdError && error.category === "permission-denied") {
    throw new ExecutionProfileError(ETCD_PROOF_SENTENCES.unread, "PROFILE_UNSUPPORTED_TARGET");
  }
  throw error;
}

/**
 * Proves `user`, the connection's etcd user, reads only: authentication on, no root role, and every permission of
 * every role READ, each read from the server now. Throws the refusal at the first answer that does not prove it; a
 * failed call other than etcd's refusal of the user's own reads is raised as the client's own error, never read as a
 * verdict.
 */
export async function proveEtcdReadOnly(client: EtcdProofClient, user: string, signal: AbortSignal): Promise<void> {
  const status = await client.authStatus({ signal });
  if (!status.enabled) throw new ExecutionProfileError(ETCD_PROOF_SENTENCES.authOff, "PROFILE_SERVER_UNENFORCED");
  const roles = await client.userGet(etcdAgentUser({ name: user }), { signal }).catch(unreadable);
  if (roles.includes(ROOT_ROLE)) {
    throw new ExecutionProfileError(ETCD_PROOF_SENTENCES.rootRole, "PROFILE_PRIVILEGES_TOO_BROAD");
  }
  const permissions = await Promise.all(roles.map((role) => client.roleGet(role, { signal }).catch(unreadable)));
  if (permissions.flat().some((permission) => permission.type !== "read")) {
    throw new ExecutionProfileError(ETCD_PROOF_SENTENCES.writer, "PROFILE_PRIVILEGES_TOO_BROAD");
  }
}
