// The child's request handlers: each reads its params at the edge, then calls the provider layer as the route it
// mirrors does (part 1, "The backend interface"). A provider-reaching step runs inside `answeringFor`, so its failure is
// answered with the connection's scrub, as the routes answer it: withheld when its text holds a credential of the
// connection, with its SQLSTATE otherwise.
// The factory functions arrive as one parameter object, which main.ts fills with the real ones and the unit leg with
// fakes, so this module value-imports neither src/lib/db/factory.ts nor src/lib/api/test-connection.ts.
import { type CancellationToken, ErrorCodes, type MessageConnection, ResponseError } from "vscode-jsonrpc";
import { cancelEditorRun, checkEditorQuery, openWithinCall, runEditorQuery } from "@/lib/api/editor-query";
import { databaseErrorBody, internalErrorBody, withWithheldText } from "@/lib/api/error-body";
import { pageOptionError } from "@/lib/api/page-probe";
import { gateRun, type RunGateAnswerBody, type RunGateRequest } from "@/lib/api/run-confirmation";
import { runConfirmationIssuerForProcess } from "@/lib/api/run-confirmation-token";
import type { testConnection } from "@/lib/api/test-connection";
import { parseConnectionString } from "@/lib/connection-string-parser";
import { scopeToCatalog } from "@/lib/db/catalog-scope";
import { clientCapabilities } from "@/lib/db/client-capabilities";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import {
  errorRecord,
  type ProviderTextScrub,
  providerTextScrub,
  scrubKindCounts,
  scrubObjectDetail,
  withheldProviderError,
} from "@/lib/db/operations/provider-text";
import { executionUiFor } from "@/lib/db/execution-ui";
import type { clearProviderCache, enabledProviderTypes, getOrCreateProvider } from "@/lib/db/factory";
import { findKind, kindHasColumns } from "@/lib/db/object-kinds";
import { supportsQueryCancel } from "@/lib/db/query-cancel";
import type { Container, DatabaseObject, KindCount, ObjectDetail, QueryPrepareOptions } from "@/lib/db/types";
import { editorLanguageOf } from "@/lib/editor/tab-language";
import type { OpenWait } from "@/lib/provider-host/core/open-once";
import { generateTableQuery } from "@/lib/query-generators";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { type RunTarget, runnableTarget } from "@/lib/sql/run-target";
import type { ColumnSchema, DatabaseConnection } from "@/lib/types";
import {
  type BackendErrorCode,
  type BackendErrorData,
  type CancelResult,
  type EngineCatalog,
  EXIT_NOTIFICATION,
  type InitializeResult,
  METHODS,
  type OpenResult,
  type PastedConnection,
  type Posture,
  PROTOCOL_VERSION,
  type QueryPage,
  type RunTargetResult,
  type SelectStatementResult,
  type TestConnectionResult,
} from "../protocol";
import { engineCatalog } from "./engine-catalog";
import { checkLocalFile } from "./local-file";
import { ConnectionRegistry, notOpenSentence, type OpenRecord } from "./registry";

/** The factory functions the handlers call, as one object. */
export interface BackendFactory {
  getOrCreateProvider: typeof getOrCreateProvider;
  /** Never a scope: the child serves one person's process (part 1). */
  removeProvider(connectionId: string): Promise<void>;
  clearProviderCache: typeof clearProviderCache;
  enabledProviderTypes: typeof enabledProviderTypes;
  testConnection: typeof testConnection;
}

/** What initialize reads off the process the child runs in, and the Node floor of the root package.json. */
export interface BackendRuntime {
  versions: NodeJS.ProcessVersions;
  platform: string;
  arch: string;
  nodeFloor: string;
}

/** The route label a test connection is logged under. */
export const TEST_ROUTE = "vscode/connection/test";
/** The route label a failed cancel of a run is logged under. */
export const RUN_ROUTE = "vscode/query/run";
/** The label a failure after a cancel stopped waiting is logged under. */
const CANCEL_ROUTE = "vscode/query/cancel";

