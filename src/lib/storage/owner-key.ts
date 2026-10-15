/**
 * The key a session's server storage rows are filed under, the `user_id` of `user_storage` (docs/STORAGE.md, User
 * Scoping & Security).
 *
 * Without governance it is the session's username, exactly as before. Under governance it is `sub:` followed by the
 * identity provider's subject, the `sub` a control plane writes grants under (docs/GOVERNANCE.md, Sign-in). An OIDC
 * session's username is the user's email when the ID token carries one, and an email can change, while the subject
 * stays, so a later email change does not move the user's rows. The prefix keeps a subject apart from any username a
 * store filed rows under before governance was switched on.
 *
 * The browser copy's owner stays the username: it tells the browser whose copy it holds, and the server files every
 * row under this key.
 */
import type { UserPayload } from "@/lib/auth";
import { governanceEnabled } from "@/lib/governance/config";

// One line, never a concatenation across lines: bun's line coverage under-counts the continuation lines of a message
// built that way.
const SUBJECT_MISSING_MESSAGE =
  "Server storage under governance is keyed by the identity provider's subject, and this session carries none";

export function storageOwnerKey(session: UserPayload): string {
  if (!governanceEnabled()) return session.username;
  const subject = session.idpSubject;
  // getSession() refuses a session without a subject under governance (src/lib/local-accounts.ts), so one that gets
  // here is an error, never a reason to file the rows under the username.
  if (typeof subject !== "string" || subject === "") throw new Error(SUBJECT_MISSING_MESSAGE);
  return `sub:${subject}`;
}
