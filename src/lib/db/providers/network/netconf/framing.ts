/**
 * RFC 6242 framing for the `netconf` provider, phase 1 (issue #1724).
 *
 * Both framings are spoken. A session starts on end-of-message framing, because the hello is sent
 * before the peer's base version is known, and moves to chunked framing when both sides offered
 * base:1.1. MEASURED 2026-10-13 against Netopeer2 2.8.7: the hello carries base:1.0 and base:1.1,
 * and Clixon 7.3.0 carries both as well once the client stops forcing a version.
 *
 * The decoder is incremental and bounded. It never holds a whole reply as one growing string:
 * a byte cap is counted as bytes arrive, so a peer that never terminates a message ends the read
 * at the cap rather than at the end of memory.
 *
 * What this file does NOT do: it does not parse XML. The reader is written once for the whole
 * repository and inherited here (decision K-10), so a message leaves this file as bytes.
 */

import { QueryError } from "@/lib/db/errors";

/** The end-of-message separator of RFC 6242 section 4.3. */
export const EOM = "]]>]]>";

/** RFC 6242 section 4.2 allows a chunk size of 1 to 4294967295. */
export const MAX_CHUNK_SIZE = 4294967295;

export type Framing = "eom" | "chunked";

export interface FrameLimits {
  /** Bytes a single message may hold. A message that passes it ends the read. */
  readonly maxMessageBytes: number;
  /** Bytes a session may hold undelivered. Guards a peer that never terminates. */
  readonly maxBufferBytes: number;
}

export type FrameFault =
  | { readonly kind: "message-too-large"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "buffer-too-large"; readonly bytes: number; readonly cap: number }
  | { readonly kind: "chunk-header-malformed"; readonly header: string }
  | { readonly kind: "chunk-size-out-of-range"; readonly size: string }
  | { readonly kind: "chunk-size-leading-zero"; readonly size: string };

export interface FrameStep {
  /** Messages completed by the bytes just fed, in arrival order. */
  readonly messages: readonly string[];
  /**
   * Set when the stream broke a rule of RFC 6242. A fault ends the session: section 4.2 requires
   * the peer to close the channel, and MEASURED 2026-10-13 that Netopeer2 does not always do so,
   * so the client applies the rule itself.
   */
  readonly fault?: FrameFault;
}

/**
 * Writes a request in the framing the session negotiated.
 *
 * RFC 6242 section 4.3 says the end-of-message separator does not appear in the data, and a peer
 * reads the first one as the end of the message, so a payload that holds it is refused rather than
 * written as two messages. Chunked framing counts bytes, so the same payload is ordinary data there.
 */
export function frame(payload: string, framing: Framing): string {
  if (framing === "eom") {
    if (payload.includes(EOM)) {
      throw new QueryError(
        `this request holds the end-of-message separator ${EOM}, which RFC 6242 section 4.3 keeps out of the data, so it is not sent`,
      );
    }
    return payload + EOM;
  }
  const bytes = Buffer.byteLength(payload, "utf8");
  return `\n#${bytes}\n${payload}\n##\n`;
}

/**
 * Reads one framing incrementally.
 *
 * A reader instance belongs to one channel. `feed` is called with whatever arrived and answers
 * the messages that are now complete. Bytes are counted as they arrive, not after a message is
 * assembled, which is the only point at which an unterminated stream can still be stopped.
 */
export class FrameReader {
  /**
   * Held as bytes, not as text.
   *
   * WHERE THIS STOPS, and it is a contract limit rather than a bug here: `feed` takes text, because
   * the transport decodes the channel's bytes with a StringDecoder. If a server cut a multi byte
   * character at a chunk boundary, the decoder would hold the incomplete sequence and the next
   * bytes it saw would be the following chunk's header, which is not a continuation, so the
   * character would already be lost before this reader was given anything. No frame reader can
   * recover from that; a transport that carried bytes could. MEASURED 2026-10-13, with a four byte
   * character every 160 bytes of data: Netopeer2 answered chunks of 10,240, 10,236, 10,240, 10,208,
   * 10,240, 10,240, 10,233, 10,195, 10,240, 10,236 and 2,648 bytes, so it SHORTENS a chunk rather
   * than cutting a character, and all eleven decoded on their own. The case is therefore not
   * reachable on the one server measured, and a bytes-carrying transport is not written for a
   * branch nothing runs. A server that chunks blind is UNMEASURED and is the thing to look for on
   * the first device.
   *
   * A chunk size counts bytes and a server chunks by bytes, so a chunk boundary can land in the
   * middle of a multi byte character. Holding text and taking `count` bytes out of it meant
   * decoding a cut sequence: the character became a replacement character, and the string length of
   * that decoded piece no longer matched the bytes consumed, so the buffer slid out of step with
   * the framing as well. Bytes in, one decode when a message is whole, which is what this file
   * already claimed to do.
   */
  private buffer: Buffer = Buffer.alloc(0);
  /**
   * The part of a chunked message whose chunks have arrived, across feeds.
   *
   * MEASURED 2026-10-13, against Netopeer2 over SSH: a 39,348 byte `get-schema` reply arrived in
   * nine pieces, framed as four chunks of 10,240, 10,240, 10,240 and 8,593 bytes. This was a local
   * variable, so a feed that completed a chunk but not the message returned, discarded what it had
   * assembled, and left the next feed to start from empty, while the bytes it dropped had already
   * been taken out of `buffer`. The reader still answered exactly one message, and the message was
   * the tail of the reply with its opening tag missing. Nothing failed: the session then refused
   * the reply for carrying no `message-id`, which is a true sentence about a mutilated message and
   * says nothing about where the bytes went. A reply that had arrived in one piece was correct, so
   * every test that fed a whole message passed.
   */
  private assembled: Buffer = Buffer.alloc(0);
  private framing: Framing;
  private readonly limits: FrameLimits;
  private faulted = false;

