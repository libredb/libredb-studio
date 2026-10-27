// The backend interface between the extension host and the child, the JSON-RPC method names and the wire types.
// Every LibreDB import is type-only, so this module adds no provider code to the host bundle.
import type { CancellationToken } from "vscode-jsonrpc";
import type { EditorQueryBody } from "@/lib/api/editor-query";
import type { ApiErrorCode } from "@/lib/api/error-codes";
import type { TestConnectionAnswer } from "@/lib/api/test-connection";
import type { ParsedConnection } from "@/lib/connection-string-parser";
import type { ConnectionField, FieldPlacement } from "@/lib/db/connection-fields";
import type {
  Container,
  DatabaseObject,
  EditorExecutionContext,
  KindCount,
  ObjectDetail,
  ProviderCapabilities,
  ProviderLabels,
} from "@/lib/db/types";
import type { EditorLanguage } from "@/lib/editor/tab-language";
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

export interface ProviderDescription {
  capabilities: ProviderCapabilities & { supportsQueryCancel: boolean };
  labels: ProviderLabels;
  /** editorLanguageForTabType(resolveTabType(capabilities)), computed in the child from the provider it opened. */
  editorLanguage: EditorLanguage;
  /** executionUiFor(connection.type).commitKeyword, computed in the child: the keyword the rolled-back notice names. */
  commitKeyword: string;
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

export interface SelectStatementParams extends ConnectionIdParams {
  object: DatabaseObject;
}

export interface SelectStatementResult {
  statement: string;
}

/** A [start, end) pair of UTF-16 offsets into a document's text. */
export interface OffsetRange {
  start: number;
  end: number;
}

export interface RunTargetParams extends ConnectionIdParams {
  text: string;
  selection: OffsetRange;
  cursor: number;
}

/**
 * range is absent when the statement is the whole text; statement is "" when the target holds no code; dangerous is
 * present, as true, when the web editor would ask before running it (isDangerousQuery under the connection's type).
 */
export interface RunTargetResult {
  statement: string;
  range?: OffsetRange;
  dangerous?: true;
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

/** One field as the add-connection flow asks for it (part 2, "Backend methods this part adds"). */
export interface EngineField {
  name: ConnectionField;
  /** connectionFieldLabel(spec, name, ""), with "" sent as null. */
  label: string | null;
  /** connectionFieldHint(spec, name), with undefined sent as null. */
  hint: string | null;
  /** connectionFieldPlaceholder(spec, name, ""), with "" sent as null. */
  placeholder: string | null;
  /** connectionFieldPlacement for one of PLACEABLE_FIELDS, "open" for every other field. */
  placement: FieldPlacement;
}

/** One engine the add-connection flow offers. */
export interface EngineForm {
  type: DatabaseType;
  /** CONNECTION_FORM[type].label */
  label: string;
  /** CONNECTION_FORM[type].defaultHost, null where the entry declares none. */
  defaultHost: string | null;
  /** CONNECTION_FORM[type].defaultPort */
  defaultPort: string;
  /** CONNECTION_STRING[type].scheme */
  pasteScheme: string | null;
  /** CONNECTION_FORM_URI_MODE[type] */
  keepsPastedString: boolean;
  /** offersSslPanel(type) */
  offersSsl: boolean;
  /** CONNECTION_FIELDS[type] of src/lib/db/connection-fields.ts, in its order. */
  fields: EngineField[];
}

export interface EngineCatalog {
  engines: EngineForm[];
  /** PASTE_FORMATS_TEXT of src/lib/connection-paste-formats.ts: the forms the paste box reads, as one phrase. */
  pasteFormats: string;
}

/** The text a person pasted: a credential, which no trace ever writes. */
export interface ParseParams {
  text: string;
}

export interface PastedConnection {
  /** parseConnectionString(text) */
  parsed: ParsedConnection | null;
  /** CONNECTION_FORM[parsed.type].label when parsed is not null. */
  label: string | null;
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
  listEngines(params: Record<string, never>): Promise<EngineCatalog>;
  parsePastedConnection(params: ParseParams): Promise<PastedConnection>;
  selectStatement(params: SelectStatementParams, token?: CancellationToken): Promise<SelectStatementResult>;
  runTarget(params: RunTargetParams): Promise<RunTargetResult>;
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
  listEngines: "engines/list",
  parsePastedConnection: "connection/parse",
  selectStatement: "objects/selectStatement",
  runTarget: "query/target",
} as const satisfies Record<keyof BackendApi, string>;

/** The notification that ends the child once shutdown has answered. */
export const EXIT_NOTIFICATION = "exit";
