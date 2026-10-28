/**
 * Session tests, driven by a fake transport so that every rule is exercised without a network.
 * The rules they hold are the ones a server may break, listed in `session.ts`.
 */
import { test } from "bun:test";
import { expectBe, expectMatch, expectRejects, expectThrows, expectTruthy } from "./helpers";
import { EOM, frame } from "@/lib/db/providers/network/netconf/framing";
import {
  NetconfSession,
  NetconfSessionError,
  clientHello,
  framingFor,
  readHello,
  type Transport,
} from "@/lib/db/providers/network/netconf/session";
import { rememberNamespace } from "@/lib/db/providers/network/netconf/requests";
import { READER_LIMITS, XmlReaderError, type XmlReaderPort } from "@/lib/db/providers/network/netconf/reader-port";

const limits = {
  maxMessageBytes: 1024 * 1024,
  maxBufferBytes: 4 * 1024 * 1024,
  helloMs: 500,
  requestMs: 500,
};

class FakeTransport implements Transport {
  written: string[] = [];
  private data: ((chunk: string) => void) | null = null;
  private closed: (() => void) | null = null;
  closedByUs = false;

  write(text: string): void {
    this.written.push(text);
  }
  onData(handler: (chunk: string) => void): void {
    this.data = handler;
  }
  onClose(handler: () => void): void {
    this.closed = handler;
  }
  close(): void {
    this.closedByUs = true;
  }
  /** Pushes bytes as if the device had sent them. */
  send(chunk: string): void {
    this.data?.(chunk);
  }
  drop(): void {
    this.closed?.();
  }
}

const helloWith = (bases: readonly string[], sessionId = "7"): string =>
  `<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities>${bases
    .map((b) => `<capability>${b}</capability>`)
    .join("")}</capabilities><session-id>${sessionId}</session-id></hello>${EOM}`;

const BASE10 = "urn:ietf:params:netconf:base:1.0";
const BASE11 = "urn:ietf:params:netconf:base:1.1";

test("the client hello offers both base versions, so the device picks the framing", () => {
  expectTruthy(clientHello().includes(BASE10));
  expectTruthy(clientHello().includes(BASE11));
});

test("a hello with no session-id ends the session, which RFC 6241 8.1 requires", () => {
  expectThrows(() => readHello("<hello><capabilities/></hello>"), NetconfSessionError);
});

test("the framing follows the device: base:1.1 chunked, base:1.0 end-of-message, neither refused", () => {
  expectBe(framingFor({ sessionId: "1", capabilities: [], bases: [BASE10, BASE11] }), "chunked");
  expectBe(framingFor({ sessionId: "1", capabilities: [], bases: [BASE10] }), "eom");
  expectThrows(() => framingFor({ sessionId: "1", capabilities: [], bases: [] }), NetconfSessionError);
});

test("a session opens, settles on chunked, and answers a request matched by message-id", async () => {
  rememberNamespace("ietf-interfaces", "urn:ietf:params:xml:ns:yang:ietf-interfaces");
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10, BASE11]));
  const { session, hello } = await opening;
  expectBe(hello.sessionId, "7");
  const reply = session.request({ operation: "get-config", source: "running" });
  // The request went out in chunked framing.
  expectMatch(transport.written[1] ?? "", /^\n#\d+\n/);
  // The chunk size counts bytes, so the reply is framed by the same writer the client uses.
  transport.send(frame('<rpc-reply message-id="1"><data/></rpc-reply>', "chunked"));
  expectMatch(await reply, /message-id="1"/);
});

test("a reply carrying another request's message-id ends the session", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const reply = session.request({ operation: "get" });
  transport.send(`<rpc-reply message-id="999"><data/></rpc-reply>${EOM}`);
  await expectRejects(reply, /answered message-id 999 to request 1/);
});

test("a notification is not a reply, and it is counted rather than mistaken for one", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const reply = session.request({ operation: "get" });
  transport.send(
    `<notification xmlns="urn:ietf:params:xml:ns:netconf:notification:1.0"><eventTime/></notification>${EOM}`,
  );
  transport.send(`<rpc-reply message-id="1"><data/></rpc-reply>${EOM}`);
  expectMatch(await reply, /message-id="1"/);
  expectBe(session.notificationCount, 1);
});

/**
 * The same fact for a notification written with a namespace prefix, which is the same element.
 *
 * MEASURED: the detection was `message.includes("<notification")`, so a prefixed notification was
 * taken for a reply carrying no message-id and ENDED THE SESSION, with a sentence about the device.
 * A reader cannot tell "the device is misbehaving" from "this client cannot read the spelling", and
 * the first is what the sentence said.
 *
 * It is a session test and not a reader test on purpose: the previous round asserted that the id
 * reader answers null for a prefixed notification, which was true before the fix as well, so that
 * assertion could not fail. What changed is what the SESSION does with it.
 */
test("a notification written with a prefix is counted, and the session survives it", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const reply = session.request({ operation: "get" });
  transport.send(
    '<nc:notification xmlns:nc="urn:ietf:params:xml:ns:netconf:notification:1.0"><nc:eventTime/></nc:notification>' +
      EOM,
  );
  transport.send(`<rpc-reply message-id="1"><data/></rpc-reply>${EOM}`);
  expectMatch(await reply, /message-id="1"/);
  expectBe(session.notificationCount, 1);
});

test("a reply with no message-id and no notification element ends the session", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const reply = session.request({ operation: "get" });
  transport.send(`<rpc-reply><data/></rpc-reply>${EOM}`);
  await expectRejects(reply, /no message-id/);
});

