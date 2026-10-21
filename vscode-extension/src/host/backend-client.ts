// The host side of the backend interface (part 1, "The backend interface"): each BackendApi method as its JSON-RPC
// request, the error answers as typed errors ("Error classification"), and the reopen of a connection in a new child
// ("Generations"). No code here reads a message text to decide (criterion 9).
import {
  type CancellationToken,
  CancellationTokenSource,
  ConnectionError,
  ErrorCodes,
  type MessageConnection,
  ResponseError,
} from "vscode-jsonrpc";
import type {
  BackendApi,
  BackendErrorCode,
  BackendErrorData,
  CancelParams,
  ConnectionIdParams,
  ConnectionParams,
  ContainersParams,
  CountsParams,
  DescribeParams,
  ListParams,
  ParseParams,
  RunQueryParams,
} from "../protocol";
import { METHODS } from "../protocol";
import type { BackendExit, BackendLink } from "./backend-supervisor";
import { UnknownConnectionError } from "./connections/connection-store";

/** What a BackendApi method resolves. */
type Answer<M extends keyof BackendApi> = Awaited<ReturnType<BackendApi[M]>>;

/** An error answer: status is the response's error.code (an HTTP status, or a JSON-RPC code), code its data.code. */
export class BackendError extends Error {
  readonly retryable?: boolean;
  readonly details?: unknown;
  readonly fixStatement?: string;

  constructor(
    readonly status: number,
    /** null for InvalidParams and ServerNotInitialized, which carry no data.code. */
    readonly code: BackendErrorCode | null,
    message: string,
    more: Omit<BackendErrorData, "code"> = {},
  ) {
    super(message);
    this.name = "BackendError";
    this.retryable = more.retryable;
    this.details = more.details;
    this.fixStatement = more.fixStatement;
  }
}

/** "The LibreDB backend stopped (exit code <n or none>, signal <s or none>)." */
export class BackendExitedError extends Error {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor({ exitCode, signal }: BackendExit) {
    super(`The LibreDB backend stopped (exit code ${exitCode ?? "none"}, signal ${signal ?? "none"}).`);
    this.name = "BackendExitedError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/**
 * The codes of a failed connection/open that offer Enter Credentials, read from data.code only, never the message.
 * CONNECTION_ERROR is here because the v0 providers wrap a refused login in ConnectionError, so a wrong password
 * answers 503 CONNECTION_ERROR on postgres, mssql, mysql and mongodb and the host cannot tell it from an unreachable
 * server; the offer is harmless there. D387 in docs/BACKLOG.md narrows this back to AUTH_ERROR.
 */
const CREDENTIALS_OFFER_CODES: ReadonlySet<BackendErrorCode | null> = new Set<BackendErrorCode>([
  "AUTH_ERROR",
  "CONNECTION_ERROR",
]);

/** A connection as a reopen reads it: its params, the profile revision they were read at, and what to store after. */
export interface SourcedConnection {
  readonly params: ConnectionParams;
  /** The profile revision the params were read at. */
  readonly revision: number;
  /** Stores what the person typed for this open; the client calls it once connection/open has succeeded, never otherwise. */
  opened(): Promise<void>;
}

/** Where a reopen reads a connection again, its secrets included: ProfileConnectionSource, over the profiles and SecretStorage. */
export interface ConnectionSource {
  read(connectionId: string): Promise<SourcedConnection>;
  /** After an open answered AUTH_ERROR or CONNECTION_ERROR: undefined when the profile lists no secretFields, else the read with the values typed again. */
  reask(connectionId: string, error: BackendError): Promise<SourcedConnection | undefined>;
  revision(connectionId: string): number;
}

/** Where and at what a connection was opened: the numbers only, so the host keeps no secret past a call. */
interface OpenRecord {
  readonly generation: number;
  readonly revision: number;
}

export class BackendClient implements BackendApi {
  /** Each opened connection's record, by id; one that differs from the current generation or revision is reopened. */
  private readonly opened = new Map<string, OpenRecord>();
  /** The reopen under way for each connection id, with its generation and revision: calls that need both share it. */
  private readonly reopening = new Map<string, { generation: number; revision: number; done: Promise<void> }>();
  /** The token source of every query/run in flight, by connection id, until the run settles. */
  private readonly runs = new Map<string, Set<CancellationTokenSource>>();

  constructor(
    private readonly link: BackendLink,
    private readonly source: ConnectionSource,
  ) {}

  /** The supervisor already ran the handshake with PROTOCOL_VERSION; this answers its result and sends nothing. */
  async initialize(): Promise<Answer<"initialize">> {
    return (await this.link.connection()).initialized;
  }

