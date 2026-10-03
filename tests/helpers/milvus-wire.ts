/**
 * The recorded transport the Milvus adapter's tests, and part C's provider tests, run the real adapter over: it has
 * the shape of `MilvusWireTransport`, logs every channel, call and close, and answers each call from the answers a
 * test names, which can be captures read with tests/helpers/milvus-fixtures.ts. A call whose signal aborts rejects as
 * grpc-js does, CANCELLED "Cancelled on client". It imports grpc-client.ts for types only, so the seam guard's list
 * of grpc-js importers stays the adapter's own.
 */
import type { WireStatus } from "@/lib/db/providers/vector/milvus/client";
import type { MilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import type { MilvusRpc, MilvusWireCall, MilvusWireTransport } from "@/lib/db/providers/vector/milvus/grpc-client";
import type { LoggedCall } from "./call-log";

export const okStatus: WireStatus = {
  code: 0,
  error_code: "Success",
  reason: "",
  retriable: false,
  detail: "",
  extra_info: {},
};

/** A grpc-js status error, as the library rejects a call. */
export function statusError(code: number, details: string): Error {
  return Object.assign(new Error(`${code} ${details}`), { code, details, metadata: {} });
}

export type RecordedMilvusAnswer = (
  request: Readonly<Record<string, unknown>>,
  call: MilvusWireCall,
) => object | Promise<object>;

export interface RecordedMilvusWire {
  readonly transport: MilvusWireTransport;
  /** `{ method: rpc, args: [request, metadata] }` for every call, in order. */
  readonly calls: LoggedCall[];
  /** Each call's deadline less the moment it was handed over, in milliseconds. */
  readonly deadlines: number[];
  readonly opened: MilvusConnectionOptions[];
  readonly closes: () => number;
}

export function recordedMilvusWire(answers: Partial<Record<MilvusRpc, RecordedMilvusAnswer>> = {}): RecordedMilvusWire {
  const calls: LoggedCall[] = [];
  const deadlines: number[] = [];
  const opened: MilvusConnectionOptions[] = [];
  let closed = 0;
  const transport: MilvusWireTransport = (options) => {
    opened.push(options);
    return {
      unary: (rpc, request, call) => {
        calls.push({ method: rpc, args: [request, call.metadata] });
        deadlines.push(call.deadline.getTime() - Date.now());
        const answer = answers[rpc];
        if (answer === undefined) return Promise.reject(new Error(`No recorded answer for ${rpc}`));
        return new Promise<object>((resolve, reject) => {
          const cancelled = () => reject(statusError(1, "Cancelled on client"));
          if (call.signal.aborted) {
            cancelled();
            return;
          }
          call.signal.addEventListener("abort", cancelled, { once: true });
          Promise.resolve()
            .then(() => answer(request as Readonly<Record<string, unknown>>, call))
            .then(resolve, reject);
        });
      },
      close: () => {
        closed++;
      },
    };
  };
  return { transport, calls, deadlines, opened, closes: () => closed };
}
