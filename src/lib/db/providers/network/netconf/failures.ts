/**
 * Which failure reaches the user, and dressed as what (issue #1724, specification section 11.2).
 *
 * The table in that section was written before anything called these paths, and it said so. The
 * wiring commit gave them a caller, and the landing check then measured what a user actually gets:
 *
 *   address with nobody on it   HTTP 500 `INTERNAL_ERROR`  "connect ECONNREFUSED 127.0.0.1:9"
 *   port that listens and says nothing  HTTP 500 `INTERNAL_ERROR` "Timed out while waiting for
 *                                       handshake", after 15,005 ms, NAMING NO ADDRESS
 *   no host key pin               HTTP 500 `INTERNAL_ERROR`  a sentence about configuration
 *
 * All three are facts about the device or the connection's settings, and all three arrived as a 500
 * logged "Unhandled error", because `src/lib/api/errors.ts` sends an unnamed `Error`'s message in
 * that last branch. The message was right; the dress was not, and a 500 sends the reader looking
 * for a defect in this product for something the network decided.
 *
 * So this module is the conversion the table asked for, and nothing more: it changes no sentence
 * the device or the dial produced, it only gives each one the class whose SCOPE matches.
 *
 *   nothing listens, the socket failed    `ConnectionError`      the whole connection
 *   the host key does not match the pin   `ConnectionError`      the whole connection
 *   the pin or the key cannot be read     `DatabaseConfigError`  the settings
 *   the credential was refused            `AuthenticationError`  the credential
 *   the session ended mid-read            `ConnectionError`      every later read, not this one
 *   the reader refused this message       `QueryError`           this read alone
 *   anything unnamed                      raised UNCHANGED       our defect, not the device's
 *
 * The last row is the one with no conversion, and it is deliberate: a `TypeError` is not a fact
 * about the device, and dressing it as one sends the reader to the device for our own bug. It is
 * returned as the SAME OBJECT rather than a copy, so a test can assert it by identity.
 */
import { AuthenticationError, ConnectionError, DatabaseConfigError, QueryError } from "@/lib/db/errors";

import { DialError } from "./dial";
import { XmlReaderError } from "./reader-port";
import { NetconfSessionError } from "./session";

/**
 * Where the connection was pointed, for the sentences that do not name it themselves.
 *
 * MEASURED, and it is why this exists: `connect ECONNREFUSED 127.0.0.1:9` carries the address and
 * `Timed out while waiting for handshake` does not, so on a port that listens and never speaks the
 * reader was told a deadline passed without being told which device missed it. The two cases are
 * different facts and both have to name the thing that failed.
 */
export interface DialTarget {
  readonly host: string;
  readonly port: number;
}

const naming = (target: DialTarget, message: string): string =>
  message.includes(target.host) ? message : `${target.host}:${target.port}: ${message}`;

/**
 * The conversion, with the target so a sentence that names no address gains one.
 *
 * `target` is optional because a read failure happens on a session whose address the caller already
 * showed; the dial is the path where the address is the missing half of the sentence.
 */
export function asHouseError(error: unknown, target?: DialTarget): unknown {
  if (error instanceof DialError) {
    const { failure } = error;
    if (failure.kind === "configuration") {
      // A setting the operator fixes, not a fact about the device: the pin or the key could not be
      // read, and no packet was sent. 400 rather than 503, because nothing was tried.
      return new DatabaseConfigError(failure.message, "netconf");
    }
    if (failure.kind === "host-key") {
      // The connection, not the credential: the device at this address is not the device this
      // connection was pinned to, and the handshake stopped before any authentication packet.
      return new ConnectionError(target === undefined ? failure.message : naming(target, failure.message), "netconf");
    }
    if (failure.kind === "refused") {
      return new AuthenticationError(failure.message, "netconf");
    }
    return new ConnectionError(target === undefined ? failure.message : naming(target, failure.message), "netconf");
  }
  if (error instanceof NetconfSessionError) {
    // The session is the connection here: this provider holds one, so a session that ended spoils
    // every later read rather than this one.
    return new ConnectionError(target === undefined ? error.message : naming(target, error.message), "netconf");
  }
  if (error instanceof XmlReaderError) {
    // This read alone. The bounds it refused on are the caps of specification section 5, and the
    // next read of a smaller subtree succeeds on the same session.
    return new QueryError(error.message, "netconf");
  }
  return error;
}
