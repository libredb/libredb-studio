/**
 * @file The seal that makes a plan UNFORGEABLE while leaving it READABLE (#789 Phase 3, ruling 1a as
 * adjudicated: "opaque" means sealed, not unreadable).
 *
 * What forging buys, stated honestly, because the next reader will otherwise reduce this to
 * "arbitrary SQL execution", find it is already possible, and delete the check. On a SQL engine it
 * buys nothing against the database: MEASURED through the product with three controls, a
 * `user`-role session created and dropped a function through `POST /api/db/query`, both with an
 * inline caller-supplied connection carrying superuser credentials and with a managed seed
 * connection whose roles admit `*`. What it buys is a LIE IN THE AUDIT: the apply route records
 * the object path, the kind and the strategy and may never record the statement, so a forged plan
 * would write a true-looking row about an object that was never touched. And on Redis the premise
 * does not hold at all: that measurement covers SQL engines, so for the one non-SQL engine in the
 * day-one set this may be a genuinely new capability and the token is a real boundary.
 */
import { SignJWT, jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/config/auth-env";
import type { ObjectEditPlan } from "@/lib/db/types";

/**
 * Fifteen minutes, carried as the JWS `exp` so `jose` owns the clock, with one measured basis and
 * one honest limit.
 *
 * The basis: the provider cache evicts on 30 idle minutes (`src/lib/db/factory.ts:444`), so a plan
 * cannot ordinarily outlive its issuing provider by much. The limit: a reconnect can replace the
 * instance sooner, which is why a `connection`-scoped revision needs more than a TTL and does not
 * ship. Five minutes was considered and rejected: the browser probe opened a real 975,134-character
 * definition rendering 13,009 lines, and a reader who spends six minutes on that diff and then
 * presses Apply must not meet a dead end. The TTL bounds REPLAY and is not the lost-update
 * protection, which is the revision.
 */
export const PLAN_TOKEN_TTL_SECONDS = 900;

/**
 * The label the signing key is derived under, and the whole of what makes a session cookie not a
 * plan token: the key is HMAC(JWT_SECRET, this label), so neither credential verifies as the other.
 * Changing this string invalidates every plan token in flight, which is the intended cost of a `v2`
 * if the claim set ever changes shape.
 */
const PLAN_KEY_LABEL = "libredb.object-edit.plan.v1";

/**
 * The plan's top-level fields, driven explicitly so a new one cannot join the type without joining
 * the walk. The line below fails to COMPILE when it does.
 */
export const PLAN_FIELDS = [
  "planVersion",
  "planId",
  "issuedAt",
  "connectionFingerprint",
  "type",
  "path",
  "kind",
  "partId",
  "strategy",
  "unit",
  "session",
  "revision",
  "consequences",
] as const;
type PlanFieldsAreExhaustive = Exclude<keyof ObjectEditPlan, (typeof PLAN_FIELDS)[number]> extends never ? true : never;
const planFieldsAreExhaustive: PlanFieldsAreExhaustive = true;
// Read once so the constant is not dead: the assignment above is the check, and this keeps the
// unused-variable rule from deleting it.
void planFieldsAreExhaustive;

/**
 * Every leaf of the plan, as `{ path, value }`, walked in a DETERMINISTIC order at every depth.
 *
 * NEVER `JSON.stringify`: key order surviving a `JSON.parse`/`JSON.stringify` round trip is a V8
 * behaviour rather than a contract, and this product is already measured re-spelling a payload on a
 * round trip (`1.0E30` becomes `1e+30` and map key order changes on the search providers' source
 * read). A canonical-JSON digest would therefore answer "forged" for a correct client.
 *
 * The top level is driven from `PLAN_FIELDS` and every level below it sorts its own keys, so the
 * walk is order-independent without being order-blind. Two SYNTHETIC leaves make a DELETION
 * visible, which a walk over present values alone cannot see: an object contributes its sorted key
 * list and an array contributes its length.
 *
 * It is exported because the seal's test enumerates the leaves FROM HERE and tampers with each one
 * by name. A digest that covers twelve of thirteen leaves passes every test that only tampers with
 * the twelve, so the population has to come from the walk rather than from a list somebody typed.
 */
export function planDigestLeaves(plan: ObjectEditPlan): readonly { readonly path: string; readonly value: string }[] {
  const leaves: { readonly path: string; readonly value: string }[] = [];
  const walk = (path: string, value: unknown): void => {
    if (value === undefined) return;
    if (Array.isArray(value)) {
      leaves.push({ path: `${path}.length`, value: String(value.length) });
      value.forEach((item, index) => walk(`${path}.${index}`, item));
      return;
    }
    if (value !== null && typeof value === "object") {
      // Default (code-point) sort, NOT localeCompare: these are an object's own KEYS being
      // ordered to build the digest this plan is SEALED with, so mint and verify must agree byte
      // for byte on every host. localeCompare would tie the ordering to the host locale and ICU
      // version, and a plan minted on one host could then fail to verify on another. S2871 is
      // suppressed for this file in sonar-project.properties for exactly this reason.
      const keys = Object.keys(value as Record<string, unknown>).sort();
      leaves.push({ path: `${path}.keys`, value: keys.join(",") });
      for (const key of keys) walk(`${path}.${key}`, (value as Record<string, unknown>)[key]);
      return;
    }
    // `${typeof value}:` and not `String(value)` alone. ROUND 1 REVIEW MEASURED the bare form
    // against the shipped module: the number 0 and the string "0" are one leaf, so a client could
    // retype `segments[].start` inside an approved digest and the seal would not move. The plan
    // arrives as JSON, where a type is something the client chose, so the tag is what makes the
    // leaf injective over the values a client can send. `null` is `object:null` and the string
    // "null" is `string:null`, and a string that spells another tag, "number:0", becomes
    // `string:number:0`, so the tag is recoverable from the encoding rather than merely prepended.
    leaves.push({ path, value: `${typeof value}:${String(value)}` });
  };
  for (const field of PLAN_FIELDS) walk(field, (plan as unknown as Record<string, unknown>)[field]);
  return leaves;
}

/** SHA-256 over the length-framed leaves, hex. Length framing is what stops two fields sliding across their boundary. */
export async function digestPlan(plan: ObjectEditPlan): Promise<string> {
  return sha256Hex(
    planDigestLeaves(plan)
      .map((leaf) => frame(leaf.path) + frame(leaf.value))
      .join(""),
  );
}

// The SERVER fingerprint is `src/lib/db/connection-fingerprint.ts`'s and is NOT redefined here:
// the PROVIDER writes it onto the plan from the connection it was built with, and this module and
// the route only VERIFY it. Two definitions of one digest is two chances for them to disagree.

export type PlanTokenVerdict = { readonly valid: true } | { readonly valid: false; readonly reason: string };

export async function mintPlanToken(plan: ObjectEditPlan, clock: () => number = Date.now): Promise<string> {
  const issuedAt = Math.floor(clock() / 1000);
  // The DIGEST rather than the plan's bytes, so the token stays a few hundred bytes whatever the
  // plan weighs, and a maximal plan does not become a maximal header.
  return new SignJWT({
    digest: await digestPlan(plan),
    fingerprint: plan.connectionFingerprint,
    planVersion: plan.planVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + PLAN_TOKEN_TTL_SECONDS)
    .sign(await planSigningKey());
}

/**
 * The five conditions, IN THIS ORDER, each with its own sentence, because a client's next action
 * differs per condition and a shared sentence would force string matching in the browser.
 */
export async function verifyPlanToken(
  token: string,
  plan: ObjectEditPlan,
  fingerprint: string,
  clock: () => number = Date.now,
): Promise<PlanTokenVerdict> {
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(token, await planSigningKey(), { currentDate: new Date(clock()) });
    claims = payload as Record<string, unknown>;
  } catch (error) {
    // Expiry is the one failure `jose` reports that a reader can act on differently, so it is
    // told apart HERE and every other failure answers the same sentence: expired, forged, signed
    // with the session key, or not a token at all. Telling those apart would only help a forger.
    return {
      valid: false,
      reason: isExpiry(error) ? "this preview has expired" : "this preview could not be verified",
    };
  }
  if (claims.digest !== (await digestPlan(plan))) {
    return { valid: false, reason: "this preview no longer matches the plan it was issued for" };
  }
  if (plan.connectionFingerprint !== fingerprint || claims.fingerprint !== fingerprint) {
    return { valid: false, reason: "this preview was built against a different connection" };
  }
  if (claims.planVersion !== 1 || plan.planVersion !== 1) {
    return { valid: false, reason: "this preview was issued by a different version of this server" };
  }
  return { valid: true };
}

/**
 * Length framing. `${value.length}:${value}` is what stops two adjacent fields sliding across
 * their boundary, so that one leaf's tail plus the next leaf's head can never spell the same
 * concatenation as some other pair of values.
 *
 * THE ORIGINAL FORM OF THIS BLOCK CLAIMED, in a measurement's voice, that no pair of
 * `ObjectEditPlan` values collides unframed because every leaf carries a structural path literal
 * and the type has no data-derived path segment. That claim is REFUTED BY RUNNING, node against
 * this walk, and the refuting pair is in the seal's test: `kind` and `partId` are both plain
 * `string` on `ObjectEditPlan` and both are engine-derived, so a value CAN absorb the next leaf's
 * path literal. `kind: "XpartIdstring:Y", partId: "P"` and `kind: "X", partId: "YpartIdstring:P"`
 * concatenate to the same unframed bytes and are told apart framed. The framing is therefore load
 * bearing over a live population of this very plan type, and not a principle kept for later.
 *
 * The pair carries the value tag `string:` inside it because `planDigestLeaves` emits
 * `${typeof value}:${String(value)}`; the earlier, untagged spelling of the same pair is
 * `kind: "XpartIdY", partId: "P"` against `kind: "X", partId: "YpartIdP"`.
 */
function frame(value: string): string {
  return `${value.length}:${value}`;
}

/**
 * SHA-256 over the input's UTF-16 CODE UNITS, lowercase hex, through Web Crypto so this works in
 * every runtime this tree targets.
 *
 * NOT `new TextEncoder().encode(input)`, and the reason is ruling 1a in the letter. MEASURED by
 * round 1 review against the shipped module: `TextEncoder` maps every UNPAIRED surrogate to
 * U+FFFD, while `JSON.stringify`/`JSON.parse` on the wire preserves the code unit, so a token
 * minted for a statement text `"A\uD800B"` answered `{ valid: true }` for a plan carrying
 * `"A\uDC00B"`. The bytes the user approved would not have been the bytes the engine received.
 * Two bytes per code unit is injective over every JavaScript string, lone surrogates included.
 *
 * MEASURED cost, bun 1.4.2 on this machine, over an input the size of the largest definition the
 * browser probe opened (975,134 characters): one whole `digestPlan` over that plan, loop included,
 * is 3.60 ms, mean of five runs after a warm-up, which is well inside one apply's budget.
 */
async function sha256Hex(input: string): Promise<string> {
  const units = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    units[index * 2] = code >>> 8;
    units[index * 2 + 1] = code & 0xff;
  }
  const digest = await crypto.subtle.digest("SHA-256", units);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * HMAC(JWT_SECRET, label), the same derivation `src/lib/agent/drive-token.ts` uses for its own
 * label: a key that can neither mint nor verify a session, so a session cookie is not a plan token
 * and a plan token is not a session.
 *
 * Derived per call rather than cached, for the reason recorded there: it is two symmetric
 * operations on 32 bytes, while a cache would hold a key that outlived a rotated secret.
 */
async function planSigningKey(): Promise<Uint8Array> {
  const secret = getJwtSecret();
  // Copied into its own buffer: `BufferSource` requires an `ArrayBuffer`, and a Uint8Array's
  // backing store is typed as possibly shared.
  const raw = secret.slice().buffer as ArrayBuffer;
  const base = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(PLAN_KEY_LABEL));
  return new Uint8Array(derived);
}

/** `jose` publishes expiry as a `code` on the error, which is the only failure a reader can act on differently. */
function isExpiry(error: unknown): boolean {
  return (error as { code?: string }).code === "ERR_JWT_EXPIRED";
}
