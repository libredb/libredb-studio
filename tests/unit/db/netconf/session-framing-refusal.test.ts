/**
 * A request whose framed text cannot be sent leaves the session as it found it.
 *
 * End-of-message framing cannot carry a body that already holds `]]>]]>` (RFC 6242 section 4.3),
 * so `frame()` refuses one. The real request builder cannot produce that text today, so this file
 * replaces it with one that does. That replacement is process-wide in bun, which is why the case
 * lives in its own file. What it holds: the refusal happens before the session takes the request
 * as in flight, so the next request on the same session is sent rather than refused as busy.
 */
import { mock, test } from "bun:test";
import { expectBe, expectTruthy } from "./helpers";
import { QueryError } from "@/lib/db/errors";
import { EOM } from "@/lib/db/providers/network/netconf/framing";
import * as requests from "@/lib/db/providers/network/netconf/requests";

const realBuildRpc = requests.buildRpc;
let unframeable = true;
mock.module("@/lib/db/providers/network/netconf/requests", () => ({
  ...requests,
  buildRpc: (request: requests.NetconfRequest, messageId: number): string =>
    unframeable ? `<rpc message-id="${messageId}"><get>]]>]]></get></rpc>` : realBuildRpc(request, messageId),
}));

const { NetconfSession } = await import("@/lib/db/providers/network/netconf/session");

class FakeTransport {
  written: string[] = [];
  private data: ((chunk: string) => void) | null = null;
  write(text: string): void {
    this.written.push(text);
  }
  onData(handler: (chunk: string) => void): void {
    this.data = handler;
  }
  onClose(): void {}
  close(): void {}
  send(chunk: string): void {
    this.data?.(chunk);
  }
}

test("a request refused by end-of-message framing leaves the session free for the next one", async () => {
  const transport = new FakeTransport();
  const opening = NetconfSession.open(transport, {
    maxMessageBytes: 1024 * 1024,
    maxBufferBytes: 4 * 1024 * 1024,
    helloMs: 500,
    requestMs: 5_000,
  });
  transport.send(
    `<hello xmlns="urn:ietf:params:xml:ns:netconf:base:1.0"><capabilities><capability>urn:ietf:params:netconf:base:1.0</capability></capabilities><session-id>7</session-id></hello>${EOM}`,
  );
  const { session } = await opening;
  const written = transport.written.length;

  const refused = await Promise.resolve()
    .then(() => session.request({ operation: "get" }))
    .catch((e: unknown) => e);
  expectTruthy(refused instanceof QueryError);
  expectBe(transport.written.length, written, "a refused request writes nothing");

  unframeable = false;
  const reply = session.request({ operation: "get" });
  expectBe(transport.written.length, written + 1, "the next request is sent");
  const sent = transport.written[written] ?? "";
  const id = /message-id="(\d+)"/.exec(sent)?.[1];
  transport.send(
    `<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="${id}"><data/></rpc-reply>${EOM}`,
  );
  expectTruthy((await reply).includes("<data"));
});