/** The user the run gate's advisory warning names for this child: it serves one VS Code window and has no login. */
export const RUN_CONFIRMATION_USER = "vscode-extension";

/** Params the child cannot read: InvalidParams, naming the field, with no data. */
export function invalidParams(message: string): ResponseError<void> {
  return new ResponseError<void>(ErrorCodes.InvalidParams, message);
}

/** A refusal of the extension's own, with an HTTP status as its code and a BackendErrorCode as data.code. */
export function refusal(status: number, code: BackendErrorCode, message: string): ResponseError<BackendErrorData> {
  return new ResponseError<BackendErrorData>(status, message, { code });
}

const FLOOR = /^>=(\d+)\.(\d+)\.(\d+)$/;

/** Whether the Node version `found` is at or above `floor`, which must be the `>=X.Y.Z` form of engines.node. */
export function nodeMeetsFloor(found: string, floor: string): boolean {
  const match = FLOOR.exec(floor);
  if (match === null) {
    throw new Error(`engines.node is "${floor}"; the backend's floor check reads only the ">=X.Y.Z" form.`);
  }
  const needed = match.slice(1).map(Number);
  const have = found.split(".").map(Number);
  const first = needed.findIndex((part, index) => have[index] !== part);
  return first === -1 || have[first] > needed[first];
}

export interface BackendHandlers {
  initialize(params: unknown): InitializeResult;
  testConnection(params: unknown): Promise<TestConnectionResult>;
  openConnection(params: unknown): Promise<OpenResult>;
  closeConnection(params: unknown): Promise<null>;
  listContainers(params: unknown): Promise<Container[]>;
  countObjects(params: unknown): Promise<Record<string, KindCount>>;
  listObjects(params: unknown): Promise<DatabaseObject[]>;
  describeObject(params: unknown): Promise<ObjectDetail>;
  runQuery(params: unknown, token: CancellationToken): Promise<QueryPage>;
  cancelQuery(params: unknown, token: CancellationToken): Promise<CancelResult>;
  shutdown(): Promise<null>;
  listEngines(params: unknown): EngineCatalog;
  parsePastedConnection(params: unknown): PastedConnection;
  selectStatement(params: unknown): Promise<SelectStatementResult>;
  runTarget(params: unknown): Promise<RunTargetResult>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** An object with no own key, and not an array: what engines/list takes. */
function isEmptyObject(value: unknown): boolean {
  return isObject(value) && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** The field `name` of a params object, or undefined when the params are not an object. */
function fieldOf(params: unknown, name: string): unknown {
  return isObject(params) ? params[name] : undefined;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw invalidParams(`${field} must be a non-empty string`);
  return value;
}

function aString(value: unknown, field: string): string {
  if (typeof value !== "string") throw invalidParams(`${field} must be a string`);
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string")) {
    throw invalidParams(`${field} must be an array of strings`);
  }
  return value;
}

function anInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) throw invalidParams(`${field} must be an integer`);
  return value as number;
}

/** The object of objects/selectStatement: the fields the generator addresses it by, checked; the rest as sent. */
function databaseObjectOf(value: unknown): DatabaseObject {
  if (!isObject(value)) throw invalidParams("object must be an object");
  stringArray(value.path, "object.path");
  aString(value.kind, "object.kind");
  aString(value.name, "object.name");
  // The other fields (readRanges among them) are the provider's and the generator's to read, as they are on the web.
  return value as unknown as DatabaseObject;
}

/** The catalog field of query/run and query/target: absent, or a non-empty string. */
function catalogOf(params: unknown): string | undefined {
  const catalog = fieldOf(params, "catalog");
  return catalog === undefined ? undefined : nonEmptyString(catalog, "catalog");
}

/**
 * The run gate's answer as the JSON-RPC error the route's answer would be: the route's status as the code and its
 * sentence; a body with a code carries it as data.code, a 428's offer beside it; a body without one carries no data.
 */
