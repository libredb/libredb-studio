/**
 * @file The server's confirmation gate on a run (FND-5).
 *
 * `POST /api/db/query`, `POST /api/db/multi-query` and `POST /api/db/transaction` (its `query` action) call `gateRun`
 * after their own field checks and before the admission gate and any provider, and so does the VS Code extension's
 * backend child on every `query/run` (route `vscode/query/run`, docs/VSCODE_EXTENSION.md), each handing it the server
 * catalog's record of the connection's engine. It classifies the submitted statement with the reader that record
 * offers: for an engine whose record offers Studio's statement vocabulary rows (`EngineOffers.statementVocabulary`),
 * `confirmationVerdict`, the reading the web editor's dialog and `POST /api/db/statement/analyze` take; for any other
 * engine, `packageConfirmationVerdict`, the statement read under the grammar the record holds
 * (`EngineRecord.statementGrammar`, the one a package's declaration states) with the claims that loosen the gate the
 * record grants (`EngineRecord.grants`), every statement asked where no register row reviewed that grammar
 * (docs/providers/CONTRACT.md, clause S-8). It then decides what the request gets, by the request's
 * `confirmation` field and the mode (`LIBREDB_RUN_CONFIRMATION`):
 *
 * | Mode | `confirmation` | Verdict run | Verdict confirm | Verdict refuse |
 * |---|---|---|---|---|
 * | advisory | absent, off production | runs | runs, marked unconfirmed, one warning | runs, marked unconfirmed, one warning |
 * | advisory | absent, on production | runs | 428 with a token | 400 with the refusal |
 * | advisory | `"ask"` | runs | 428 with a token | 400 with the refusal |
 * | required | absent or `"ask"` | runs | 428 with a token | 400 with the refusal |
 * | either | `{ "token" }` | the token is verified, then runs | typed asked: 428 with a new token; else the token is verified, then runs | 400 with the refusal |
 * | either | `{ "token", "typed" }` | 400, nothing typed is asked | typed asked and equal: the token is verified, then runs; else 400 | 400 with the refusal |
 *
 * The mode decides who is refused, never what the verdict says. The verdict reads the connection's environment: on
 * `production` every statement it asks about asks for the connection's name to be typed (FND-5 slice 6c), and advisory
 * mode spares no request there: leaving the field out is a client skip, so it is answered as `"ask"` is. The typed
 * value is compared exactly, before the token is verified, so a typed refusal never spends a token; the token binds
 * the expected value through its verdict digest. A verified token that does not confirm the request is refused with
 * the sentence that says why. An explain request is not classified: the route
 * builds the EXPLAIN only for a statement its strategy accepts and never runs the caller's statement (#201).
 *
 * A reader that throws is the gate asking: the verdict is `confirm` with `classificationFailed`, asking for the
 * connection's name on a production connection (refused where it has none), and one error line names the route, the
 * connection type and the error's name, never the statement. A record that offers the vocabulary rows and no legacy
 * provider is a host defect, raised before any reading (`legacyConnection`), never read as a classification failure.
 * The token binds the connection by its fields, whichever reader read the statement.
 */
import { ApiErrorCode } from "@/lib/api/error-codes";
import {
  mintRunConfirmation,
  type RunConfirmationBinding,
  type RunConfirmationIssuer,
  type RunConfirmationRoute,
  type RunVerdict,
  verifyRunConfirmation,
} from "@/lib/api/run-confirmation-token";
import { runConfirmationMode } from "@/lib/config/run-confirmation";
import { type EngineConnection, type EngineRecord, legacyConnection } from "@/lib/db/server-catalog";
import {
  type ConfirmationVerdict,
  confirmationVerdict,
  escalatedAsk,
  packageConfirmationVerdict,
  resolvedTypedConfirmation,
  TYPED_NAME_MISSING_REFUSAL,
} from "@/lib/editor/statement-analysis";
import { logger } from "@/lib/logger";
import type { TypedConfirmation } from "@/lib/editor/statement-analysis";

/** The refusal of a `confirmation` field of any other shape, before anything is classified. */
export const CONFIRMATION_FIELD_MESSAGE = 'confirmation must be "ask" or { "token": string, "typed"?: string }';

/** The refusal of a typed value sent for a statement whose verdict asks nothing typed. */
const TYPED_NOT_ASKED = "this statement asks for no typed confirmation";

