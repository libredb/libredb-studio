/**
 * The one gRPC channel Studio opens, its option set, and unary and bidirectional calls with a deadline, the call's own
 * AbortSignal and the sent or unsent notice. Nothing here knows about an engine, and no provider is imported; each
 * provider's adapter maps its own RPCs onto `openGrpcChannel` and hands it the method definitions its descriptor
 * loads. Server-only.
 */
import {
  type CallCredentials,
  type ChannelOptions,
  Client,
  type ClientDuplexStream,
  credentials,
  type MethodDefinition,
  Metadata,
  type ServiceError,
} from "@grpc/grpc-js";
import { ClosingCredentials, grpcChannelCredentials } from "./credentials";
import type { GrpcTlsOptions } from "./tls";

/**
 * How a channel retries a call, which each provider chooses and its doc states.
 * "transparent" is grpc-js's own default: only a call the server never processed (a refused or never-started stream)
 * is sent again, so a name that resolves to several servers fails over across them inside the channel.
 * "none" sets `grpc.enable_retries` 0: no call is ever sent twice, and every failure is the caller's explicit error.
 * Neither installs a retry policy, because no service config is ever loaded.
 */
type GrpcRetries = "transparent" | "none";

/** An HTTP/2 ping every 10 s while a call is open. */
const KEEPALIVE_TIME_MS = 10_000;
/** The connection dropped when a ping is unanswered for 6 s. */
const KEEPALIVE_TIMEOUT_MS = 6_000;

/**
 * The one option set every gRPC channel of Studio opens with, exactly:
 * no service config from DNS, so a `grpc_config=` TXT record installs no retry policy and no balancer;
 * the receive cap the caller passes, so no answer past it is read;
 * no proxy from the environment (`grpc_proxy`, `https_proxy`, `http_proxy`), so the endpoint itself is dialled, which
 * grpc-js otherwise asks to CONNECT to the endpoint (`mapProxyName`, http_proxy.ts);
 * the retry stance the caller passes (GrpcRetries): "none" sets `grpc.enable_retries` 0, "transparent" leaves the key
 * out;
 * an HTTP/2 ping every 10 s while a call is open, and the connection dropped when one is unanswered for 6 s, so a
 * server that stops answering without closing the connection (a lost host, a partition, a frozen VM) fails the call
 * it holds; grpc-js 1.14.5 sends no ping by default (`keepaliveTimeMs` -1, transport.ts);
 * and, with TLS, the TLS name override, so the TLS identity is the override in every TLS mode, never the dialled
 * address.
 * 10 s is twice the 5 s ping minimum every server this transport was measured against enforces (each provider doc
 * names its measurement); `grpc.keepalive_permit_without_calls` stays off, because such servers count a ping with no
 * call open as a strike.
 * Never set: `grpc.default_authority`, `grpc.max_send_message_length`, `grpc.default_compression_algorithm`.
 */
export function grpcChannelOptions(options: {
  readonly receiveCapBytes: number;
  readonly retries: GrpcRetries;
  readonly serverNameOverride?: string;
}): ChannelOptions {
  return {
    "grpc.service_config_disable_resolution": 1,
    "grpc.max_receive_message_length": options.receiveCapBytes,
    "grpc.enable_http_proxy": 0,
    ...(options.retries === "none" ? { "grpc.enable_retries": 0 } : {}),
    "grpc.keepalive_time_ms": KEEPALIVE_TIME_MS,
    "grpc.keepalive_timeout_ms": KEEPALIVE_TIMEOUT_MS,
    ...(options.serverNameOverride === undefined
      ? {}
      : { "grpc.ssl_target_name_override": options.serverNameOverride }),
  };
}

/** One call as a provider's adapter hands it to the channel. */
export interface GrpcCall {
  /** What the adapter attaches to this call, by metadata key; nothing else is sent. */
  readonly metadata: Readonly<Record<string, string>>;
  /** The gRPC deadline of this call. */
  readonly deadline: Date;
  /** The call's own signal: its abort is `call.cancel()`, and an abort before grpc-js picked a transport is `unsent`. */
  readonly signal: AbortSignal;
}

export interface GrpcChannelConfig {
  /** `dns:<host>:<port>` from validated parts, never a server's string. */
  readonly target: string;
  /** Undefined is plaintext. */
  readonly tls?: GrpcTlsOptions;
  /** `grpc.max_receive_message_length`; required, no default. */
  readonly receiveCapBytes: number;
  /** The provider's retry stance; required, no default. */
  readonly retries: GrpcRetries;
  /** The provider's error for a call its own signal ended before grpc-js gave it a transport. */
  readonly unsent: (status: ServiceError) => Error;
}

/** One bidirectional stream, read in flowing mode: messages in order, then the end or the call's error. */
export interface GrpcBidiStream {
  write(message: object): void;
  /** The next message; undefined once the server ended the stream; a rejection with the call's error. */
  read(): Promise<object | undefined>;
  /** grpc-js `call.cancel()`; the stream leaves the channel's open set. */
  cancel(): void;
}

/** The channel of one provider connection; messages are the provider descriptor's, as its loader options read them. */
export interface GrpcChannel {
  unary(method: MethodDefinition<object, object>, request: object, call: GrpcCall): Promise<object>;
  bidiStream(method: MethodDefinition<object, object>, call: GrpcCall): GrpcBidiStream;
  /** Cancels every stream still open, closes the grpc-js client, then ends every socket the credentials hold. */
  close(): void;
}

