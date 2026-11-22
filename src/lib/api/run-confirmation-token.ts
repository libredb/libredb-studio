/**
 * @file The run confirmation token (FND-5): what the run routes hand a caller in a 428 answer, and what the caller
 * sends back to run the statement it confirmed (docs/API_DOCS.md, "Server confirmation of a run").
 *
 * It is an explicit second step, not an authorization check: whoever holds the session can always ask for a token and
 * send it back. What it binds is that the run it confirms is the one the server classified: the same session, the same
 * server and catalog, the same route, the same statement and bound values, and the same reading of the statement. It
 * lives five minutes and is accepted once per process.
 *
 * HS256 through `jose` under HMAC(JWT_SECRET, `RUN_CONFIRMATION_KEY_LABEL`), the derivation the object edit plan token
 * and the agent drive token use under their own labels, so neither a session cookie nor any other token of this server
 * verifies as a run confirmation, and a run confirmation is neither of those.
 *
 * The payload of a JWS is readable by whoever holds the token, so each binding claim (`sid`, `cid`, `sd`, `vd`) is
 * keyed: HMAC under HMAC(JWT_SECRET, `RUN_CONFIRMATION_BINDING_LABEL`) of the SHA-256 of the framed binding text.
 * Without the server key a claim says nothing about the session, the connection, the statement or the verdict.
 */
import { SignJWT, jwtVerify } from "jose";
import type { UserPayload } from "@/lib/auth";
import { getJwtSecret } from "@/lib/config/auth-env";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import type { TypedConfirmation } from "@/lib/editor/statement-analysis";
import type { DatabaseConnection } from "@/lib/types";
import { sha256Hex } from "@/lib/api/utf16-digest";

/**
 * Five minutes, carried as the JWS `exp` so `jose` owns the clock: long enough to read the confirmation dialog and type
 * a connection's name, short enough that a token found later in a log or a proxy is dead.
 */
export const RUN_CONFIRMATION_TTL_SECONDS = 300;

/**
 * The label the signing key is derived under. Changing it invalidates every run confirmation in flight, which is the
 * intended cost of a `v2` if the claim set ever changes shape.
 */
const RUN_CONFIRMATION_KEY_LABEL = "libredb.run-confirmation.v1";

/**
 * The label the binding claims' key is derived under: its own label rather than the signing key, so the key that
 * signs a token and the key that seals its claims are never the same bytes.
 */
const RUN_CONFIRMATION_BINDING_LABEL = "libredb.run-confirmation.binding.v1";

/** The claim set's version, checked on every verification. */
const CLAIMS_VERSION = 1;

/** The run route a token was minted on, so a token a SANDBOX run earned on `transaction` cannot confirm another. */
export type RunConfirmationRoute = "query" | "multi-query" | "transaction";

/**
 * The server's reading of a statement a token can carry: `run` (the gate does not ask) or `confirm`, with what the
 * gate asks and whether the reading failed (`classificationFailed`, a reader threw, so the gate asks).
 */
export type RunVerdict =
  | { readonly decision: "run" }
  | {
      readonly decision: "confirm";
      readonly unreadable: boolean;
      readonly typedConfirmation: TypedConfirmation | null;
      readonly classificationFailed: boolean;
    };

/** Everything a token is bound to, read from the request the route is answering. */
export interface RunConfirmationBinding {
  /** The session the route's guard read: a token binds its username, its role and the session's own `iat`. */
  readonly session: UserPayload & { readonly iat?: number };
  /** The connection this request resolved, after any override the route applies: its server, never its id. */
  readonly connection: DatabaseConnection;
  /** The database a server-level connection runs the statement in (`requestCatalog`), or undefined. */
  readonly catalog: string | undefined;
  readonly route: RunConfirmationRoute;
  /** The submitted `sql`, as the client sent it. */
  readonly statement: string;
  /** The bound values the route hands the driver, or undefined where the request carries none. */
  readonly params: readonly unknown[] | undefined;
  readonly verdict: RunVerdict;
}

