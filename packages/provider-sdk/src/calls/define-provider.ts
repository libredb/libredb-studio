/**
 * The provider module record and its check (docs/providers/CONTRACT.md, clauses C-1, C-3 and C-4).
 *
 * A package's entry default-exports what `defineProvider` returns: `{ contract, manifest, impl }`. `checkProviderModule`
 * reads any value as such a record and answers every way it is not one, each a refusal naming its rule and a JSON
 * Pointer into the record. The loader runs it on the entry's default export, so a record another copy of the SDK built
 * is checked by the host's copy.
 *
 * The check reads only what the calls need: the two contracts, the manifest's `calls` segment, each engine's facets and
 * the implementation's functions. Validating the manifest against the schema is the loader's, which holds the schema
 * bytes; a manifest is typed `unknown` here and read defensively, because a JSON import's type is wider than the
 * manifest's and a cast would hide a mismatch. A function is read only as an own property, so a method a class
 * instance inherits is not read. No refusal carries a value of the manifest or the implementation; a contract is named
 * only when it has the form `MAJOR.MINOR`.
 */
import { CONSOLE_FACETS, PROVIDER_CONTRACT, type ProviderImpl, type ProviderModule } from "./types";

/** Every rule a definition refusal can name. */
export const DEFINITION_REFUSAL_RULES = Object.freeze([
  "module-not-a-record",
  "contract-not-served",
  "manifest-unreadable",
  "impl-key-unknown",
  "call-missing",
  "facet-undeclared",
  "facet-unimplemented",
  "engine-facet-without-call",
] as const);

export type DefinitionRefusalRule = (typeof DEFINITION_REFUSAL_RULES)[number];

/** One way a value is not a provider module record. */
export interface DefinitionRefusal {
  readonly rule: DefinitionRefusalRule;
  /** A JSON Pointer into the record; the empty string is the record itself. */
  readonly pointer: string;
  /** The key, for a record or implementation key the contract does not define, or a record key that is missing. */
  readonly key?: string;
  /** The call or facet, by its contract name, such as `console.cancel`. */
  readonly name?: string;
  /** The contract a record or manifest names, when it has the form `MAJOR.MINOR`. */
  readonly contract?: string;
}

/** Thrown by `defineProvider` with every refusal, its message their sentences. */
export class ProviderDefinitionError extends Error {
  readonly refusals: readonly DefinitionRefusal[];

  constructor(refusals: readonly DefinitionRefusal[]) {
    super(refusals.map(definitionRefusalSentence).join(" "));
    this.name = "ProviderDefinitionError";
    this.refusals = Object.freeze([...refusals]);
  }
}

const RECORD_KEYS: readonly string[] = Object.freeze(["contract", "manifest", "impl"]);
const IMPL_KEYS: readonly string[] = Object.freeze(["open", "close", "console"]);
const CONSOLE_KEYS: readonly string[] = Object.freeze(["execute", ...CONSOLE_FACETS]);
const OFFERS: readonly unknown[] = Object.freeze(["offered", "not-offered"]);
const CONTRACT_FORM = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

type Fields = Readonly<Record<string, unknown>>;

/** `value` as a record of fields, when it is an object that is not an array; otherwise undefined. */
function fieldsOf(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : undefined;
}

/** Whether `value` is a plain object: one whose prototype is `Object.prototype` or none. */
function isPlainRecord(value: unknown): value is Fields {
  if (fieldsOf(value) === undefined) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `key` as one reference token of a JSON Pointer. */
function token(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** The own property `key` of `fields`, never one it inherits. */
function own(fields: Fields | undefined, key: string): unknown {
  return fields !== undefined && Object.hasOwn(fields, key) ? fields[key] : undefined;
}

/** A refusal of a contract at `pointer`, naming the contract when it has the form of one. */
function contractRefusal(value: unknown, pointer: string): DefinitionRefusal {
  return typeof value === "string" && CONTRACT_FORM.test(value)
    ? { rule: "contract-not-served", pointer, contract: value }
    : { rule: "contract-not-served", pointer };
}

/**
 * The manifest's console facet offers, each `true` when offered, `false` when not, and absent when it cannot be read,
 * with a refusal for every key the check reads that is missing or of the wrong type.
 */
function readCalls(manifest: Fields, refusals: DefinitionRefusal[]): Partial<Record<string, boolean>> {
  const offers: Partial<Record<string, boolean>> = {};
  const calls = fieldsOf(own(manifest, "calls"));
  if (calls === undefined) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/calls" });
    return offers;
  }
  const consoleCalls = fieldsOf(own(calls, "console"));
  if (consoleCalls === undefined) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/calls/console" });
    return offers;
  }
  const execute = fieldsOf(own(consoleCalls, "execute"));
  if (execute === undefined) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/calls/console/execute" });
  } else if (!Array.isArray(own(execute, "honours"))) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/calls/console/execute/honours" });
  }
  for (const facet of CONSOLE_FACETS) {
    const offer = own(consoleCalls, facet);
    if (OFFERS.includes(offer)) offers[facet] = offer === "offered";
    else refusals.push({ rule: "manifest-unreadable", pointer: `/manifest/calls/console/${facet}` });
  }
  return offers;
}

