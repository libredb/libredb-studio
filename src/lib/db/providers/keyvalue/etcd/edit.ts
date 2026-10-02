/**
 * The guarded value edit of one key (spec 4.5), the one write the UI offers: the build reads the key
 * once and issues a plan whose unit is one etcd `Txn` in etcdctl's txn words, and the apply sends
 * exactly that `Txn`, built from the unit alone.
 *
 * The unit is `txn` with, in the order etcdctl's txn format writes them, the compare
 * `mod("<key>") = "<mod_revision>"`, the success `put --ignore-lease <key>` with the payload, and the
 * failure `get <key>` as `trailing` (spec 3.4, R11 CF-3). The compare's key is Go-quoted, the put and
 * get keys are txn request words, and a key that begins with `-` is written after `--` (spec 5.1.3,
 * 6.4). `--ignore-lease` keeps an attached lease, and the failure read keeps the one update shape kine
 * accepts, a MOD EQUAL compare, one Put and one Range on failure (spec 4.5, section 8).
 *
 * The apply parses the unit's tokens with commands.ts, the parser the editor runs, so every operation
 * etcd receives is one the preview showed (ruling 1a): the compare from `arguments[0]`, the put from
 * the rest of `arguments` and `payload.text`, the read from `trailing`. The payload never passes
 * through the lexer, because a txn line cannot carry a literal newline: the parser reads a stand-in
 * word where the value stands, and the apply attaches the payload's own bytes.
 *
 * E6 and E8 are write-policy.ts's decisions, and inside the apply they are the returned `refused`
 * outcome, never a throw, because the apply route turns every throw into `interrupted` (spec 5.6).
 * After the send an error answer is `refused` only when errors.ts's closed list says etcd gave it
 * before the write could apply; "database space exceeded" earns one read of the key; every other
 * answer is `interrupted` with `committed: "unknown"`, since the proposal can still commit.
 */
import { QueryError } from "@/lib/db/errors";
import { EDIT_CHARACTER_LIMIT } from "@/lib/db/object-edit";
import { SOURCE_CHARACTER_LIMIT, sourceBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  DatabaseType,
  ObjectEditBuild,
  ObjectEditCurrentText,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditRefusalClass,
  ObjectEditRequest,
} from "@/lib/db/types";
import {
  type EtcdBytes,
  type EtcdClient,
  EtcdError,
  type EtcdErrorCategory,
  type EtcdKeyValue,
  type EtcdRangeResponse,
  type EtcdTxnRequest,
  type EtcdTxnResponse,
} from "./client";
import { type EtcdCommand, type EtcdParseLimits, parseEtcdCommand } from "./commands";
import { type EtcdErrorContext, toProviderError, writeNotApplied } from "./errors";
import { assessCommand } from "./guard";
import { decodeUtf8, encodeKey, typedKey } from "./keys";
import { quoteGoString, quoteTxnWord } from "./lexer";
import { type EtcdSurfaceContext, surfaceErrorContext } from "./objects";
import { rangeCovered } from "./permissions";
import { type ValueView, viewValue } from "./values";
import { refuseBeforeSend, refuseReadOnly } from "./write-policy";

const PROVIDER: DatabaseType = "etcd";

/** Part 1 of a key's source, the one part the edit writes (spec 4.4). */
const VALUE_PART = "value";

/** What the plan's revision compares, in etcd's own name for the field (spec 4.4, 4.5). */
const REVISION_BASIS = "mod_revision";

/** The first byte of a key etcdctl would read as a flag, so the key is written after `--` (spec 5.1.3, 6.4). */
const DASH = 0x2d;

const TYPED_PUT = "Write it with a typed put in the editor.";

/** The Source tab gives these two reasons in the same words (objects.ts), so one fact reads as one sentence (spec 4.4). */
const METADATA_NOT_EDITED = "etcd keeps a key's metadata itself: only its value is edited.";
const VALUE_NOT_TEXT = "The value is not UTF-8 text, so it is shown as base64 and is not edited here.";

const count = (n: number): string => n.toLocaleString("en-US");

/** "1 byte", "4 bytes", as the Source tab names a value's size (spec 4.4). */
const byteCount = (n: number): string => `${count(n)} byte${n === 1 ? "" : "s"}`;

/**
 * What the composition root stamps on every plan: the server fingerprint only it can compute from
 * the connection, which both edit routes compare with the connection they resolved, and the plan's
 * id and time, which a test fixes.
 */
