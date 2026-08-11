/**
 * Inertness guard for anything an agent run persists (#329, epic #325).
 *
 * The durable contracts in `types.ts` are inert by construction, but a run
 * record travels through generic code — a workflow handler's return value, a
 * summary a model composed, an event payload assembled at a call site — and the
 * type that describes it is gone at runtime. This is the check the run store
 * applies before a value is written, so "persisted state carries only
 * serializable identifiers, summaries and references" is a mechanical property
 * rather than a review habit. (The store itself lands with the run service; this
 * module is complete and tested independently of it.)
 *
 * Six rules. The first one that fires is the reported violation:
 *
 * 1. `FUNCTION_VALUE` — a function, a method, or an accessor property. Never
 *    data, and JSON drops it silently, so a handler that stored one would resume
 *    with a field that quietly changed shape. An accessor is refused WITHOUT
 *    being read: reading it would run whatever it does and let its own throw
 *    escape in place of a typed refusal.
 * 2. `NON_SERIALIZABLE_VALUE` — a symbol, a bigint, a non-finite number, or a
 *    symbol-keyed property. Each one either throws in `JSON.stringify` or, worse,
 *    survives it as `null`/absent: `NaN` becomes `null`, and a NaN budget that
 *    reads as null after a restart is how a limit stops limiting.
 * 3. `CYCLIC_REFERENCE` — refused here, by name and with a path, rather than as
 *    an opaque `TypeError` from the serializer. A value referenced twice is NOT a
 *    cycle: JSON duplicates a shared reference perfectly well.
 * 4. `CLASS_INSTANCE` — anything whose prototype is not the plain one for its
 *    kind (`Object.prototype`, `Array.prototype`, or null): a driver client, a
 *    connection pool, a provider, a `Map`, a `Date`, an `Error`, an `Array`
 *    subclass. This is the categorical form of "no database client is retained" —
 *    it does not enumerate driver types, so a client this repository has never
 *    heard of is refused too. It also catches the near-misses that would
 *    round-trip into something ELSE (a `Date` returns as a string, a `Map` as
 *    `{}`).
 * 5. `CREDENTIAL_KEY` — a key that names, or is shaped like, a credential.
 * 6. `RAW_RESULT_SET` — a key that carries result payload rather than a summary
 *    of one. Rows and plans belong in the run-scoped artifact store, cited by an
 *    `AgentArtifactReference`.
 *
 * Order of evaluation, precisely: the value rules (1-3) settle a value before it
 * is entered; a container is then checked as a whole (4, then its symbol keys)
 * before any of its keys are read, and each key is checked (1, 5, 6) before the
 * walk descends into it. So `{ password: new Map() }` reports `CREDENTIAL_KEY`
 * and a `Map` carrying a symbol key reports `CLASS_INSTANCE` — in both cases the
 * outer, more specific fact about why the value cannot be persisted at all.
 *
 * Both key rules fire on the KEY, whatever the value is: a credential-shaped
 * field holding a placeholder is code on its way to persisting the real thing,
 * and refusing it early is the cheap moment.
 *
 * An array is walked exactly like any other container — its own non-index
 * properties are subject to every rule. That is not a hypothetical: this
 * repository's own SQL Server provider reads `recordset.columns` off the array
 * the driver returned (`src/lib/db/providers/sql/mssql.ts:590`), so a walk that
 * stopped at "the elements are clean" would miss what a driver hangs beside
 * them.
 *
 * Neither key set is written out by hand. The credential NAMES are derived from
 * the field classifications in `src/lib/storage/connection-secrets.ts` — the
 * repository's single answer to "which stored fields are credentials" — plus one
 * map for the LLM settings, which had none. The result names are derived from
 * `QueryResult`'s own keys the same way.
 *
 * How much that inheritance is worth, precisely, because it is easy to overstate:
 * each individual map IS a compile-time mirror (a new field on
 * `DatabaseConnection` or `QueryResult` fails `typecheck` until it is
 * classified), and that protection carries here for free. The AGGREGATE does not
 * inherit it — `SECRET_FIELD_MAPS` is a hand-maintained array, and nothing makes
 * a fourth map appear in it. That step is covered by a test instead
 * (`tests/unit/lib/agent/state-guard.test.ts` fails when the storage module
 * exports a classification map the array does not register), which is a weaker
 * guarantee than the compiler's and is named here so it is not mistaken for one.
 *
 * HONEST LIMITS. This is defense in depth behind the closed contracts, not a
 * boundary; the reason a result cannot reach a run record is that
 * `AgentRunRecord` has no field that accepts one.
 *
 *  - Rules 5 and 6 recognise a NAME, and they are not equally wide. Rule 5's
 *    derived names are widened by the stems below, so a session token or a
 *    provider secret is caught under a name the storage maps never spell. Rule 6
 *    matches its derived names EXACTLY: `rows` and `allRows` are refused,
 *    `resultRows` and `sampleRows` are not. That asymmetry is deliberate — the
 *    credential stems are a closed family of spellings for the same field,
 *    whereas rows smuggled under a key called `sample` are structurally
 *    indistinguishable from a legitimate summary, so widening rule 6 would buy
 *    partial coverage while implying total coverage. The real boundary is the
 *    contract: `AgentRunRecord` has no field that accepts a result set.
 *  - Non-enumerable own properties are not walked. JSON drops them too, so
 *    nothing leaks; the value simply loses them across the round trip.
 *  - The round trip is lossless for OBJECT properties, not for array slots. An
 *    `undefined` property is dropped by JSON and by this guard alike, so the
 *    field is absent either way; an `undefined` (or absent) ARRAY element
 *    serializes as `null`, and this guard accepts it. Rule 2 refuses `NaN` for
 *    the same class of reason, so this is a real asymmetry rather than a
 *    principled exemption — it is accepted because an array of run events never
 *    has a hole, not because the hole would be harmless.
 *  - Deeply nested state exhausts the stack rather than producing a typed
 *    refusal, and it does so EARLIER than the serializer does. It fails closed —
 *    a `RangeError` escapes PAST a caller that catches only `AgentStateError`
 *    rather than being masked as a refusal, and nothing is persisted. What is
 *    stable is the ORDERING: a recursive walk costs more frames per level than
 *    the serializer does, so there is a band this guard cannot clear that the
 *    store could otherwise persist. The depths are not stable enough to quote as
 *    a bound — measured in this runtime, this walk gave out between roughly 9.8k
 *    and 12.6k levels depending only on how warm the JIT was, against roughly 40k
 *    for `JSON.stringify`. Treat the gap as real and its width as unknown.
 *    Corollary: `RangeError` is the one throw this module forwards rather than
 *    answers, so a hostile object can raise one deliberately from REFLECTION and
 *    escape as that instead of as a typed refusal. Only from reflection — a
 *    `constructor` getter that throws `RangeError` is still reported as
 *    `CLASS_INSTANCE`, because `constructorName` catches everything and the
 *    prototype rule had already fired before the name was read, so that reason
 *    code is true. Either way it buys nothing: the value is not persisted, and
 *    the alternative is misreporting every real overflow.
 *  - The walk reads each property from its DESCRIPTOR, while `JSON.stringify`
 *    reads through `[[Get]]`. For every ordinary value those agree. They diverge
 *    on a proxy whose `getOwnPropertyDescriptor` trap answers with something
 *    inert while its `get` trap returns something else — that value clears this
 *    guard and then serializes the other thing. Reading through `[[Get]]` instead
 *    is not the fix: it would invoke exactly the accessors rule 1 exists to
 *    refuse unread. The real boundary is, again, the contract.
 */