/** The refusals of each engine's facets: one for a facet this contract has no call for, or for one it cannot read. */
function readEngines(manifest: Fields, refusals: DefinitionRefusal[]): void {
  const engines = own(manifest, "engines");
  if (!Array.isArray(engines)) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/engines" });
    return;
  }
  engines.forEach((engine: unknown, index) => {
    const at = `/manifest/engines/${index}`;
    if (fieldsOf(engine) === undefined) {
      refusals.push({ rule: "manifest-unreadable", pointer: at });
      return;
    }
    const facets = fieldsOf(own(engine as Fields, "facets"));
    if (facets === undefined) {
      refusals.push({ rule: "manifest-unreadable", pointer: `${at}/facets` });
      return;
    }
    const monitoring = fieldsOf(own(facets, "monitoring"));
    if (monitoring === undefined) {
      refusals.push({ rule: "manifest-unreadable", pointer: `${at}/facets/monitoring` });
    } else {
      for (const panel of Object.keys(monitoring)) {
        const offer = monitoring[panel];
        const pointer = `${at}/facets/monitoring/${token(panel)}`;
        if (!OFFERS.includes(offer)) refusals.push({ rule: "manifest-unreadable", pointer });
        else if (offer === "offered") refusals.push({ rule: "engine-facet-without-call", pointer });
      }
    }
    for (const list of ["maintenance", "agentReadings"]) {
      const items = own(facets, list);
      if (!Array.isArray(items)) {
        refusals.push({ rule: "manifest-unreadable", pointer: `${at}/facets/${list}` });
        continue;
      }
      for (let item = 0; item < items.length; item += 1) {
        refusals.push({ rule: "engine-facet-without-call", pointer: `${at}/facets/${list}/${item}` });
      }
    }
  });
}

/** The refusals of the implementation against the facets the manifest offers. */
function readImpl(value: unknown, offers: Partial<Record<string, boolean>>, refusals: DefinitionRefusal[]): void {
  const impl = fieldsOf(value);
  const consoleImpl = fieldsOf(own(impl, "console"));
  for (const key of Object.keys(impl ?? {})) {
    if (!IMPL_KEYS.includes(key)) refusals.push({ rule: "impl-key-unknown", pointer: `/impl/${token(key)}`, key });
  }
  for (const call of ["open", "close"]) {
    if (typeof own(impl, call) !== "function")
      refusals.push({ rule: "call-missing", pointer: `/impl/${call}`, name: call });
  }
  for (const key of Object.keys(consoleImpl ?? {})) {
    if (!CONSOLE_KEYS.includes(key)) {
      refusals.push({ rule: "impl-key-unknown", pointer: `/impl/console/${token(key)}`, key });
    }
  }
  if (typeof own(consoleImpl, "execute") !== "function") {
    refusals.push({ rule: "call-missing", pointer: "/impl/console/execute", name: "console.execute" });
  }
  for (const facet of CONSOLE_FACETS) {
    const offered = offers[facet];
    const pointer = `/impl/console/${facet}`;
    const name = `console.${facet}`;
    if (offered === true && typeof own(consoleImpl, facet) !== "function") {
      refusals.push({ rule: "facet-unimplemented", pointer, name });
    } else if (offered === false && consoleImpl !== undefined && Object.hasOwn(consoleImpl, facet)) {
      refusals.push({ rule: "facet-undeclared", pointer, name });
    }
  }
}