export interface EtcdEditPlanStamp {
  readonly type: DatabaseType;
  readonly connectionFingerprint: string;
  readonly planId: string;
  readonly issuedAt: string;
}

/** A build that issues no plan: nothing that changes anything was sent, so no engine reported a position. */
function refuse(refusal: ObjectEditRefusalClass, sentence: string): ObjectEditBuild {
  return { built: false, refusal: { refusal, sentence, at: { within: "none" } } };
}

/** The text's UTF-8, or undefined when a lone surrogate leaves no bytes that read back as the text. */
function exactBytes(text: string): EtcdBytes | undefined {
  const bytes = encodeKey(text);
  return decodeUtf8(bytes) === text ? bytes : undefined;
}

/**
 * The key a request or a plan addresses: one path segment, the whole key, whose UTF-8 reads back as
 * the segment. A key that is not UTF-8 has no path (spec 4.1), so a segment that is not text names no
 * stored key, and a U+FFFD in a segment is that character's own bytes, never a stand-in for others.
 */
function keyOf(path: readonly string[]): EtcdBytes {
  if (path.length !== 1) {
    throw new QueryError(
      `An etcd key is addressed by one path segment, the whole key, and this one has ${path.length}.`,
      PROVIDER,
    );
  }
  const key = exactBytes(path[0]);
  if (key === undefined) {
    throw new QueryError(
      "This key is not UTF-8 text, so it names no stored key: a key that is not UTF-8 is read and written with a typed command.",
      PROVIDER,
    );
  }
  if (key.length === 0)
    throw new QueryError('An etcd key is never empty: etcd answers "key is not provided".', PROVIDER);
  return key;
}

/** The user whose grants scope the context (spec 4.7); a scoped context without one is a composition defect. */
function scopedUser(context: EtcdSurfaceContext): string {
  if (context.principal === undefined) {
    throw new Error(
      "An etcd surface context scoped to a user's grants carries no principal: the provider builds both from one connect (spec 4.7)",
    );
  }
  return context.principal.name;
}

/**
 * The value edit as the one command guard.ts classifies, so write-policy.ts decides E8 for it by the
 * rule it applies to a typed put, before any request (spec 3.1, E8).
 */
function valueEditCommand(key: EtcdBytes): EtcdCommand {
  return { kind: "put", key, value: new Uint8Array(0), prevKv: false, ignoreValue: false, ignoreLease: true };
}

/**
 * 4.4's rule for a part's language, E9 row 6's: `json` when values.ts reads the value as JSON, else
 * `plaintext` (R13 D11). A key under a protected prefix never reaches here, because E8 refuses its edit.
 */
function languageOf(view: ValueView): string {
  return view.encoding === "json" ? "json" : "plaintext";
}

/**
 * The build's answer where it needs no read (spec 4.5): read-only mode (E6), a part other than the value and
 * a protected key (E8) are refused, and a request that names another kind or no key is raised, each before
 * any request; undefined where the build goes on to read the key. The provider asks it before its walk reads
 * the grants, so none of these sends a request (spec 5.6).
 */
export function refuseValueEditBeforeRead(
  context: Pick<EtcdSurfaceContext, "readOnly">,
  request: ObjectEditRequest,
): ObjectEditBuild | undefined {
  const readOnly = refuseReadOnly(context);
  if (readOnly !== undefined) return refuse("privilege", readOnly.message);
  if (request.kind !== "key") {
    throw new QueryError("etcd edits only the value of a key, and this request names another kind.", PROVIDER);
  }
  const key = keyOf(request.path);
  if (request.partId !== VALUE_PART) return refuse("unsupported", METADATA_NOT_EDITED);
  const protectedKey = refuseBeforeSend(assessCommand(valueEditCommand(key)), context);
  return protectedKey === undefined ? undefined : refuse("unsupported", protectedKey.message);
}

/**
 * Reads the key once and issues the plan, or refuses (spec 4.5). The refusals that need no read send
 * nothing (`refuseValueEditBeforeRead`). A read etcd refuses is raised in 5.6's words, as a Redis build
 * raises one, because it leaves nothing to plan against, and a key etcd no longer holds is a `QueryError`
 * naming the key. After the read the refusals follow 4.5's order, the order the Source tab gives its
 * reason in (objects.ts): a withheld, empty, non-UTF-8 or whitespace-only value (4.4), a key outside the
 * writable union (4.7), a value past the edit bound, and an unchanged text.
 */
