/**
 * The user's OpenShift access token, kept in server memory only, in a record keyed by the random session handle the
 * signed session cookie carries (`UserPayload.sessionHandle`) and bound to the session's uid, name and issuer. A token
 * never reaches a cookie, a log, an audit record, storage, a URL or a response; the record holds nothing else (no
 * refresh token, no groups).
 *
 * A record is answered only to the key of its own session and only until it expires; it ends at sign-out, at expiry,
 * and when the API server answers 401 to its token (OS2's reviews). The store holds at most 8 records per uid and 4096
 * in all, dropping expired records first, then the oldest of the uid, then the oldest written. It lives on
 * `globalThis`, because the callback that writes it and the routes that read it are separate Next.js bundles; a
 * restart empties it. No export lists, counts or iterates records.
 */

const STORE_KEY = Symbol.for("libredb-studio.openshift-auth-tokens");
const MAX_RECORDS = 4096;
const MAX_RECORDS_PER_UID = 8;

interface TokenRecord {
  readonly token: string;
  readonly uid: string;
  readonly name: string;
  readonly issuer: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

interface TokenStore {
  total: number;
  perUid: number;
  readonly records: Map<string, TokenRecord>;
}

type StoreHolder = { [STORE_KEY]?: TokenStore };

function store(): TokenStore {
  const holder = globalThis as StoreHolder;
  holder[STORE_KEY] ??= { total: MAX_RECORDS, perUid: MAX_RECORDS_PER_UID, records: new Map() };
  return holder[STORE_KEY];
}

/** What a session's cookie binds its record to. */
export interface OpenShiftSessionKey {
  readonly sessionHandle: string; // UserPayload.sessionHandle
  readonly uid: string; // UserPayload.idpSubject
  readonly name: string; // UserPayload.username
  readonly issuer: string; // UserPayload.idpIssuer
}

/** Stores the record of a sign-in under its new handle. Only the callback route calls it. */
export function storeOpenShiftSession(
  handle: string,
  record: { token: string; uid: string; name: string; issuer: string; expiresAtMs: number },
  nowMs = Date.now(),
): void {
  const { records, total, perUid } = store();
  records.delete(handle);
  if (records.size >= total) {
    for (const [stored, { expiresAtMs }] of records) if (expiresAtMs <= nowMs) records.delete(stored);
  }
  // Map order is insertion order, so the first entries are the oldest.
  const ofUid = [...records].filter(([, stored]) => stored.uid === record.uid);
  for (const [stored] of ofUid.slice(0, Math.max(0, ofUid.length - perUid + 1))) records.delete(stored);
  while (records.size >= total) records.delete(records.keys().next().value as string);
  records.set(handle, { ...record, createdAtMs: nowMs });
}

/** The key of a verified session, or null unless its handle, subject, issuer and user name are all non-empty strings. */
export function openShiftSessionKey(session: {
  sessionHandle?: string;
  idpSubject?: string;
  idpIssuer?: string;
  username?: string;
}): OpenShiftSessionKey | null {
  const { sessionHandle, idpSubject, idpIssuer, username } = session;
  const fields = [sessionHandle, idpSubject, idpIssuer, username];
  if (!fields.every((field) => typeof field === "string" && field !== "")) return null;
  return {
    sessionHandle: sessionHandle as string,
    uid: idpSubject as string,
    name: username as string,
    issuer: idpIssuer as string,
  };
}

/**
 * The token of the record under `key.sessionHandle`, only while it has not expired and its uid, name and issuer equal
 * the key's. An expired record is deleted; a mismatching one is left alone. Never throws.
 */
export function openShiftBearerToken(key: OpenShiftSessionKey, nowMs = Date.now()): string | null {
  const { records } = store();
  const record = records.get(key.sessionHandle);
  if (record === undefined) return null;
  if (record.expiresAtMs <= nowMs) {
    records.delete(key.sessionHandle);
    return null;
  }
  const bound = record.uid === key.uid && record.name === key.name && record.issuer === key.issuer;
  return bound ? record.token : null;
}

/** Ends a session's record: true when one existed. */
export function endOpenShiftSession(sessionHandle: string): boolean {
  return store().records.delete(sessionHandle);
}

/** Test seam: forgets every record, as a restart does, and sets the bounds. */
export function resetOpenShiftSessions(limits?: { total?: number; perUid?: number }): void {
  const current = store();
  current.records.clear();
  current.total = limits?.total ?? MAX_RECORDS;
  current.perUid = limits?.perUid ?? MAX_RECORDS_PER_UID;
}
