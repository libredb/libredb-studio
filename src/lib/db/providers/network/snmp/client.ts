/**
 * The one place this provider owns a socket (SN-S4, SN-S5).
 *
 * WHAT IT IS AND IS NOT. It resolves a name once, checks every answer with the address rules the
 * repository already has, connects a UDP socket to the literal it checked, and sends only what
 * the valve has read. It holds no retry policy of its own beyond a deadline, and it never
 * decides what to ask: that is the statement parser's job and the walk's.
 *
 * WHY THE NAME IS RESOLVED HERE RATHER THAN BY THE SOCKET. Measured on 13 October 2026: handing
 * a guard to a socket's `lookup` leaves a refused request with no callback and no timeout, so a
 * refusal becomes a hang. Resolving first means the refusal is a thrown error with a sentence,
 * and the socket is connected to an address that has already passed, so there is no second
 * resolution that could return a different one.
 *
 * WHY THE DEADLINE IS OURS. Over UDP there is no connection to notice a failure, and most
 * failures are silence. A deadline is therefore not a safety net around a protocol timeout; it
 * is the only thing that ends a request that will never be answered.
 */
import { createSocket, type Socket } from "node:dgram";
import { lookup as dnsLookup } from "node:dns";
import {
  assertNotLinkLocalLiteral,
  assertPublicDnsAnswers,
  assertPublicLiteralHost,
} from "@/lib/db/http/egress-policy";
import { QueryError } from "@/lib/db/errors";
import { randomBytes } from "node:crypto";
import { decodeResponse, encodePdu, encodeRequest, type Response } from "./message";
import { localizedKey, SALT_BYTES, type AuthHash } from "./usm";
import { advanced, estimatedTime, startClock, windowVerdict, type EngineClock } from "./time-window";
import { PDU_REPORT } from "./valve";
import {
  encodeAuthenticatedV3Message,
  encodeDiscovery,
  encodeEncryptedV3Message,
  encodeScopedPdu,
  readAuthenticatedAnswer,
  readDiscovery,
  type DiscoveredEngine,
  type SecurityLevel,
  type V3Keys,
} from "./v3-message";
import { failureFromSilence, failureFromSocket, USM_REPORT_OIDS, type SnmpFailure } from "./errors";
import { createGuardedSocketFactory, type ClientFacingSocket, type GuardedTarget } from "./transport";

/**
 * Reads the same flag the shared guard reads, by the same name, so the two cannot disagree.
 * An unset or false value leaves local connections working, which is the repository's default.
 */
function blockPrivateHosts(): boolean {
  const value = process.env.DB_HTTP_BLOCK_PRIVATE_HOSTS?.trim().toLowerCase();
  return value === "true" || value === "on" || value === "1";
}

export class SnmpTransportError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "SnmpTransportError";
    Object.setPrototypeOf(this, SnmpTransportError.prototype);
  }
}

export interface ResolvedTarget extends GuardedTarget {
  /** The name the user typed, kept so a message can name what they asked for. */
  readonly asked: string;
}

/**
 * Resolves and checks one host, answering the literal the socket will be connected to.
 *
 * An address literal is checked as a literal; a name is resolved with every answer checked
 * together, because a mixed answer that is half acceptable is not acceptable: the socket would
 * be free to pick the other half.
 */
export async function resolveTarget(host: string, port: number): Promise<ResolvedTarget> {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (/^[\d.]+$/.test(bare) || bare.includes(":")) {
    assertNotLinkLocalLiteral(bare);
    assertPublicLiteralHost(bare);
    return { address: bare, port, asked: host };
  }
  const answers = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    dnsLookup(bare, { all: true }, (error, addresses) => {
      if (error) {
        reject(new SnmpTransportError(`\`${host}\` did not resolve: ${error.code ?? error.message}`));
        return;
      }
      resolve(addresses);
    });
  });
  // The two checks are not applied the same way, and copying the shared transport's shape is
  // the point rather than a detail. `assertPublicLiteralHost` consults the flag itself and
  // returns when it is off (`egress-policy.ts:82`), but `assertPublicDnsAnswers` does NOT: it
  // refuses loopback and private answers unconditionally, because the shared transport only
  // installs it when the flag is on (`guardedNodeOptions`, line 130). Calling it unconditionally
  // here refused every agent reached by name on a local network even with the flag off, which
  // is the common case; a test with a name rather than a literal is what found it.
  if (blockPrivateHosts()) assertPublicDnsAnswers(answers);
  // The link-local refusal is not flag-dependent anywhere, so it runs either way.
  for (const answer of answers) assertNotLinkLocalLiteral(answer.address);
  return { address: answers[0].address, port, asked: host };
}