export async function buildEtcdValueEdit(
  client: Pick<EtcdClient, "range">,
  context: EtcdSurfaceContext,
  request: ObjectEditRequest,
  stamp: EtcdEditPlanStamp,
): Promise<ObjectEditBuild> {
  const refused = refuseValueEditBeforeRead(context, request);
  if (refused !== undefined) return refused;
  const key = keyOf(request.path);

  // The key as a person types it back, the one way every sentence names a key (spec 5.5, 5.6).
  const shown = typedKey(key, "command-line");
  let answer: EtcdRangeResponse;
  try {
    answer = await client.range({ key, limit: 1 }, { signal: context.signal });
  } catch (error) {
    throw toProviderError(error, surfaceErrorContext(context, "get", { range: shown }));
  }
  const stored = answer.kvs[0];
  if (stored === undefined) {
    throw new QueryError(
      `etcd holds no key ${shown}: it may have been deleted since the Source tab read it.`,
      PROVIDER,
    );
  }

  // values.ts's one reading of the value, so a withheld value is refused by the rule every surface
  // withholds it by (E9); unbounded, so a shown value's text is the whole value.
  const view = viewValue(key, stored.value, Number.POSITIVE_INFINITY);
  if (view.encoding === "withheld") {
    return refuse("unsupported", `Studio does not edit a value it withholds: ${view.text}.`);
  }
  if (view.byteLength === 0) return refuse("unsupported", `The value is empty (0 bytes). ${TYPED_PUT}`);
  if (view.encoding === "base64") return refuse("unsupported", VALUE_NOT_TEXT);
  const text = view.text;
  if (text.trim() === "") {
    return refuse("unsupported", `The value holds only whitespace (${byteCount(view.byteLength)}). ${TYPED_PUT}`);
  }
  if (!rangeCovered({ key }, context.writable)) {
    return refuse("privilege", `etcd user ${scopedUser(context)} may read this key but not write it`);
  }
  if (text.length > EDIT_CHARACTER_LIMIT) {
    return refuse(
      "guard",
      `The value is ${count(text.length)} characters and the Source tab shows at most ${count(EDIT_CHARACTER_LIMIT)}, so the text you edited is a cut copy of it, and applying it would delete everything past the bound. ${TYPED_PUT}`,
    );
  }
  if (request.text === text) return refuse("definition", "This text is identical to the value etcd holds.");
  const payload = exactBytes(request.text);
  if (payload === undefined) {
    return refuse(
      "definition",
      "This text holds a lone UTF-16 surrogate, which is not text, so it has no bytes to store: remove it.",
    );
  }

  const keyWord = quoteTxnWord(key);
  const afterFlags = key[0] === DASH ? ["--"] : [];
  return {
    built: true,
    plan: {
      planVersion: 1,
      planId: stamp.planId,
      issuedAt: stamp.issuedAt,
      connectionFingerprint: stamp.connectionFingerprint,
      type: stamp.type,
      path: [...request.path],
      kind: request.kind,
      partId: request.partId,
      strategy: "guarded-atomic-batch",
      unit: {
        medium: "command",
        name: "txn",
        arguments: [
          `mod(${quoteGoString(key)}) = "${stored.modRevision}"`,
          "put",
          "--ignore-lease",
          ...afterFlags,
          keyWord,
        ],
        payload: {
          text: request.text,
          language: languageOf(viewValue(key, payload, Number.POSITIVE_INFINITY)),
          segments: [{ from: "user", start: 0, end: request.text.length }],
        },
        trailing: ["get", ...afterFlags, keyWord],
        payloadLabel: "value",
      },
      session: [],
      revision: { check: "guarded", token: stored.modRevision, basis: REVISION_BASIS, scope: "server" },
      consequences: [],
    },
    preimage: { text, language: languageOf(view) },
  };
}

/** The word the parser reads where the put's value stands; the apply attaches the payload's own bytes (spec 4.5). */
const PAYLOAD_WORD = "payload";

/** The unit is a single-key txn with no ranged read and no timeout flag, so no bound of the connection applies. */
const APPLY_PARSE_LIMITS: EtcdParseLimits = {
  maxLimit: Number.POSITIVE_INFINITY,
  txnRangeLimit: Number.POSITIVE_INFINITY,
  maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
  maxWatchWindowMs: Number.POSITIVE_INFINITY,
};

/**
 * The refusal class of each answer on 4.5's closed list that names its own cause: the caller's grant,
 * or the request's shape. Every other answer on the list is etcd, or the connection, not taking the
 * write at that moment, which the union has no class for, so it reads `unsupported`; its sentence
 * carries etcd's words and 5.6's instruction.
 */
