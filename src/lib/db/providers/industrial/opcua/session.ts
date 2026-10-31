/**
 * This provider's own rules over the library, stated without touching it (#1677 O-S1, O-S2, O-S7).
 *
 * THIS MODULE IMPORTS NO LIBRARY AT ALL, and `tests/unit/db/opcua/seam.test.ts` asserts it: the one
 * module allowed to import `node-opcua-client` is `library.ts`, which fills in the
 * `OpcuaLibraryBridge` interface declared here. The library's own session carries `write`, `call`,
 * `historyUpdate`, `addNodes` and `createSubscription2` on the same object as the eight reads;
 * handing that object to the provider would make the read-only guarantee a habit. This file closes
 * over the bridge and returns the eight-service interface instead.
 *
 * THE SPLIT IS MEASURED RATHER THAN TIDY. `node-opcua-hostname` calls `prepareFQDN()` at module
 * scope without awaiting it, and its `dns.lookupService` throws inside a callback the library's own
 * try/catch cannot see: measured under Bun 1.4.2, where this host's name resolved to a zone-indexed
 * link-local address, the error arrived as an uncaught one. A test of the rules below therefore has
 * to be able to run with the library outside its import graph, and it can.
 *
 * WHAT THIS FILE DECIDES, and what `library.ts` only carries out: the endpoint is chosen by the
 * mode the reader asked for and never downgraded; the certificate pin is checked before the session
 * exists; every library throw becomes this provider's own sentence, message only; a continuation
 * point is released rather than abandoned; and the transport's message ceiling is named here.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import {
  OPCUA_HISTORY_READ_MODIFIED,
  OPCUA_HISTORY_RETURN_BOUNDS,
  OPCUA_HIERARCHICAL_REFERENCES,
  OPCUA_MAX_MESSAGE_BYTES,
  OPCUA_READ_ATTRIBUTES,
  OPCUA_TYPE,
} from "./constants";
import type {
  OpcuaBrowseResult,
  OpcuaDataValue,
  OpcuaEndpoint,
  OpcuaHistoryPage,
  OpcuaNodeId,
  OpcuaReadOnlyClient,
  OpcuaServerLimits,
} from "./client";
import { OPCUA_PKI_ROOT_ENV } from "./pki";
import type { OpcuaConnectionOptions } from "./connection";
import { errorForStatus, messageOf } from "./errors";
import { effectiveTokenPolicy, pinRefusal, plaintextIdentityRefusal } from "./security";

/**
 * The library surface this module uses, declared rather than imported as a type.
 *
 * `node-opcua-client` ships its own declarations, so this is not about missing types: it is about
 * naming the eight calls and nothing else even inside this file, so a later edit here cannot reach
 * `write` without first widening this.
 */
interface LibrarySession {
  browse(nodesToBrowse: readonly unknown[]): Promise<readonly unknown[]>;
  browseNext(
    continuationPoints: readonly Uint8Array[],
    releaseContinuationPoints: boolean,
  ): Promise<readonly unknown[]>;
  read(nodesToRead: readonly unknown[]): Promise<readonly unknown[]>;
  /**
   * HistoryRead itself, rather than the library's `readHistoryValue` convenience.
   *
   * THE CONVENIENCE CANNOT RELEASE A CONTINUATION POINT. Its options are
   * `numValuesPerNode`, `returnBounds`, `isReadModified` and `timestampsToReturn` and nothing else,
   * so `releaseContinuationPoints` passed there is silently ignored - the slot stays held until the
   * session closes, and OPC PLC publishes a hundred of them shared with the plant's own clients.
   * The service takes it, so the service is what this seam names, and the three cases below are one
   * call with different fields.
   */
  historyRead(options: {
    readonly nodeId: string;
    readonly startTime?: Date;
    readonly endTime?: Date;
    readonly valuesPerPage: number;
    readonly continuationPoint?: Uint8Array;
    readonly releaseContinuationPoints?: boolean;
    readonly isReadModified: boolean;
    readonly returnBounds: boolean;
  }): Promise<readonly unknown[]>;
  close(deleteSubscriptions?: boolean): Promise<void>;
}