/**
 * Every way `value` is not a provider module record this SDK serves, in the order the record is read: its keys, the
 * two contracts, the manifest's calls, its engines' facets, and the implementation. A value that is not a plain record
 * with exactly its three keys, or one built against another contract, is refused without reading further.
 */
export function checkProviderModule(value: unknown): readonly DefinitionRefusal[] {
  if (!isPlainRecord(value)) return [{ rule: "module-not-a-record", pointer: "" }];
  const keyRefusals: DefinitionRefusal[] = [
    ...Object.keys(value).filter((key) => !RECORD_KEYS.includes(key)),
    ...RECORD_KEYS.filter((key) => !Object.hasOwn(value, key)),
  ].map((key) => ({ rule: "module-not-a-record", pointer: "", key }));
  if (keyRefusals.length > 0) return keyRefusals;

  const manifest = fieldsOf(value.manifest);
  if (manifest === undefined) return [{ rule: "manifest-unreadable", pointer: "/manifest" }];
  const refusals: DefinitionRefusal[] = [];
  if (value.contract !== PROVIDER_CONTRACT) refusals.push(contractRefusal(value.contract, "/contract"));
  if (!Object.hasOwn(manifest, "contract")) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/contract" });
  } else if (manifest.contract !== PROVIDER_CONTRACT) {
    refusals.push(contractRefusal(manifest.contract, "/manifest/contract"));
  }
  if (refusals.length > 0) return refusals;

  const offers = readCalls(manifest, refusals);
  readEngines(manifest, refusals);
  readImpl(value.impl, offers, refusals);
  return refusals;
}

/** `value` frozen, with every object and array it holds, at every depth. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/**
 * The record a package's entry default-exports, for the manifest it was built with and its implementation.
 *
 * The record is frozen. Its manifest is a deep-frozen `structuredClone` of the one passed, so freezing never touches
 * the package's own object, which an import may share; a manifest holding a value JSON cannot hold, such as a function,
 * makes the clone throw its `DataCloneError`. The implementation and its `console` are frozen in place, so the
 * functions the check read are the ones the host calls.
 *
 * @throws {ProviderDefinitionError} With every refusal `checkProviderModule` answers, before anything is cloned or
 * frozen.
 */
export function defineProvider<Handle>(manifest: unknown, impl: ProviderImpl<Handle>): ProviderModule {
  const refusals = checkProviderModule({ contract: PROVIDER_CONTRACT, manifest, impl });
  if (refusals.length > 0) throw new ProviderDefinitionError(refusals);
  const copy = deepFreeze(structuredClone(manifest));
  Object.freeze(impl.console);
  return Object.freeze({ contract: PROVIDER_CONTRACT, manifest: copy, impl: Object.freeze(impl) });
}

/**
 * A refusal in one sentence for people, naming where it is and, for a key, which, quoted as a JSON string so the
 * sentence stays one line; never a value of the manifest or the implementation.
 */
export function definitionRefusalSentence(refusal: DefinitionRefusal): string {
  const at = refusal.pointer === "" ? "the top level" : refusal.pointer;
  const key = JSON.stringify(refusal.key ?? "");
  const name = refusal.name === undefined ? "" : ` ${refusal.name}`;
  switch (refusal.rule) {
    case "module-not-a-record":
      return refusal.key === undefined
        ? `The value at ${at} is not a provider module record, a plain object with exactly the keys contract, manifest and impl.`
        : `The key ${key} is missing from the provider module record at ${at}, or is not one of its keys contract, manifest and impl.`;
    case "contract-not-served":
      return refusal.contract === undefined
        ? `The value at ${at} is not the provider contract this SDK serves.`
        : `The value at ${at} names provider contract ${refusal.contract}, which this SDK does not serve.`;
    case "manifest-unreadable":
      return `The manifest value at ${at}, which defining a provider reads, is missing or not of the type the provider contract defines there.`;
    case "impl-key-unknown":
      return `The implementation has the key ${key} at ${at}, for which the provider contract defines no call.`;
    case "call-missing":
      return `The implementation has no function of its own at ${at} for a mandatory call${name}.`;
    case "facet-undeclared":
      return `The implementation answers the console facet${name} at ${at}, which the manifest declares not-offered.`;
    case "facet-unimplemented":
      return `The manifest offers the console facet${name}, for which the implementation has no function of its own at ${at}.`;
    case "engine-facet-without-call":
      return `The engine facet at ${at} is offered, and this provider contract has no call that serves it yet.`;
  }
}
