// The messages between the extension host and the Results webview, and the two guards each side parses with.
// Both bundles import this module, so it imports neither vscode nor the DOM, and nothing but types besides its own code.
//
// The guard rules, where part 4 leaves the bound to the builder:
// - A message is a plain object whose v is exactly RESULTS_PROTOCOL_VERSION, checked before its type, so a message of
//   another version is refused as v whatever its type.
// - Top-level keys are exact both ways: a key the shape does not name is refused. On WebviewToHost that is trust rule 1:
//   no statement, connection id, queryId, catalog, limit, offset or path can ride along.
// - runId is a lowercase UUID, as crypto.randomUUID() mints it; requestId is a non-negative safe integer.
// - copy.text is at most RESULTS_LIMITS.copyTextChars characters, notify.message is non-empty and at most notifyChars,
//   reportError.message at most reportErrorChars (trust rule 4).
// - A page is checked on the keys the grid reads and every other key passes through, as appendResultPage spreads them:
//   the page is the query route's body, which may carry a key QueryResult does not name. No size bound applies to a
//   page, so a 10 MB cell arrives.
// - grid.databaseType is a non-empty string of at most 64 characters: the guard cannot list the DatabaseType union
//   without importing a value, and the grid only passes it through. grid.commitKeyword is non-empty, at most 32.
// - Each failure kind is held to its own keys.
// A refusal throws ResultsProtocolError naming the dotted path of the first field that failed.
import type { ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import type { QueryPage } from "./protocol";

export const RESULTS_PROTOCOL_VERSION = 1;

/** The guards' bounds on what the webview may send (trust rule 4). */
export const RESULTS_LIMITS = {
  copyTextChars: 16 * 1024 * 1024,
  notifyChars: 1_000,
  reportErrorChars: 10_000,
} as const;

export type ThemeKind = "light" | "dark" | "highContrast" | "highContrastLight";

/** What the grid needs from the connection that produced the rows, read from its open ProviderDescription. */
export interface GridContext {
  databaseType: DatabaseType;
  /** capabilities.supportsResultPagination === true */
  supportsResultPagination: boolean;
  maskingExemptColumns?: ProviderCapabilities["maskingExemptColumns"];
  /** ProviderDescription.commitKeyword (a protocol addition, made by Part H). */
  commitKeyword: string;
}

export type RunFailure =
  | { kind: "error"; message: string; detail?: string; fixStatement?: string }
  | { kind: "cancelled" }
  | { kind: "backendExited"; exitCode: number | null; signal: string | null };

export type HostToWebview =
  | { v: 1; type: "init"; theme: ThemeKind }
  | { v: 1; type: "theme"; theme: ThemeKind }
  | { v: 1; type: "clear" }
  | { v: 1; type: "runStarted"; runId: string; statement: string; startedAt: number }
  | { v: 1; type: "runSucceeded"; runId: string; page: QueryPage; grid: GridContext }
  | { v: 1; type: "runFailed"; runId: string; failure: RunFailure }
  | { v: 1; type: "pageStarted"; runId: string }
  | { v: 1; type: "pageAppended"; runId: string; page: QueryPage }
  | { v: 1; type: "pageFailed"; runId: string; failure: RunFailure }
  | { v: 1; type: "copied"; requestId: number; ok: boolean };

export type WebviewToHost =
  | { v: 1; type: "ready" }
  | { v: 1; type: "loadMore"; runId: string }
  | { v: 1; type: "copy"; requestId: number; text: string }
  | { v: 1; type: "notify"; level: "info" | "error"; message: string }
  | { v: 1; type: "reportError"; message: string };

/** What the webview keeps through getState and setState; rows never enter it. */
export interface ResultsViewState {
  v: 1;
  maskingEnabled: boolean;
  scroll: { runId: string; top: number; left: number } | null;
}

export const INITIAL_VIEW_STATE: ResultsViewState = Object.freeze({ v: 1, maskingEnabled: false, scroll: null });

/** A refused message: `field` is the dotted path of the first field that failed ("type", "page.pagination.hasMore"). */
export class ResultsProtocolError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`);
    this.name = "ResultsProtocolError";
    this.field = field;
  }
}

type Obj = Record<string, unknown>;

const THEMES: readonly ThemeKind[] = ["light", "dark", "highContrast", "highContrastLight"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key);

function isPlainObject(raw: unknown): raw is Obj {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const proto = Object.getPrototypeOf(raw);
  return proto === Object.prototype || proto === null;
}

function object(raw: unknown, field: string): Obj {
  if (!isPlainObject(raw)) throw new ResultsProtocolError(field, "expected an object");
  return raw;
}

function array(raw: unknown, field: string): unknown[] {
  if (!Array.isArray(raw)) throw new ResultsProtocolError(field, "expected an array");
  return raw;
}

/** Refuses the first own key of `obj` that `allowed` does not name. */
function exactKeys(obj: Obj, allowed: readonly string[], type: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ResultsProtocolError(join(path, key), `not a field of ${type}`);
  }
}

function present(obj: Obj, key: string, path: string): unknown {
  if (!Object.hasOwn(obj, key)) throw new ResultsProtocolError(join(path, key), "missing");
  return obj[key];
}

function string(obj: Obj, key: string, path: string, bounds: { max?: number; nonEmpty?: boolean } = {}): string {
  const value = present(obj, key, path);
  if (typeof value !== "string") throw new ResultsProtocolError(join(path, key), "expected a string");
  if (bounds.nonEmpty && value.length === 0)
    throw new ResultsProtocolError(join(path, key), "expected a non-empty string");
  if (bounds.max !== undefined && value.length > bounds.max) {
    throw new ResultsProtocolError(join(path, key), `longer than ${bounds.max} characters`);
  }
  return value;
}

function boolean(obj: Obj, key: string, path: string): boolean {
  const value = present(obj, key, path);
  if (typeof value !== "boolean") throw new ResultsProtocolError(join(path, key), "expected a boolean");
  return value;
}

function number(obj: Obj, key: string, path: string, min = Number.NEGATIVE_INFINITY): number {
  const value = present(obj, key, path);
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new ResultsProtocolError(join(path, key), "expected a number");
  if (value < min) throw new ResultsProtocolError(join(path, key), "expected a non-negative number");
  return value;
}

/** A safe integer of at least `min`. */
function integer(obj: Obj, key: string, path: string, min = 0): number {
  const value = present(obj, key, path);
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new ResultsProtocolError(
      join(path, key),
      min === 0 ? "expected a non-negative integer" : `expected an integer of at least ${min}`,
    );
  }
  return value as number;
}

function uuid(obj: Obj, key: string, path: string): string {
  const value = present(obj, key, path);
  if (typeof value !== "string" || !UUID.test(value))
    throw new ResultsProtocolError(join(path, key), "expected a UUID");
  return value;
}

function oneOf<T extends string>(obj: Obj, key: string, path: string, values: readonly T[]): T {
  const value = present(obj, key, path);
  if (!values.includes(value as T))
    throw new ResultsProtocolError(join(path, key), `expected one of ${values.join(", ")}`);
  return value as T;
}

/** Runs `check` only when `obj` has `key`. */
function optional(obj: Obj, key: string, check: () => unknown): void {
  if (Object.hasOwn(obj, key)) check();
}

function checkPage(raw: unknown, path: string): void {
  const page = object(raw, path);
  array(present(page, "rows", path), join(path, "rows")).forEach((row, i) => {
    object(row, join(path, `rows.${i}`));
  });
  array(present(page, "fields", path), join(path, "fields")).forEach((field, i) => {
    if (typeof field !== "string") throw new ResultsProtocolError(join(path, `fields.${i}`), "expected a string");
  });
  number(page, "rowCount", path);
  number(page, "executionTime", path);
  const paginationPath = join(path, "pagination");
  const pagination = object(present(page, "pagination", path), paginationPath);
  for (const key of ["limit", "offset", "totalReturned"]) integer(pagination, key, paginationPath);
  for (const key of ["hasMore", "wasLimited"]) boolean(pagination, key, paginationPath);
  optional(page, "warnings", () => {
    array(page.warnings, join(path, "warnings")).forEach((raw, i) => {
      const itemPath = join(path, `warnings.${i}`);
      const warning = object(raw, itemPath);
      string(warning, "message", itemPath);
      optional(warning, "code", () => {
        if (typeof warning.code !== "string" && typeof warning.code !== "number") {
          throw new ResultsProtocolError(join(itemPath, "code"), "expected a string or a number");
        }
      });
      optional(warning, "severity", () => string(warning, "severity", itemPath));
    });
  });
  optional(page, "columnTypes", () => {
    const typesPath = join(path, "columnTypes");
    const types = object(page.columnTypes, typesPath);
    for (const key of Object.keys(types)) string(types, key, typesPath);
  });
  optional(page, "vectorColumns", () => object(page.vectorColumns, join(path, "vectorColumns")));
  optional(page, "rolledBack", () => boolean(page, "rolledBack", path));
  optional(page, "openTransaction", () => {
    if (page.openTransaction !== "rolled-back") {
      throw new ResultsProtocolError(join(path, "openTransaction"), 'expected "rolled-back"');
    }
  });
  optional(page, "resultSetCount", () => integer(page, "resultSetCount", path, 2));
}

function checkGrid(raw: unknown): void {
  const grid = object(raw, "grid");
  exactKeys(
    grid,
    ["databaseType", "supportsResultPagination", "maskingExemptColumns", "commitKeyword"],
    "grid",
    "grid",
  );
  string(grid, "databaseType", "grid", { nonEmpty: true, max: 64 });
  boolean(grid, "supportsResultPagination", "grid");
  string(grid, "commitKeyword", "grid", { nonEmpty: true, max: 32 });
  optional(grid, "maskingExemptColumns", () => {
    const path = "grid.maskingExemptColumns";
    const exempt = object(grid.maskingExemptColumns, path);
    exactKeys(exempt, ["column", "reason"], "maskingExemptColumns", path);
    string(exempt, "column", path);
    string(exempt, "reason", path);
  });
}

const FAILURE_KEYS: Record<RunFailure["kind"], readonly string[]> = {
  error: ["kind", "message", "detail", "fixStatement"],
  cancelled: ["kind"],
  backendExited: ["kind", "exitCode", "signal"],
};

function checkFailure(raw: unknown): void {
  const failure = object(raw, "failure");
  const kind = oneOf(failure, "kind", "failure", Object.keys(FAILURE_KEYS) as RunFailure["kind"][]);
  exactKeys(failure, FAILURE_KEYS[kind], kind, "failure");
  if (kind === "error") {
    string(failure, "message", "failure");
    optional(failure, "detail", () => string(failure, "detail", "failure"));
    optional(failure, "fixStatement", () => string(failure, "fixStatement", "failure"));
  } else if (kind === "backendExited") {
    const exitCode = present(failure, "exitCode", "failure");
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) {
      throw new ResultsProtocolError("failure.exitCode", "expected an integer or null");
    }
    const signal = present(failure, "signal", "failure");
    if (signal !== null && typeof signal !== "string") {
      throw new ResultsProtocolError("failure.signal", "expected a string or null");
    }
  }
}

/** One guard per message type: the keys it allows besides v and type, and the checks on them. */
interface Shape {
  keys: readonly string[];
  check(message: Obj): void;
}

const HOST_SHAPES: Record<HostToWebview["type"], Shape> = {
  init: { keys: ["theme"], check: (m) => oneOf(m, "theme", "", THEMES) },
  theme: { keys: ["theme"], check: (m) => oneOf(m, "theme", "", THEMES) },
  clear: { keys: [], check: () => undefined },
  runStarted: {
    keys: ["runId", "statement", "startedAt"],
    check: (m) => {
      uuid(m, "runId", "");
      string(m, "statement", "");
      number(m, "startedAt", "");
    },
  },
  runSucceeded: {
    keys: ["runId", "page", "grid"],
    check: (m) => {
      uuid(m, "runId", "");
      checkPage(present(m, "page", ""), "page");
      checkGrid(present(m, "grid", ""));
    },
  },
  runFailed: {
    keys: ["runId", "failure"],
    check: (m) => {
      uuid(m, "runId", "");
      checkFailure(present(m, "failure", ""));
    },
  },
  pageStarted: { keys: ["runId"], check: (m) => uuid(m, "runId", "") },
  pageAppended: {
    keys: ["runId", "page"],
    check: (m) => {
      uuid(m, "runId", "");
      checkPage(present(m, "page", ""), "page");
    },
  },
  pageFailed: {
    keys: ["runId", "failure"],
    check: (m) => {
      uuid(m, "runId", "");
      checkFailure(present(m, "failure", ""));
    },
  },
  copied: {
    keys: ["requestId", "ok"],
    check: (m) => {
      integer(m, "requestId", "");
      boolean(m, "ok", "");
    },
  },
};

const WEBVIEW_SHAPES: Record<WebviewToHost["type"], Shape> = {
  ready: { keys: [], check: () => undefined },
  loadMore: { keys: ["runId"], check: (m) => uuid(m, "runId", "") },
  copy: {
    keys: ["requestId", "text"],
    check: (m) => {
      integer(m, "requestId", "");
      string(m, "text", "", { max: RESULTS_LIMITS.copyTextChars });
    },
  },
  notify: {
    keys: ["level", "message"],
    check: (m) => {
      oneOf(m, "level", "", ["info", "error"]);
      string(m, "message", "", { nonEmpty: true, max: RESULTS_LIMITS.notifyChars });
    },
  },
  reportError: {
    keys: ["message"],
    check: (m) => string(m, "message", "", { max: RESULTS_LIMITS.reportErrorChars }),
  },
};

function parse(raw: unknown, shapes: Record<string, Shape>): Obj {
  const message = object(raw, "$");
  if (message.v !== RESULTS_PROTOCOL_VERSION) throw new ResultsProtocolError("v", "expected 1");
  const type = present(message, "type", "");
  const shape = typeof type === "string" && Object.hasOwn(shapes, type) ? shapes[type] : undefined;
  if (!shape) throw new ResultsProtocolError("type", `unknown message type ${String(type)}`);
  exactKeys(message, ["v", "type", ...shape.keys], type as string, "");
  shape.check(message);
  return message;
}

/** The webview's guard on what the host posts. */
export function parseHostMessage(raw: unknown): HostToWebview {
  return parse(raw, HOST_SHAPES) as unknown as HostToWebview;
}

/** The host's guard on what the webview posts. */
export function parseWebviewMessage(raw: unknown): WebviewToHost {
  return parse(raw, WEBVIEW_SHAPES) as unknown as WebviewToHost;
}

/** undefined (no saved state) gives INITIAL_VIEW_STATE; anything else is held to the shape or throws. */
export function parseViewState(raw: unknown): ResultsViewState {
  if (raw === undefined) return INITIAL_VIEW_STATE;
  const state = object(raw, "$");
  if (state.v !== RESULTS_PROTOCOL_VERSION) throw new ResultsProtocolError("v", "expected 1");
  exactKeys(state, ["v", "maskingEnabled", "scroll"], "the view state", "");
  boolean(state, "maskingEnabled", "");
  const scroll = present(state, "scroll", "");
  if (scroll !== null) {
    const saved = object(scroll, "scroll");
    exactKeys(saved, ["runId", "top", "left"], "scroll", "scroll");
    uuid(saved, "runId", "scroll");
    number(saved, "top", "scroll", 0);
    number(saved, "left", "scroll", 0);
  }
  return state as unknown as ResultsViewState;
}
