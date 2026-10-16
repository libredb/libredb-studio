/**
 * The byte transport built on ssh2's channel.
 *
 * ssh2 itself is not here: the channel and the client are fakes, because what is being held is not
 * ssh2's behaviour but the three decisions `node-ports.ts` makes over it. The decisions are the
 * decoder, the two sources a close can come from, and what `close()` ends.
 */
import { test } from "bun:test";
import { expectBe, expectEqual, expectTruthy } from "./helpers";
import { transportOf, type ChannelLike, type ClientLike } from "@/lib/db/providers/network/netconf/node-ports";

interface Fakes {
  readonly channel: ChannelLike;
  readonly client: ClientLike;
  readonly written: string[];
  data(chunk: Buffer): void;
  closeChannel(): void;
  closeClient(): void;
  readonly ended: { channel: number; client: number };
}

function fakes(): Fakes {
  const written: string[] = [];
  const ended = { channel: 0, client: 0 };
  let onData: ((chunk: Buffer) => void) | null = null;
  let onChannelClose: (() => void) | null = null;
  let onClientClose: (() => void) | null = null;
  return {
    written,
    ended,
    channel: {
      write: (text) => void written.push(text),
      on: (_event, handler) => void (onData = handler),
      once: (_event, handler) => void (onChannelClose = handler),
      end: () => void (ended.channel += 1),
    },
    client: {
      once: (_event, handler) => void (onClientClose = handler),
      end: () => void (ended.client += 1),
    },
    data: (chunk) => onData?.(chunk),
    closeChannel: () => onChannelClose?.(),
    closeClient: () => onClientClose?.(),
  };
}

/**
 * The decoder is the point of `transportOf`. A chunk size counts bytes, and a device name or a
 * description can carry a character whose bytes land in two TCP segments. Decoding each segment on
 * its own turns that one character into two replacement characters, the reply still parses, and the
 * value is quietly wrong: nothing fails, so nothing reports it.
 */
test("a character whose bytes arrive in two reads is delivered once, whole", () => {
  const f = fakes();
  const transport = transportOf(f.channel, f.client);
  const seen: string[] = [];
  transport.onData((text) => seen.push(text));
  // One character of each UTF-8 length, because a decoder can be wrong about any of them: the
  // micro sign is two bytes, the euro sign three and the emoji four. Fed one byte at a time, so
  // every one of them is split.
  const text = "ge-0/0/0 \u{00B5}\u{20AC}\u{1F600}";
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length; at += 1) f.data(bytes.subarray(at, at + 1));
  expectBe(seen.join(""), text);
  expectTruthy(!seen.join("").includes("�"));
});

test("a split in the middle of a multi byte character holds nothing back once its bytes arrive", () => {
  const f = fakes();
  const transport = transportOf(f.channel, f.client);
  let seen = "";
  transport.onData((text) => void (seen += text));
  const bytes = Buffer.from("\u{1F600}", "utf8");
  f.data(bytes.subarray(0, 2));
  expectBe(seen, "", "half a character is not a character and must not be delivered");
  f.data(bytes.subarray(2));
  expectBe(seen, "\u{1F600}");
});

/**
 * Either end can close first, and which one wins is a race: the channel closes when the device ends
 * the session, the client closes when the connection drops under it. The outcome is the same in
 * every order, which is what makes the race unobservable rather than merely unlikely. The session's
 * own end is idempotent, so a second close is the same close.
 */
test("a close from either end reaches the session, in any order, and the outcome is the same", () => {
  for (const order of [["channel"], ["client"], ["channel", "client"], ["client", "channel"]]) {
    const f = fakes();
    const transport = transportOf(f.channel, f.client);
    let closes = 0;
    transport.onClose(() => void (closes += 1));
    for (const source of order) {
      if (source === "channel") f.closeChannel();
      else f.closeClient();
    }
    expectTruthy(closes >= 1, `no close reached the session for ${order.join(" then ")}`);
  }
});

test("close ends the channel and the client, so neither half is left open", () => {
  const f = fakes();
  transportOf(f.channel, f.client).close();
  expectEqual(f.ended, { channel: 1, client: 1 });
});

test("write passes the text through as it was given", () => {
  const f = fakes();
  transportOf(f.channel, f.client).write("<rpc/>");
  expectEqual(f.written, ["<rpc/>"]);
});