export type RunConfirmationCheck = { readonly valid: true } | { readonly valid: false; readonly reason: string };

/**
 * The tokens accepted in this process, by `jti`, until their `exp` (seconds): a token is accepted once. Kept on
 * `globalThis` under a registered symbol rather than in a module variable, because Next.js may bundle the three run
 * routes apart, so one server process can hold this module more than once (src/lib/db/egress-decision.ts does the same
 * for the same reason). Per process: across replicas a token is accepted at most once per replica within its life.
 */
const USED_KEY = Symbol.for("libredb-studio.run-confirmation.used");

type UsedHolder = { [USED_KEY]?: Map<string, number> };

function usedTokens(): Map<string, number> {
  const holder = globalThis as UsedHolder;
  holder[USED_KEY] ??= new Map();
  return holder[USED_KEY];
}

/** Test seam: forgets every accepted token, as a new process would. */
export function forgetUsedRunConfirmations(): void {
  delete (globalThis as UsedHolder)[USED_KEY];
}

/** Mints a token for this binding; `expiresAt` is its `exp`, in seconds since the epoch. */
export async function mintRunConfirmation(
  binding: RunConfirmationBinding,
  clock: () => number = Date.now,
): Promise<{ token: string; expiresAt: number }> {
  const issuedAt = Math.floor(clock() / 1000);
  const expiresAt = issuedAt + RUN_CONFIRMATION_TTL_SECONDS;
  const token = await new SignJWT({
    v: CLAIMS_VERSION,
    sid: await sessionDigest(binding.session),
    cid: await connectionDigest(binding.connection, binding.catalog),
    rt: binding.route,
    sd: await statementDigest(binding.statement, binding.params),
    vd: await keyedDigest(verdictText(binding.verdict)),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(await runConfirmationKey());
  return { token, expiresAt };
}

/**
 * Whether `token` confirms this binding. The conditions are checked IN THIS ORDER, each with its own sentence, so a
 * caller can tell what to do next without matching on one shared sentence: not verifiable (a bad signature, another
 * key, another claim version, not a token at all), expired, another route, another session, another connection or
 * catalog, another statement or bound value, another reading of the statement, already used. A token is recorded as
 * used only when every other condition holds, so a refused token is not spent.
 */
export async function verifyRunConfirmation(
  token: string,
  binding: RunConfirmationBinding,
  clock: () => number = Date.now,
): Promise<RunConfirmationCheck> {
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(token, await runConfirmationKey(), { currentDate: new Date(clock()) });
    claims = payload as Record<string, unknown>;
  } catch (error) {
    return {
      valid: false,
      reason: isExpiry(error) ? "this confirmation has expired" : "this confirmation could not be verified",
    };
  }
  if (claims.v !== CLAIMS_VERSION) return { valid: false, reason: "this confirmation could not be verified" };
  if (claims.rt !== binding.route) return { valid: false, reason: "this confirmation was issued for another route" };
  if (claims.sid !== (await sessionDigest(binding.session))) {
    return { valid: false, reason: "this confirmation was issued for another session" };
  }
  if (claims.cid !== (await connectionDigest(binding.connection, binding.catalog))) {
    return { valid: false, reason: "this confirmation was issued for another connection" };
  }
  if (claims.sd !== (await statementDigest(binding.statement, binding.params))) {
    return { valid: false, reason: "this confirmation was issued for another statement" };
  }
  if (claims.vd !== (await keyedDigest(verdictText(binding.verdict)))) {
    return { valid: false, reason: "this confirmation was issued for another reading of the statement" };
  }
  const used = usedTokens();
  const jti = claims.jti as string;
  if (used.has(jti)) return { valid: false, reason: "this confirmation has already been used" };
  const now = Math.floor(clock() / 1000);
  for (const [seen, expiry] of used) if (expiry < now) used.delete(seen);
  used.set(jti, claims.exp as number);
  return { valid: true };
}

/** Length framing, so two adjacent fields cannot slide across their boundary and spell another pair. */
function frame(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * The session: its username, its role and its own `iat`, so a token outlives neither a sign-out and sign-in nor a
 * role change. Every session `guardRoute` admits carries a numeric `iat` (signJWT sets it on every cookie Studio signs,
 * and a bearer access token is admitted only with one), so a session without one is refused by name here rather than
 * bound to a default.
 */
async function sessionDigest(session: UserPayload & { readonly iat?: number }): Promise<string> {
  if (typeof session.iat !== "number") {
    throw new Error("The session carries no issue time, so a run confirmation cannot be bound to it");
  }
  return keyedDigest(frame(session.username) + frame(session.role) + frame(String(session.iat)));
}

/**
 * The server the statement reaches, by `connectionFingerprint` and never by the connection's id (an inline id is a
 * string the caller typed), framed with the catalog, where the absence of one is its own value.
 */
async function connectionDigest(connection: DatabaseConnection, catalog: string | undefined): Promise<string> {
  const server = await connectionFingerprint(connection);
  return keyedDigest(frame(server) + (catalog === undefined ? frame("catalog:none") : frame(`catalog:${catalog}`)));
}

/**
 * The statement's UTF-16 code units and its bound values, each value tagged with its type so the number 1 and the
 * string "1" differ, and the absence of `params` its own value.
 */
async function statementDigest(statement: string, params: readonly unknown[] | undefined): Promise<string> {
  const values =
    params === undefined
      ? frame("params:none")
      : frame(`params:${params.length}`) + params.map((value) => frame(`${typeof value}:${String(value)}`)).join("");
  return keyedDigest(frame(statement) + values);
}

/** The verdict, field by field, in a fixed order. */
function verdictText(verdict: RunVerdict): string {
  if (verdict.decision === "run") return frame("run");
  const typed = verdict.typedConfirmation;
  const typedText =
    typed === null
      ? frame("typed:none")
      : frame(`typed:${typed.type}`) +
        frame(typed.expected) +
        (typed.type === "connection-name"
          ? frame(String(typed.targets.length)) + typed.targets.map(frame).join("")
          : "");
  return frame("confirm") + frame(String(verdict.unreadable)) + frame(String(verdict.classificationFailed)) + typedText;
}

/**
 * A binding claim: HMAC-SHA-256, lowercase hex, under the binding key, of `sha256Hex(text)`. The inner digest keeps the
 * one definition of a string's bytes (UTF-16 code units, lone surrogates included) in `sha256Hex`; the HMAC keys it.
 */
async function keyedDigest(text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    (await derivedKey(RUN_CONFIRMATION_BINDING_LABEL)).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const tag = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(await sha256Hex(text)));
  return Array.from(new Uint8Array(tag))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The signing key: HMAC(JWT_SECRET, `RUN_CONFIRMATION_KEY_LABEL`). */
function runConfirmationKey(): Promise<Uint8Array> {
  return derivedKey(RUN_CONFIRMATION_KEY_LABEL);
}

/**
 * HMAC(JWT_SECRET, label), derived per call rather than cached, for the reason `planSigningKey` in
 * src/lib/api/object-edit-plan-token.ts records: a cache would hold a key that outlived a rotated secret.
 */
async function derivedKey(label: string): Promise<Uint8Array> {
  // Copied into its own buffer: `BufferSource` requires an `ArrayBuffer`, and a Uint8Array's backing store is typed as
  // possibly shared.
  const raw = getJwtSecret().slice().buffer as ArrayBuffer;
  const base = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(label));
  return new Uint8Array(derived);
}

/** `jose` publishes expiry as a `code` on the error, the one failure a caller can act on differently. */
function isExpiry(error: unknown): boolean {
  return (error as { code?: string }).code === "ERR_JWT_EXPIRED";
}