/** Opens the channel over `ClosingCredentials(grpcChannelCredentials(config.tls))`; sends nothing and dials nothing. */
export function openGrpcChannel(config: GrpcChannelConfig): GrpcChannel {
  const closing = new ClosingCredentials(grpcChannelCredentials(config.tls));
  const client = new Client(
    config.target,
    closing,
    grpcChannelOptions({
      receiveCapBytes: config.receiveCapBytes,
      retries: config.retries,
      ...(config.tls === undefined ? {} : { serverNameOverride: config.tls.serverNameOverride }),
    }),
  );
  const streams = new Set<GrpcBidiStream>();
  return {
    unary: (method, request, call) => unaryCall(client, method, request, call, config.unsent),
    bidiStream: (method, call) => openStream(client, method, call, streams, config.unsent),
    close: () => {
      // Each stream ends with call.cancel(), grpc-js's close() releases the subchannels, and every socket they still
      // hold ends last, whatever it waits for.
      for (const stream of streams) stream.cancel();
      client.close();
      closing.endEverySocket();
    },
  };
}

function metadataOf(call: GrpcCall): Metadata {
  const metadata = new Metadata();
  for (const [key, value] of Object.entries(call.metadata)) metadata.set(key, value);
  return metadata;
}

/** Ends a call through `cancel` when its signal aborts, at once when it already has; returns the listener's removal. */
function cancelOnAbort(signal: AbortSignal, cancel: () => void): () => void {
  if (signal.aborted) {
    cancel();
    return () => undefined;
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

/**
 * Whether grpc-js gave a call a transport. grpc-js 1.14.5 asks a call's credentials for its metadata only once
 * a pick has handed it a connected subchannel, right before it opens the call's stream (`LoadBalancingCall.doPick`,
 * load-balancing-call.ts near 183), so a call never asked was still waiting for name resolution, its metadata filters or
 * its LB pick, and its request never left; a call asked is read as one whose request may have left. These credentials
 * add no metadata and only note that ask.
 */
function pickNotice(): { readonly credentials: CallCredentials; readonly picked: () => boolean } {
  let picked = false;
  return {
    credentials: credentials.createFromMetadataGenerator((_options, callback) => {
      picked = true;
      callback(null, new Metadata());
    }),
    picked: () => picked,
  };
}

/**
 * The failure a call raises: grpc-js's own, or the provider's `unsent` error for a call its own signal ended before
 * grpc-js gave it a transport, which grpc-js words as it words a cancel after the send, so that the provider reads the
 * request as never sent.
 */
function callFailure(
  error: ServiceError,
  signal: AbortSignal,
  picked: boolean,
  unsent: GrpcChannelConfig["unsent"],
): Error {
  return signal.aborted && !picked ? unsent(error) : error;
}

function unaryCall(
  client: Client,
  method: MethodDefinition<object, object>,
  request: object,
  call: GrpcCall,
  unsent: GrpcChannelConfig["unsent"],
): Promise<object> {
  const pick = pickNotice();
  return new Promise<object>((resolve, reject) => {
    // grpc-js answers after this function returns, so the listener's removal is in place by then.
    let release: () => void = () => undefined;
    const pending = client.makeUnaryRequest(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      request,
      metadataOf(call),
      { deadline: call.deadline, credentials: pick.credentials },
      (error, value) => {
        release();
        if (error) reject(callFailure(error, call.signal, pick.picked(), unsent));
        else resolve(value as object);
      },
    );
    release = cancelOnAbort(call.signal, () => pending.cancel());
  });
}

/**
 * A grpc-js bidirectional stream as the adapter reads it: messages in order, then the end or the call's error. It is
 * one of `open` until it is cancelled, so the channel's close() can cancel it first.
 */
function openStream(
  client: Client,
  method: MethodDefinition<object, object>,
  call: GrpcCall,
  open: Set<GrpcBidiStream>,
  unsent: GrpcChannelConfig["unsent"],
): GrpcBidiStream {
  const pick = pickNotice();
  const duplex: ClientDuplexStream<object, object> = client.makeBidiStreamRequest(
    method.path,
    method.requestSerialize,
    method.responseDeserialize,
    metadataOf(call),
    { deadline: call.deadline, credentials: pick.credentials },
  );
  const received: object[] = [];
  const waiting: Array<{
    readonly resolve: (message: object | undefined) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  let ended = false;
  let failure: { readonly error: unknown } | undefined;
  duplex.on("data", (message: object) => {
    const reader = waiting.shift();
    if (reader === undefined) received.push(message);
    else reader.resolve(message);
  });
  duplex.on("end", () => {
    ended = true;
    for (const reader of waiting.splice(0)) reader.resolve(undefined);
  });
  // grpc-js emits a failed call's error before its end, so a reader meets the error, never a clean end.
  duplex.on("error", (error: ServiceError) => {
    const raised = callFailure(error, call.signal, pick.picked(), unsent);
    failure = { error: raised };
    for (const reader of waiting.splice(0)) reader.reject(raised);
  });
  const release = cancelOnAbort(call.signal, () => duplex.cancel());
  const stream: GrpcBidiStream = {
    write: (message) => {
      duplex.write(message);
    },
    read: () => {
      const message = received.shift();
      if (message !== undefined) return Promise.resolve(message);
      if (failure !== undefined) return Promise.reject(failure.error);
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    cancel: () => {
      open.delete(stream);
      release();
      duplex.cancel();
    },
  };
  open.add(stream);
  return stream;
}