/** What `openSession` needs of the library, so a test can stand in for it without a server. */
export interface OpcuaLibraryBridge {
  /** GetEndpoints, before any session: what the server offers and the certificate it presents. */
  readEndpoints(options: OpcuaConnectionOptions): Promise<readonly OpcuaEndpoint[]>;
  /** Connect and activate a session, with the strict certificate manager and the given PKI root. */
  openSession(options: OpcuaConnectionOptions): Promise<LibrarySession>;
  /** The server's published operation limits, read once. */
  readLimits(session: LibrarySession): Promise<OpcuaServerLimits>;
  /** Shape the library's own answers into this provider's, which is where decoding lives. */
  shapeBrowse(answers: readonly unknown[], nodeIds: readonly OpcuaNodeId[]): readonly OpcuaBrowseResult[];
  shapeRead(answers: readonly unknown[], nodeIds: readonly OpcuaNodeId[]): readonly OpcuaDataValue[];
  shapeHistory(answers: readonly unknown[], nodeId: OpcuaNodeId): OpcuaHistoryPage;
}

/**
 * Open one session and return the read-only client over it.
 *
 * THE PIN IS CHECKED BEFORE THE SESSION EXISTS. Measured: the library calls
 * `certificateManager.checkCertificate` exactly once and before CreateSession, so a wrong pin
 * refuses with zero CreateSessionRequest on the wire. This reads the thumbprint from GetEndpoints
 * and refuses here, which is the same point in the exchange and does not depend on the library
 * keeping that call where it is.
 */
/**
 * `bridge.openSession`, with the same translation every other call gets (O-S8).
 *
 * Measured before this existed: a dead port, a mode mismatch and a username where the server offers
 * no UserName token each arrived as the library's own `Error`, so five of the nine status codes the
 * error table maps as configuration errors - `BadUserAccessDenied`, `BadIdentityTokenInvalid`,
 * `BadIdentityTokenRejected`, `BadCertificateUntrusted`, `BadSecurityChecksFailed` - could never be
 * produced by this provider at all.
 */
async function openGuarded(bridge: OpcuaLibraryBridge, options: OpcuaConnectionOptions) {
  try {
    return await bridge.openSession(options);
  } catch (error) {
    throw dialRefusal(error, options);
  }
}

/**
 * GetEndpoints, with the same translation (O-S8), BECAUSE IT IS THE CALL THAT MEETS A DEAD SERVER.
 *
 * This was the one library call in this module with no guard on it, and it is the first one the
 * provider makes - so the most ordinary failure on a plant floor, a wrong host or port or a server
 * that is down, was the one case the provider did not own. Measured through the query route against
 * a closed port: HTTP 500 `INTERNAL_ERROR` carrying three lines of the library's own prose and
 * `Err = (connect ECONNREFUSED 127.0.0.1:54999)`, newlines inside the JSON error field included.
 * A 500 reads as "Studio broke"; this is a connection that was typed wrong, which is a 400 with an
 * address in it.
 */
async function endpointsGuarded(bridge: OpcuaLibraryBridge, options: OpcuaConnectionOptions) {
  try {
    return await bridge.readEndpoints(options);
  } catch (error) {
    throw dialRefusal(error, options);
  }
}

/**
 * A dial that failed because the client's own PKI DIRECTORY could not be written, as its own
 * sentence, or undefined where the dial failed for any other reason.
 *
 * A DIRECTORY FAULT IS NOT AN ENDPOINT FAULT, and it was answered as one. The certificate manager
 * creates its directories LAZILY - measured, both its construction and `initialize()` succeed under
 * a read-only parent - so the `EACCES` arrives here, with the endpoint in hand and the directory
 * only in the library's own text, and the reader was told "This connection could not be opened to
 * opc.tcp://... Check the endpoint URL" about a server that was listening. The default root is
 * inside the data directory (`pki.ts`), so this is what a read-only data mount, or a host directory
 * owned by another uid, produces on the first connect of an installation.
 *
 * BOTH HALVES ARE REQUIRED, so an unrelated `EACCES` - a socket the kernel refuses, a tunnel key
 * that cannot be read - is not relabelled as a directory fault: the message must carry a filesystem
 * code AND this connection's own PKI root.
 */
function pkiRefusal(message: string, options: OpcuaConnectionOptions): Error | undefined {
  if (!/\b(EACCES|EPERM|EROFS|ENOSPC|ENOTDIR)\b/.test(message)) return undefined;
  /*
   * BOTH SIDES FLATTENED THE SAME WAY. The message reaching here has had every whitespace run
   * collapsed to one space (see `dialRefusal`), so a root that holds two spaces of its own - a
   * directory somebody named that way - would no longer appear in it verbatim, this guard would say
   * no, and the reader would get the generic endpoint sentence instead of the one naming the
   * directory they have to fix. The sentence below still prints the real root.
   */
  if (!message.includes(options.pkiRoot.replaceAll(/\s+/g, " "))) return undefined;
  return new DatabaseConfigError(
    `The OPC UA client's certificate directory could not be prepared at ${options.pkiRoot}: ${message}. Studio ` +
      "writes its own key pair and its trust list there, so a connection cannot be opened without it. Make that " +
      `directory writable by this process, or point ${OPCUA_PKI_ROOT_ENV} at one that is.`,
    OPCUA_TYPE,
  );
}