/**
 * What a v3 connection needs beyond an address. Absent means v2c, which carries a community and
 * no identity of its own.
 */
export interface V3Credentials {
  readonly userName: string;
  readonly authPassphrase: string;
  readonly privacyPassphrase?: string;
  readonly level: SecurityLevel;
  readonly hash: AuthHash;
  readonly contextName?: string;
  /**
   * SN-S8. The engine identity the operator expects, as lowercase hex. Discovery takes the
   * identity from whatever answers, so without a pin the first reply decides what every key is
   * localised to. With one, a different identity ends the connection instead of being adopted.
   */
  readonly engineIdPin?: string;
}

export interface ExchangeOptions {
  readonly target: ResolvedTarget;
  readonly community: string;
  readonly deadlineMs: number;
  /** Present for v3. The community is then unused and no v2c datagram is ever built. */
  readonly v3?: V3Credentials;
  /** Injected so a test can drive the client over a real socket without naming one here. */
  readonly createRawSocket?: () => Socket;
}

export interface Exchange {
  readonly send: (
    pduTag: number,
    requestId: number,
    oids: readonly (readonly number[])[],
    bulk?: { nonRepeaters: number; maxRepetitions: number },
  ) => Promise<Response | SnmpFailure>;
  readonly close: () => void;
}

/**
 * Opens one socket for one connection and answers requests on it.
 *
 * A failure comes back as a value rather than as a throw wherever the agent is the one that
 * failed, because "no answer" and "the agent said no" are readings and the caller decides what
 * to do with them. A throw is reserved for this process doing something it should not: an
 * unsendable request, a datagram the valve refuses, a target that is not the one connected.
 */
