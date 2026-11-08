/**
 * The bounded body reader: a body is counted as it arrives, and the read stops at the first chunk past the bound, with
 * the stream cancelled and nothing after it pulled.
 */
import { describe, expect, test } from "bun:test";
import { BodyLimitExceededError, readBoundedText } from "@/lib/db/http/bounded-body";

/** A body that hands out `chunk` on every pull and never ends, recording how often it was pulled and if it was cancelled. */
function endless(chunk: Uint8Array) {
  const seen = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { response: new Response(body), seen };
}

/** A body of the given chunks, in order, then its end. */
function chunked(...chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("readBoundedText", () => {
  test("answers a body within the bound as text", async () => {
    expect(await readBoundedText(new Response('{"a":1}'), 7)).toBe('{"a":1}');
  });

  test("decodes a character split across two chunks as one, and drops a byte order mark", async () => {
    const bytes = new TextEncoder().encode("﻿denied: é");
    const response = chunked(bytes.subarray(0, bytes.length - 1), bytes.subarray(bytes.length - 1));

    expect(await readBoundedText(response, bytes.length)).toBe("denied: é");
  });

  test("answers an empty string for a response with no body", async () => {
    expect(await readBoundedText(new Response(null, { status: 204 }), 0)).toBe("");
  });

  test("stops at the first chunk past the bound, cancels the stream and pulls nothing after it", async () => {
    const { response, seen } = endless(new Uint8Array(1024));

    let caught: unknown;
    try {
      await readBoundedText(response, 4096);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BodyLimitExceededError);
    expect((caught as BodyLimitExceededError).bytesRead).toBe(5120);
    expect((caught as BodyLimitExceededError).limit).toBe(4096);
    expect((caught as Error).message).toBe("The response body passed 4096 bytes and was not read further");
    expect(seen.pulls).toBe(5);
    expect(seen.cancelled).toBe(true);
  });
});