/**
 * One library throw on the way to a session, as this provider's own sentence.
 *
 * A status code in the message becomes that code's sentence from the error table. Anything else
 * names the endpoint, because what the reader can act on is the address: the library's own text is
 * kept after it rather than replaced, since it is often the only thing that says WHICH part of the
 * dial failed - but it is flattened to one line, because a newline in a JSON error field is read by
 * nothing that draws it.
 */
function dialRefusal(error: unknown, options: OpcuaConnectionOptions): Error {
  /*
   * `\s+`, NOT `\s*\n\s*`, and the difference is measured rather than stylistic. `\s` already
   * matches a newline, so in `\s*\n\s*` the first group eats a whole whitespace run, fails to find
   * the newline it still needs, and gives one character back per attempt, at every start position:
   * quadratic. Measured on this machine against a run of spaces ending in a non-space, which is what
   * a server's own diagnostic text can be: 2.6ms at 2,000 characters, 31.8ms at 8,000, 454ms at
   * 32,000 and 7.9 SECONDS at 128,000, against 0.07ms for `\s+` at that last size. The text comes
   * from a peer the reader has not authenticated yet, so a hostile server could hold the event loop
   * with nothing but whitespace. `\s+` collapses runs of spaces as well, which is what a message
   * drawn on one line wants anyway.
   */
  const message = messageOf(error).replaceAll(/\s+/g, " ").trim();
  const code = /\b(Bad[A-Za-z]+)\b/.exec(message)?.[1];
  if (code !== undefined) return errorForStatus(code, options.pkiRoot);
  const unwritable = pkiRefusal(message, options);
  if (unwritable !== undefined) return unwritable;
  // The remedy is added only where the library gave none: node-opcua's own dial failure already
  // says to check that the server is up, and a sentence that says it twice reads as a machine.
  const remedy = /check/i.test(message)
    ? ""
    : " Check the endpoint URL, and whether anything between here and the server refuses that port.";
  return new DatabaseConfigError(
    `This connection could not be opened to ${options.endpointUrl}: ${message}${remedy}`,
    OPCUA_TYPE,
  );
}