export async function openExchange(options: ExchangeOptions): Promise<Exchange> {
  const { target, community, deadlineMs, v3 } = options;
  const createRawSocket = options.createRawSocket ?? (() => createSocket("udp4"));
  const factory = createGuardedSocketFactory({ target, createRawSocket });
  const socket = factory.dgramModule.createSocket("udp4");
  // Each waiting request keeps the means to send itself again, because a notInTimeWindow
  // Report is the engine saying "ask again with my clock", and a request that merely stopped
  // waiting would report silence for a question the engine was willing to answer.
  const waiting = new Map<
    number,
    { readonly settle: (answer: Response | SnmpFailure) => void; readonly resend: () => void; retried: boolean }
  >();
  // Discovery is answered before any key exists, so its reply cannot go through the
  // authenticated reader and needs its own slot rather than a flag on the one below.
  let awaitingDiscovery: ((datagram: Uint8Array) => void) | undefined;
  let keys: V3Keys | undefined;
  let engine: DiscoveredEngine | undefined;
  let clock: EngineClock | undefined;
  let messageId = 1;

  // ICMP comes back on a CONNECTED socket, and without this listener it is an unhandled
  // `error` event that takes the process down rather than the request. Measured against a
  // loopback port with nothing on it: `recvmsg ECONNREFUSED` arrives within milliseconds, which
  // is the one case where UDP does tell us the far end is not there. It is recorded and ends
  // the waiting requests; on a real network the same situation is usually silence instead, and
  // the deadline is what answers then.
  let lastSocketError: string | undefined;
  /** Set when this provider's own code threw while reading a datagram. Never a device fact. */
  let internalFault: string | undefined;
  socket.on("error", (...args: unknown[]) => {
    const error = args[0] as NodeJS.ErrnoException | undefined;
    lastSocketError = error?.code ?? "UNKNOWN";
    // Settled with the failure itself, not with a fabricated empty answer. An invented response
    // would reach the caller as "the agent replied with nothing", which is a different fact
    // from "the host told us nothing is listening", and the second one is what happened.
    for (const pending of waiting.values()) pending.settle(failureFromSocket(lastSocketError));
  });

  socket.on("message", (...args: unknown[]) => {
    const datagram = args[0] as Uint8Array;
    if (awaitingDiscovery !== undefined) {
      awaitingDiscovery(datagram);
      return;
    }
    let response: Response;
    try {
      if (keys === undefined) {
        response = decodeResponse(datagram);
      } else {
        const answer = readAuthenticatedAnswer(datagram, keys);
        const now = Date.now();
        // The clock moves on every VERIFIED answer, including a Report. A Report is how an
        // engine says the time it was sent is not the time we think it is, so ignoring its
        // counters would leave the connection stuck outside the window it is complaining about.
        if (clock !== undefined) {
          const verdict = windowVerdict(clock, { boots: answer.engineBoots, time: answer.engineTime }, now);
          clock = advanced(clock, { boots: answer.engineBoots, time: answer.engineTime }, now);
          if (verdict !== "inside" && answer.pduTag !== PDU_REPORT) {
            // Verified but out of time. Dropped rather than answered, because a digest only
            // says who wrote a message and the window is what says when. The request ends at
            // its own deadline, and the sentence for that names the version and the level.
            return;
          }
        }
        if (answer.pduTag === PDU_REPORT) {
          // The clock has already been moved on by the lines above. A Report that says the
          // window was the problem is worth one more try per request: the engine refused the
          // timing, not the credential, and it has just told us what the timing should be.
          const oid = answer.response.varbinds[0]?.oid.join(".");
          if (oid === USM_REPORT_OIDS.notInTimeWindow) {
            for (const pending of waiting.values()) {
              if (pending.retried) continue;
              pending.retried = true;
              pending.resend();
            }
          }
          return;
        }
        response = answer.response;
      }
    } catch (error) {
      // A datagram this process cannot READ is dropped rather than failing the request it might
      // belong to: the kernel has already told us it came from the agent, and a request that is
      // still waiting ends at its own deadline with a sentence that lists what silence can mean.
      // At v3 this also covers an answer whose digest does not verify, which is a datagram we
      // have no reason to believe came from the engine at all.
      //
      // BUT ONLY THE REFUSALS THIS PROVIDER DECLARES. Catching everything would hide our own
      // defects inside a fact about the device: a TypeError in this decoder would leave the
      // request timing out as "the agent did not answer", and an operator would go and look at
      // their agent. Every declared refusal extends QueryError; anything else is ours, is kept,
      // and is what the deadline reports instead of silence.
      if (!(error instanceof QueryError)) {
        internalFault = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    waiting.get(response.requestId)?.settle(response);
  });
  await factory.start();

  if (v3 !== undefined) {
    engine = await discover(socket, target, deadlineMs, messageId, (listener) => {
      awaitingDiscovery = listener;
    });
    awaitingDiscovery = undefined;
    messageId += 1;
    if (v3.engineIdPin !== undefined) {
      const found = Buffer.from(engine.engineId).toString("hex");
      if (found !== v3.engineIdPin.toLowerCase()) {
        socket.close();
        throw new SnmpTransportError(
          `the agent at ${target.address} answered with engine id ${found}, and this connection is pinned to ${v3.engineIdPin.toLowerCase()}`,
        );
      }
    }
    const engineId = Buffer.from(engine.engineId);
    keys = {
      localizedAuthKey: localizedKey(v3.authPassphrase, engineId, v3.hash),
      localizedPrivKey:
        v3.level === "authPriv" && v3.privacyPassphrase !== undefined
          ? localizedKey(v3.privacyPassphrase, engineId, v3.hash)
          : undefined,
      hash: v3.hash,
    };
    clock = startClock(engine.engineBoots, engine.engineTime, Date.now());
  }

  return {
    send: (pduTag, requestId, oids, bulk) =>
      new Promise<Response | SnmpFailure>((resolve) => {
        let settled = false;
        const finish = (value: Response | SnmpFailure) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiting.delete(requestId);
          resolve(value);
        };
        // The silence sentence names the version and level this connection actually has. It
        // used to say v2c whatever had been opened, which explains a v3 timeout with the list
        // of things that go wrong on a version the connection is not speaking.
        const timer = setTimeout(
          () =>
            finish(
              internalFault !== undefined
                ? {
                    kind: "transport" as const,
                    reason:
                      "this provider failed while reading an answer, which is a defect here and " +
                      `not a fault of the agent: ${internalFault}`,
                    retryable: false as const,
                  }
                : lastSocketError !== undefined
                  ? failureFromSocket(lastSocketError)
                  : failureFromSilence({
                      version: v3 === undefined ? "v2c" : "v3",
                      securityLevel: v3?.level,
                      contextNameSet: (v3?.contextName ?? "") !== "",
                    }),
            ),
          deadlineMs,
        );
        const build = () =>
          v3 === undefined || keys === undefined || engine === undefined
            ? encodeRequest(pduTag, {
                community,
                requestId,
                oids,
                nonRepeaters: bulk?.nonRepeaters,
                maxRepetitions: bulk?.maxRepetitions,
              })
            : buildV3Request({
                v3,
                keys,
                engine,
                clock,
                messageId: (messageId += 1),
                pduTag,
                requestId,
                oids,
                bulk,
              });
        /** One transmission. Called again, unchanged in substance, if the engine asks for it. */
        const transmit = () => {
          const datagram = build();
          socket.send(datagram, 0, datagram.length, target.port, target.address, (error?: Error) => {
            if (error === undefined || error === null) return;
            const code = (error as NodeJS.ErrnoException).code;
            finish(code === undefined ? failureFromSocket("UNKNOWN") : failureFromSocket(code));
          });
        };
        waiting.set(requestId, { settle: finish, resend: transmit, retried: false });
        transmit();
      }),
    close: () => socket.close(),
  };
}

/**
 * The discovery leg: one unauthenticated question whose only job is to draw a Report naming the
 * engine. Its own timeout is the connection's, because a connection that cannot discover is a
 * connection that cannot be opened at all.
 */
async function discover(
  socket: ClientFacingSocket,
  target: ResolvedTarget,
  deadlineMs: number,
  messageId: number,
  listen: (listener: (datagram: Uint8Array) => void) => void,
): Promise<DiscoveredEngine> {
  return new Promise<DiscoveredEngine>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new SnmpTransportError(
            `the agent at ${target.address} did not answer the discovery request, so its engine identity is unknown and no key can be localised`,
          ),
        ),
      deadlineMs,
    );
    listen((datagram) => {
      let found: DiscoveredEngine;
      try {
        found = readDiscovery(datagram);
      } catch {
        // Not a Report. Dropped rather than failing discovery, because a stray datagram from
        // the agent's address must not decide what this connection's keys are localised to.
        return;
      }
      clearTimeout(timer);
      resolve(found);
    });
    const request = encodeDiscovery(messageId, 1);
    socket.send(request, 0, request.length, target.port, target.address, () => undefined);
  });
}

