/**
 * What an OPC UA status code means, in words a reader can act on (#1677, Part 4 7.38).
 *
 * THE TABLE IS WRITTEN FROM FOUR SERVERS, NOT ONE, because the same failure is reported four ways.
 * Measured on a wrong password: OPC PLC, open62541 and asyncua-with-a-user-manager all answer
 * `BadUserAccessDenied`; Milo answers `BadIdentityTokenInvalid`; and a STOCK asyncua accepted every
 * username with every password, including an invented one, because its default user manager returns
 * a user for anything. So a sentence keyed on one server's code would be wrong on the next, and a
 * code this table does not know travels as itself rather than as a guess.
 *
 * NO SENTENCE ECHOES A CREDENTIAL, and that needs a rule about the error OBJECT and not only its
 * message. Measured: `node-opcua-client` throws an Error carrying `request` and `response`, so
 * `JSON.stringify(error)` emits the ActivateSessionRequest including `userName`. The message itself
 * is clean. Every caller logs `error.message`, never the error.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { OPCUA_TYPE } from "./constants";

/**
 * The codes a server actually answers with on the paths this provider walks, and what to do.
 *
 * Each is a code measured against at least one of the four stacks, and the remedy is one the reader
 * can perform. Where no remedy exists the sentence says what happened and stops, rather than
 * offering an action that cannot work.
 */
/**
 * Where a sentence wants this connection's PKI root, replaced by `statusSentence` when it has one.
 *
 * A placeholder rather than a template because `SENTENCES` is a plain table a reader can scan, and
 * one entry taking an argument would make every other entry look like it might too.
 */
const PKI_ROOT_MARK = "{pkiRoot}";

const SENTENCES: Readonly<Record<string, string>> = {
  // Session and identity.
  BadUserAccessDenied:
    "the server refused this identity. The username or password is wrong, or that account may not open a session.",
  BadIdentityTokenInvalid:
    "the server rejected the identity token. Milo answers this where other servers answer BadUserAccessDenied, so a wrong password reads this way too.",
  BadIdentityTokenRejected:
    "the server rejected the identity token as it was built. An empty password produces this where a wrong one does not.",
  BadCertificateUntrusted:
    "the server's certificate is not trusted by this connection, and nothing was sent to it. The library " +
    `wrote the certificate it was offered into ${PKI_ROOT_MARK}/rejected: MOVE that file into ` +
    `${PKI_ROOT_MARK}/trusted/certs - moving, not copying, because a copy left in rejected is still ` +
    "refused, which is measured. Pinning the thumbprint does NOT make it trusted: a pin narrows which " +
    "already-trusted certificate is accepted.",
  BadSecurityChecksFailed:
    "the server refused our own certificate. A server with its own trust list has to be given the client certificate before it will accept a secured channel.",
  BadSecurityModeRejected: "the server does not offer that security mode on this endpoint.",
  BadSecurityPolicyRejected: "the server does not offer that security policy, or this client cannot speak it.",
  BadTooManyOperations:
    "the request named more nodes than the server will take at once. This provider chunks by its own bound and by the server's where the server publishes one, so this means the server enforces a limit it did not publish.",
  BadTooManySessions:
    "the server's session table is full. A plant server shares it with its own clients, so this is usually not about us.",
  BadSessionIdInvalid:
    "the session is no longer valid. The server may have timed it out; reading again opens a new one.",
  // ^ That last clause is a PROMISE, and `OpcuaSessionPool.withSession` is what keeps it: a read
  // that fails on a stale session drops the session and runs once more on a fresh one. Measured
  // before it did: three reads in a row answered BadSessionIdInvalid, `isConnected()` kept saying
  // true, and the connection stayed bricked until Studio restarted.
  BadSessionClosed: "the server closed the session.",
  // Nodes and reads.
  BadNodeIdUnknown:
    "the server has no node with that id. A namespace index is a position in the server's own table and moves between restarts, so a saved id written with ns= may address nothing after one.",
  BadNodeIdInvalid: "that node id is not one the server can read.",
  BadAttributeIdInvalid: "that attribute does not exist on that node.",
  BadNotReadable:
    "the node refuses a read. Milo answers this for CurrentSessionCount even to an authenticated session.",
  BadUserAccessDeniedOnRead: "this identity may not read that node's value, although it can see the node.",
  BadIndexRangeNoData: "the array range asked for holds no data.",
  // History.
  BadHistoryOperationUnsupported:
    "that node keeps no history. Historizing is an attribute of the node, so only a node whose Historizing is true answers a history read; the others are read for their current value.",
  BadHistoryOperationInvalid: "the history read was built in a way the server refuses.",
  BadContinuationPointInvalid:
    "the server no longer accepts that continuation point. A server validates a continued read against the details of the read that handed the point out, so a window or a page size that changed between pages invalidates it; measured on OPC PLC, the rest of the history is then unreachable by token.",
  BadNotSupported:
    "the server does not support that service. open62541's ci_server answers this for a history read at service level, so the whole request fails rather than one node.",
  // Transport.
  BadConnectionClosed:
    "the connection closed. An answer larger than the client's own message limit closes the channel rather than failing one request, and every later request on that session then fails this way.",
  BadTimeout: "the server did not answer in time.",
  BadEncodingLimitsExceeded:
    "the answer was larger than the encoder would build. Measured on OPC PLC: a Browse of 2,500 nodes answered this and the session stayed usable, so the request was too wide rather than the connection broken; a narrower page reads the same level.",
  BadServerNotConnected: "the connection is not open.",
};