const NOT_APPLIED_CLASS: Readonly<Partial<Record<EtcdErrorCategory, ObjectEditRefusalClass>>> = {
  "permission-denied": "privilege",
  "request-too-large": "definition",
  "too-many-ops": "definition",
  "duplicate-key": "definition",
};

const SHAPE = "its txn is not one mod compare, one put --ignore-lease and one get, all of one key";

/** The Txn the apply sends, the command guard.ts classifies for E8, and the facts the outcome reads. */
interface ValueEditTxn {
  readonly command: EtcdCommand;
  readonly request: EtcdTxnRequest;
  readonly key: EtcdBytes;
  readonly revision: string;
}

function refused(refusal: ObjectEditRefusalClass, sentence: string, duration: number): ObjectEditOutcome {
  return { outcome: "refused", refusal: { refusal, sentence, at: { within: "none" } }, duration };
}

function interrupted(sentence: string, duration: number): ObjectEditOutcome {
  return { outcome: "interrupted", committed: "unknown", sentence, duration };
}

/** A plan this module did not build: raised before any request, as Redis raises on a plan it did not build. */
function foreign(what: string): QueryError {
  return new QueryError(
    `This etcd value edit plan was not built by this provider: ${what}. Nothing was sent.`,
    PROVIDER,
  );
}

function sameBytes(a: EtcdBytes, b: EtcdBytes): boolean {
  return a.length === b.length && a.every((byte, at) => byte === b[at]);
}

/**
 * The unit, parsed back with commands.ts, as the one Txn this module builds, or a raise before any
 * request (spec 4.5). The request is built from the parse alone, never from `plan.path` or
 * `plan.revision`, which are only held against what the unit spells (ruling 1a).
 */
function txnFromPlan(plan: ObjectEditPlan): ValueEditTxn {
  const unit = plan.unit;
  if (unit.medium !== "command" || unit.name !== "txn") throw foreign("its unit is not an etcd txn command");
  const revision = plan.revision;
  if (revision.check !== "guarded") throw foreign("its revision is not the guarded mod_revision this provider issues");
  if (plan.kind !== "key" || plan.partId !== VALUE_PART) throw foreign("it edits something other than a key's value");
  const key = keyOf(plan.path);
  const [compareLine, ...putWords] = unit.arguments;
  const body = `txn\n${compareLine}\n\n${[...putWords, PAYLOAD_WORD].join(" ")}\n\n${(unit.trailing ?? []).join(" ")}\n`;
  const parsed = parseEtcdCommand(body, APPLY_PARSE_LIMITS);
  if (!parsed.ok) throw foreign(`its txn does not parse: ${parsed.refusal.message}`);
  const txn = parsed.parsed.command;
  if (txn.kind !== "txn" || txn.compares.length !== 1 || txn.success.length !== 1 || txn.failure.length !== 1) {
    throw foreign(SHAPE);
  }
  const [compare] = txn.compares;
  const [put] = txn.success;
  const [get] = txn.failure;
  if (compare.target !== "mod" || compare.operator !== "=" || put.kind !== "put" || get.kind !== "get") {
    throw foreign(SHAPE);
  }
  if (!put.ignoreLease || put.ignoreValue || put.prevKv || put.lease !== undefined) throw foreign(SHAPE);
  const readsOneKey =
    get.rangeEnd === undefined &&
    !get.prefix &&
    !get.fromKey &&
    get.limit === undefined &&
    get.revision === undefined &&
    !get.keysOnly &&
    !get.countOnly &&
    get.consistency === "l";
  if (!readsOneKey) throw foreign(SHAPE);
  if (![compare.key, put.key, get.key].every((spelled) => sameBytes(spelled, key))) {
    throw foreign("its keys differ from the key it is addressed to");
  }
  if (compare.operand !== revision.token) throw foreign("its compare revision differs from its revision token");
  const value = exactBytes(unit.payload.text);
  if (value === undefined) throw foreign("its payload holds a lone UTF-16 surrogate, which has no bytes to store");
  return {
    command: txn,
    key,
    revision: compare.operand,
    request: {
      compare: [{ key: compare.key, target: "mod", result: "equal", operand: compare.operand }],
      success: [{ op: "put", request: { key: put.key, value, ignoreLease: true } }],
      failure: [{ op: "range", request: { key: get.key, limit: 1 } }],
    },
  };
}