  /** Touches neither the record nor the source. */
  async testConnection(params: ConnectionParams, token?: CancellationToken): Promise<Answer<"testConnection">> {
    const { connection } = await this.link.connection();
    return await this.request<Answer<"testConnection">>(connection, METHODS.testConnection, params, token);
  }

  /** Records the source's revision taken before the request, so an edit while the open waits leaves the record stale. */
  async openConnection(params: ConnectionParams, token?: CancellationToken): Promise<Answer<"openConnection">> {
    const revision = this.source.revision(params.connection.id);
    const { connection, generation } = await this.link.connection();
    const opened = await this.request<Answer<"openConnection">>(connection, METHODS.openConnection, params, token);
    this.opened.set(params.connection.id, { generation, revision });
    return opened;
  }

  async closeConnection(params: ConnectionIdParams): Promise<null> {
    this.opened.delete(params.connectionId);
    const { connection } = await this.link.connection();
    return await this.request<null>(connection, METHODS.closeConnection, params);
  }

  listContainers(params: ContainersParams, token?: CancellationToken): Promise<Answer<"listContainers">> {
    return this.onOpenConnection(params.connectionId, (connection) =>
      this.request<Answer<"listContainers">>(connection, METHODS.listContainers, params, token),
    );
  }

  countObjects(params: CountsParams, token?: CancellationToken): Promise<Answer<"countObjects">> {
    return this.onOpenConnection(params.connectionId, (connection) =>
      this.request<Answer<"countObjects">>(connection, METHODS.countObjects, params, token),
    );
  }

  listObjects(params: ListParams, token?: CancellationToken): Promise<Answer<"listObjects">> {
    return this.onOpenConnection(params.connectionId, (connection) =>
      this.request<Answer<"listObjects">>(connection, METHODS.listObjects, params, token),
    );
  }

  describeObject(params: DescribeParams, token?: CancellationToken): Promise<Answer<"describeObject">> {
    return this.onOpenConnection(params.connectionId, (connection) =>
      this.request<Answer<"describeObject">>(connection, METHODS.describeObject, params, token),
    );
  }

  /**
   * The child cancels the statement when the caller cancels, when the supervisor is about to stop, and on cancelRuns
   * for its connection, which reaches the token source until the run settles.
   */
  async runQuery(params: RunQueryParams, token?: CancellationToken): Promise<Answer<"runQuery">> {
    const own = new CancellationTokenSource();
    const links = [this.link.onWillStop(() => own.cancel())];
    if (token !== undefined) links.push(token.onCancellationRequested(() => own.cancel()));
    const held = this.runs.get(params.connectionId) ?? new Set<CancellationTokenSource>();
    this.runs.set(params.connectionId, held.add(own));
    try {
      return await this.onOpenConnection(params.connectionId, (connection) =>
        this.request<Answer<"runQuery">>(connection, METHODS.runQuery, params, own.token),
      );
    } finally {
      held.delete(own);
      if (held.size === 0) this.runs.delete(params.connectionId);
      for (const link of links) link.dispose();
      own.dispose();
    }
  }

  /** Remove's step 2: cancels the token of every query/run this client has in flight on the id. */
  cancelRuns(connectionId: string): void {
    for (const own of this.runs.get(connectionId) ?? []) own.cancel();
  }

  /**
   * Remove's step 3: forgets the id, and sends connection/close only when it was opened in the current generation
   * while the link is ready; never starts a child.
   */
  async closeIfOpen(connectionId: string): Promise<void> {
    const record = this.opened.get(connectionId);
    this.opened.delete(connectionId);
    if (record === undefined || this.link.state !== "ready" || record.generation !== this.link.generation) return;
    // A ready link answers its running child: this call starts none.
    const { connection } = await this.link.connection();
    await this.request<null>(connection, METHODS.closeConnection, { connectionId });
  }

  /** Never reopens: no statement can run in a child that never opened the connection. */
  async cancelQuery(params: CancelParams): Promise<Answer<"cancelQuery">> {
    const { connection } = await this.link.connection();
    return await this.request<Answer<"cancelQuery">>(connection, METHODS.cancelQuery, params);
  }

  async shutdown(): Promise<null> {
    await this.link.stop();
    return null;
  }

  /** Reads no connection and records nothing: the catalogue names engines, not connections. */
  async listEngines(params: Record<string, never>): Promise<Answer<"listEngines">> {
    const { connection } = await this.link.connection();
    return await this.request<Answer<"listEngines">>(connection, METHODS.listEngines, params);
  }

  /** Reads no connection and records nothing; the text is a credential the host keeps no copy of. */
  async parsePastedConnection(params: ParseParams): Promise<Answer<"parsePastedConnection">> {
    const { connection } = await this.link.connection();
    return await this.request<Answer<"parsePastedConnection">>(connection, METHODS.parsePastedConnection, params);
  }

