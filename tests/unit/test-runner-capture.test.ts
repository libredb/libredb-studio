import { describe, expect, test } from "bun:test";
import { CAPTURE_HEAD_BYTES, CAPTURE_TAIL_BYTES, captureBounded } from "../runner/capture";

/** A stream that hands out exactly these chunks, the way a child's pipe does. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** `text` repeated until it is exactly `length` bytes, so a slice is recognisable. */
function filler(text: string, length: number): string {
  return text.repeat(Math.ceil(length / text.length)).slice(0, length);
}

describe("capturing a child's output", () => {
  test("a stream under the limit comes back byte for byte, with no marker", async () => {
    const text = "bun test v1.4.2\nπ over several chunks, ünicode included\n 3 pass\n";
    const chunks = [bytes(text.slice(0, 20)), bytes(text.slice(20))];

    const captured = await captureBounded(streamOf(chunks), { name: "stdout", headBytes: 64, tailBytes: 64 });

    expect(captured).toBe(text);
    expect(captured).not.toContain("elided");
  });

  test("an empty stream is an empty string", async () => {
    expect(await captureBounded(streamOf([]), { name: "stderr", headBytes: 8, tailBytes: 8 })).toBe("");
  });

  test("a stream longer than head plus tail keeps both ends and says how much went, and from which stream", async () => {
    const head = filler("HEAD-", 1000);
    const middle = filler("middle-", 5000);
    const tail = `${filler("TAIL-", 991)}\n 3 pass\n`;
    const chunks = [bytes(head), bytes(middle), bytes(tail)];

    const captured = await captureBounded(streamOf(chunks), { name: "stderr", headBytes: 1000, tailBytes: 1000 });

    expect(captured).toBe(`${head}\n[runner: 5000 bytes of stderr elided here]\n${tail}`);
    // The end of the stream is what a reader needs most, because bun writes its
    // failure diffs and its per-file summary there.
    expect(captured.endsWith(" 3 pass\n")).toBe(true);
  });

  test("limits that fall in the middle of a chunk keep exactly the head and tail bytes asked for", async () => {
    const chunks = ["abc", "def", "ghi", "jkl", "mno"].map(bytes);

    const captured = await captureBounded(streamOf(chunks), { name: "stdout", headBytes: 5, tailBytes: 5 });

    expect(captured).toBe("abcde\n[runner: 5 bytes of stdout elided here]\nklmno");
  });

  test("a stream of exactly head plus tail bytes is kept whole", async () => {
    // The paired control for the case above: one byte more is what starts the eliding.
    const whole = filler("x", 10);

    expect(await captureBounded(streamOf([bytes(whole)]), { name: "stdout", headBytes: 5, tailBytes: 5 })).toBe(whole);
    expect(
      await captureBounded(streamOf([bytes(`${whole}y`)]), { name: "stdout", headBytes: 5, tailBytes: 5 }),
    ).toContain("[runner: 1 bytes of stdout elided here]");
  });

  test("the limits the runner uses are a megabyte at each end of each stream", () => {
    // The basis is measured, and is argued in the module's docblock: the largest real
    // file prints 154,526 bytes on stdout and the largest stderr is 48,369 bytes.
    expect(CAPTURE_HEAD_BYTES).toBe(1024 * 1024);
    expect(CAPTURE_TAIL_BYTES).toBe(1024 * 1024);
  });

  test("the default limits keep a real file's output whole", async () => {
    const output = filler("a real test file's console output\n", 200_000);

    expect(await captureBounded(streamOf([bytes(output)]), { name: "stdout" })).toBe(output);
  });
});
