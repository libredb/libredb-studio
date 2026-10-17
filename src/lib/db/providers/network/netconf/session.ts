/**
 * One NETCONF session: the hello exchange, the framing it settles on, and request to reply
 * matching (issue #1724, requirements NC-S1, NC-S5, NC-S6, NC-S8).
 *
 * The transport is injected rather than opened here, for two reasons. The provider dials the socket
 * itself and hands it to ssh2 through the `sock` option, so the socket is already somebody else's
 * object by the time a session exists (requirement NC-S3). And a session's rules are the part worth
 * testing without a network: every rule below is a case in `netconf.test.ts` driven by a fake
 * transport.
 *
 * Rules the client enforces because a server may not, each measured on 2026-10-13:
 *   a hello must arrive within a deadline, and it must carry a `<session-id>`;
 *   a common base version must exist, or the session ends rather than guessing a framing;
 *   a reply's `message-id` must equal its request's, and a reply carrying none is not a reply;
 *   a framing fault ends the session, which RFC 6242 4.2 requires of the peer and Netopeer2 does
 *   not always do;
 *   every read is bounded by bytes before it is bounded by anything else.
 *
 * The message-id rule is here because of a measured bug rather than a reading. A probe written for
 * these measurements matched replies by arrival order. When a server accepted
 * `create-subscription` it began sending notifications, which carry no `message-id`, the probe
 * counted them as replies, and it then blamed the wrong operation for a failure: it reported 17
 * replies to 12 requests. A notification is not a reply, and only the `message-id` says so.
 */

import { FrameReader, frame, type Framing, type FrameLimits, type FrameFault } from "./framing";
import { buildRpc, type NetconfRequest } from "./requests";