export async function openReadOnlySession(
  bridge: OpcuaLibraryBridge,
  options: OpcuaConnectionOptions,
): Promise<OpcuaReadOnlyClient> {
  const endpoints = await endpointsGuarded(bridge, options);
  /**
   * The endpoint this connection asks for: its mode, and its policy where the reader named one.
   *
   * THE PAIR IS THE ENDPOINT, NOT THE MODE. A server offers one endpoint per (mode, policy) pair -
   * measured on OPC PLC, seven of them for three modes - and the library matches on both. Choosing
   * by mode alone and then dialling with no policy is how a `SignAndEncrypt` connection came to
   * answer "Cannot find an Endpoint matching security mode: 3 policy: …#None": the mode was the
   * reader's and the policy was the default, and no endpoint carries that pair.
   */
  const chosen = endpoints.find(
    (endpoint) =>
      endpoint.securityMode === options.mode &&
      (options.policyUri === undefined || endpoint.securityPolicyUri === options.policyUri),
  );
  if (chosen === undefined) {
    const offered = [...new Set(endpoints.map((endpoint) => endpoint.securityMode))].join(", ") || "none";
    const policies = [...new Set(endpoints.map((endpoint) => endpoint.securityPolicyUri.split("#")[1] ?? ""))]
      .filter((name) => name !== "")
      .join(", ");
    throw new DatabaseConfigError(
      `The server offers no ${options.mode} endpoint${
        options.policyUri === undefined ? "" : ` with the policy ${options.policyUri}`
      }. It offers the modes: ${offered}${policies === "" ? "" : `, with the policies: ${policies}`}. ` +
        "This provider never falls back to a weaker mode, because a connection meant to be encrypted must not " +
        "become an unencrypted one without the reader saying so.",
      OPCUA_TYPE,
    );
  }

  const refusal = pinRefusal(options.pinnedThumbprint, chosen.serverCertificateThumbprint);
  if (refusal !== undefined) throw new DatabaseConfigError(refusal, OPCUA_TYPE);

  /*
   * A USERNAME WHERE THE SERVER TAKES NONE IS OUR SENTENCE, NOT THE LIBRARY'S. The dialog draws
   * Username and Password for every OPC UA connection, and plenty of servers - the fixture this
   * provider is measured against among them - offer Anonymous only. Measured through the query
   * route before this check existed: the reader was answered "Cannot find USERNAME user token
   * policy in end point description", which is node-opcua's internal string, grammar mistake
   * included, and says nothing a reader can do. The token list is already in hand here, so the
   * refusal names what the server does offer and what to do about it.
   */
  if (options.identity === "username" && !chosen.userIdentityTokens.some((token) => token.tokenType === "UserName")) {
    const offered = [...new Set(chosen.userIdentityTokens.map((token) => token.tokenType))].join(", ") || "none";
    throw new DatabaseConfigError(
      `This server takes no username on its ${options.mode} endpoint: it accepts ${offered}. Clear the username ` +
        "and password to connect anonymously, or ask whoever runs the server to enable a UserName identity token.",
      OPCUA_TYPE,
    );
  }

  /**
   * And the credential is refused HERE, where the server's own token policy is finally known (O-S3).
   *
   * The refusal cannot be made in `connection.ts`: whether a password is protected depends on the
   * UserName token's own `securityPolicyUri`, which only GetEndpoints answers (Part 4 7.41). It is
   * made before `openSession`, so nothing has been sent: measured through a proxy against stock
   * asyncua, whose token declares None, the password crossed the wire in the clear without it.
   */
  const plaintext = plaintextIdentityRefusal({
    host: options.host,
    tunnelled: options.tunnelled,
    mode: options.mode,
    kind: options.identity,
    effectivePolicy: effectiveTokenPolicy(chosen, options.identity),
  });
  if (plaintext !== undefined) throw new DatabaseConfigError(plaintext, OPCUA_TYPE);

  /**
   * The session, with the chosen endpoint's policy where the reader named none.
   *
   * Every library throw on this path becomes this provider's own sentence too: a dead port, a
   * refused identity and a certificate the server would not accept all arrive here, and before this
   * they arrived as the library's own Error - which is also the only path on which the library's
   * Error can carry the ActivateSessionRequest, and the username inside it.
   */
  const session = await openGuarded(bridge, {
    ...options,
    ...(options.policyUri === undefined ? { policyUri: chosen.securityPolicyUri } : {}),
  });
  let limits: OpcuaServerLimits | undefined;

  /** Every call out of here turns a library throw into our own sentence, message only (O-S8). */
  const guarded = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const message = messageOf(error);
      const code = /\b(Bad[A-Za-z]+)\b/.exec(message)?.[1];
      // The root travels with the refusal here too: a secured session that is refused by the trust
      // list names the directory the reader has to act in (`errors.ts`).
      if (code !== undefined) throw errorForStatus(code, options.pkiRoot);
      /*
       * A THROW WITH NOTHING IN IT STILL HAS TO SAY SOMETHING. Measured: a node id the library
       * rejected while building the request threw an Error whose `message` was the empty string,
       * and this line answered the reader "A read failed: " with nothing after the colon. Where the
       * library says nothing, the sentence says what it can - which operation, and that the library
       * gave no reason - rather than printing a colon and stopping.
       */
      if (message === "")
        throw new QueryError(
          `${what} failed, and the client library gave no reason. The request may name a node id the ` +
            "library refuses to encode.",
          OPCUA_TYPE,
        );
      throw new QueryError(`${what} failed: ${message}`, OPCUA_TYPE);
    }
  };

  return {
    endpoints: async () => endpoints,
    limits: async () => {
      limits ??= await guarded("Reading the server's operation limits", () => bridge.readLimits(session));
      return limits;
    },
    browse: async (nodeIds, direction) =>
      guarded("A browse", async () =>
        bridge.shapeBrowse(
          await session.browse(
            nodeIds.map((nodeId) => ({
              nodeId,
              // Hierarchical references with every subtype: the measured reach. Forward (0) to the children, and
              // inverse (1, Part 4 7.5) to the parents, which the agent path reads to place a node it could not
              // see from above.
              referenceTypeId: OPCUA_HIERARCHICAL_REFERENCES,
              includeSubtypes: true,
              browseDirection: direction === "inverse" ? 1 : 0,
              resultMask: 63,
            })),
          ),
          nodeIds,
        ),
      ),
    browseNext: async (points) =>
      guarded("A browse continuation", async () =>
        // The node ids of a continued answer are the ones whose points these are, which only the
        // caller knows; an empty list left every continued result carrying `nodeId: ""`, harmless
        // only because nothing read it. The caller's own node is what the shaping is given.
        bridge.shapeBrowse(
          await session.browseNext(points, false),
          points.map(() => ""),
        ),
      ),
    releaseBrowseContinuationPoints: async (points) => {
      // Released rather than abandoned: OPC PLC publishes ten, shared with the plant's own clients.
      await guarded("Releasing a browse continuation point", async () => {
        await session.browseNext(points, true);
      });
    },
    read: async (nodeIds) =>
      guarded("A read", async () =>
        bridge.shapeRead(
          // One request for the value and the nine attributes beside it, per node, in the order
          // `OPCUA_READ_ATTRIBUTES` names. Ten requests would be ten round trips for one row.
          await session.read(
            nodeIds.flatMap((nodeId) =>
              OPCUA_READ_ATTRIBUTES.map((attributeId) => ({
                nodeId,
                attributeId,
              })),
            ),
          ),
          nodeIds,
        ),
      ),
    historyRead: async (request) =>
      guarded("A history read", async () =>
        bridge.shapeHistory(
          await session.historyRead({
            nodeId: request.nodeId,
            ...(request.startTime === undefined ? {} : { startTime: request.startTime }),
            ...(request.endTime === undefined ? {} : { endTime: request.endTime }),
            // Always set, never left to the server: Part 11 6.5.3 reads 0 as "no maximum", and the
            // library sends 0 when the caller says nothing, so the page was the server's.
            valuesPerPage: request.valuesPerPage,
            isReadModified: OPCUA_HISTORY_READ_MODIFIED,
            // Explicitly false: the library's convenience defaults it TRUE, which on open62541
            // turned a one-hour read into two rows whose value is null.
            returnBounds: OPCUA_HISTORY_RETURN_BOUNDS,
          }),
          request.nodeId,
        ),
      ),
    historyReadNext: async (request) =>
      guarded("A history continuation", async () =>
        bridge.shapeHistory(
          await session.historyRead({
            nodeId: request.nodeId,
            continuationPoint: request.continuationPoint,
            // The FIRST page's window, not a fresh one: measured, a continuation whose details
            // differ from the read that handed out the point answers BadContinuationPointInvalid.
            ...(request.startTime === undefined ? {} : { startTime: request.startTime }),
            ...(request.endTime === undefined ? {} : { endTime: request.endTime }),
            valuesPerPage: request.valuesPerPage,
            isReadModified: OPCUA_HISTORY_READ_MODIFIED,
            returnBounds: OPCUA_HISTORY_RETURN_BOUNDS,
          }),
          request.nodeId,
        ),
      ),
    releaseHistoryContinuationPoint: async (request) => {
      await guarded("Releasing a history continuation point", async () => {
        await session.historyRead({
          nodeId: request.nodeId,
          continuationPoint: request.continuationPoint,
          releaseContinuationPoints: true,
          ...(request.startTime === undefined ? {} : { startTime: request.startTime }),
          ...(request.endTime === undefined ? {} : { endTime: request.endTime }),
          valuesPerPage: request.valuesPerPage,
          isReadModified: OPCUA_HISTORY_READ_MODIFIED,
          returnBounds: OPCUA_HISTORY_RETURN_BOUNDS,
        });
      });
    },
    close: async () => {
      // GUARDED LIKE EVERY OTHER CALL (O-S8), and this one needs it most: the library's Error
      // carries the request that produced it, so an unguarded close could put the
      // ActivateSessionRequest - and the username in it - into whatever logged the failure.
      // `deleteSubscriptions` is true although this provider creates none: the server deletes
      // whatever it holds for the session rather than leaving it to a timeout.
      await guarded("Closing the session", async () => {
        await session.close(true);
      });
    },
  };
}

/** The client's own message ceiling, named here so a bridge can set it on the transport. */
export const OPCUA_TRANSPORT_SETTINGS = Object.freeze({
  maxMessageSize: OPCUA_MAX_MESSAGE_BYTES,
  /**
   * No chunk limit, which is what 0 means here and what the library would have used anyway.
   *
   * MEASURED IN THE LIBRARY, NOT ASSUMED: `node-opcua-transport`'s
   * `client_transport_base.js` reads `transportSettings.maxChunkCount || ClientTransportBase.defaultMaxChunk`
   * and its own default is `0 // 0 - no limits`, so passing 0 is passing nothing. It is stated
   * rather than omitted because the field beside it, `maxMessageSize`, IS enforced, and a reader of
   * these two settings should not have to guess which one bites. What bounds an answer's size is
   * the batch sizes in `constants.ts`.
   */
  maxChunkCount: 0,
});