import type { LLMConfig } from "@/lib/llm/types";
import { type FieldClass, SECRET_FIELD_MAPS } from "@/lib/storage/connection-secrets";
import type { QueryResult, QueryTab } from "@/lib/types";

export type AgentStateViolation =
  /** A function, method or accessor: not data, and silently dropped by JSON. */
  | "FUNCTION_VALUE"
  /** A symbol, a bigint, a non-finite number, or a symbol-keyed property. */
  | "NON_SERIALIZABLE_VALUE"
  /** A true cycle — not a value that merely appears twice. */
  | "CYCLIC_REFERENCE"
  /** A driver, pool, provider or other class instance. */
  | "CLASS_INSTANCE"
  /** A key that names, or is shaped like, a credential. */
  | "CREDENTIAL_KEY"
  /** A key carrying result payload instead of a summary of one. */
  | "RAW_RESULT_SET";

/**
 * The LLM settings surface has no field classification of its own, so this is
 * it — typed as a total record over `LLMConfig`, exactly like the connection maps
 * it borrows the vocabulary from: add a field to `LLMConfig` and this object stops
 * satisfying its type until the new field is classified.
 */
const LLM_CONFIG_FIELDS: Record<keyof LLMConfig, FieldClass> = {
  provider: "public",
  apiKey: "secret",
  model: "public",
  apiUrl: "public",
};

type ResultFieldClass = "payload" | "summary";

/**
 * Which parts of a query result are the result ITSELF, and which merely describe
 * it. Total over `QueryResult`, so a new result field must be classified before
 * it compiles.
 *
 * `explainPlan` is payload: a plan tree is the output of the operation that
 * produced it and can be arbitrarily large. `warnings` is not — engine notices
 * are bounded diagnostics, and run state already carries engine text in a
 * database-error refusal, so refusing them here would be inconsistent as well as
 * costly. `fields`, `columnTypes` and `pagination` describe shape, not rows.
 */
