/**
 * @file The server's confirmation gate on a run (FND-5, docs/API_DOCS.md "Server confirmation of a run").
 *
 * `POST /api/db/query`, `POST /api/db/multi-query` and `POST /api/db/transaction` (its `query` action) call `gateRun`
 * after their own field checks and before the admission gate and any provider. It classifies the submitted statement
 * with `confirmationVerdict`, the reading the web editor's dialog and `POST /api/db/statement/analyze` take, and
 * decides what the request gets, by the request's `confirmation` field and the mode (`LIBREDB_RUN_CONFIRMATION`):
 *
 * | Mode | `confirmation` | Verdict run | Verdict confirm | Verdict refuse |
 * |---|---|---|---|---|
 * | advisory | absent | runs | runs, marked unconfirmed, one warning | runs, marked unconfirmed, one warning |
 * | advisory | `"ask"` | runs | 428 with a token | 400 with the refusal |
 * | required | absent or `"ask"` | runs | 428 with a token | 400 with the refusal |
 * | either | `{ "token" }` | the token is verified, then runs | the token is verified, then runs | 400 with the refusal |
 *
 * The mode decides who is refused, never what the verdict says. A present token is always verified, and one that does
 * not confirm the request is refused with the sentence that says why. An explain request is not classified: the route
 * builds the EXPLAIN only for a statement its strategy accepts and never runs the caller's statement (#201).
 *
 * A reader that throws is the gate asking: the verdict is `confirm` with `classificationFailed`, and one error line
 * names the route, the connection type and the error's name, never the statement.
 */
import type { UserPayload } from "@/lib/auth";
import { ApiErrorCode } from "@/lib/api/error-codes";
import {
  mintRunConfirmation,
  type RunConfirmationBinding,
  type RunConfirmationRoute,
  type RunVerdict,
  verifyRunConfirmation,
} from "@/lib/api/run-confirmation-token";
import { runConfirmationMode } from "@/lib/config/run-confirmation";
import { confirmationVerdict } from "@/lib/editor/statement-analysis";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";

/** The refusal of a `confirmation` field of any other shape, before anything is classified. */
export const CONFIRMATION_FIELD_MESSAGE = 'confirmation must be "ask" or { "token": string }';

/** The 428's sentence. */
export const CONFIRMATION_REQUIRED_MESSAGE =
  "This statement needs a confirmation before it runs: send the same request again with the confirmation token in this answer.";

export interface RunGateRequest {
  readonly route: RunConfirmationRoute;
  /** The session the route's guard read. */
  readonly session: UserPayload & { readonly iat?: number };
  /** The connection the request resolved, after any override the route applies to it. */
  readonly connection: DatabaseConnection;
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
  | { readonly kind: "answer"; readonly status: number; readonly body: Record<string, unknown> };

type ConfirmationField = { readonly kind: "absent" } | { readonly kind: "ask" } | { readonly kind: "token"; readonly token: string };

/** The field's shape, or null for any other value. */
function readConfirmationField(value: unknown): ConfirmationField | null {
  if (value === undefined) return { kind: "absent" };
  if (value === "ask") return { kind: "ask" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const token = (value as { token?: unknown }).token;
  if (keys.length !== 1 || typeof token !== "string" || token === "") return null;
  return { kind: "token", token };
}

/** The verdict, with a reader that throws read as the gate asking. */
function classify(request: RunGateRequest): RunVerdict | { readonly decision: "refuse"; readonly refusal: string } {
  try {
    const verdict = confirmationVerdict(request.sql, request.connection.type, request.connection.name);
    return verdict.decision === "confirm" ? { ...verdict, classificationFailed: false } : verdict;
  } catch (error) {
    logger.error("The confirmation gate could not read a statement, so it asks for a confirmation", undefined, {
      route: `api/db/${request.route}`,
      type: request.connection.type,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { decision: "confirm", unreadable: false, typedConfirmation: null, classificationFailed: true };
  }
}

/** Decides what a run request gets; throws the mode's `DatabaseConfigError` when the setting cannot be read. */
export async function gateRun(request: RunGateRequest, clock: () => number = Date.now): Promise<RunGateDecision> {
  const field = readConfirmationField(request.confirmation);
  if (field === null) return { kind: "answer", status: 400, body: { error: CONFIRMATION_FIELD_MESSAGE } };
  const mode = runConfirmationMode();
  if (request.explain) return { kind: "run", unconfirmed: false };

  const verdict = classify(request);
  const spared = mode === "advisory" && field.kind === "absent";

  if (verdict.decision === "refuse") {
    if (spared) return ranUnconfirmed(request);
    return { kind: "answer", status: 400, body: { error: verdict.refusal } };
  }

  const binding: RunConfirmationBinding = {
    session: request.session,
    connection: request.connection,
    catalog: request.catalog,
    route: request.route,
    statement: request.sql,
    params: request.params,
    verdict,
  };
  if (field.kind === "token") {
    const check = await verifyRunConfirmation(field.token, binding, clock);
    if (!check.valid) {
      return { kind: "answer", status: 400, body: { error: check.reason, code: ApiErrorCode.CONFIRMATION_INVALID } };
    }
    return { kind: "run", unconfirmed: false };
  }

  if (verdict.decision === "run") return { kind: "run", unconfirmed: false };
  if (spared) return ranUnconfirmed(request);

  const { token, expiresAt } = await mintRunConfirmation(binding, clock);
  return {
    kind: "answer",
    status: 428,
    body: {
      error: CONFIRMATION_REQUIRED_MESSAGE,
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

/** Advisory mode sparing a caller that did not ask: the statement runs, and the answer and one warning say so. */
function ranUnconfirmed(request: RunGateRequest): RunGateDecision {
  logger.warn("A statement that needs a confirmation ran without one", {
    route: `api/db/${request.route}`,
    type: request.connection.type,
    user: request.session.username,
  });
  return { kind: "run", unconfirmed: true };
}
