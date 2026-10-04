/**
 * A recording transport for the InfluxDB route-table client (InfluxDB spec 8, contract section 19): what
 * `createInfluxClient` takes in place of the shared `createNodeTransport`, through the provider constructor's client
 * factory, so a test sees every request the client would have put on the wire and answers it from a committed
 * capture, with no socket and no `mock.module()`.
 *
 * Each request takes the next scripted answer. A capture with `cut` fails as the shared transport fails a body the
 * server ended before its terminating chunk: kind "network" with `truncated` set. A request past the script throws.
 * The signal and the byte cap are honoured as the shared transport honours them: an already-aborted signal fails
 * before anything is recorded or answered (kind "timeout" for an `AbortSignal.timeout()` reason, "aborted"
 * otherwise), and a body longer than `maxResponseBytes` fails as kind "too-large", cut or not, since its bytes arrive
 * before the cut. A signal that fires after the request was answered has nothing left to stop.
 */
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import type { InfluxCapture } from "./influxdb-fixtures";

export interface RecordedInfluxRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly form?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** The headers the transport was built with: the connection's, the credential among them. */
  readonly headers: Readonly<Record<string, string>>;
}

export type ScriptedAnswer = InfluxCapture | ((request: RecordedInfluxRequest) => InfluxCapture);

/** The shared transport's failure for an aborted signal: a deadline or a cancellation, told apart by the reason. */
function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

function recorded(request: NodeRequest, headers: Readonly<Record<string, string>>): RecordedInfluxRequest {
  return {
    method: request.method,
    url: request.url,
    ...(request.form === undefined ? {} : { form: request.form }),
    ...(request.body === undefined ? {} : { body: request.body }),
    headers,
  };
}

export function recordingInfluxTransport(script: readonly ScriptedAnswer[]): {
  readonly factory: (options: NodeTransportOptions) => NodeTransport;
  readonly requests: RecordedInfluxRequest[];
} {
  const requests: RecordedInfluxRequest[] = [];
  let next = 0;
  const factory = (options: NodeTransportOptions): NodeTransport => ({
    async request(request): Promise<NodeResponse> {
      if (request.signal.aborted) throw abortFailure(request.signal);
      const seen = recorded(request, options.headers);
      requests.push(seen);
      const scripted = script[next];
      if (scripted === undefined) throw new Error(`No scripted answer is left for ${request.method} ${request.url}`);
      next += 1;
      const capture = typeof scripted === "function" ? scripted(seen) : scripted;
      if (Buffer.byteLength(capture.body) > request.maxResponseBytes) {
        throw new TransportError(
          "too-large",
          `The response exceeded the ${request.maxResponseBytes}-byte limit for one response, so it was not read to the end`,
        );
      }
      if (capture.cut !== undefined) {
        throw new TransportError("network", "The server ended the response before it was complete", {
          truncated: true,
        });
      }
      return { status: capture.status, contentType: capture.contentType, retryAfter: null, text: capture.body };
    },
    close() {},
  });
  return { factory, requests };
}