test("a framing fault ends the session rather than waiting for the device to close the channel", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10, BASE11]));
  const { session } = await opening;
  const reply = session.request({ operation: "get" });
  transport.send("\n#0172\n" + "x".repeat(172) + "\n##\n");
  await expectRejects(reply, /framing/);
});

test("a device that sends no hello within the deadline ends the attempt", async () => {
  const transport = new FakeTransport();
  await expectRejects(NetconfSession.open(transport, { ...limits, helloMs: 20 }), /no hello within the deadline/);
});

test("close sends close-session and then closes the transport, and never kill-session", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const closing = session.close();
  const sent = transport.written.at(-1) ?? "";
  expectMatch(sent, /<close-session\/>/);
  expectBe(sent.includes("kill-session"), false);
  transport.send(`<rpc-reply message-id="1"><ok/></rpc-reply>${EOM}`);
  await closing;
  expectBe(transport.closedByUs, true);
});

test("a device that drops the channel on close-session still leaves the session closed, by us", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const closing = session.close();
  transport.drop();
  await closing;
  expectBe(transport.closedByUs, true);
});

test("a request after this side closed the session is refused with the sentence for that ending", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const closing = session.close();
  transport.send(`<rpc-reply message-id="1"><ok/></rpc-reply>${EOM}`);
  await closing;
  await expectRejects(session.request({ operation: "get" }), /this session was closed/);
});

test("a device that drops the channel fails the request in flight with a sentence", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, limits);
  transport.send(helloWith([BASE10]));
  const { session } = await opening;
  const reply = session.request({ operation: "get" });
  transport.drop();
  await expectRejects(reply, /the device closed this session/);
});

test("the reader port refuses a DOCTYPE, which RFC 6241 3.2 forbids in NETCONF content", () => {
  // The real reader lands with another session (K-10). This fake holds the provider to the shape
  // it will be given, and the DOCTYPE rule is the one the provider depends on rather than hopes for.
  const fake: XmlReaderPort = {
    parse(message) {
      if (/<!DOCTYPE/i.test(message)) throw new XmlReaderError({ kind: "doctype" });
      return { name: "data", attributes: new Map(), children: [], bindings: new Map() };
    },
  };
  expectThrows(() => fake.parse('<!DOCTYPE x [<!ENTITY a "b">]><data/>', READER_LIMITS), XmlReaderError);
  expectBe(fake.parse("<data/>", READER_LIMITS).name, "data");
});

/**
 * Four endings that a reader answers four different ways, held apart by their REASON.
 *
 * MEASURED: all four answered `protocol`, with seven different sentences across nine places. The
 * sentences serve a person reading one and serve nothing that branches on the field, so the four
 * were separated only by prose. They are answered differently: a deadline asks for patience or a
 * longer one; a device offering no base version this client speaks cannot be used at all, which is
 * compatibility rather than misbehaviour; a request already in flight is THIS PROVIDER'S defect and
 * has no business wearing a word that describes the device; and a reply NETCONF does not allow is
 * the device.
 *
 * The last of those is the fourth scope of the error rules: our own defect is never dressed as a
 * fact about the device. A reason code was breaking that rule while every sentence stayed true.
 */
test("a deadline, an incompatibility, our own defect and a device fault end with four reasons", async () => {
  const deadline = new FakeTransport();
  const timedOut = await NetconfSession.open(deadline, { ...limits, helloMs: 20 }).catch((e: unknown) => e);
  expectTruthy(timedOut instanceof NetconfSessionError);
  expectBe(timedOut.end.reason, "deadline");

  const mismatch = new FakeTransport();
  const opening = NetconfSession.open(mismatch, limits);
  mismatch.send(helloWith(["urn:ietf:params:netconf:base:0.9"]));
  const refused = await opening.catch((e: unknown) => e);
  expectTruthy(refused instanceof NetconfSessionError);
  expectBe(refused.end.reason, "incompatible");

  const busy = new FakeTransport();
  const opened = NetconfSession.open(busy, limits);
  busy.send(helloWith([BASE10]));
  const { session } = await opened;
  // The first request is held and ended here, not left to its own 500 ms deadline: unawaited, it
  // rejected after the test's own checks on a loaded macOS runner and failed the test there.
  const first = session.request({ operation: "get" }).catch((e: unknown) => e);
  const second = await session.request({ operation: "get" }).catch((e: unknown) => e);
  expectTruthy(second instanceof NetconfSessionError);
  expectBe(second.end.reason, "internal", "our own defect must not wear a word about the device");
  busy.drop();
  const dropped = await first;
  expectTruthy(dropped instanceof NetconfSessionError);
  expectBe(dropped.end.reason, "closed-by-peer");

  // The REQUEST deadline as well as the hello one: they are two paths with one meaning, and a test
  // that held only the first left the second free to drift back. A planted mutation did exactly
  // that and survived until this case existed.
  const slow = new FakeTransport();
  const slowOpen = NetconfSession.open(slow, { ...limits, requestMs: 20 });
  slow.send(helloWith([BASE10]));
  const { session: waiting } = await slowOpen;
  const late = await waiting.request({ operation: "get" }).catch((e: unknown) => e);
  expectTruthy(late instanceof NetconfSessionError);
  expectBe(late.end.reason, "deadline");

  const bad = new FakeTransport();
  const third = NetconfSession.open(bad, limits);
  bad.send(helloWith([BASE10]));
  const { session: live } = await third;
  const reply = live.request({ operation: "get" });
  bad.send(`<rpc-reply><data/></rpc-reply>${EOM}`);
  const broken = await reply.catch((e: unknown) => e);
  expectTruthy(broken instanceof NetconfSessionError);
  expectBe(broken.end.reason, "protocol");
});