/** The refusal of a typed value other than the one the verdict expects, compared exactly. */
const TYPED_MISMATCH = "the typed confirmation does not match what this statement asks to be typed";

/** The 428's sentence. */
export const CONFIRMATION_REQUIRED_MESSAGE =
  "This statement needs a confirmation before it runs: send the same request again with the confirmation token in this answer.";

/** The 428's sentence where the person also types a value. */
export const CONFIRMATION_TYPED_MESSAGE =
  "This statement needs a typed confirmation before it runs: send the same request again with the confirmation token in this answer and, as typed, the value its typedConfirmation expects.";

/** The label each route's log lines name, so a line says which surface ran the statement. */
const ROUTE_LOG_LABELS: Readonly<Record<RunConfirmationRoute, string>> = {
  query: "api/db/query",
  "multi-query": "api/db/multi-query",
  transaction: "api/db/transaction",
  "vscode/query/run": "vscode/query/run",
};

/** The `confirmation` object of a 428 answer: the token to send back and what the gate asks. */
export interface RunConfirmationOffer {
  readonly token: string;
  /** When the token expires, as an ISO time. */
  readonly expiresAt: string;
  readonly unreadable: boolean;
  readonly typedConfirmation: TypedConfirmation | null;
  readonly classificationFailed: boolean;
}

/** The body of a gate answer: the sentence, the code where it has one, and the 428's offer. */
export interface RunGateAnswerBody {
  readonly error: string;
  readonly code?: ApiErrorCode;
  readonly confirmation?: RunConfirmationOffer;
}

export interface RunGateRequest {
  readonly route: RunConfirmationRoute;
  /** Who mints and checks the token: the route's signed-in session, or the VS Code backend child's own process. */
  readonly issuer: RunConfirmationIssuer;
  /** The connection the request resolved, after any override the route applies to it. */
  readonly connection: EngineConnection;
  /** The server catalog's record of the connection's engine, whose offers say which reader reads the statement. */
  readonly engine: EngineRecord;
  /** The request's catalog (`requestCatalog`). */
  readonly catalog: string | undefined;
  /** The submitted statement, never a statement the route builds from it. */
  readonly sql: string;
  /** The bound values the route hands the driver. */
  readonly params: readonly unknown[] | undefined;
  /** The request body's `confirmation` field, as sent. */
  readonly confirmation: unknown;
  /** Whether the request asks for a plan rather than a run. */
  readonly explain: boolean;
}

/**
 * What the route does: run the statement, saying in its answer that it ran unconfirmed where `unconfirmed`, or answer
 * `body` with `status` and run nothing.
 */
export type RunGateDecision =
  | { readonly kind: "run"; readonly unconfirmed: boolean }
  | { readonly kind: "answer"; readonly status: number; readonly body: RunGateAnswerBody };

type ConfirmationField =
  | { readonly kind: "absent" }
  | { readonly kind: "ask" }
  | { readonly kind: "token"; readonly token: string; readonly typed: string | undefined };