const QUERY_RESULT_FIELDS: Record<keyof QueryResult, ResultFieldClass> = {
  rows: "payload",
  explainPlan: "payload",
  fields: "summary",
  rowCount: "summary",
  executionTime: "summary",
  pagination: "summary",
  warnings: "summary",
  columnTypes: "summary",
};

/**
 * The one raw-row field that lives outside `QueryResult`: the editor tab's
 * accumulated page buffer. Typed as `keyof QueryTab` so renaming the field
 * breaks the build rather than silently un-covering it.
 */
const TAB_ROW_BUFFER_FIELD: keyof QueryTab = "allRows";

/** Case- and separator-insensitive: `API_KEY`, `api-key` and `apiKey` are one name. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function classifiedKeys<T extends string>(map: Record<string, T>, wanted: T): string[] {
  return Object.keys(map).filter((key) => map[key] === wanted);
}

/**
 * Derived from the classification maps rather than restating their contents: the
 * maps stay the single source of truth, and a field promoted to `secret` there is
 * covered here without an edit.
 */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(
  [...SECRET_FIELD_MAPS, LLM_CONFIG_FIELDS as Record<string, FieldClass>]
    .flatMap((map) => classifiedKeys(map, "secret"))
    .map(normalizeKey),
);

/**
 * Credential-shaped substrings, matched against the normalized key. The maps
 * above cover what this product STORES; a run's own state can hold a session
 * token or a provider secret under a name they never spell (`clientSecret`,
 * `accessToken`, `dbPassword`), and a guard that missed those would be trusted
 * for more than it does.
 *
 * A bare `token`, `pass` or `key` stem is deliberately absent: it would refuse
 * `tokenCount`, `totalTokens`, `passthrough` and `keyColumns` — fields an agent
 * run legitimately persists — and a rule that refuses real state is a rule
 * someone routes around. So the token family is spelled out by prefix instead.
 * `clientkey` is why the derived set above is still needed: no stem matches it.
 */
const CREDENTIAL_STEMS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "secret",
  "apikey",
  "privatekey",
  "credential",
  "accesstoken",
  "idtoken",
  "refreshtoken",
  "bearertoken",
  "sessiontoken",
  "authtoken",
  "authorization",
  "cookie",
  "jwt",
];

const RESULT_PAYLOAD_KEYS: ReadonlySet<string> = new Set(
  [...classifiedKeys(QUERY_RESULT_FIELDS as Record<string, ResultFieldClass>, "payload"), TAB_ROW_BUFFER_FIELD].map(
    normalizeKey,
  ),
);

/** An array's own keys are its indices plus whatever else was hung on it. */
const INDEX_KEY = /^\d+$/;

export class AgentStateError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: AgentStateViolation,
    /** Where the offending value sits, e.g. `run.events[2].artifact.rows`. */
    public readonly path: string,
  ) {
    super(message);
    this.name = "AgentStateError";
    Object.setPrototypeOf(this, AgentStateError.prototype);
  }
}

interface Finding {
  readonly violation: AgentStateViolation;
  readonly path: string;
  readonly detail?: string;
}

/**
 * `seen` holds the ancestors of the value being inspected — added on the way in
 * and removed on the way out, so only a real cycle is reported and a shared
 * reference is not. `cleared` is what keeps that affordable: a node already
 * walked clean cannot participate in a cycle (it would have met itself in `seen`
 * during its own walk), so it never has to be walked again. Without the memo a
 * shared subgraph costs one walk per PATH that reaches it, which is exponential
 * on stacked diamonds.
 */
interface WalkState {
  readonly seen: Set<object>;
  readonly cleared: Set<object>;
}

// One line, hoisted: bun's line coverage under-counts the continuation lines of a
// wrapped string literal (same reason as src/lib/config/auth-env.ts:20).
const refusalMessage = (finding: Finding): string =>
  `agent state refused: ${finding.violation} at ${finding.path}${finding.detail === undefined ? "" : ` (${finding.detail})`}`;

/**
 * Best available name for what an instance is, for the refusal message.
 *
 * `constructor` resolves through the prototype chain, so naming an instance can
 * run code the value controls — the one place this module reads something it has
 * already decided to refuse. It is read inside a `try` for exactly that reason:
 * a driver that throws while being named must not replace the typed refusal with
 * its own error. The value is refused either way; only the label degrades.
 */
function constructorName(value: object): string {
  try {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : "unknown class";
  } catch {
    return "unknown class";
  }
}

function isCredentialKey(normalized: string): boolean {
  return CREDENTIAL_KEYS.has(normalized) || CREDENTIAL_STEMS.some((stem) => normalized.includes(stem));
}

