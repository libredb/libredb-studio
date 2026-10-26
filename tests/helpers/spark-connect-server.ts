/**
 * A fake Spark Connect server for the Apache Spark provider's tests, built from the provider's own
 * descriptor so the allowlist is proven from the client's side. It answers statements by their exact text and models
 * the measured behaviours the provider depends on: sessions and their server-side ids, the two steps, chunked results,
 * the reattach window, progress, Interrupt by tag, ErrorInfo errors with one FetchErrorDetails, oversized messages,
 * tokens, TLS and a connection reset through its own TCP relay. It runs no SQL.
 *
 * No bun:test and no Bun global, so the same module also runs in a Node child; TLS material is read from
 * tests/fixtures/tls/ under the working directory, which must be the repository root.
 */
import { createPrivateKey, randomUUID, type webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import {
  Metadata,
  type MethodDefinition,
  Server,
  ServerCredentials,
  type ServerReadableStream,
  type ServerUnaryCall,
  type ServerWritableStream,
  type ServiceDefinition,
  type sendUnaryData,
} from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { sparkDefinition } from "@/lib/db/providers/sql/spark/grpc-client";

export interface SparkFakeErrorInfo {
  readonly errorClass?: string;
  readonly sqlState?: string;
  readonly messageParameters?: Readonly<Record<string, string>>;
  readonly errorId?: string;
  readonly classes?: readonly string[];
}

export interface SparkFakeOptions {
  tls?: true;
  token?: string;
  sparkVersion?: string;
  progressEveryMs?: number;
  reattachWindowMs?: number;
  interruptDelayMs?: number;
  statements: Readonly<Record<string, SparkFakeAnswer>>;
}

export type SparkFakeAnswer =
  | { kind: "command"; ipc: Uint8Array }
  | { kind: "relation"; schema: object | Buffer; ipc: readonly Uint8Array[]; corrupt?: "gap" | "repeat" | "row-count" }
  | {
      kind: "error";
      code: number;
      message: string;
      errorInfo?: SparkFakeErrorInfo;
      details?: Uint8Array;
      fetch?: object;
    }
  | { kind: "silent" }
  | { kind: "progress-only" }
  | { kind: "oversized"; bytes: number; path: "command" | "relation" }
  | { kind: "status"; code: number; message: string }
  | { kind: "reset" };

export interface SparkFakeLogEntry {
  readonly rpc: string;
  readonly sessionId: string;
  readonly operationId?: string;
  readonly tags: readonly string[];
  readonly requestOptions: readonly object[];
  readonly reattachOptions?: object;
  readonly metadata: Readonly<Record<string, string>>;
  readonly at: number;
  readonly request: object;
}

export interface SparkFakeLog {
  readonly entries: readonly SparkFakeLogEntry[];
  clear(): void;
}

export interface SparkFakeServer {
  readonly target: string;
  readonly log: SparkFakeLog;
  readonly caPem: string | undefined;
  restart(): void;
  close(): void;
}

const SERVICE = "spark.connect.SparkConnectService";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNIMPLEMENTED_RPCS = [
  "AddArtifacts",
  "ArtifactStatus",
  "ReattachExecute",
  "ReleaseExecute",
  "CloneSession",
  "GetStatus",
];
const EMPTY_SCHEMA = { struct: { fields: [] } };
/** The first byte of a TLS handshake record, which a TLS client sends first. */
const TLS_HANDSHAKE_RECORD = 0x16;
/**
 * What the TLS fake answers a client whose first byte does not open a TLS handshake: an HTTP/1.1 400, bytes that are
 * not HTTP/2, which grpc-js reports as "Protocol error", the text the measured TLS proxy gives a plaintext client
 * too. Against grpc-js's own TLS server such a client fails with "Failed to connect" instead, under Bun and under
 * Node (measured with grpc-js 1.14.5 and 1.14.6 on Bun 1.4.2 and Node 24.14.0).
 */
const PLAINTEXT_ON_TLS_ANSWER = "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

const RPC_TYPES = protobuf.Root.fromJSON({
  nested: {
    google: {
      nested: {
        rpc: {
          nested: {
            Status: {
              fields: {
                code: { type: "int32", id: 1 },
                message: { type: "string", id: 2 },
                details: { rule: "repeated", type: "Any", id: 3 },
              },
            },
            Any: { fields: { type_url: { type: "string", id: 1 }, value: { type: "bytes", id: 2 } } },
            ErrorInfo: {
              fields: {
                reason: { type: "string", id: 1 },
                domain: { type: "string", id: 2 },
                metadata: { keyType: "string", type: "string", id: 3 } as protobuf.IMapField,
              },
            },
          },
        },
      },
    },
  },
});

interface FakeError {
  readonly code: number;
  readonly details: string;
  readonly metadata: Metadata;
}

function statusDetails(code: number, message: string, info: SparkFakeErrorInfo): Buffer {
  const metadata: Record<string, string> = {};
  if (info.classes !== undefined) metadata.classes = JSON.stringify(info.classes);
  if (info.errorClass !== undefined) metadata.errorClass = info.errorClass;
  if (info.sqlState !== undefined) metadata.sqlState = info.sqlState;
  if (info.messageParameters !== undefined) metadata.messageParameters = JSON.stringify(info.messageParameters);
  if (info.errorId !== undefined) metadata.errorId = info.errorId;
  const ErrorInfo = RPC_TYPES.lookupType("google.rpc.ErrorInfo");
  const value = ErrorInfo.encode(
    ErrorInfo.create({ reason: "org.apache.spark.SparkException", domain: "org.apache.spark", metadata }),
  ).finish();
  const Status = RPC_TYPES.lookupType("google.rpc.Status");
  return Buffer.from(
    Status.encode(
      Status.create({ code, message, details: [{ type_url: "type.googleapis.com/google.rpc.ErrorInfo", value }] }),
    ).finish(),
  );
}

function failure(code: number, details: string, bytes?: Uint8Array): FakeError {
  const metadata = new Metadata();
  if (bytes !== undefined) metadata.set("grpc-status-details-bin", Buffer.from(bytes));
  return { code, details, metadata };
}

const sparkFailure = (errorClass: string, sqlState: string, text: string) =>
  failure(13, text, statusDetails(13, text, { errorClass, sqlState }));

/** The rows of an IPC stream's record batches, read from their FlatBuffers headers; 0 for bytes that are not a stream. */
function declaredRows(bytes: Uint8Array): number {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    let rows = 0;
    while (offset + 8 <= bytes.length) {
      if (view.getUint32(offset, true) !== 0xffffffff) return 0;
      const size = view.getInt32(offset + 4, true);
      if (size === 0) return rows;
      const meta = offset + 8;
      const root = meta + view.getUint32(meta, true);
      const vtable = root - view.getInt32(root, true);
      const field = (table: number, table_vtable: number, id: number) =>
        4 + 2 * id < view.getUint16(table_vtable, true) ? view.getUint16(table_vtable + 4 + 2 * id, true) : 0;
      const headerType = field(root, vtable, 1) === 0 ? 0 : view.getUint8(root + field(root, vtable, 1));
      const bodyLength =
        field(root, vtable, 3) === 0 ? 0 : Number(view.getBigInt64(root + field(root, vtable, 3), true));
      if (headerType === 3) {
        const at = root + field(root, vtable, 2);
        const batch = at + view.getUint32(at, true);
        const batchVtable = batch - view.getInt32(batch, true);
        const length = field(batch, batchVtable, 0);
        rows += length === 0 ? 0 : Number(view.getBigInt64(batch + length, true));
      }
      offset = meta + size + bodyLength;
    }
    return rows;
  } catch {
    return 0;
  }
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    out.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0));
    rest = Math.floor(rest / 128);
  } while (rest > 0);
  return out;
}