function gateAnswerError(status: number, body: RunGateAnswerBody): ResponseError<BackendErrorData | void> {
  if (body.code === undefined) return new ResponseError<void>(status, body.error);
  return new ResponseError<BackendErrorData>(status, body.error, {
    code: body.code,
    ...(body.confirmation !== undefined && { confirmation: body.confirmation }),
  });
}

/** The connectionId every request after connection/open names its connection by. */
function connectionIdOf(params: unknown): string {
  return nonEmptyString(fieldOf(params, "connectionId"), "connectionId");
}

/** The connection and posture of a connection/test or connection/open, revived and with the posture made explicit. */
function readConnectionParams(params: unknown): OpenRecord {
  const wire = fieldOf(params, "connection");
  if (!isObject(wire)) throw invalidParams("connection must be an object");
  nonEmptyString(wire.id, "connection.id");
  aString(wire.type, "connection.type");
  const createdAt = new Date(typeof wire.createdAt === "string" ? wire.createdAt : Number.NaN);
  if (Number.isNaN(createdAt.getTime())) throw invalidParams("connection.createdAt must be an ISO date string");
  const allowExternalFileAccess = fieldOf(fieldOf(params, "posture"), "allowExternalFileAccess");
  if (typeof allowExternalFileAccess !== "boolean") {
    throw invalidParams("posture.allowExternalFileAccess must be a boolean");
  }
  // The other fields are the provider's to check, as they are behind the routes.
  const connection = { ...wire, createdAt } as unknown as DatabaseConnection;
  return { connection, posture: { allowExternalFileAccess } };
}

/**
 * Runs `work`, a handler's provider-reaching step on `connection`, and answers every failure of it as `toResponseError`
 * answers it with the connection's scrub (core's scrub, `providerTextScrub(connection, "any")`): the error's own status,
 * code, kind, outcome and retryable, with its texts replaced when they hold a credential of the connection and its
 * SQLSTATE beside them when they do not. A `ResponseError` of the child's own is rethrown as it is.
 */
async function answeringFor<T>(connection: DatabaseConnection, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ResponseError) throw error;
    throw toResponseError(error, providerTextScrub(connection, "any"));
  }
}

