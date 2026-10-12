/**
 * The recorded RabbitMQ answers under `tests/fixtures/rabbitmq/`, and the seams that record and replay them.
 *
 * `tests/live/rabbitmq-evidence.ts` runs the real provider against a pinned broker with two recording seams: the
 * management transport factory, whose every GET is kept with its status, content type and body text, and the AMQP
 * dial, whose every byte in both directions is kept. `tests/integration/db/rabbitmq-provider.test.ts` replays them:
 * the management answers through the management API stub, keyed by the stub's own `requestKey`, and the AMQP server
 * bytes through the fake peer.
 *
 * Every capture names the image, the digest, the broker version and the seed content hash it was taken from, and
 * expected outcomes are keyed by the directory, which is the pinned version (`4.3.6`, `4.2.9`) or `nightly`, never by
 * a version a broker reports. A capture built by hand rather than recorded carries `$built` with its reason.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AmqpDial, AmqpSocket } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import type { ManagementTransportFactory } from "@/lib/db/providers/stream/rabbitmq/management/client";
import { requestKey, type StubAnswer } from "./rabbitmq-management-stub";

export type CaptureSet = "4.3.6" | "4.2.9" | "nightly";

export interface CaptureHeader {
  readonly image: string;
  readonly digest: string;
  readonly version: string;
  /** `seedHash()` of `tests/live/rabbitmq-seed.ts` when the broker was seeded. */
  readonly seed: string;
  readonly date: string;
  /** What ran, as whom: "connect() and the tree as studio-reader". */
  readonly surface: string;
}