/** What a session needs from whatever carries its bytes. */
export interface Transport {
  write(text: string): void;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface SessionLimits extends FrameLimits {
  /** Milliseconds a hello may take. Measured 18 to 36 ms on loopback, so this is generous. */
  readonly helloMs: number;
  /** Milliseconds one request may take. */
  readonly requestMs: number;
}

/**
 * Why a session ended, and the four protocol-ish endings are NOT one reason.
 *
 * MEASURED: `protocol` was produced at nine places with seven different sentences, and three of
 * them are answered differently by whoever reads them. A deadline asks for patience or a longer
 * one. A device that offers no base version this client speaks cannot be used at all, which is a
 * fact about compatibility rather than about behaviour. And "a request is already in flight" is
 * THIS PROVIDER'S OWN defect, which has no business wearing the same word as a device's protocol
 * fault: the fourth scope of section 11.2 says a defect of ours is never dressed as a fact about
 * the device, and that rule was being broken by a reason code while every sentence stayed correct.
 *
 * The sentences already differed, which serves a person reading one and serves nothing that
 * branches on the field. Two states separated only by their sentence are not separated for code.
 */
export type SessionEnd =
  | { readonly reason: "closed-by-us" }
  | { readonly reason: "closed-by-peer" }
  | { readonly reason: "framing"; readonly fault: FrameFault }
  /** The device answered in a way NETCONF does not allow. */
  | { readonly reason: "protocol"; readonly detail: string }
  /** Nothing arrived in time. The device may be slow, busy or unreachable. */
  | { readonly reason: "deadline"; readonly detail: string }
  /** The device works and this client cannot speak to it. */
  | { readonly reason: "incompatible"; readonly detail: string }
  /** Our own defect. Never a claim about the device. */
  | { readonly reason: "internal"; readonly detail: string };

export class NetconfSessionError extends Error {
  readonly end: SessionEnd;
  constructor(end: SessionEnd) {
    super(describeEnd(end));
    this.end = end;
  }
}

function describeEnd(end: SessionEnd): string {
  switch (end.reason) {
    case "closed-by-us":
      return "this session was closed";
    case "closed-by-peer":
      return "the device closed this session";
    case "framing":
      return `the device broke the NETCONF framing rules (${end.fault.kind}), so the session was ended`;
    // The four below carry their own sentence for the same reason: it is written where the fault is
    // found, which is the only place that knows what happened. They are listed separately rather
    // than defaulted so that adding a reason to the union cannot compile until somebody has said
    // what a reader should be told.
    case "protocol":
    case "deadline":
    case "incompatible":
    case "internal":
      return end.detail;
  }
}

export interface Hello {
  readonly sessionId: string;
  readonly capabilities: readonly string[];
  readonly bases: readonly string[];
}

const CLIENT_BASES = ["urn:ietf:params:netconf:base:1.0", "urn:ietf:params:netconf:base:1.1"] as const;

/** The client hello. Both base versions are offered, so the server picks the framing. */
/**
 * A name pattern that accepts a namespace PREFIX, which is the half of XML a flat pattern forgets.
 *
 * `<session-id>` and `<nc:session-id>` are the same element: the prefix binds a namespace and the
 * local name is what identifies it. MEASURED against the patterns these replaced: a hello written
 * with prefixes was refused with "the device's hello carried no session-id, which RFC 6241 8.1
 * requires", a sentence that blames the device for this client's reading, and a prefixed
 * notification was taken for a reply with no id, which ends the session with another wrong
 * sentence. Netopeer2 writes neither with a prefix, so the fixture could never show this.
 *
 * The prefix is not VALIDATED against its binding here, and that limit is deliberate: resolving a
 * prefix to a namespace is the reader port's work, and this file parses no XML. What it does is
 * stop a legal spelling from reading as an absent element.
 *
 * A start tag may also carry ATTRIBUTES and whitespace, and a closing tag may carry whitespace, so
 * the two halves are built rather than written out. MEASURED after the prefix fix, which did not
 * cover these: `<session-id xmlns="...">`, `<session-id >` and `</session-id >` each produced the
 * same refusal, "the device's hello carried no session-id, which RFC 6241 8.1 requires", and
 * `<capability xmlns="...">` answered zero capabilities, which leaves no common base version and
 * ends the session. Three legal spellings and one of them is what a server writing its namespaces
 * inline produces.
 */
const PREFIX = "(?:[A-Za-z_][A-Za-z0-9_.-]*:)?";
/** `<name>` with any attributes, and `</name>` with any trailing space. */
const opening = (name: string): string => `<${PREFIX}${name}(?:\\s[^>]*)?\\s*>`;
const closing = (name: string): string => `</${PREFIX}${name}\\s*>`;

/** The local name of an element start tag, prefix removed. */
function localNameOf(tag: string | null): string | null {
  if (tag === null) return null;
  const name = /^<\s*([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)/.exec(tag)?.[1];
  if (name === undefined) return null;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * The first ELEMENT's start tag, skipping what may legally come before it.
 *
 * MEASURED against the first version of this function, which took the first `<`: a reply led by an
 * XML declaration answered null, and so did one led by a comment, which means EVERY reply from such
 * a device would have been refused for carrying no message-id. RFC 6241's own examples are written
 * with `<?xml version="1.0" encoding="UTF-8"?>` in front, so this is a device away rather than a
 * hypothetical; the fixture measured here does not send one, which is exactly why a test had to.
 *
 * A DOCTYPE is skipped here and refused where it matters: the reader port's contract refuses one
 * outright, because RFC 6241 section 3.2 says it MUST NOT appear in NETCONF content.
 */
function firstElementTag(message: string): string | null {
  let at = 0;
  for (;;) {
    while (at < message.length && /\s/.test(message[at] ?? "")) at += 1;
    if (message[at] !== "<") return null;
    const next = message[at + 1];
    if (next === "?") {
      const end = message.indexOf("?>", at);
      if (end === -1) return null;
      at = end + 2;
      continue;
    }
    if (next === "!") {
      const end = message.startsWith("<!--", at) ? message.indexOf("-->", at) + 2 : message.indexOf(">", at);
      if (end < at) return null;
      at = end + 1;
      continue;
    }
    const close = message.indexOf(">", at);
    return close === -1 ? null : message.slice(at, close + 1);
  }
}

/**
 * The `message-id` of a message, read from its FIRST element's start tag and nowhere else.
 *
 * Three things here are not decoration, and each one was measured against the pattern this
 * replaced, `/message-id="(\d+)"/`:
 *
 * 1. XML allows an attribute value in single quotes, so `message-id='7'` is a legal reply. The old
 *    pattern did not match it, and the session ended a healthy session saying the device sent no
 *    message-id.
 * 2. XML allows whitespace around the `=`, so `message-id = "7"` is legal and was not matched
 *    either.
 * 3. The old pattern searched the WHOLE message, so a reply whose own id was single quoted while
 *    its DATA carried the text `message-id="999"` matched 999: the content. The session then ended
 *    with "the device answered message-id 999 to request 7", which accuses the device of a fault
 *    that is this client's reading. Limiting the search to the first start tag is what makes the
 *    content unable to answer, and content is exactly what a device's data is.
 *
 * The value is compared as TEXT rather than parsed as a number, because the id in a reply is the
 * one we sent echoed back, and an id that is not the text we sent is not our reply whatever it
 * parses to.
 */
export function messageIdOf(message: string): string | null {
  const tag = firstElementTag(message);
  if (tag === null) return null;
  const found = /\smessage-id\s*=\s*("([^"]*)"|'([^']*)')/.exec(tag);
  const value = found?.[2] ?? found?.[3];
  return value === undefined || value === "" ? null : value;
}

export function clientHello(): string {
  const caps = CLIENT_BASES.map((base) => `<capability>${base}</capability>`).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities>${caps}</capabilities></hello>`
  );
}

/**
 * Reads the server hello out of its raw text.
 *
 * It is read with a narrow scan rather than the XML reader, because the framing of the rest of the
 * session depends on it and the reader is not bound yet. The scan takes two things and nothing
 * else: the session id and the capability URIs.
 */
export function readHello(message: string): Hello {
  const id = new RegExp(`${opening("session-id")}\\s*(\\d+)\\s*${closing("session-id")}`).exec(message);
  if (!id?.[1]) {
    throw new NetconfSessionError({
      reason: "protocol",
      detail: "the device's hello carried no session-id, which RFC 6241 8.1 requires",
    });
  }
  const capabilities = [
    ...message.matchAll(new RegExp(`${opening("capability")}\\s*([^<\\s]+)\\s*${closing("capability")}`, "g")),
  ].map((m) => m[1] ?? "");
  const bases = capabilities.filter((cap) => cap.startsWith("urn:ietf:params:netconf:base:"));
  return { sessionId: id[1], capabilities, bases };
}

/**
 * The framing both sides can speak.
 *
 * Chunked framing when the server offered base:1.1, end-of-message when it offered only base:1.0,
 * and an ended session when it offered neither: a session with no common base version has no
 * defined framing, and guessing one produces a stream the peer cannot read.
 */
export function framingFor(hello: Hello): Framing {
  if (hello.bases.includes("urn:ietf:params:netconf:base:1.1")) return "chunked";
  if (hello.bases.includes("urn:ietf:params:netconf:base:1.0")) return "eom";
  throw new NetconfSessionError({
    reason: "incompatible",
    detail: "this device offered no NETCONF base version this client speaks",
  });
}

interface Pending {
  readonly messageId: number;
  resolve(message: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class NetconfSession {
  private readonly reader: FrameReader;
  private framing: Framing = "eom";
  private nextId = 1;
  private pending: Pending | null = null;
  private ended: SessionEnd | null = null;
  private helloWaiter: ((message: string) => void) | null = null;
  /** Notifications arrive when a subscription exists. This provider never subscribes, so one is a fault. */
  private notifications = 0;

  private readonly transport: Transport;
  private readonly limits: SessionLimits;

  private constructor(transport: Transport, limits: SessionLimits) {
    this.transport = transport;
    this.limits = limits;
    this.reader = new FrameReader("eom", limits);
    transport.onData((chunk) => this.onData(chunk));
    transport.onClose(() => this.end({ reason: "closed-by-peer" }));
  }

  /** Opens a session: sends the client hello, reads the server's, and settles the framing. */
  static async open(transport: Transport, limits: SessionLimits): Promise<{ session: NetconfSession; hello: Hello }> {
    const session = new NetconfSession(transport, limits);
    const helloText = await session.awaitHello();
    const hello = readHello(helloText);
    session.framing = framingFor(hello);
    if (session.framing === "chunked") session.reader.useChunked();
    transport.write(frame(clientHello(), "eom"));
    return { session, hello };
  }

  private awaitHello(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.end({ reason: "deadline", detail: "the device sent no hello within the deadline" });
        reject(new NetconfSessionError({ reason: "deadline", detail: "the device sent no hello within the deadline" }));
      }, this.limits.helloMs);
      this.helloWaiter = (message) => {
        clearTimeout(timer);
        this.helloWaiter = null;
        resolve(message);
      };
    });
  }

  /** Sends one of the five allowed operations and answers its reply, matched by message-id. */
  request(request: NetconfRequest): Promise<string> {
    if (this.ended) return Promise.reject(new NetconfSessionError(this.ended));
    if (this.pending) {
      // One request at a time. Netopeer2 answers pipelined requests in order, measured, but a
      // single outstanding request is what makes the message-id rule enforceable rather than
      // advisory.
      return Promise.reject(new NetconfSessionError({ reason: "internal", detail: "a request is already in flight" }));
    }
    const messageId = this.nextId++;
    const text = buildRpc(request, messageId);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(
          new NetconfSessionError({ reason: "deadline", detail: "the device did not answer within the deadline" }),
        );
      }, this.limits.requestMs);
      this.pending = { messageId, resolve, reject, timer };
      this.transport.write(frame(text, this.framing));
    });
  }

  /** `<close-session>`, then the transport. Never `<kill-session>`, requirement NC-S8. */
  async close(): Promise<void> {
    if (this.ended) return;
    try {
      await this.request({ operation: "close-session" });
    } catch {
      // A device that drops the channel on close is not an error worth reporting: the session is
      // over either way, which is the only thing this method promises.
    }
    this.end({ reason: "closed-by-us" });
    this.transport.close();
  }

  get notificationCount(): number {
    return this.notifications;
  }

  private onData(chunk: string): void {
    if (this.ended) return;
    const step = this.reader.feed(chunk);
    if (step.fault) {
      // One end, with the framing fault as its reason. A second call followed this one, describing
      // a framing fault as "a reply with no message-id": dead, because `end` keeps the FIRST reason
      // and ignores later ones, and wrong, because the two are different faults with different
      // answers. A reader told the stream broke looks at the wire; a reader told a reply carried no
      // id looks at the device's replies. The dead call could only ever have moved them the wrong
      // way, and a sentence that cannot run is still a sentence somebody will read.
      this.end({ reason: "framing", fault: step.fault });
      return;
    }
    for (const message of step.messages) {
      this.onMessage(message);
      if (this.ended) return;
    }
  }

  private onMessage(message: string): void {
    if (this.helloWaiter) {
      this.helloWaiter(message);
      return;
    }
    const id = messageIdOf(message);
    if (id === null) {
      if (localNameOf(firstElementTag(message)) === "notification") {
        // This provider sends no create-subscription, so a notification means the session is
        // carrying somebody else's subscription or the device sent one unasked. Either way it is
        // not a reply and it must not be counted as one.
        this.notifications += 1;
        return;
      }
      this.end({
        reason: "protocol",
        detail: "the device sent a reply with no message-id, so no reply can be matched to its request",
      });
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    if (id !== String(pending.messageId)) {
      clearTimeout(pending.timer);
      this.pending = null;
      const end: SessionEnd = {
        reason: "protocol",
        detail: `the device answered message-id ${id} to request ${pending.messageId}`,
      };
      this.end(end);
      pending.reject(new NetconfSessionError(end));
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(message);
  }

  private end(end: SessionEnd): void {
    if (this.ended) return;
    this.ended = end;
    const pending = this.pending;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending = null;
      pending.reject(new NetconfSessionError(end));
    }
  }
}