export function createHandlers(
  factory: BackendFactory,
  runtime: BackendRuntime,
  registry: ConnectionRegistry = new ConnectionRegistry(),
): BackendHandlers {
  // The run confirmation's issuer: this child's own secret and session, drawn once and held only in its memory, so a
  // token from another child or from before a restart is not verifiable (docs/VSCODE_EXTENSION.md section 7).
  const issuer = runConfirmationIssuerForProcess(RUN_CONFIRMATION_USER);
  /** The run gate's request for a statement on an open record, as the query route builds it for one statement. */
  const gateRequest = (record: OpenRecord, catalog: string | undefined, sql: string, confirmation: unknown) =>
    ({
      route: RUN_ROUTE,
      issuer,
      connection: record.connection,
      catalog,
      sql,
      params: undefined,
      confirmation,
      explain: false,
    }) satisfies RunGateRequest;

  /** The record connection/open stored for this id, or the CONNECTION_NOT_OPEN refusal the host reopens on. */
  const openRecord = (connectionId: string): OpenRecord => {
    const record = registry.get(connectionId);
    if (record === undefined) {
      throw refusal(404, "CONNECTION_NOT_OPEN", notOpenSentence(connectionId));
    }
    return record;
  };

  // A type the channel leaves out gets the factory's own "not available" refusal, so the extension's file rules run
  // only on an enabled one.
  const checkEnabledLocalFile = (connection: DatabaseConnection, posture: Posture): void => {
    const enabled = factory.enabledProviderTypes();
    if (enabled === null || enabled.includes(connection.type)) checkLocalFile(connection, posture);
  };

  // As handleObjectRequest (src/lib/api/object-route.ts) resolves it: the cached provider, or a new one opened from
  // the record after the idle sweep closed the old one. Engine-shape checks of a path stay with the provider.
  const providerOf = (record: OpenRecord) => factory.getOrCreateProvider(record.connection, {}, record.posture);
  // The same provider, waited for only within an editor call's open wait, its engine's connect budget
  // (`openWithinCall`), as the query and cancel routes wait for theirs: the call stops waiting when the wait ends, and
  // the open goes on for the next call.
  const providerWithin = (record: OpenRecord, wait: OpenWait) =>
    factory.getOrCreateProvider(record.connection, {}, record.posture, wait);

  // Each id's connection/open and connection/close run one at a time, in the order they arrived: a second open finds
  // the first one's provider and record, and a close never runs beside an open of the same id. The factory also
  // shares one open in flight per cache key, which keeps its cache whole; this keeps the child's own records in order.
  const turns = new Map<string, Promise<void>>();
  const inTurn = <T>(connectionId: string, step: () => Promise<T>): Promise<T> => {
    const run = (turns.get(connectionId) ?? Promise.resolve()).then(step);
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    turns.set(connectionId, done);
    void done.then(() => {
      if (turns.get(connectionId) === done) turns.delete(connectionId);
    });
    return run;
  };

  return {
    initialize(params) {
      const protocolVersion = fieldOf(params, "protocolVersion");
      if (typeof protocolVersion !== "number") throw invalidParams("protocolVersion must be a number");
      if (protocolVersion !== PROTOCOL_VERSION) {
        throw refusal(
          500,
          "PROTOCOL_MISMATCH",
          `The LibreDB backend speaks protocol version ${PROTOCOL_VERSION}, but the extension sent version ${protocolVersion}. Reinstall the LibreDB extension.`,
        );
      }
      const { versions, platform, arch, nodeFloor } = runtime;
      if (!nodeMeetsFloor(versions.node, nodeFloor)) {
        throw refusal(
          500,
          "RUNTIME_UNSUPPORTED",
          `The LibreDB backend needs Node ${nodeFloor.slice(2)} or later and was started on Node ${versions.node}.`,
        );
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        runtime: {
          node: versions.node,
          electron: versions.electron ?? null,
          modules: versions.modules,
          platform,
          arch,
        },
        enabledProviders: factory.enabledProviderTypes(),
      };
    },

    // The core bounds the whole test by its own deadline, the engine's connect budget (docs/providers/CONTRACT.md,
    // clause C-56): at it the core answers a ConnectionError naming the budget, closes a one-shot tunnel at once and
    // the provider it built once the driver's connect settles.
    async testConnection(params) {
      const { connection, posture } = readConnectionParams(params);
      checkEnabledLocalFile(connection, posture);
      return await answeringFor(connection, () => factory.testConnection(connection, posture, TEST_ROUTE));
    },

    async openConnection(params) {
      const record = readConnectionParams(params);
      checkEnabledLocalFile(record.connection, record.posture);
      const { id } = record.connection;
      return await answeringFor(record.connection, () =>
        inTurn(id, async () => {
          // An edited connection closes its old pool now rather than at the idle sweep.
          if (registry.differs(record)) {
            registry.delete(id);
            await factory.removeProvider(id);
          }
          const provider = await factory.getOrCreateProvider(record.connection, {}, record.posture);
          registry.set(record);
          // Studio's record of the masking exemption, read by the type the connection was opened with, never the
          // provider's own.
          const capabilities = clientCapabilities(record.connection.type, provider.getCapabilities());
          return {
            description: {
              // supportsQueryCancel is computed as POST /api/db/provider-meta computes it.
              capabilities: { ...capabilities, supportsQueryCancel: supportsQueryCancel(provider) },
              labels: provider.getLabels(),
              editorLanguage: editorLanguageOf(capabilities),
              // A contract registry row, looked up by the type the connection was opened with.
              commitKeyword: executionUiFor(record.connection.type).commitKeyword,
            },
          };
        }),
      );
    },

    async closeConnection(params) {
      const connectionId = connectionIdOf(params);
      return await inTurn(connectionId, async () => {
        registry.delete(connectionId);
        await factory.removeProvider(connectionId);
        return null;
      });
    },

    async listContainers(params) {
      const connectionId = connectionIdOf(params);
      const parent = fieldOf(params, "parent");
      const path = parent === undefined ? undefined : stringArray(parent, "parent");
      const record = openRecord(connectionId);
      return await answeringFor(record.connection, async () => (await providerOf(record)).listContainers(path));
    },

    async countObjects(params) {
      const connectionId = connectionIdOf(params);
      const container = stringArray(fieldOf(params, "container"), "container");
      const record = openRecord(connectionId);
      // The counts' `unavailable` and `sampledFrom` sentences are the provider's own words, answered through the
      // connection's scrub as the object routes answer them.
      return await answeringFor(record.connection, async () =>
        scrubKindCounts(
          providerTextScrub(record.connection, "any"),
          await (await providerOf(record)).countObjects(container),
        ),
      );
    },

    async listObjects(params) {
      const connectionId = connectionIdOf(params);
      const container = stringArray(fieldOf(params, "container"), "container");
      const kind = aString(fieldOf(params, "kind"), "kind");
      const record = openRecord(connectionId);
      return await answeringFor(record.connection, async () => (await providerOf(record)).listObjects(container, kind));
    },

    async describeObject(params) {
      const connectionId = connectionIdOf(params);
      const path = stringArray(fieldOf(params, "path"), "path");
      const kind = aString(fieldOf(params, "kind"), "kind");
      const record = openRecord(connectionId);
      // The description's `indexes.unavailable` sentence is the provider's own words, answered through the
      // connection's scrub as the object routes answer it.
      return await answeringFor(record.connection, async () =>
        scrubObjectDetail(
          providerTextScrub(record.connection, "any"),
          await (await providerOf(record)).describeObject(path, kind),
        ),
      );
    },

    // The steps of POST /api/db/query for one statement, in its order (part 1, "What query/run re-does from the query
    // route"), through the same functions.
    async runQuery(params, token) {
      const connectionId = connectionIdOf(params);
      const queryId = nonEmptyString(fieldOf(params, "queryId"), "queryId");
      const statement = aString(fieldOf(params, "statement"), "statement");
      const catalog = catalogOf(params);
      const bounds = { limit: fieldOf(params, "limit"), offset: fieldOf(params, "offset") };
      // Its sentence names options.limit as the route's body does, so both channels word it once.
      const boundsError = pageOptionError(bounds);
      if (boundsError !== null) throw invalidParams(boundsError);
      // pageOptionError held each bound to a non-negative safe integer when present.
      const options = bounds as QueryPrepareOptions;

      const record = openRecord(connectionId);
      // The bounds and the statement were read above, so what refuses here is the connection's statement timeout,
      // invalid params, or a console text bound, which the route answers 413 with no code.
      const refused = checkEditorQuery({
        statement,
        type: record.connection.type,
        options,
        queryTimeout: record.connection.queryTimeout,
      });
      if (refused !== null) {
        throw refused.status === 413 ? refusal(413, "TEXT_TOO_LARGE", refused.error) : invalidParams(refused.error);
      }
      // The server's run gate, after the fields, the bounds and the text bound and before any provider, as the route
      // orders it: a request it answers builds no provider and runs nothing. A page read is classified like any run.
      const gate = await gateRun(gateRequest(record, catalog, statement, fieldOf(params, "confirmation")));
      if (gate.kind === "answer") throw gateAnswerError(gate.status, gate.body);

      // A cancelled request is the caller going away, as a dropped browser request is the route's.
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try {
        return await answeringFor(record.connection, async () => {
          const provider = await scopeToCatalog(
            await openWithinCall(controller.signal, record.connection.type, (wait) => providerWithin(record, wait)),
            catalog,
          );
          const { body, resultSetCount } = await runEditorQuery(provider, {
            statement,
            options,
            queryId,
            signal: controller.signal,
            route: RUN_ROUTE,
            scrub: providerTextScrub(record.connection, "any"),
          });
          return {
            ...body,
            ...(resultSetCount > 1 && { resultSetCount }),
            ...(gate.unconfirmed && { confirmation: "unconfirmed" as const }),
          };
        });
      } finally {
        listener.dispose();
      }
    },

    // As POST /api/db/cancel: the whole connection's provider, which finds a statement in whichever session runs it.
    async cancelQuery(params, token) {
      const connectionId = connectionIdOf(params);
      const queryId = nonEmptyString(fieldOf(params, "queryId"), "queryId");
      const record = openRecord(connectionId);
      // The request's cancellation is the caller going away, as a dropped browser request is the cancel route's: it
      // ends the wait for the provider's open and for the engine's answer, and a token already cancelled calls nothing.
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      try {
        return await answeringFor(record.connection, async () => {
          const provider = await openWithinCall(controller.signal, record.connection.type, (wait) =>
            providerWithin(record, wait),
          );
          // Through the provider host core's cancel call, bounded by its cleanup deadline and the request's signal.
          const answer = await cancelEditorRun(provider, queryId, controller.signal, CANCEL_ROUTE);
          if (!answer.offered) {
            throw refusal(400, "CANCEL_UNSUPPORTED", "Query cancellation is not supported for this database type");
          }
          return { cancelled: answer.cancelled };
        });
      } finally {
        listener.dispose();
      }
    },

    // The dispatcher refuses every request from here on; this closes every pool the factory holds.
    async shutdown() {
      await factory.clearProviderCache();
      return null;
    },

    // No provider: the same list the factory's refusal parses keeps a type out of the catalogue.
    listEngines(params) {
      if (!isEmptyObject(params)) throw invalidParams("engines/list takes an empty params object");
      return engineCatalog(factory.enabledProviderTypes());
    },

    // No provider and no line: the text is a credential.
    parsePastedConnection(params) {
      const parsed = parseConnectionString(aString(fieldOf(params, "text"), "text"));
      return { parsed, label: parsed === null ? null : CONNECTION_FORM[parsed.type].label };
    },

    // What the web's tree click writes (handleTableClick), with the columns read only where the engine declares a
    // projection for a kind that has them (part 3, "Backend additions" 1).
    async selectStatement(params) {
      const connectionId = connectionIdOf(params);
      const object = databaseObjectOf(fieldOf(params, "object"));
      const record = openRecord(connectionId);
      return await answeringFor(record.connection, async () => {
        const provider = await providerOf(record);
        const capabilities = provider.getCapabilities();
        let columns: readonly ColumnSchema[] | undefined;
        if (capabilities.previewProjection !== undefined && kindHasColumns(findKind(capabilities, object.kind))) {
          columns = (await provider.describeObject(object.path, object.kind)).columns;
        }
        try {
          return {
            statement: generateTableQuery(object.path, provider.type, capabilities, columns, {
              readRanges: object.readRanges,
            }),
          };
        } catch (error) {
          throw refusal(500, "INTERNAL_ERROR", (error as Error).message);
        }
      });
    },

    // The web editor's run target rule on the offsets the host's editor reports, through runnableTarget: a target with
    // no code under the sql editor language answers "", so the host's one blank check says "Nothing to run." (builder's
    // call 4). The target also carries the server's run gate's verdict on it, asked with "ask" on the catalog the run
    // will reach: null where the gate does not ask, else the 428's offer with a token query/run accepts once.
    async runTarget(params) {
      const connectionId = connectionIdOf(params);
      const text = aString(fieldOf(params, "text"), "text");
      const selectionField = fieldOf(params, "selection");
      if (!isObject(selectionField)) throw invalidParams("selection must be an object");
      const selection = {
        start: anInteger(selectionField.start, "selection.start"),
        end: anInteger(selectionField.end, "selection.end"),
      };
      const cursor = anInteger(fieldOf(params, "cursor"), "cursor");
      const catalog = catalogOf(params);
      const record = openRecord(connectionId);
      const capabilities = await answeringFor(record.connection, async () =>
        (await providerOf(record)).getCapabilities(),
      );
      const rule = {
        editorLanguage: editorLanguageOf(capabilities),
        statementTerminator: capabilities.statementTerminator,
        grammar: resolveSqlGrammar(record.connection.type),
      };
      let target: RunTarget;
      try {
        target = runnableTarget({ text, selection, cursor, ...rule });
      } catch (error) {
        // Offsets the rule cannot honour are the caller's params (the PR 10 ruling); anything else is an error answer.
        throw error instanceof RangeError ? invalidParams(error.message) : error;
      }
      // Nothing to run asks nothing.
      if (rule.editorLanguage === "sql" && target.statement === "") return { statement: "", confirmation: null };
      const gate = await gateRun(gateRequest(record, catalog, target.statement, "ask"));
      if (gate.kind === "run") return { ...target, confirmation: null };
      // Asked with "ask", the gate answers a 428 with its offer or a refusal, which is this request's answer.
      if (gate.status !== 428 || gate.body.confirmation === undefined) throw gateAnswerError(gate.status, gate.body);
      return { ...target, confirmation: gate.body.confirmation };
    },
  };
}

