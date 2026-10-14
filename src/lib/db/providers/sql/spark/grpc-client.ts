/**
 * The Apache Spark provider's gRPC adapter: the one provider file that imports the generated
 * descriptor, and with proto/descriptor.ts the only files under src/ importing @grpc/proto-loader, over the shared gRPC
 * transport of src/lib/db/grpc/, which tests/unit/db/spark/seam-guard.test.ts holds.
 *
 * The channel, its options and its calls are the shared transport's; this file adds a stub built from
 * SparkConnectService filtered to SPARK_ALLOWLISTED_RPCS, so AddArtifacts, ArtifactStatus, ReattachExecute,
 * ReleaseExecute, CloneSession and GetStatus cannot be called although the whole descriptor is loaded. Retries are
 * "none": a statement sent twice runs twice. A call its own signal ended before it was sent raises
 * SparkError("unsent").
 */
import { fromJSON, type MethodDefinition, type PackageDefinition, type ServiceDefinition } from "@grpc/proto-loader";
import { type GrpcServerStream, type GrpcServerStreamLimits, openGrpcChannel } from "@/lib/db/grpc/channel";
import type { SparkConnectionOptions } from "./connection-options";
import { SPARK_RECEIVE_CAP_BYTES } from "./constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import { SPARK_DESCRIPTOR } from "./proto/descriptor";

/** Field names as the .proto files spell them, 64-bit integers as decimal strings, enums by name, defaults, oneof names. */
export const SPARK_LOADER_OPTIONS = {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
} as const;

export type SparkRpc = "ExecutePlan" | "AnalyzePlan" | "Config" | "Interrupt" | "ReleaseSession" | "FetchErrorDetails";

/** Every RPC the adapter may name; the stub holds these and no other. */
export const SPARK_ALLOWLISTED_RPCS: readonly SparkRpc[] = [
  "ExecutePlan",
  "AnalyzePlan",
  "Config",
  "Interrupt",
  "ReleaseSession",
  "FetchErrorDetails",
];

const SERVICE = "spark.connect.SparkConnectService";

let definition: PackageDefinition | undefined;
let allowlisted: ServiceDefinition | undefined;

/** The descriptor as grpc-js reads it, built on first use and kept for the process: fromJSON costs 33 to 37 ms. */
export function sparkDefinition(): PackageDefinition {
  definition ??= fromJSON(SPARK_DESCRIPTOR, SPARK_LOADER_OPTIONS);
  return definition;
}

/** SparkConnectService filtered to the allowlist, the one definition the stub calls through. */
export function allowlistedService(): ServiceDefinition {
  if (allowlisted === undefined) {
    const full = sparkDefinition()[SERVICE] as ServiceDefinition;
    allowlisted = Object.fromEntries(SPARK_ALLOWLISTED_RPCS.map((rpc) => [rpc, full[rpc]])) as ServiceDefinition;
  }
  return allowlisted;
}

/** `authorization: Bearer <token>`, the prefix exact and case-sensitive; no metadata at all without a token. */
export function sparkCallMetadata(token: string | undefined): Readonly<Record<string, string>> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

function method(rpc: SparkRpc): MethodDefinition<object, object> {
  return allowlistedService()[rpc] as MethodDefinition<object, object>;
}

export interface SparkWireCall {
  metadata: Readonly<Record<string, string>>;
  deadline: Date;
  signal: AbortSignal;
}

/** The transport's paused server stream under a Spark name, so readers import it type-only from here. */
export type SparkPlanStream = GrpcServerStream;

/**
 * The channel of one connection. After close(), executePlan throws at once and unary rejects, each with grpc-js's own
 * error, which carries no gRPC code and which toSparkError reads as a local client failure that sent nothing, so every
 * caller opens a call inside the try that maps its failure; a call still open when close() runs ends CANCELLED.
 */
export interface SparkWireChannel {
  unary(rpc: Exclude<SparkRpc, "ExecutePlan">, request: object, call: SparkWireCall): Promise<object>;
  executePlan(request: object, call: SparkWireCall, limits: GrpcServerStreamLimits): SparkPlanStream;
  close(): void;
}

/** Opens the channel for validated options; sends nothing. */
export type SparkWireTransport = (options: SparkConnectionOptions) => SparkWireChannel;

export const grpcWireTransport: SparkWireTransport = (options) => {
  const channel = openGrpcChannel({
    target: options.target,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    receiveCapBytes: SPARK_RECEIVE_CAP_BYTES,
    retries: "none",
    unsent: (status) => new SparkError("unsent", SPARK_ERROR_SENTENCES.unsent, { cause: status }),
  });
  return {
    unary: (rpc, request, call) => channel.unary(method(rpc), request, call),
    executePlan: (request, call, limits) => channel.serverStream(method("ExecutePlan"), request, call, limits),
    close: () => channel.close(),
  };
};
