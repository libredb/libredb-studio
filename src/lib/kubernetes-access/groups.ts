/**
 * The groups store: the only place a review's groups come from.
 *
 * The OIDC callback reads the `groups` claim of the ID token it has just verified and records it here per issuer and
 * subject, before it mints the session; a review takes its `user` from the signed session's subject and its `groups`
 * from this record, never from a header, another cookie field or a display name. Rancher builds the claim from the
 * same group principals it impersonates a user with on a downstream cluster, without its two system groups, and sends
 * no claim at all to a user without group principals, every local user included: an absent claim is an empty list.
 *
 * A claim that is not a list of non-empty strings, holds more than 512 groups or one longer than 256 bytes, or names a
 * group under Kubernetes' reserved `system:` prefix is refused, and the callback refuses the sign-in with it: a review
 * that asserted `system:authenticated` would allow what the cluster grants every authenticated user, which Rancher
 * measured as more than it lets that user reach, and `system:masters` would allow everything.
 *
 * A record serves the sessions its subject's sign-ins minted, so it expires with the session lifetime, and the newest
 * verified sign-in replaces it. The store holds at most 4096 records and evicts the oldest written first; a session
 * whose record is gone signs in again (session-guard.ts). It lives on `globalThis`, because the callback that writes it
 * and the routes that read it are separate Next.js bundles; a restart empties it.
 */
import { sessionTtlSeconds } from "@/lib/config/auth-env";

const STORE_KEY = Symbol.for("libredb-studio.kubernetes-access-groups");
const MAX_RECORDS = 4096;
const MAX_GROUPS = 512;
const MAX_GROUP_BYTES = 256;
const RESERVED_PREFIX = "system:";

const NOT_A_LIST = "the ID token's groups claim is not a list of group names";
const TOO_MANY = `the ID token's groups claim lists more than ${MAX_GROUPS} groups`;
const TOO_LONG = `the ID token's groups claim lists a group longer than ${MAX_GROUP_BYTES} bytes`;
const RESERVED = `the ID token's groups claim lists a group that starts with ${RESERVED_PREFIX}, which only Kubernetes assigns`;

export type GroupsClaimReading =
  | { readonly ok: true; readonly groups: readonly string[] }
  | { readonly ok: false; readonly problem: string };

interface GroupsRecord {
  readonly groups: readonly string[];
  readonly writtenAt: number;
}

interface GroupsStore {
  readonly limit: number;
  readonly records: Map<string, GroupsRecord>;
}

type StoreHolder = { [STORE_KEY]?: GroupsStore };

function store(): GroupsStore {
  const holder = globalThis as StoreHolder;
  holder[STORE_KEY] ??= { limit: MAX_RECORDS, records: new Map() };
  return holder[STORE_KEY];
}

/** Test seam: forgets every record, as a restart does, with an optional size limit. */
export function resetGroupRecords(limit = MAX_RECORDS): void {
  (globalThis as StoreHolder)[STORE_KEY] = { limit, records: new Map() };
}

/** The verified ID token's groups as a review asserts them, sorted and without duplicates, or why they cannot be. */
export function readGroupsClaim(claims: Readonly<Record<string, unknown>>): GroupsClaimReading {
  const value = claims.groups;
  if (value === undefined || value === null) return { ok: true, groups: [] };
  if (!Array.isArray(value) || !value.every((group) => typeof group === "string" && group !== "")) {
    return { ok: false, problem: NOT_A_LIST };
  }
  const groups = [...new Set(value as string[])].sort();
  if (groups.length > MAX_GROUPS) return { ok: false, problem: TOO_MANY };
  if (groups.some((group) => Buffer.byteLength(group, "utf8") > MAX_GROUP_BYTES)) return { ok: false, problem: TOO_LONG };
  if (groups.some((group) => group.startsWith(RESERVED_PREFIX))) return { ok: false, problem: RESERVED };
  return { ok: true, groups };
}

const recordKey = (issuer: string, subject: string): string => JSON.stringify([issuer, subject]);

/** How long a record serves sessions, in ms; null when the session lifetime cannot be read. */
function maxAgeMs(): number | null {
  try {
    return sessionTtlSeconds() * 1000;
  } catch {
    return null;
  }
}

/** Records the groups of a subject's verified sign-in, replacing its earlier record. */
export function recordGroups(issuer: string, subject: string, groups: readonly string[], nowMs = Date.now()): void {
  const { records, limit } = store();
  const key = recordKey(issuer, subject);
  records.delete(key);
  if (records.size >= limit) {
    const maxAge = maxAgeMs();
    for (const [stored, record] of records) {
      if (maxAge === null || nowMs - record.writtenAt >= maxAge) records.delete(stored);
    }
  }
  while (records.size >= limit) records.delete(records.keys().next().value as string);
  records.set(key, { groups: Object.freeze([...groups]), writtenAt: nowMs });
}

/** The groups recorded for a subject, or null when it has no live record: none written, evicted, or expired. */
export function recordedGroups(
  issuer: string | undefined,
  subject: string | undefined,
  nowMs = Date.now(),
): readonly string[] | null {
  if (!issuer || !subject) return null;
  const { records } = store();
  const key = recordKey(issuer, subject);
  const record = records.get(key);
  if (record === undefined) return null;
  const maxAge = maxAgeMs();
  if (maxAge === null) return null;
  if (nowMs - record.writtenAt >= maxAge) {
    records.delete(key);
    return null;
  }
  return record.groups;
}