function inspect(value: unknown, path: string, walk: WalkState): Finding | null {
  if (value === null) return null;

  const kind = typeof value;
  if (kind === "function") return { violation: "FUNCTION_VALUE", path };
  if (kind === "symbol" || kind === "bigint") return { violation: "NON_SERIALIZABLE_VALUE", path, detail: kind };
  if (kind === "number" && !Number.isFinite(value)) {
    return { violation: "NON_SERIALIZABLE_VALUE", path, detail: String(value) };
  }
  if (kind !== "object") return null;

  const object = value as object;
  if (walk.seen.has(object)) return { violation: "CYCLIC_REFERENCE", path };
  if (walk.cleared.has(object)) return null;

  walk.seen.add(object);
  try {
    const finding = inspectContainer(object, path, walk);
    if (finding === null) walk.cleared.add(object);
    return finding;
  } finally {
    walk.seen.delete(object);
  }
}

/** What a container looks like once it has been read: its kind and its own properties. */
interface Reflected {
  readonly isArray: boolean;
  readonly entries: ReadonlyArray<readonly [string, PropertyDescriptor]>;
}

/**
 * Every reflective read of `object` happens here, in one step, before the walk
 * descends into anything. Two reasons it is not interleaved with the key loop:
 *
 *  - An exotic object can throw from reflection ITSELF, with no property of its
 *    own involved: a revoked proxy throws from `Array.isArray`, and a proxy with
 *    a hostile `ownKeys` or `getOwnPropertyDescriptor` trap throws from those.
 *    Refusing such a value as `CLASS_INSTANCE` is honest — something that will
 *    not answer what its own keys are is not the inert plain data this module
 *    admits — and it keeps the refusal typed, which is the whole contract.
 *  - The `catch` rethrows a `RangeError` rather than answering with it. Stack
 *    exhaustion raises one from whichever call happened to be running, and the
 *    deepest frames of this walk are the reflective ones, so it lands HERE more
 *    often than anywhere else. Answering `CLASS_INSTANCE` would name a rule that
 *    did not fire, about a value that may be perfectly inert — a false reason
 *    code rather than a degraded label. It escapes as itself instead; see HONEST
 *    LIMITS. (Keeping the recursive descent outside this `try` is the other half:
 *    it keeps the overflow from being caught a second time on the way out.)
 */
function reflect(object: object, path: string): Reflected | Finding {
  try {
    const isArray = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== (isArray ? Array.prototype : Object.prototype) && prototype !== null) {
      return { violation: "CLASS_INSTANCE", path, detail: constructorName(object) };
    }

    // JSON drops a symbol-keyed property without a word, so state carrying one
    // does not survive its own round trip.
    if (Object.getOwnPropertySymbols(object).length > 0) {
      return { violation: "NON_SERIALIZABLE_VALUE", path, detail: "symbol key" };
    }

    // A key from Object.keys always has an own descriptor. Carrying the
    // descriptor rather than the value is what keeps an accessor from being
    // invoked before it is refused.
    const entries = Object.keys(object).map(
      (key) => [key, Object.getOwnPropertyDescriptor(object, key) as PropertyDescriptor] as const,
    );
    return { isArray, entries };
  } catch (error) {
    if (error instanceof RangeError) throw error;
    return { violation: "CLASS_INSTANCE", path, detail: "unreadable object" };
  }
}

function inspectContainer(object: object, path: string, walk: WalkState): Finding | null {
  const reflected = reflect(object, path);
  if (!("entries" in reflected)) return reflected;

  for (const [key, descriptor] of reflected.entries) {
    const keyPath = reflected.isArray && INDEX_KEY.test(key) ? `${path}[${key}]` : `${path}.${key}`;
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      return { violation: "FUNCTION_VALUE", path: keyPath, detail: "accessor" };
    }
    const normalized = normalizeKey(key);
    if (isCredentialKey(normalized)) return { violation: "CREDENTIAL_KEY", path: keyPath, detail: key };
    if (RESULT_PAYLOAD_KEYS.has(normalized)) return { violation: "RAW_RESULT_SET", path: keyPath, detail: key };
    const finding = inspect(descriptor.value, keyPath, walk);
    if (finding !== null) return finding;
  }
  return null;
}

/**
 * Refuses a value that must not be persisted as agent run state, naming the rule
 * that fired and where. `label` roots the reported path — pass what the value is
 * ("run", "snapshot") so a refusal reads as a location in the state, not in a
 * walker.
 *
 * Returning normally is not a claim that the value is meaningful state; it means
 * these six rules found nothing.
 */
export function assertPersistableState(value: unknown, label = "state"): void {
  const finding = inspect(value, label, { seen: new Set<object>(), cleared: new Set<object>() });
  if (finding !== null) {
    throw new AgentStateError(refusalMessage(finding), finding.violation, finding.path);
  }
}
