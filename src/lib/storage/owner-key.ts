/**
 * The key a session's server storage rows are filed under, the `user_id` of `user_storage` (docs/STORAGE.md, User
 * Scoping & Security).
 *
 * Without governance it is the session's username, exactly as before. Under governance, and in openshift sign-in mode
 * (where the subject is the OpenShift user's uid), it is `sub:` followed by the
 * identity provider's subject, the `sub` a control plane writes grants under (docs/GOVERNANCE.md, Sign-in). An OIDC
 * session's username is the user's email when the ID token carries one, and an email can change, while the subject
 * stays, so a later email change does not move the user's rows. The prefix keeps a subject apart from any username a
 * store filed rows under before governance was switched on.
 *
 * Without governance a username that starts with `sub:` is refused, so no username can ever reach the namespace
 * governance files subjects under: rows filed under one before governance was switched on would belong to the user
 * whose subject it names.
 *
 * The browser copy's owner stays the username: it tells the browser whose copy it holds, and the server files every
 * row under this key.
 */
import type { UserPayload } from "@/lib/auth";
import { authProvider } from "@/lib/config/auth-provider";
import { governanceEnabled } from "@/lib/governance/config";

// One line, never a concatenation across lines: bun's line coverage under-counts the continuation lines of a message
// built that way.
const SUBJECT_PREFIX = "sub:";
const RESERVED_USERNAME_MESSAGE = `A username that starts with "${SUBJECT_PREFIX}" cannot use server storage: the prefix is reserved for identity provider subjects under governance`;
const SUBJECT_MISSING_MESSAGE = `Server storage under governance or openshift sign-in is keyed by the identity provider's subject, and this session carries none`;

export function storageOwnerKey(session: UserPayload): string {
  // openshift sign-in files rows under the user's uid as governance does under the subject: a user re-created under
  // the same name, or a name equal to a username of an earlier mode, starts over instead of reading those rows.
  if (!governanceEnabled() && authProvider() !== "openshift") {
    if (session.username.startsWith(SUBJECT_PREFIX)) throw new Error(RESERVED_USERNAME_MESSAGE);
    return session.username;
  }
  const subject = session.idpSubject;
  // getSession() refuses a session without a subject under governance (src/lib/local-accounts.ts), so one that gets
  // here is an error, never a reason to file the rows under the username.
  if (typeof subject !== "string" || subject === "") throw new Error(SUBJECT_MISSING_MESSAGE);
  return `${SUBJECT_PREFIX}${subject}`;
}