/**
 * Part 1 "Error classification": a ResponseError passes through; a database error answers P3's status, sentence and
 * code, with its error kind and outcome as the route body carries them; anything else is 500 INTERNAL_ERROR. With the
 * connection's `scrub`, an error whose text holds a credential of the connection answers the same status and data
 * with only its texts replaced (`withWithheldText`), as the routes answer it, and a database error's data also carries
 * the `sqlState` of its error record (`errorRecord`), which the record holds only when the text was not withheld.
 * Without a scrub no data carries one, as a route's body before its connection resolves.
 */
export function toResponseError(error: unknown, scrub?: ProviderTextScrub): ResponseError<BackendErrorData | void> {
  if (error instanceof ResponseError) return error;
  const body = databaseErrorBody(error)?.body ?? internalErrorBody(error);
  const withheld = scrub === undefined ? null : withheldProviderError(scrub, error);
  const {
    statusCode,
    error: message,
    code,
    retryable,
    details,
    fixStatement,
    kind,
    outcome,
  } = withheld === null ? body : withWithheldText(body, withheld.message);
  const sqlState = scrub === undefined ? undefined : errorRecord(scrub, error).sqlState;
  return new ResponseError<BackendErrorData>(statusCode, message, {
    // Both bodies always carry a code; the type leaves it optional for the routes' other answers.
    code: code as BackendErrorCode,
    ...(retryable !== undefined && { retryable }),
    ...(details !== undefined && { details }),
    ...(fixStatement !== undefined && { fixStatement }),
    ...(kind !== undefined && { kind }),
    ...(outcome !== undefined && { outcome }),
    ...(sqlState !== undefined && { sqlState }),
  });
}