function tlsMaterial(): { readonly ca: string; readonly cert: string; readonly key: string } {
  const dir = join(process.cwd(), "tests", "fixtures", "tls");
  if (!existsSync(join(dir, "server.crt"))) {
    throw new Error(
      "startSparkFake reads tests/fixtures/tls/ from the working directory, which must be the repository root",
    );
  }
  const jwk = JSON.parse(readFileSync(join(dir, "server.key.jwk.json"), "utf8")) as webcrypto.JsonWebKey;
  return {
    ca: readFileSync(join(dir, "ca.crt"), "utf8"),
    cert: readFileSync(join(dir, "server.crt"), "utf8"),
    key: createPrivateKey({ key: jwk, format: "jwk" }).export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

interface FakeSession {
  serverSideId: string;
  released: boolean;
  readonly conf: Map<string, string>;
}

interface Execution {
  readonly sessionId: string;
  readonly operationId: string;
  readonly tags: readonly string[];
  end(error: FakeError): void;
}

type Request = Record<string, unknown>;

export async function startSparkFake(options: SparkFakeOptions): Promise<SparkFakeServer> {
  const entries: SparkFakeLogEntry[] = [];
  const sessions = new Map<string, FakeSession>();
  const executions = new Set<Execution>();
  const fetchable = new Map<string, object>();
  const sockets = new Set<net.Socket>();
  const material = options.tls === true ? tlsMaterial() : undefined;

  const record = (rpc: string, request: Request, metadata: Metadata) => {
    const requestOptions = (request.request_options as readonly Request[] | undefined) ?? [];
    const reattach = requestOptions
      .map((option) => option.reattach_options)
      .find((value) => value !== null && value !== undefined);
    entries.push({
      rpc,
      sessionId: String(request.session_id ?? ""),
      ...(typeof request.operation_id === "string" && request.operation_id !== ""
        ? { operationId: request.operation_id }
        : {}),
      tags: (request.tags as readonly string[] | undefined) ?? [],
      requestOptions,
      ...(reattach === undefined ? {} : { reattachOptions: reattach as object }),
      metadata: Object.fromEntries(Object.entries(metadata.getMap()).map(([key, value]) => [key, String(value)])),
      at: Date.now(),
      request,
    });
  };

  const authFailure = (metadata: Metadata): FakeError | undefined => {
    if (options.token === undefined) return undefined;
    const value = metadata.get("authorization")[0];
    if (value === undefined) return failure(16, "No authentication token provided");
    return value === `Bearer ${options.token}` ? undefined : failure(16, "Invalid authentication token");
  };

  const sessionFor = (request: Request): FakeSession | FakeError => {
    const id = request.session_id;
    if (typeof id !== "string" || !UUID.test(id)) {
      return sparkFailure("INVALID_HANDLE.FORMAT", "HY000", "[INVALID_HANDLE.FORMAT] The handle is invalid.");
    }
    let session = sessions.get(id);
    if (session?.released) {
      return sparkFailure(
        "INVALID_HANDLE.SESSION_CLOSED",
        "HY000",
        "[INVALID_HANDLE.SESSION_CLOSED] The handle is invalid. Session was closed.",
      );
    }
    if (session === undefined) {
      session = { serverSideId: randomUUID(), released: false, conf: new Map() };
      sessions.set(id, session);
    }
    const observed = request.client_observed_server_side_session_id;
    if (typeof observed === "string" && observed !== "" && observed !== session.serverSideId) {
      return sparkFailure(
        "INVALID_HANDLE.SESSION_CHANGED",
        "HY000",
        "[INVALID_HANDLE.SESSION_CHANGED] The existing Spark server driver instance has restarted.",
      );
    }
    return session;
  };

  /** Logs, checks the token and the session, and answers either the session or the failure to send. */
  const admit = (rpc: string, request: Request, metadata: Metadata): FakeSession | FakeError => {
    record(rpc, request, metadata);
    return authFailure(metadata) ?? sessionFor(request);
  };
  const isFailure = (value: FakeSession | FakeError): value is FakeError => "code" in value;
  const head = (request: Request, session: FakeSession) => ({
    session_id: request.session_id,
    server_side_session_id: session.serverSideId,
  });

  const full = sparkDefinition()[SERVICE] as unknown as ServiceDefinition;
  const executeMethod = full.ExecutePlan as MethodDefinition<object, object>;
  const service: ServiceDefinition = {
    ...full,
    ExecutePlan: {
      ...executeMethod,
      responseSerialize: (value: object) => (Buffer.isBuffer(value) ? value : executeMethod.responseSerialize(value)),
    },
  };

  const executePlan = (call: ServerWritableStream<Request, object>) => {
    const request = call.request;
    const admitted = admit("ExecutePlan", request, call.metadata);
    if (isFailure(admitted)) {
      call.emit("error", admitted);
      return;
    }
    const session = admitted;
    const operationId =
      typeof request.operation_id === "string" && request.operation_id !== "" ? request.operation_id : randomUUID();
    const base = {
      session_id: request.session_id,
      server_side_session_id: session.serverSideId,
      operation_id: operationId,
    };
    const write = (response: object) => call.write({ ...base, response_id: randomUUID(), ...response });
    const timers: ReturnType<typeof setTimeout>[] = [];
    let open = true;
    const finish = () => {
      if (!open) return false;
      open = false;
      executions.delete(execution);
      for (const timer of timers) clearTimeout(timer);
      return true;
    };
    const execution: Execution = {
      sessionId: String(request.session_id),
      operationId,
      tags: (request.tags as readonly string[] | undefined) ?? [],
      end: (error) => {
        if (finish()) call.emit("error", error);
      },
    };
    const end = () => {
      if (finish()) call.end();
    };
    executions.add(execution);
    call.on("cancelled", () => finish());
    const requestOptions = (request.request_options as readonly Request[] | undefined) ?? [];
    const reattach = requestOptions
      .map((option) => option.reattach_options as { reattachable?: boolean } | null | undefined)
      .find((value) => value);
    if (reattach?.reattachable === true) timers.push(setTimeout(end, options.reattachWindowMs ?? 120_000));
    // The decoder answers an absent plan as null, which the fake answers as a statement it holds no answer for.
    const plan = (request.plan ?? {}) as {
      readonly command?: {
        readonly sql_command?: { readonly input?: { readonly sql?: { readonly query?: string } | null } | null } | null;
      } | null;
      readonly root?: { readonly sql?: { readonly query?: string } | null } | null;
    };
    const commandText = plan.command?.sql_command?.input?.sql?.query;
    const rootText = plan.root?.sql?.query;
    const text = commandText ?? rootText;
    // Only the table's own keys answer, so a statement such as "toString" finds no inherited member.
    const answer = text !== undefined && Object.hasOwn(options.statements, text) ? options.statements[text] : undefined;
    if (answer === undefined) {
      execution.end(failure(3, `the fake has no answer for ${JSON.stringify(text)}`));
      return;
    }
    if (commandText !== undefined) {
      if (answer.kind === "command") {
        write({ sql_command_result: { relation: { local_relation: { data: Buffer.from(answer.ipc) } } } });
        write({ metrics: { metrics: [] } });
        end();
      } else if (answer.kind === "error") {
        const errorId = answer.errorInfo?.errorId;
        if (errorId !== undefined && answer.fetch !== undefined) fetchable.set(errorId, answer.fetch);
        const bytes =
          answer.details ??
          (answer.errorInfo === undefined ? undefined : statusDetails(answer.code, answer.message, answer.errorInfo));
        execution.end(failure(answer.code, answer.message, bytes));
      } else if (answer.kind === "oversized" && answer.path === "command") {
        write({ sql_command_result: { relation: { local_relation: { data: Buffer.alloc(answer.bytes) } } } });
        end();
      } else {
        write({ sql_command_result: { relation: { sql: { query: text } } } });
        end();
      }
      return;
    }
    switch (answer.kind) {
      case "relation": {
        if (Buffer.isBuffer(answer.schema)) {
          const prefix = executeMethod.responseSerialize({ ...base, response_id: randomUUID() });
          call.write(Buffer.concat([prefix, Buffer.from([0x3a, ...varint(answer.schema.length)]), answer.schema]));
        } else {
          write({ schema: answer.schema });
        }
        const chunking = requestOptions
          .map(
            (option) =>
              option.result_chunking_options as
                | { allow_arrow_batch_chunking?: boolean; preferred_arrow_chunk_size?: string | number }
                | null
                | undefined,
          )
          .find((value) => value);
        const size =
          chunking?.allow_arrow_batch_chunking === true ? Number(chunking.preferred_arrow_chunk_size ?? 0) : 0;
        let startRow = 0;
        answer.ipc.forEach((ipc, index) => {
          const actual = declaredRows(ipc);
          const rows = actual + (answer.corrupt === "row-count" && index === 0 ? 1 : 0);
          if (size < 1024) {
            write({ arrow_batch: { row_count: String(rows), data: Buffer.from(ipc) } });
          } else {
            const count = Math.max(1, Math.ceil(ipc.length / size));
            const declared = answer.corrupt === "gap" && index === 0 && count === 1 ? 2 : count;
            for (let chunk = 0; chunk < count; chunk += 1) {
              if (answer.corrupt === "gap" && index === 0 && chunk === 1) continue;
              const response = {
                arrow_batch: {
                  row_count: String(rows),
                  data: Buffer.from(ipc.subarray(chunk * size, (chunk + 1) * size)),
                  start_offset: String(startRow),
                  chunk_index: String(chunk),
                  num_chunks_in_batch: String(declared),
                },
              };
              write(response);
              if (answer.corrupt === "repeat" && index === 0 && chunk === 0) write(response);
            }
          }
          startRow += actual;
        });
        write({ metrics: { metrics: [] } });
        end();
        return;
      }
      case "silent":
        return;
      case "progress-only": {
        const every = options.progressEveryMs ?? 2_000;
        if (every > 0) {
          const timer = setInterval(
            () => write({ execution_progress: { stages: [], num_inflight_tasks: "0" } }),
            every,
          );
          timers.push(timer as unknown as ReturnType<typeof setTimeout>);
        }
        return;
      }
      case "status":
        write({ schema: EMPTY_SCHEMA });
        execution.end(failure(answer.code, answer.message));
        return;
      case "reset":
        write({ schema: EMPTY_SCHEMA });
        timers.push(
          setTimeout(() => {
            for (const socket of sockets) socket.destroy();
          }, 10),
        );
        return;
      case "oversized":
        write({ schema: EMPTY_SCHEMA });
        write({ arrow_batch: { row_count: "1", data: Buffer.alloc(answer.bytes) } });
        end();
        return;
      default:
        execution.end(failure(3, `the fake answers ${answer.kind} only on the command step`));
    }
  };

  const unary =
    (rpc: string, handle: (request: Request, session: FakeSession) => object | FakeError) =>
    (call: ServerUnaryCall<Request, object>, callback: sendUnaryData<object>) => {
      const admitted = admit(rpc, call.request, call.metadata);
      if (isFailure(admitted)) return callback(admitted);
      const answer = handle(call.request, admitted);
      return "code" in answer && "metadata" in answer ? callback(answer as FakeError) : callback(null, answer);
    };

  const handlers: Record<string, unknown> = {
    ExecutePlan: executePlan,
    AnalyzePlan: unary("AnalyzePlan", (request, session) =>
      request.spark_version
        ? { ...head(request, session), spark_version: { version: options.sparkVersion ?? "4.2.0" } }
        : failure(3, "the fake answers spark_version only"),
    ),
    Config: unary("Config", (request, session) => {
      const operation = request.operation as {
        readonly set?: { readonly pairs: readonly { readonly key: string; readonly value?: string }[] } | null;
        readonly get_option?: { readonly keys: readonly string[] } | null;
        readonly get_all?: { readonly prefix?: string } | null;
      };
      let pairs: { key: string; value?: string }[] = [];
      if (operation.set) for (const pair of operation.set.pairs) session.conf.set(pair.key, pair.value ?? "");
      else if (operation.get_option)
        pairs = operation.get_option.keys.map((key) =>
          session.conf.has(key) ? { key, value: session.conf.get(key) as string } : { key },
        );
      else if (operation.get_all) {
        const prefix = operation.get_all.prefix ?? "";
        pairs = [...session.conf]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key: key.slice(prefix.length), value }));
      }
      return { ...head(request, session), pairs, warnings: [] };
    }),
    Interrupt: unary("Interrupt", (request, session) => {
      const matches = [...executions].filter(
        (execution) =>
          execution.sessionId === request.session_id &&
          (request.interrupt_type === "INTERRUPT_TYPE_TAG"
            ? execution.tags.includes(String(request.operation_tag))
            : request.interrupt_type === "INTERRUPT_TYPE_OPERATION_ID"
              ? execution.operationId === request.operation_id
              : true),
      );
      for (const execution of matches) {
        setTimeout(
          () =>
            execution.end(
              sparkFailure("OPERATION_CANCELED", "HY008", "[OPERATION_CANCELED] Operation has been cancelled."),
            ),
          options.interruptDelayMs ?? 5,
        );
      }
      return { ...head(request, session), interrupted_ids: matches.map((execution) => execution.operationId) };
    }),
    ReleaseSession: (call: ServerUnaryCall<Request, object>, callback: sendUnaryData<object>) => {
      record("ReleaseSession", call.request, call.metadata);
      const refused = authFailure(call.metadata);
      if (refused !== undefined) return callback(refused);
      const id = call.request.session_id;
      if (typeof id !== "string" || !UUID.test(id))
        return callback(
          sparkFailure("INVALID_HANDLE.FORMAT", "HY000", "[INVALID_HANDLE.FORMAT] The handle is invalid."),
        );
      const session = sessions.get(id) ?? {
        serverSideId: randomUUID(),
        released: false,
        conf: new Map<string, string>(),
      };
      sessions.set(id, session);
      if (!session.released) {
        session.released = true;
        for (const execution of [...executions].filter((candidate) => candidate.sessionId === id)) {
          execution.end(
            sparkFailure(
              "INVALID_CURSOR.DISCONNECTED",
              "HY109",
              "[INVALID_CURSOR.DISCONNECTED] The cursor is disconnected.",
            ),
          );
        }
      }
      return callback(null, { session_id: id, server_side_session_id: session.serverSideId });
    },
    FetchErrorDetails: unary("FetchErrorDetails", (request, session) => {
      const errorId = String(request.error_id);
      const answer = fetchable.get(errorId);
      fetchable.delete(errorId);
      return { ...head(request, session), ...(answer ?? { errors: [] }) };
    }),
  };
  for (const rpc of UNIMPLEMENTED_RPCS) {
    handlers[rpc] =
      rpc === "AddArtifacts"
        ? (call: ServerReadableStream<Request, object>, callback: sendUnaryData<object>) => {
            record(rpc, {}, call.metadata);
            call.on("data", () => undefined);
            call.on("end", () => callback(failure(12, `${rpc} is not served by the fake`)));
          }
        : rpc === "ReattachExecute"
          ? (call: ServerWritableStream<Request, object>) => {
              record(rpc, call.request, call.metadata);
              call.emit("error", failure(12, `${rpc} is not served by the fake`));
            }
          : (call: ServerUnaryCall<Request, object>, callback: sendUnaryData<object>) => {
              record(rpc, call.request, call.metadata);
              callback(failure(12, `${rpc} is not served by the fake`));
            };
  }

  const server = new Server();
  server.addService(service, handlers as never);
  const credentials =
    material === undefined
      ? ServerCredentials.createInsecure()
      : ServerCredentials.createSsl(
          null,
          [{ private_key: Buffer.from(material.key), cert_chain: Buffer.from(material.cert) }],
          false,
        );
  const grpcPort = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", credentials, (error, port) => (error ? reject(error) : resolve(port))),
  );

  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  };
  // The relay dials the server once the client's first bytes arrive, so the TLS fake can answer a plaintext client
  // as a TLS proxy does instead of handing it to grpc-js's TLS server.
  const relay = net.createServer((client) => {
    track(client);
    client.once("data", (first: Buffer) => {
      if (material !== undefined && first[0] !== TLS_HANDSHAKE_RECORD) {
        client.end(PLAINTEXT_ON_TLS_ANSWER);
        return;
      }
      const upstream = net.connect(grpcPort, "127.0.0.1");
      track(upstream);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      upstream.write(first);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayPort = (relay.address() as net.AddressInfo).port;

  return {
    target: `dns:127.0.0.1:${relayPort}`,
    log: {
      get entries() {
        return entries;
      },
      clear: () => {
        entries.length = 0;
      },
    },
    caPem: material?.ca,
    restart: () => {
      for (const session of sessions.values()) session.serverSideId = randomUUID();
    },
    close: () => {
      server.forceShutdown();
      relay.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
