// The backend interface between the extension host and the child, the JSON-RPC method names and the wire types.
// Every LibreDB import is type-only, so this module adds no provider code to the host bundle.
import type { CancellationToken } from "vscode-jsonrpc";
import type { EditorQueryBody } from "@/lib/api/editor-query";
import type { ApiErrorCode } from "@/lib/api/error-codes";
import type { TestConnectionAnswer } from "@/lib/api/test-connection";
import type {
  Container,
  DatabaseObject,
  EditorExecutionContext,
  KindCount,
  ObjectDetail,
  ProviderCapabilities,
  ProviderLabels,
} from "@/lib/db/types";
import type { DatabaseConnection, DatabaseType } from "@/lib/types";

/** The version initialize carries both ways; the child refuses any other with PROTOCOL_MISMATCH. */
export const PROTOCOL_VERSION = 1;

/** A DatabaseConnection as JSON carries it; the child revives createdAt. */
export type WireConnection = Omit<DatabaseConnection, "createdAt"> & { createdAt: string };

/** Always explicit: getOrCreateProvider reads an absent posture as deny. */
export type Posture = Required<Pick<EditorExecutionContext, "allowExternalFileAccess">>;

/** data.code of an error response: the route's ApiErrorCode, or one of the six the extension adds. */
export type BackendErrorCode =
  | ApiErrorCode
  | "CONNECTION_NOT_OPEN"
  | "SHUTTING_DOWN"
  | "PROTOCOL_MISMATCH"
  | "RUNTIME_UNSUPPORTED"
  | "TEXT_TOO_LARGE"
  | "CANCEL_UNSUPPORTED";

/** data of an error response that carries a code; InvalidParams and ServerNotInitialized carry none. */
export interface BackendErrorData {
  code: BackendErrorCode;
  retryable?: boolean;
  details?: unknown;
  fixStatement?: string;
}

export interface InitializeParams {
  protocolVersion: number;
}

export interface InitializeResult {
  protocolVersion: number;
  runtime: { node: string; electron: string | null; modules: string; platform: string; arch: string };
  enabledProviders: readonly DatabaseType[] | null;
}

/** editorLanguage (PR 11) and commitKeyword (PR 13) join with their parts. */
export interface ProviderDescription {
  capabilities: ProviderCapabilities & { supportsQueryCancel: boolean };
  labels: ProviderLabels;
}

/** The core's own union, so the wire answer cannot drift from the route's. */
export type TestConnectionResult = TestConnectionAnswer;

export interface ConnectionParams {
  connection: WireConnection;
  posture: Posture;
}

export interface OpenResult {
  description: ProviderDescription;
}

export interface ConnectionIdParams {
  connectionId: string;
}

export interface ContainersParams extends ConnectionIdParams {
  parent?: readonly string[];
}

export interface CountsParams extends ConnectionIdParams {
  container: readonly string[];
}

export interface ListParams extends ConnectionIdParams {
  container: readonly string[];
  kind: string;
}

export interface DescribeParams extends ConnectionIdParams {
  path: readonly string[];
  kind: string;
}

export interface RunQueryParams {
  connectionId: string;
  /** Host-minted crypto.randomUUID(), fresh for every run and every page read. */
  queryId: string;
  /** The editor text as sent; the child adds only the row bound. */
  statement: string;
  /** Only where capabilities.catalogSessions is true. */
  catalog?: string;
  /** libredb.query.rowLimit, default 500. */
  limit: number;
  /** 0 for a run; the previous offset plus the rows returned for a page read. */
  offset: number;
}

/** The body POST /api/db/query answers (EditorQueryBody, which has no explainFormat), plus resultSetCount above 1. */
export type QueryPage = EditorQueryBody & { resultSetCount?: number };

export interface CancelParams {
  connectionId: string;
  queryId: string;
}

export interface CancelResult {
  cancelled: boolean;
}

export interface BackendApi {
  initialize(params: InitializeParams): Promise<InitializeResult>;
  testConnection(params: ConnectionParams, token?: CancellationToken): Promise<TestConnectionResult>;
  openConnection(params: ConnectionParams, token?: CancellationToken): Promise<OpenResult>;
  closeConnection(params: ConnectionIdParams): Promise<null>;
  listContainers(params: ContainersParams, token?: CancellationToken): Promise<Container[]>;
  countObjects(params: CountsParams, token?: CancellationToken): Promise<Record<string, KindCount>>;
  listObjects(params: ListParams, token?: CancellationToken): Promise<DatabaseObject[]>;
  describeObject(params: DescribeParams, token?: CancellationToken): Promise<ObjectDetail>;
  runQuery(params: RunQueryParams, token?: CancellationToken): Promise<QueryPage>;
  cancelQuery(params: CancelParams): Promise<CancelResult>;
  shutdown(): Promise<null>;
}

/** One JSON-RPC method name per BackendApi method, so no method can be added without its name. */
export const METHODS = {
  initialize: "initialize",
  testConnection: "connection/test",
  openConnection: "connection/open",
  closeConnection: "connection/close",
  listContainers: "objects/containers",
  countObjects: "objects/counts",
  listObjects: "objects/list",
  describeObject: "objects/describe",
  runQuery: "query/run",
  cancelQuery: "query/cancel",
  shutdown: "shutdown",
} as const satisfies Record<keyof BackendApi, string>;

/** The notification that ends the child once shutdown has answered. */
export const EXIT_NOTIFICATION = "exit";
