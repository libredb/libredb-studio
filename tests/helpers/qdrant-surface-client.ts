/**
 * The `send` a Qdrant surface is handed, as a recording double (vector-family spec 3.13): every request is recorded
 * in order before it is answered, as `{ method: op, args: [collection, body] }` for `expectCalls`, and answered from
 * the recorded captures by default. A test that needs a failure or a slow answer passes its own `answer`.
 *
 * It stands in for what index.ts builds around the client: no permit and no wording of failures here, so the object
 * and monitoring modules are tested for what they send and how they read the answers.
 */
import type { QdrantAnswer, QdrantOp, QdrantRequest, QdrantSend } from "@/lib/db/providers/vector/qdrant/client";
import type { LoggedCall } from "./call-log";
import { recordedAnswer } from "./qdrant-surface-fixtures";

export interface RecordingSend {
  readonly send: QdrantSend<QdrantOp>;
  readonly calls: LoggedCall[];
  /** The most requests that were in flight at once. */
  maxInFlight(): number;
}

export function recordingSend(
  answer: (request: QdrantRequest) => QdrantAnswer | Promise<QdrantAnswer> = recordedAnswer,
): RecordingSend {
  const calls: LoggedCall[] = [];
  let inFlight = 0;
  let most = 0;
  const send: QdrantSend<QdrantOp> = async (request) => {
    calls.push({ method: request.op, args: [request.params.collection_name ?? null, request.body ?? null] });
    inFlight += 1;
    most = Math.max(most, inFlight);
    try {
      return await answer(request);
    } finally {
      inFlight -= 1;
    }
  };
  return { send, calls, maxInFlight: () => most };
}
