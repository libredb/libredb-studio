/**
 * Pure builders of every request message the Apache Spark provider sends, in the field names of the vendored
 * v4.2.0 protos as proto-loader reads them (`keepCase`). Every message carries the fixed identity and, once a
 * session's first answer was observed, `client_observed_server_side_session_id`, so a restarted server answers
 * INVALID_HANDLE.SESSION_CHANGED instead of silently opening a fresh session without the setup.
 * Every ExecutePlan asks for 4 MiB result chunks and carries no reattach option. Pure: no I/O, no logger.
 */
import { SPARK_ARROW_CHUNK_BYTES, SPARK_CLIENT_TYPE, SPARK_USER_CONTEXT } from "./constants";

export interface SparkSessionRef {
  sessionId: string;
  /** The server-side id the session's first answer carried; sent on every later request of the session. */
  serverSideSessionId?: string;
}

export interface SparkRunIds {
  operationId: string;
  tag: string;
}

function identity() {
  return { user_context: { ...SPARK_USER_CONTEXT }, client_type: SPARK_CLIENT_TYPE };
}

/** session_id, the observed server-side id when known, and the identity: the head of every request but ReleaseSession. */
function head(session: SparkSessionRef) {
  return {
    session_id: session.sessionId,
    ...(session.serverSideSessionId === undefined
      ? {}
      : { client_observed_server_side_session_id: session.serverSideSessionId }),
    ...identity(),
  };
}

function chunking() {
  return [
    {
      result_chunking_options: {
        allow_arrow_batch_chunking: true,
        preferred_arrow_chunk_size: SPARK_ARROW_CHUNK_BYTES,
      },
    },
  ];
}

/** ExecutePlan 1: the statement as a command (SqlCommand.input, field 6). */
export function sqlCommandRequest(session: SparkSessionRef, sql: string, run: SparkRunIds): object {
  return {
    ...head(session),
    operation_id: run.operationId,
    tags: [run.tag],
    request_options: chunking(),
    plan: { command: { sql_command: { input: { sql: { query: sql } } } } },
  };
}

/** ExecutePlan 2: the relation the command step answered, as the plan root. */
export function relationRequest(session: SparkSessionRef, relation: object, run: SparkRunIds): object {
  return {
    ...head(session),
    operation_id: run.operationId,
    tags: [run.tag],
    request_options: chunking(),
    plan: { root: relation },
  };
}

export function configSetRequest(session: SparkSessionRef, pairs: readonly (readonly [string, string])[]): object {
  return { ...head(session), operation: { set: { pairs: pairs.map(([key, value]) => ({ key, value })) } } };
}

export function configGetOptionRequest(session: SparkSessionRef, keys: readonly string[]): object {
  return { ...head(session), operation: { get_option: { keys: [...keys] } } };
}

export function configGetAllRequest(session: SparkSessionRef, prefix: string): object {
  return { ...head(session), operation: { get_all: { prefix } } };
}

/** AnalyzePlan spark_version: one unary call, no Spark job. */
export function versionRequest(session: SparkSessionRef): object {
  return { ...head(session), spark_version: {} };
}

/** Interrupt by the run's tag, which reaches both of its operations. */
export function interruptByTagRequest(session: SparkSessionRef, tag: string): object {
  return { ...head(session), interrupt_type: "INTERRUPT_TYPE_TAG", operation_tag: tag };
}

/** ReleaseSession tombstones the id; its message has no observed-id field (base.proto ReleaseSessionRequest). */
export function releaseSessionRequest(session: SparkSessionRef): object {
  return { session_id: session.sessionId, ...identity(), allow_reconnect: false };
}

export function fetchErrorDetailsRequest(session: SparkSessionRef, errorId: string): object {
  return { ...head(session), error_id: errorId };
}
