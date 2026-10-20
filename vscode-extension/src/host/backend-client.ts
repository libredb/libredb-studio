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
  RunQueryParams,
} from "../protocol";
import { METHODS } from "../protocol";
import type { BackendExit, BackendLink } from "./backend-supervisor";

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

/** Where a reopen reads a connection again, its secrets included: PR 8 implements it over the profiles and SecretStorage. */
export interface ConnectionSource {
  read(connectionId: string): Promise<ConnectionParams>;
}

export class BackendClient implements BackendApi {
  /** The generation each connection was opened in, by id: the number only, so the host keeps no secret past a call. */
  private readonly opened = new Map<string, number>();
  /** The reopen under way for each connection id, with its generation: concurrent calls share it. */
  private readonly reopening = new Map<string, { generation: number; done: Promise<void> }>();

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

  async openConnection(params: ConnectionParams, token?: CancellationToken): Promise<Answer<"openConnection">> {
    const { connection, generation } = await this.link.connection();
    const opened = await this.request<Answer<"openConnection">>(connection, METHODS.openConnection, params, token);
    this.opened.set(params.connection.id, generation);
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

  /** The child cancels the statement when the caller cancels, and when the supervisor is about to stop. */
  async runQuery(params: RunQueryParams, token?: CancellationToken): Promise<Answer<"runQuery">> {
    const own = new CancellationTokenSource();
    const links = [this.link.onWillStop(() => own.cancel())];
    if (token !== undefined) links.push(token.onCancellationRequested(() => own.cancel()));
    try {
      return await this.onOpenConnection(params.connectionId, (connection) =>
        this.request<Answer<"runQuery">>(connection, METHODS.runQuery, params, own.token),
      );
    } finally {
      for (const link of links) link.dispose();
      own.dispose();
    }
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

  /**
   * Sends on a connection opened in the current child: opens it first when it was not opened in this generation, and
   * on a CONNECTION_NOT_OPEN answer, and only on that code, opens it again and retries once.
   */
  private async onOpenConnection<T>(
    connectionId: string,
    send: (connection: MessageConnection) => Promise<T>,
  ): Promise<T> {
    const { connection, generation } = await this.link.connection();
    if (this.opened.get(connectionId) !== generation) await this.reopen(connection, generation, connectionId);
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

  /** Reads the source once and sends one connection/open for every call that needs this id in this generation. */
  private reopen(connection: MessageConnection, generation: number, connectionId: string): Promise<void> {
    const underWay = this.reopening.get(connectionId);
    if (underWay?.generation === generation) return underWay.done;
    const done = (async () => {
      await this.request<Answer<"openConnection">>(
        connection,
        METHODS.openConnection,
        await this.source.read(connectionId),
      );
      this.opened.set(connectionId, generation);
    })().finally(() => {
      // A failed reopen is not kept: the next call reads the source again.
      if (this.reopening.get(connectionId)?.done === done) this.reopening.delete(connectionId);
    });
    this.reopening.set(connectionId, { generation, done });
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