/** The sentence for one status code, with the code itself always carried. */
export function statusSentence(code: string, pkiRoot?: string): string {
  const sentence = SENTENCES[code];
  if (sentence === undefined) return `The server answered ${code}.`;
  /*
   * THE PATH THE READER HAS TO ACT ON IS THE PATH THIS SENTENCE NAMES. The trust-list refusal told
   * a reader to move a file from `rejected` into `trusted/certs` and never said WHERE those are -
   * measured in a browser, where the only answer a Sign or SignAndEncrypt connect gives is this
   * sentence, and the browser offers no way to move anything. The root is this connection's own
   * (`pki.ts`: the variable, or `<data directory>/opcua-pki`), so the caller passes it where it has
   * one; with no root in hand the sentence keeps the words it had.
   */
  return `The server answered ${code}: ${sentence.replaceAll(PKI_ROOT_MARK, pkiRoot ?? "the PKI root")}`;
}

/**
 * The error a caller raises from a status code, as a query failure or a config failure.
 *
 * A code about what the reader TYPED is a config error, because the remedy is in the dialog or the
 * request; everything else is a query error. The split decides which surface shows it.
 */
const CONFIG_CODES: ReadonlySet<string> = new Set([
  "BadUserAccessDenied",
  "BadIdentityTokenInvalid",
  "BadIdentityTokenRejected",
  "BadCertificateUntrusted",
  "BadSecurityChecksFailed",
  "BadSecurityModeRejected",
  "BadSecurityPolicyRejected",
  "BadNodeIdUnknown",
  "BadNodeIdInvalid",
]);

export function errorForStatus(code: string, pkiRoot?: string): Error {
  const sentence = statusSentence(code, pkiRoot);
  return CONFIG_CODES.has(code) ? new DatabaseConfigError(sentence, OPCUA_TYPE) : new QueryError(sentence, OPCUA_TYPE);
}

/**
 * The status codes that mean THIS SESSION OR ITS CHANNEL IS GONE, as the four stacks spell it.
 *
 * Each is a code after which no further request on the same session can succeed, so the only thing
 * a reader can be given is a new session. `BadConnectionClosed` is here because the channel carries
 * the session: measured on OPC PLC, an answer larger than the client's message limit closes the
 * channel and every later request on that session fails this way. `BadTimeout` is NOT here - a
 * server that was slow once is still the same session, and reopening on a timeout would spend a
 * session on every slow read.
 */
const STALE_SESSION_CODES: readonly string[] = Object.freeze([
  "BadSessionIdInvalid",
  "BadSessionClosed",
  "BadServerNotConnected",
  "BadConnectionClosed",
]);

/**
 * The status code a message REPORTS, as opposed to one it merely contains.
 *
 * A SUBSTRING MATCH READS THE READER'S OWN TEXT AS THE SERVER'S. Every refusal this provider writes
 * quotes what was asked for, so a node id the reader typed travels back inside the message: asked
 * for `s=BadSessionIdInvalid`, the answer said so, and a substring match then read a healthy
 * session as a dead one and dropped it. A code counts only where a server can have put it - at the
 * very start of the message, which is how the library throws one, or straight after this provider's
 * own "The server answered " - and nowhere else.
 */
function reportedStatusCode(message: string): string | undefined {
  const own = /^The server answered (Bad[A-Za-z]+)\b/.exec(message);
  if (own !== null) return own[1];
  const bare = /^(Bad[A-Za-z]+)\b/.exec(message.trim());
  return bare?.[1];
}

/**
 * Whether what the client raised says the session is gone.
 *
 * Read off the MESSAGE, because that is all that crosses out of the library: `node-opcua-client`
 * throws an Error naming the code, and this provider's own `statusSentence` writes the code into
 * its sentence too, so both forms are caught by the same test - and only those two forms, for the
 * reason `reportedStatusCode` states.
 */
export function isStaleSession(error: unknown): boolean {
  const code = reportedStatusCode(messageOf(error));
  return code !== undefined && STALE_SESSION_CODES.includes(code);
}

/**
 * The message of whatever the client raised, with nothing of the object around it.
 *
 * THIS IS A SECURITY RULE, NOT TIDINESS. The Error the client throws carries `request` and
 * `response`, so serialising it emits the ActivateSessionRequest and the username inside it. Only
 * the message crosses out of this provider.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.trim() : String(error);
}

/**
 * A request the client stopped waiting for: no answer arrived within the library's transaction timeout.
 *
 * ITS OWN CLASS BECAUSE THE SESSION POOL ACTS ON IT, and a status code cannot carry it: no answer means no code. A
 * secure channel can break in a way the library does not report, so a session whose request went unanswered cannot be
 * trusted with the next one (`OpcuaSessionPool.withSession`).
 */
export class OpcuaUnansweredError extends QueryError {
  constructor(message: string) {
    super(message, OPCUA_TYPE);
    this.name = "OpcuaUnansweredError";
    Object.setPrototypeOf(this, OpcuaUnansweredError.prototype);
  }
}