export interface ManagementExchange {
  readonly method: "GET";
  /** The management API stub's key for this request, `requestKey` of the URL as sent. */
  readonly key: string;
  /** As sent: the Path prefix included, percent-encoding kept. */
  readonly path: string;
  /** The key's query: the pairs decoded and sorted, joined by "&"; empty when there is none. */
  readonly query: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

export interface ManagementCapture {
  readonly $captured: CaptureHeader;
  readonly $built?: string;
  readonly exchanges: readonly ManagementExchange[];
}

export interface AmqpCapture {
  readonly $captured: CaptureHeader;
  readonly $built?: string;
  /** The read request the provider ran. */
  readonly request: string;
  /** Every byte the broker sent on the connection, base64. */
  readonly serverBytes: string;
}

/**
 * Resolved from this file's directory, so the e2e stub finds it as Bun does. `__dirname`, not `import.meta.url`:
 * Playwright loads this file as CommonJS on Node, where `import.meta` is a syntax error, and Bun defines `__dirname`
 * in every module.
 */
export const RABBITMQ_CAPTURES_ROOT = path.join(__dirname, "../fixtures/rabbitmq");

function read<T>(set: CaptureSet, kind: "management" | "amqp", name: string): T {
  return JSON.parse(readFileSync(path.join(RABBITMQ_CAPTURES_ROOT, set, kind, `${name}.json`), "utf8")) as T;
}

export const loadManagementCapture = (set: CaptureSet, name: string): ManagementCapture =>
  read(set, "management", name);
export const loadAmqpCapture = (set: CaptureSet, name: string): AmqpCapture => read(set, "amqp", name);

/** The capture names of one set and kind, sorted. */
export function captureNames(set: CaptureSet, kind: "management" | "amqp"): string[] {
  return readdirSync(path.join(RABBITMQ_CAPTURES_ROOT, set, kind))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** The key the management API stub answers this exchange by, recorded with `requestKey` so the two never differ. */
export const stubKey = (exchange: Pick<ManagementExchange, "key">): string => exchange.key;

/** The capture's answers for `createManagementStub`, one per key, as `recordingTransport` kept them. */
export function stubAnswers(capture: ManagementCapture): Record<string, StubAnswer> {
  const answers: Record<string, StubAnswer> = {};
  for (const exchange of capture.exchanges) {
    const key = stubKey(exchange);
    if (answers[key]) throw new Error(`${capture.$captured.surface}: ${key} is recorded twice`);
    answers[key] = { status: exchange.status, body: exchange.body, contentType: exchange.contentType ?? undefined };
  }
  return answers;
}

/**
 * Wraps the provider's transport factory so every request's answer is kept in `sink`, unchanged for the provider.
 * The stub answers a key one way, so a repeat with the first answer's status is dropped even when its body differs (an
 * overview's rates move between two reads); a repeat with another status is kept, so the capture holds that key twice
 * and the captures' unit test names it, since no replay could play both.
 */
export function recordingTransport(
  inner: ManagementTransportFactory,
  sink: ManagementExchange[],
): ManagementTransportFactory {
  return (options) => {
    const transport = inner(options);
    return {
      async request(request) {
        const response = await transport.request(request);
        const key = requestKey({ method: "GET", url: request.url });
        if (sink.some((exchange) => exchange.key === key && exchange.status === response.status)) return response;
        const mark = key.indexOf("?");
        sink.push({
          method: "GET",
          key,
          path: new URL(request.url).pathname,
          query: mark === -1 ? "" : key.slice(mark + 1),
          status: response.status,
          contentType: response.contentType,
          body: response.text,
        });
        return response;
      },
      close: () => transport.close(),
    };
  };
}

/** The bytes one AMQP connection carried. */
export interface AmqpRecording {
  readonly server: Uint8Array[];
  readonly client: Uint8Array[];
  /** How many server bytes had arrived when the client sent `connection.close`; null while it has not. */
  clientClosedAt: number | null;
}

/** Whether a client write holds a `connection.close` (class 10, method 50, channel 0). */
const holdsConnectionClose = (data: Uint8Array): boolean =>
  splitFrames(data).some((frame) => frame.channel === 0 && frame.classId === 10 && frame.methodId === 50);

/** Wraps the provider's dial so every byte of every connection is kept; the socket the provider gets behaves the same. */
export function recordingDial(inner: AmqpDial, sink: AmqpRecording[]): AmqpDial {
  return async (endpoint, signal) => {
    const socket = await inner(endpoint, signal);
    const recording: AmqpRecording = { server: [], client: [], clientClosedAt: null };
    sink.push(recording);
    let serverBytes = 0;
    const wrapped: AmqpSocket = {
      write(data) {
        recording.client.push(data.slice());
        if (recording.clientClosedAt === null && holdsConnectionClose(data)) recording.clientClosedAt = serverBytes;
        return socket.write(data);
      },
      on(event: "data" | "end" | "close" | "error", listener: (...args: never[]) => void) {
        if (event === "data") {
          return socket.on("data", (chunk: Uint8Array) => {
            recording.server.push(chunk.slice());
            serverBytes += chunk.length;
            (listener as (chunk: Uint8Array) => void)(chunk);
          });
        }
        return socket.on(event as "end", listener as () => void);
      },
      pause: () => socket.pause(),
      resume: () => socket.resume(),
      destroy: () => socket.destroy(),
      get destroyed() {
        return socket.destroyed;
      },
    } as AmqpSocket;
    return wrapped;
  };
}

export const joinBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export interface SplitFrame {
  readonly type: number;
  readonly channel: number;
  readonly classId?: number;
  readonly methodId?: number;
  /** Offsets of the whole frame, header to frame-end, in the byte stream. */
  readonly start: number;
  readonly end: number;
}

/** Splits a server byte stream into frames, after the eight bytes of a protocol header if the stream starts with one. */
export function splitFrames(bytes: Uint8Array): SplitFrame[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: SplitFrame[] = [];
  let at = 0;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 3);
    const end = at + 8 + size;
    if (end > bytes.length) break;
    const type = bytes[at];
    const method = type === 1 ? { classId: view.getUint16(at + 7), methodId: view.getUint16(at + 9) } : {};
    frames.push({ type, channel: view.getUint16(at + 1), ...method, start: at, end });
    at = end;
  }
  return frames;
}

/** The server bytes after `basic.consume-ok`, which the replay peer sends after its own handshake. */
export function bytesAfterConsumeOk(bytes: Uint8Array): Uint8Array {
  const consumeOk = splitFrames(bytes).find((frame) => frame.classId === 60 && frame.methodId === 21);
  if (!consumeOk) throw new Error("the capture holds no basic.consume-ok");
  return bytes.slice(consumeOk.end);
}

/** The last method frame the server sent, whole: the close a failure capture ends with. */
export function lastMethodFrame(bytes: Uint8Array): Uint8Array {
  const methods = splitFrames(bytes).filter((frame) => frame.type === 1);
  const last = methods[methods.length - 1];
  if (!last) throw new Error("the capture holds no method frame");
  return bytes.slice(last.start, last.end);
}

/** The base64 bytes of an AMQP capture. */
export const captureBytes = (capture: AmqpCapture): Uint8Array =>
  new Uint8Array(Buffer.from(capture.serverBytes, "base64"));

/** Every secret that appears in a capture's text, in any of the forms an answer could carry it. */
export function captureSecretHits(text: string, secrets: readonly string[]): string[] {
  return secrets.filter(
    (secret) =>
      secret.length > 0 &&
      [secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)].some((form) => text.includes(form)),
  );
}
