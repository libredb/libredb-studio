/**
 * Reading a child's stdout or stderr without letting one file's output size the run.
 *
 * The output is captured rather than inherited because several files run at once, so
 * it has to be held in memory until the file lands. Held with no bound, one runaway
 * test file sizes the runner: measured on bun 1.4.2, a file printing 300 MB took the
 * runner to 577 MB of RSS, and the whole run's output added up because every outcome
 * kept its own.
 *
 * So each stream keeps its first CAPTURE_HEAD_BYTES and its last CAPTURE_TAIL_BYTES,
 * and says in one line how many bytes fell between them. Both ends are kept because
 * both are read: the head has bun's file header and the first failure diff, and the
 * tail has the rest of the diffs and bun's own per-file summary.
 *
 * The limit is a megabyte at each end, measured against this repository rather than
 * guessed: over the 543 test files the tree held when this was measured, the largest
 * printed 154,526 bytes on stdout and the largest stderr was 48,369 bytes, with a
 * median of 104 bytes. A megabyte is about 7x
 * the largest stdout and about 20x the largest stderr, so nothing that runs here
 * today is ever cut, and the worst case per running child is 4 MB.
 *
 * Nothing is decided from this text (the counts and the skips come from the child's
 * junit report, see tests/runner/report.ts), so a cut can never change a verdict.
 */

/** Bytes kept from the start of each stream. */
export const CAPTURE_HEAD_BYTES = 1024 * 1024;

/** Bytes kept from the end of each stream. */
export const CAPTURE_TAIL_BYTES = 1024 * 1024;

export type CaptureLimits = {
  /** The stream's name, for the line that says what was left out. */
  name: "stdout" | "stderr";
  headBytes?: number;
  tailBytes?: number;
};

function join(chunks: Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return joined;
}

export async function captureBounded(
  stream: ReadableStream<Uint8Array>,
  { name, headBytes = CAPTURE_HEAD_BYTES, tailBytes = CAPTURE_TAIL_BYTES }: CaptureLimits,
): Promise<string> {
  const head: Uint8Array[] = [];
  let headLength = 0;
  const tail: Uint8Array[] = [];
  let tailLength = 0;
  let elidedBytes = 0;

  const reader = stream.getReader();
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk, in order.
    const { done, value } = await reader.read();
    if (done) break;
    let rest = value;

    if (headLength < headBytes) {
      const take = Math.min(headBytes - headLength, rest.length);
      head.push(rest.subarray(0, take));
      headLength += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) continue;

    tail.push(rest);
    tailLength += rest.length;
    while (tailLength > tailBytes) {
      const oldest = tail[0] as Uint8Array;
      const excess = tailLength - tailBytes;
      if (oldest.length <= excess) {
        tail.shift();
        elidedBytes += oldest.length;
        tailLength -= oldest.length;
        continue;
      }
      // slice rather than subarray: a copy lets the chunk that held the dropped bytes go.
      tail[0] = oldest.slice(excess);
      elidedBytes += excess;
      tailLength -= excess;
    }
  }

  const decoder = new TextDecoder();
  if (elidedBytes === 0) return decoder.decode(join([...head, ...tail], headLength + tailLength));
  // The two ends are decoded separately, so a multi-byte character or an escape
  // sequence that straddles a cut decodes as a replacement character. That is the
  // honest reading of text with a hole in it, and the hole is stated where it is.
  return [
    decoder.decode(join(head, headLength)),
    `\n[runner: ${elidedBytes} bytes of ${name} elided here]\n`,
    decoder.decode(join(tail, tailLength)),
  ].join("");
}
