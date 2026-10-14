/**
 * One call per case through the shared gRPC transport, as both runtimes run it: under Bun inside
 * tests/unit/db/spark/tls-handshake.test.ts, and under Node in a child that runs a bundle of this module, so both run
 * the same code against the same listeners. Each case dials 127.0.0.1 with its own TLS identity, the shape an SSH
 * tunnel's far end gives the transport, and reports grpc-js's raw status for the test to map with toSparkError.
 */
import { type GrpcChannel, openGrpcChannel } from "@/lib/db/grpc/channel";
import { grpcTlsIdentity } from "@/lib/db/grpc/tls";
import { SPARK_IP_SERVER_NAME, SPARK_RECEIVE_CAP_BYTES } from "@/lib/db/providers/sql/spark/constants";

/** A unary method whose messages are raw bytes: the stub server answers an empty request and never a non-empty one. */
export const SPARK_STUB_METHOD: Parameters<GrpcChannel["unary"]>[0] = {
  path: "/spark.connect.SparkConnectService/Config",
  requestStream: false,
  responseStream: false,
  requestSerialize: (value) => Buffer.from(value as Uint8Array),
  requestDeserialize: (bytes) => bytes,
  responseSerialize: (value) => Buffer.from(value as Uint8Array),
  responseDeserialize: (bytes) => bytes,
};

export interface SparkHandshakeCase {
  readonly name: string;
  readonly port: number;
  /** Absent is plaintext. */
  readonly tls?: {
    readonly mode: "verify-ca" | "verify-full";
    readonly ca: string;
    /** The TLS identity: a name, or an IP checked against the certificate's IP addresses. */
    readonly identity: string;
    readonly clientCertificate?: { readonly cert: string; readonly key: string };
  };
  /**
   * When set, an answered call first proves the channel ready, then a call the server never answers is ended by its
   * own signal this long after it was sent.
   */
  readonly cancelAfterMs?: number;
  readonly timeoutMs: number;
}

export type SparkHandshakeOutcome =
  | { readonly name: string; readonly outcome: "answered" | "unsent" }
  | { readonly name: string; readonly outcome: "failed"; readonly code: number; readonly details: string };

const UNSENT = "the call's own signal ended it before grpc-js picked a transport";
const HOLD = new Uint8Array([1]);

async function runCase(item: SparkHandshakeCase): Promise<SparkHandshakeOutcome> {
  const tls =
    item.tls === undefined
      ? undefined
      : grpcTlsIdentity(
          {
            mode: item.tls.mode,
            ca: item.tls.ca,
            ...(item.tls.clientCertificate === undefined ? {} : { clientCertificate: item.tls.clientCertificate }),
            verify: true,
          },
          item.tls.identity,
          SPARK_IP_SERVER_NAME,
        );
  const channel = openGrpcChannel({
    target: `dns:127.0.0.1:${item.port}`,
    ...(tls === undefined ? {} : { tls }),
    receiveCapBytes: SPARK_RECEIVE_CAP_BYTES,
    retries: "none",
    unsent: () => new Error(UNSENT),
  });
  const call = (request: Uint8Array, signal: AbortSignal) =>
    channel.unary(SPARK_STUB_METHOD, request, {
      metadata: {},
      deadline: new Date(Date.now() + item.timeoutMs),
      signal,
    });
  try {
    await call(new Uint8Array(0), new AbortController().signal);
    if (item.cancelAfterMs !== undefined) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), item.cancelAfterMs);
      try {
        await call(HOLD, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }
    return { name: item.name, outcome: "answered" };
  } catch (error) {
    if (error instanceof Error && error.message === UNSENT) return { name: item.name, outcome: "unsent" };
    const { code, details } = error as { readonly code: number; readonly details: string };
    return { name: item.name, outcome: "failed", code, details };
  } finally {
    channel.close();
  }
}

/** Every case in order, one at a time. */
export async function runSparkHandshakeCases(cases: readonly SparkHandshakeCase[]): Promise<SparkHandshakeOutcome[]> {
  const outcomes: SparkHandshakeOutcome[] = [];
  for (const item of cases) {
    // oxlint-disable-next-line no-await-in-loop -- one case at a time, so no case's listener sees another's dial.
    outcomes.push(await runCase(item));
  }
  return outcomes;
}