  /**
   * Sends on a connection opened in the current child at the profile's current revision: opens it first when its record
   * is missing or either number differs (part 2, "Revision"), and on a CONNECTION_NOT_OPEN answer, and only on that
   * code, opens it again and retries once.
   */
  private async onOpenConnection<T>(
    connectionId: string,
    send: (connection: MessageConnection) => Promise<T>,
  ): Promise<T> {
    const { connection, generation } = await this.link.connection();
    const record = this.opened.get(connectionId);
    if (
      record === undefined ||
      record.generation !== generation ||
      record.revision !== this.source.revision(connectionId)
    ) {
      await this.reopen(connection, generation, connectionId);
    }
    try {
      return await send(connection);
    } catch (error) {
      if (!(error instanceof BackendError && error.code === "CONNECTION_NOT_OPEN")) throw error;
      this.opened.delete(connectionId);
      const current = await this.link.connection();
      await this.reopen(current.connection, current.generation, connectionId);
      return await send(current.connection);
    }
  }

  /**
   * Reads the connection from the source and opens it; an AUTH_ERROR or CONNECTION_ERROR answer (D387) asks the source
   * once more (Enter Credentials) and opens with its answer, or rethrows when it has none. Records the revision the read
   * answered, after that read's opened() has stored what the person typed; a profile removed while the open waited is
   * closed in the child and rejects UnknownConnectionError, recording nothing.
   * Every call that needs this id in this generation at the profile's current revision shares one reopen, so the source
   * is read, and the person asked, once. A reopen at a newer revision starts once the one under way has settled, opened
   * or failed, so the child's last connection/open of the id is the one the record names.
   */
  private reopen(connection: MessageConnection, generation: number, connectionId: string): Promise<void> {
    // Throws UnknownConnectionError for a profile the source no longer lists, before a call can share a reopen of it.
    const revision = this.source.revision(connectionId);
    const underWay = this.reopening.get(connectionId);
    if (underWay?.generation === generation && underWay.revision === revision) return underWay.done;
    const open = async (): Promise<void> => {
      let sourced = await this.source.read(connectionId);
      try {
        await this.request<Answer<"openConnection">>(connection, METHODS.openConnection, sourced.params);
      } catch (error) {
        if (!(error instanceof BackendError && CREDENTIALS_OFFER_CODES.has(error.code))) throw error;
        const again = await this.source.reask(connectionId, error);
        if (again === undefined) throw error;
        sourced = again;
        await this.request<Answer<"openConnection">>(connection, METHODS.openConnection, sourced.params);
      }
      try {
        await sourced.opened();
        // Throws UnknownConnectionError for a profile removed while the open waited, whose Remove found no record.
        this.source.revision(connectionId);
      } catch (error) {
        // The child keeps no provider for a profile the source no longer lists.
        if (error instanceof UnknownConnectionError) {
          await this.request<null>(connection, METHODS.closeConnection, { connectionId });
        }
        throw error;
      }
      this.opened.set(connectionId, { generation, revision: sourced.revision });
    };
    const started = underWay?.generation === generation ? underWay.done.then(open, open) : open();
    const done = started.finally(() => {
      // A failed reopen is not kept: the next call reads the source again.
      if (this.reopening.get(connectionId)?.done === done) this.reopening.delete(connectionId);
    });
    this.reopening.set(connectionId, { generation, revision, done });
    return done;
  }

  /** One request, its params by name and the caller's token, with its error turned by toBackendError. */
  private async request<R>(
    connection: MessageConnection,
    method: string,
    params: object,
    token?: CancellationToken,
  ): Promise<R> {
    try {
      // vscode-jsonrpc would send an undefined token as a second, positional param.
      const sent =
        token === undefined
          ? connection.sendRequest<R>(method, params)
          : connection.sendRequest<R>(method, params, token);
      return await sent;
    } catch (error) {
      throw toBackendError(error, this.link.lastExit);
    }
  }
}

/**
 * The error a request's caller sees: a request lost with its child is BackendExitedError, an error answer is
 * BackendError, and anything else stays as it is.
 */
export function toBackendError(error: unknown, lastExit: BackendExit | undefined): unknown {
  const lost =
    (error instanceof ResponseError && error.code === ErrorCodes.PendingResponseRejected) ||
    error instanceof ConnectionError;
  if (lost) {
    if (lastExit === undefined) {
      return new Error("A pending request was rejected while the LibreDB backend had not exited.");
    }
    return new BackendExitedError(lastExit);
  }
  if (!(error instanceof ResponseError)) return error;
  const data: unknown = error.data;
  if (typeof data === "object" && data !== null && typeof (data as BackendErrorData).code === "string") {
    const { code, ...more } = data as BackendErrorData;
    return new BackendError(error.code, code, error.message, more);
  }
  return new BackendError(error.code, null, error.message);
}
