/**
 * A response body read as UTF-8 text under a byte bound, for any HTTP-speaking engine.
 *
 * `Response.text()` holds the whole body before a caller can count it, so a bound checked after it bounds nothing: an
 * answer of any size is already in memory. Here the body is pulled one chunk at a time and its bytes are counted as they
 * arrive; the first chunk that takes the count past the bound cancels the stream, which releases the connection, and
 * the read fails with {@link BodyLimitExceededError} before anything past the bound is decoded or parsed.
 */

/** A body that passed the bound it was read under; the stream was cancelled and the rest was never pulled. */
export class BodyLimitExceededError extends Error {
  constructor(
    /** The bytes pulled when the read stopped, the chunk that passed the bound included. */
    readonly bytesRead: number,
    readonly limit: number,
  ) {
    super(`The response body passed ${limit} bytes and was not read further`);
    this.name = "BodyLimitExceededError";
    Object.setPrototypeOf(this, BodyLimitExceededError.prototype);
  }
}

/**
 * The body of `response` as text, at most `limit` bytes of it. A character split across two chunks decodes as one,
 * and a leading byte order mark is dropped, as `Response.text()` does.
 */
export async function readBoundedText(response: Response, limit: number): Promise<string> {
  const stream = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const decoded: string[] = [];
  let pulled = 0;
  let chunk = await reader.read();
  while (!chunk.done) {
    pulled += chunk.value.byteLength;
    if (pulled > limit) {
      // oxlint-disable-next-line no-await-in-loop -- the read ends here: the cancel is awaited once and the loop is left.
      await reader.cancel();
      throw new BodyLimitExceededError(pulled, limit);
    }
    decoded.push(decoder.decode(chunk.value, { stream: true }));
    // oxlint-disable-next-line no-await-in-loop -- a stream is pulled one chunk after the other, each counted first.
    chunk = await reader.read();
  }
  decoded.push(decoder.decode());
  return decoded.join("");
}