/** Builds one authenticated, optionally encrypted request on an engine already discovered. */
function buildV3Request(input: {
  v3: V3Credentials;
  keys: V3Keys;
  engine: DiscoveredEngine;
  clock: EngineClock | undefined;
  messageId: number;
  pduTag: number;
  requestId: number;
  oids: readonly (readonly number[])[];
  bulk?: { nonRepeaters: number; maxRepetitions: number };
}): Uint8Array {
  const { v3, keys, engine } = input;
  const scopedPdu = encodeScopedPdu({
    contextEngineId: engine.engineId,
    contextName: v3.contextName ?? "",
    pdu: encodePdu(input.pduTag, {
      requestId: input.requestId,
      oids: input.oids,
      nonRepeaters: input.bulk?.nonRepeaters,
      maxRepetitions: input.bulk?.maxRepetitions,
    }),
  });
  // The counters go out as the clock believes them NOW, not as discovery found them. Sending
  // the discovered time forever puts every request outside the window a couple of minutes into
  // a connection, which an agent answers by refusing a credential that was never wrong.
  const now = Date.now();
  const usm = {
    engineId: engine.engineId,
    engineBoots: input.clock?.boots ?? engine.engineBoots,
    engineTime: input.clock === undefined ? engine.engineTime : estimatedTime(input.clock, now),
    userName: v3.userName,
    privParameters: new Uint8Array(0),
  };
  const common = {
    messageId: input.messageId,
    level: v3.level,
    reportable: true,
    localizedAuthKey: keys.localizedAuthKey,
    hash: v3.hash,
  };
  if (v3.level !== "authPriv" || keys.localizedPrivKey === undefined) {
    return encodeAuthenticatedV3Message({ ...common, usm, msgData: scopedPdu, encrypted: false });
  }
  // A fresh salt per message. RFC 3826 section 3.1.2.1 builds the IV from the engine counters
  // and this value, so reusing one would reuse an IV under the same key.
  return encodeEncryptedV3Message({
    ...common,
    usm,
    scopedPdu,
    localizedPrivKey: keys.localizedPrivKey,
    salt: new Uint8Array(randomBytes(SALT_BYTES)),
  });
}