/** The key's value now, for the conflict's diff: E9's classifier on the failure read, so a withheld value is its label (spec 4.5, E9). */
function currentText(kv: EtcdKeyValue): ObjectEditCurrentText {
  const view = viewValue(kv.key, kv.value, SOURCE_CHARACTER_LIMIT);
  const language = languageOf(view);
  if (!view.cut) return { text: view.text, language };
  return {
    text: view.text,
    language,
    truncated: { limit: SOURCE_CHARACTER_LIMIT, reason: sourceBoundTruncationReason(SOURCE_CHARACTER_LIMIT) },
  };
}

/**
 * An error after the send (spec 4.5, 5.6): `refused` only on errors.ts's closed list; a NOSPACE answer
 * earns one linearizable read of the key, whose unchanged revision proves the Txn wrote nothing, since
 * etcd applies a write before it answers NOSPACE at apply time; every other answer is `interrupted`,
 * and no read decides it, because the proposal can still commit after any read.
 */
async function afterFailedSend(
  client: Pick<EtcdClient, "range">,
  context: EtcdSurfaceContext,
  error: EtcdError,
  txn: ValueEditTxn,
  errors: EtcdErrorContext,
  elapsed: () => number,
): Promise<ObjectEditOutcome> {
  if (writeNotApplied(error)) {
    return refused(
      NOT_APPLIED_CLASS[error.category] ?? "unsupported",
      toProviderError(error, errors).message,
      elapsed(),
    );
  }
  const unknown = toProviderError(error, errors).message;
  if (error.category !== "no-space") return interrupted(unknown, elapsed());
  let stored: EtcdKeyValue | undefined;
  try {
    stored = (await client.range({ key: txn.key, limit: 1 }, { signal: context.signal })).kvs[0];
  } catch (readError) {
    const reason = toProviderError(readError, { ...errors, command: "get", write: false }).message;
    return interrupted(
      `${unknown} The read of the key that would have told whether it was written failed too: ${reason}`,
      elapsed(),
    );
  }
  if (stored?.modRevision !== txn.revision) return interrupted(unknown, elapsed());
  const quota = toProviderError(error, { ...errors, write: false }).message;
  return refused(
    "unsupported",
    `${quota} The key still holds the revision the edit read, so nothing was written.`,
    elapsed(),
  );
}

/**
 * Sends the plan's one `Txn`, or refuses before any request (spec 4.5, E6, E8). Through a read-only
 * provider every plan is refused and nothing throws (spec E6); any other plan this module did not
 * build is raised as a `QueryError` before any request.
 */
export async function applyEtcdValueEdit(
  client: Pick<EtcdClient, "txn" | "range">,
  context: EtcdSurfaceContext,
  plan: ObjectEditPlan,
): Promise<ObjectEditOutcome> {
  const started = context.now();
  const elapsed = (): number => context.now() - started;
  const readOnly = refuseReadOnly(context);
  if (readOnly !== undefined) return refused("privilege", readOnly.message, elapsed());
  const txn = txnFromPlan(plan);
  const protectedKey = refuseBeforeSend(assessCommand(txn.command), context);
  if (protectedKey !== undefined) return refused("unsupported", protectedKey.message, elapsed());

  const shown = typedKey(txn.key, "command-line");
  const errors = surfaceErrorContext(context, "value edit", { write: true, range: shown });
  let answer: EtcdTxnResponse;
  try {
    answer = await client.txn(txn.request, { signal: context.signal });
  } catch (error) {
    if (!(error instanceof EtcdError)) throw error;
    return await afterFailedSend(client, context, error, txn, errors, elapsed);
  }
  if (answer.succeeded) {
    return {
      outcome: "applied",
      revision: { check: "guarded", token: answer.header.revision, basis: REVISION_BASIS, scope: "server" },
      duration: elapsed(),
    };
  }
  const read = answer.responses[0];
  if (read?.op !== "range") {
    throw new QueryError(
      "etcd answered the value edit's failed compare without the read of its failure branch, so what the key holds now is unknown: read the key before you edit it again.",
      PROVIDER,
    );
  }
  const current = read.response.kvs[0];
  if (current === undefined) {
    return refused(
      "guard",
      `The key ${shown} was deleted after the edit read it, so there is no current value to compare with. Nothing was written.`,
      elapsed(),
    );
  }
  return { outcome: "conflict", conflict: "object-changed", current: currentText(current), duration: elapsed() };
}
