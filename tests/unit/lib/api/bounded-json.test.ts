import { describe, expect, test } from "bun:test";
import { readBoundedJson } from "@/lib/api/bounded-json";

const LIMIT = 64;
const encoder = new TextEncoder();

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/x", { method: "POST", body, headers });
}

/** A body stream that serves `chunks`, then either ends or keeps serving `tail` forever. */
function recordingStream(chunks: Uint8Array[], tail?: Uint8Array) {
  const state = { pulls: 0, cancelled: false };
  const queue = [...chunks];
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        const next = queue.shift() ?? tail;
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    // No read-ahead: a pull happens only when the reader asks, so a pull count proves a read.
    { highWaterMark: 0 },
  );
  return { stream, state };
}

describe("readBoundedJson", () => {
  test("parses a JSON body under the limit", async () => {
    const result = await readBoundedJson(post(JSON.stringify({ action: "rename", name: "Laptop" })), LIMIT);
    expect(result).toEqual({ ok: true, body: { action: "rename", name: "Laptop" } });
  });

  test("parses a body split across several chunks", async () => {
    const { stream } = recordingStream([encoder.encode('{"a":'), encoder.encode("1}")]);
    expect(await readBoundedJson(post(stream), LIMIT)).toEqual({ ok: true, body: { a: 1 } });
  });

  test("refuses a body over the limit with 413 without reading past it", async () => {
    const exact = recordingStream([new Uint8Array(LIMIT + 1).fill(0x20)]);
    expect(await readBoundedJson(post(exact.stream), LIMIT)).toEqual({ ok: false, status: 413, reason: "too_large" });

    const endless = recordingStream([], new Uint8Array(16).fill(0x20));
    expect(await readBoundedJson(post(endless.stream), LIMIT)).toEqual({ ok: false, status: 413, reason: "too_large" });
    expect(endless.state.cancelled).toBe(true);
    // Five chunks of 16 bytes cross 64; the reader stops there instead of draining the stream.
    expect(endless.state.pulls).toBeLessThan(10);
  });

  test("refuses a declared Content-Length over the limit without reading the body", async () => {
    const { stream, state } = recordingStream([encoder.encode("{}")]);
    const request = post(stream, { "content-length": String(LIMIT + 1) });
    expect(await readBoundedJson(request, LIMIT)).toEqual({ ok: false, status: 413, reason: "too_large" });
    expect(state.pulls).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });

  test("refuses an empty or unparseable body with 400, and says which", async () => {
    expect(await readBoundedJson(post(null), LIMIT)).toEqual({ ok: false, status: 400, reason: "empty" });
    expect(await readBoundedJson(post(""), LIMIT)).toEqual({ ok: false, status: 400, reason: "empty" });
    // Bytes that are only whitespace are a body, and not JSON.
    expect(await readBoundedJson(post("  "), LIMIT)).toEqual({ ok: false, status: 400, reason: "malformed" });
    expect(await readBoundedJson(post("{not json"), LIMIT)).toEqual({ ok: false, status: 400, reason: "malformed" });
    const invalidUtf8 = recordingStream([new Uint8Array([0x22, 0xff, 0x22])]);
    expect(await readBoundedJson(post(invalidUtf8.stream), LIMIT)).toEqual({
      ok: false,
      status: 400,
      reason: "malformed",
    });
  });

  test("counts bytes, not characters", async () => {
    // 22 characters of three UTF-8 bytes each, plus the two quotes: 24 characters, 68 bytes.
    const body = JSON.stringify("€".repeat(22));
    expect(body.length).toBeLessThan(LIMIT);
    expect(encoder.encode(body).byteLength).toBeGreaterThan(LIMIT);
    expect(await readBoundedJson(post(body), LIMIT)).toEqual({ ok: false, status: 413, reason: "too_large" });
  });
});