/** Registers one request handler per METHODS entry and the exit notification on a connection of any transport. */
export function registerHandlers(
  connection: MessageConnection,
  handlers: BackendHandlers,
  exit: (code: number) => void,
): void {
  let initialized = false;
  let shuttingDown = false;
  for (const [name, method] of Object.entries(METHODS) as [keyof BackendHandlers, string][]) {
    // Every handler takes the params and the token, and shutdown reads neither.
    const handler = handlers[name] as (params: unknown, token: CancellationToken) => unknown;
    // vscode-jsonrpc passes the params when the request carries any, then the request's token.
    connection.onRequest(method, async (...args: unknown[]) => {
      const token = args.at(-1) as CancellationToken;
      const params = args.length > 1 ? args[0] : undefined;
      try {
        if (shuttingDown) throw refusal(503, "SHUTTING_DOWN", "The LibreDB backend is shutting down.");
        if (!initialized && name !== "initialize") {
          throw new ResponseError(ErrorCodes.ServerNotInitialized, "The LibreDB backend has not been initialized.");
        }
        if (name === "shutdown") shuttingDown = true;
        const answer = await handler.call(handlers, params, token);
        // A value JSON cannot carry fails here, as this request's answer, rather than inside the transport's writer.
        JSON.stringify(answer);
        if (name === "initialize") initialized = true;
        return answer;
      } catch (error) {
        throw toResponseError(error);
      }
    });
  }
  connection.onNotification(EXIT_NOTIFICATION, () => {
    exit(0);
  });
}