/** The field's shape, or null for any other value. */
function readConfirmationField(value: unknown): ConfirmationField | null {
  if (value === undefined) return { kind: "absent" };
  if (value === "ask") return { kind: "ask" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { token, typed } = value as { token?: unknown; typed?: unknown };
  if (Object.keys(value).some((key) => key !== "token" && key !== "typed")) return null;
  if (typeof token !== "string" || token === "") return null;
  if ("typed" in value && typeof typed !== "string") return null;
  return { kind: "token", token, typed: typed as string | undefined };
}

/** What the gate reads: the request, and the reader of its verdict the record offers. */
interface GateRequest extends RunGateRequest {
  readonly verdict: () => ConfirmationVerdict;
}

/** The verdict, with a reader that throws read as the gate asking. */
function classify(request: GateRequest): RunVerdict | { readonly decision: "refuse"; readonly refusal: string } {
  try {
    const verdict = request.verdict();
    return verdict.decision === "confirm" ? { ...verdict, classificationFailed: false } : verdict;
  } catch (error) {
    logger.error("The confirmation gate could not read a statement, so it asks for a confirmation", undefined, {
      route: ROUTE_LOG_LABELS[request.route],
      type: request.connection.type,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    // Nothing was read, so no row asks anything typed; on a production connection the name is still asked.
    const typedConfirmation = resolvedTypedConfirmation(
      escalatedAsk(undefined, request.connection.environment),
      request.connection.name,
    );
    if (typedConfirmation === undefined) return { decision: "refuse", refusal: TYPED_NAME_MISSING_REFUSAL };
    return { decision: "confirm", unreadable: false, typedConfirmation, classificationFailed: true };
  }
}

/**
 * Decides what a run request gets, its statement read by the reader its engine's record offers; throws the mode's
 * `DatabaseConfigError` when the setting cannot be read.
 *
 * @throws {Error} A host defect: when the record offers Studio's statement vocabulary rows and no legacy provider.
 */
export async function gateRun(request: RunGateRequest, clock: () => number = Date.now): Promise<RunGateDecision> {
  const { engine, connection, sql } = request;
  const { name, environment } = connection;
  let verdict: () => ConfirmationVerdict;
  if (engine.offers.statementVocabulary) {
    // Read before the gate, outside the reader: a record that disagrees with itself is raised, not asked about.
    const { type } = legacyConnection(engine, connection);
    verdict = () => confirmationVerdict(sql, type, name, environment);
  } else {
    verdict = () => packageConfirmationVerdict(sql, engine.statementGrammar, engine.grants, name, environment);
  }
  return gate({ ...request, verdict }, clock);
}

/** The gate: what `request` gets, by its field, the mode and its verdict. */
async function gate(request: GateRequest, clock: () => number): Promise<RunGateDecision> {
  const field = readConfirmationField(request.confirmation);
  if (field === null) return { kind: "answer", status: 400, body: { error: CONFIRMATION_FIELD_MESSAGE } };
  const mode = runConfirmationMode();
  if (request.explain) return { kind: "run", unconfirmed: false };

  const verdict = classify(request);
  // Advisory mode spares a caller that sent no field, except on a production connection, where nothing skips the ask.
  const spared = mode === "advisory" && field.kind === "absent" && request.connection.environment !== "production";

  if (verdict.decision === "refuse") {
    if (spared) return ranUnconfirmed(request);
    return { kind: "answer", status: 400, body: { error: verdict.refusal } };
  }

  const binding: RunConfirmationBinding = {
    issuer: request.issuer,
    connection: request.connection,
    catalog: request.catalog,
    route: request.route,
    statement: request.sql,
    params: request.params,
    verdict,
  };
  const typedAsk = verdict.decision === "confirm" ? verdict.typedConfirmation : null;
  // The typed checks come before the token's verification, so a typed refusal never spends a token. The token's
  // verdict digest binds the expected value, so a token minted under another name or environment is refused below.
  if (field.kind === "token" && field.typed !== undefined) {
    if (typedAsk === null) return invalid(TYPED_NOT_ASKED);
    if (field.typed !== typedAsk.expected) return invalid(TYPED_MISMATCH);
  }
  // A token sent without the value its statement asks to be typed is not verified, so it is not spent: the request is
  // asked again below, with a fresh token.
  if (field.kind === "token" && (typedAsk === null || field.typed !== undefined)) {
    const check = await verifyRunConfirmation(field.token, binding, clock);
    if (!check.valid) return invalid(check.reason);
    return { kind: "run", unconfirmed: false };
  }

  if (verdict.decision === "run") return { kind: "run", unconfirmed: false };
  if (spared) return ranUnconfirmed(request);

  const { token, expiresAt } = await mintRunConfirmation(binding, clock);
  return {
    kind: "answer",
    status: 428,
    body: {
      error: typedAsk === null ? CONFIRMATION_REQUIRED_MESSAGE : CONFIRMATION_TYPED_MESSAGE,
      code: ApiErrorCode.CONFIRMATION_REQUIRED,
      confirmation: {
        token,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        unreadable: verdict.unreadable,
        typedConfirmation: verdict.typedConfirmation,
        classificationFailed: verdict.classificationFailed,
      },
    },
  };
}

/** A 400 that names why the confirmation does not confirm the request. */
function invalid(reason: string): RunGateDecision {
  return { kind: "answer", status: 400, body: { error: reason, code: ApiErrorCode.CONFIRMATION_INVALID } };
}

/** Advisory mode sparing a caller that did not ask: the statement runs, and the answer and one warning say so. */
function ranUnconfirmed(request: GateRequest): RunGateDecision {
  logger.warn("A statement that needs a confirmation ran without one", {
    route: ROUTE_LOG_LABELS[request.route],
    type: request.connection.type,
    user: request.issuer.user,
  });
  return { kind: "run", unconfirmed: true };
}