  constructor(framing: Framing, limits: FrameLimits) {
    this.framing = framing;
    this.limits = limits;
  }

  /** Moves the channel to chunked framing, after both hellos offered base:1.1. */
  useChunked(): void {
    this.framing = "chunked";
  }

  feed(chunk: string): FrameStep {
    if (this.faulted) return { messages: [] };
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(chunk, "utf8") : Buffer.concat([this.buffer, Buffer.from(chunk, "utf8")]);
    if (this.buffer.length > this.limits.maxBufferBytes) {
      return this.fail({ kind: "buffer-too-large", bytes: this.buffer.length, cap: this.limits.maxBufferBytes });
    }
    return this.framing === "eom" ? this.readEom() : this.readChunked();
  }

  private fail(fault: FrameFault): FrameStep {
    this.faulted = true;
    this.buffer = Buffer.alloc(0);
    this.assembled = Buffer.alloc(0);
    return { messages: [], fault };
  }

  private readEom(): FrameStep {
    const messages: string[] = [];
    for (;;) {
      const at = this.buffer.indexOf(EOM, 0, "utf8");
      if (at === -1) return { messages };
      const bytes = at;
      if (bytes > this.limits.maxMessageBytes) {
        return this.fail({ kind: "message-too-large", bytes, cap: this.limits.maxMessageBytes });
      }
      const message = this.buffer.subarray(0, at).toString("utf8");
      this.buffer = this.buffer.subarray(at + Buffer.byteLength(EOM, "utf8"));
      messages.push(message);
    }
  }

  private readChunked(): FrameStep {
    const messages: string[] = [];
    for (;;) {
      if (startsWith(this.buffer, END)) {
        this.buffer = this.buffer.subarray(END.length);
        if (this.assembled.length > this.limits.maxMessageBytes) {
          return this.fail({
            kind: "message-too-large",
            bytes: this.assembled.length,
            cap: this.limits.maxMessageBytes,
          });
        }
        // The one decode: the whole message's bytes are here, so no character can be cut.
        messages.push(this.assembled.toString("utf8"));
        this.assembled = Buffer.alloc(0);
        continue;
      }
      const header = /^\n#(\d+)\n/.exec(this.buffer.subarray(0, HEADER_MAX).toString("latin1"));
      if (!header) {
        // Either the header has not arrived in full, or it is not a header at all. A header is
        // ASCII, so reading its bytes as latin1 cannot turn a long header into a short one.
        const seen = this.buffer.subarray(0, HEADER_MAX).toString("latin1");
        if (/^\n#\d*$|^\n#?$|^$/.test(seen)) return { messages };
        return this.fail({ kind: "chunk-header-malformed", header: seen.slice(0, 16) });
      }
      const size = header[1] ?? "";
      // RFC 6242 section 4.2 prohibits a leading zero. MEASURED 2026-10-13: Netopeer2 accepts
      // `#0172`, which the same clause forbids, so the client refuses it on its own.
      if (size.length > 1 && size.startsWith("0")) {
        return this.fail({ kind: "chunk-size-leading-zero", size });
      }
      const value = Number(size);
      if (value < 1 || value > MAX_CHUNK_SIZE) {
        return this.fail({ kind: "chunk-size-out-of-range", size });
      }
      const start = header[0].length;
      if (this.buffer.length - start < value) return { messages };
      const body = this.buffer.subarray(start, start + value);
      this.assembled = this.assembled.length === 0 ? Buffer.from(body) : Buffer.concat([this.assembled, body]);
      this.buffer = this.buffer.subarray(start + value);
      // The cap is checked as the message grows, not only where it ends. A peer that keeps sending
      // chunks and never sends the terminator holds bytes here rather than in `buffer`, so
      // checking only at the terminator would leave this half of the read unbounded, and the
      // buffer cap in `feed` would never see them.
      if (this.assembled.length > this.limits.maxMessageBytes) {
        return this.fail({
          kind: "message-too-large",
          bytes: this.assembled.length,
          cap: this.limits.maxMessageBytes,
        });
      }
    }
  }
}

/** The chunked framing's end of message marker, and the longest header this reader will read. */
const END = Buffer.from("\n##\n", "utf8");
const HEADER_MAX = 16;

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}
