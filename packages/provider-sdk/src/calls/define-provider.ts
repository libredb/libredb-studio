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
 * manifest's and a cast would hide a mismatch. Every key the check reads is read as an own data property, by its
 * descriptor: a method a class instance inherits is not read, and a getter is never called but refused, so the
 * functions checked are the functions the host calls. No refusal carries a value of the manifest or the
 * implementation; a contract is named only when it has the form `MAJOR.MINOR`.
 */
import { type Fields, fieldsOf, isPlainRecord, type OwnRead, readOwn, token, valueOf } from "./records";
import {
  CONSOLE_FACETS,
  EXECUTE_REQUEST_FIELDS,
  PROVIDER_CONTRACT,
  type ProviderImpl,
  type ProviderModule,
} from "./types";

/** Every rule a definition refusal can name. */
export const DEFINITION_REFUSAL_RULES = Object.freeze([
  "module-not-a-record",
  "contract-not-served",
  "manifest-unreadable",
  "property-not-data",
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
const REQUEST_FIELDS: readonly unknown[] = EXECUTE_REQUEST_FIELDS;
const CONTRACT_FORM = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/**
 * The own property `key` of `target`, read by its descriptor, with a `property-not-data` refusal at `pointer` when it
 * is an accessor, whose getter is never called.
 */
function own(target: unknown, key: string, pointer: string, refusals: DefinitionRefusal[]): OwnRead {
  const read = readOwn(target, key);
  if (read.kind === "accessor") refusals.push({ rule: "property-not-data", pointer });
  return read;
}

/** A refusal of a contract at `pointer`, naming the contract when it has the form of one. */
function contractRefusal(value: unknown, pointer: string): DefinitionRefusal {
  return typeof value === "string" && CONTRACT_FORM.test(value)
    ? { rule: "contract-not-served", pointer, contract: value }
    : { rule: "contract-not-served", pointer };
}

/**
 * `fields[key]` as a record of fields, or undefined with a refusal at `pointer`: `property-not-data` for an accessor,
 * `manifest-unreadable` for a value that is missing or no record.
 */
function manifestRecord(
  fields: Fields,
  key: string,
  pointer: string,
  refusals: DefinitionRefusal[],
): Fields | undefined {
  const read = own(fields, key, pointer, refusals);
  if (read.kind === "accessor") return undefined;
  const record = fieldsOf(valueOf(read));
  if (record === undefined) refusals.push({ rule: "manifest-unreadable", pointer });
  return record;
}

/**
 * The refusals of execute's `honours`: it must be a list of request fields, each listed once. A list longer than the
 * request fields cannot be one, so it is refused as `manifest-unreadable` by its length, before any item is read: a
 * sparse array's length bounds no loop over it.
 */
function readHonours(execute: Fields, refusals: DefinitionRefusal[]): void {
  const pointer = "/manifest/calls/console/execute/honours";
  const read = own(execute, "honours", pointer, refusals);
  if (read.kind === "accessor") return;
  const honours = valueOf(read);
  if (!Array.isArray(honours) || honours.length > REQUEST_FIELDS.length) {
    refusals.push({ rule: "manifest-unreadable", pointer });
    return;
  }
  const seen: unknown[] = [];
  for (let index = 0; index < honours.length; index += 1) {
    const item = own(honours, String(index), `${pointer}/${index}`, refusals);
    if (item.kind === "accessor") continue;
    const field = valueOf(item);
    if (!REQUEST_FIELDS.includes(field) || seen.includes(field)) {
      refusals.push({ rule: "manifest-unreadable", pointer: `${pointer}/${index}` });
    }
    seen.push(field);
  }
}

/**
 * The manifest's console facet offers, each `true` when offered, `false` when not, and absent when it cannot be read,
 * with a refusal for every key the check reads that is missing, of the wrong type or an accessor.
 */
function readCalls(manifest: Fields, refusals: DefinitionRefusal[]): Partial<Record<string, boolean>> {
  const offers: Partial<Record<string, boolean>> = {};
  const calls = manifestRecord(manifest, "calls", "/manifest/calls", refusals);
  if (calls === undefined) return offers;
  const consoleCalls = manifestRecord(calls, "console", "/manifest/calls/console", refusals);
  if (consoleCalls === undefined) return offers;
  const execute = manifestRecord(consoleCalls, "execute", "/manifest/calls/console/execute", refusals);
  if (execute !== undefined) readHonours(execute, refusals);
  for (const facet of CONSOLE_FACETS) {
    const pointer = `/manifest/calls/console/${facet}`;
    const read = own(consoleCalls, facet, pointer, refusals);
    if (read.kind === "accessor") continue;
    const offer = valueOf(read);
    if (OFFERS.includes(offer)) offers[facet] = offer === "offered";
    else refusals.push({ rule: "manifest-unreadable", pointer });
  }
  return offers;
}

/** The refusals of one engine's facets: one for a facet this contract has no call for, or for one it cannot read. */
function readFacets(engine: Fields, at: string, refusals: DefinitionRefusal[]): void {
  const facets = manifestRecord(engine, "facets", `${at}/facets`, refusals);
  if (facets === undefined) return;
  const monitoring = manifestRecord(facets, "monitoring", `${at}/facets/monitoring`, refusals);
  if (monitoring !== undefined) {
    for (const panel of Object.keys(monitoring)) {
      const pointer = `${at}/facets/monitoring/${token(panel)}`;
      const read = own(monitoring, panel, pointer, refusals);
      if (read.kind === "accessor") continue;
      const offer = valueOf(read);
      if (!OFFERS.includes(offer)) refusals.push({ rule: "manifest-unreadable", pointer });
      else if (offer === "offered") refusals.push({ rule: "engine-facet-without-call", pointer });
    }
  }
  for (const list of ["maintenance", "agentReadings"]) {
    const pointer = `${at}/facets/${list}`;
    const read = own(facets, list, pointer, refusals);
    if (read.kind === "accessor") continue;
    const items = valueOf(read);
    if (!Array.isArray(items)) {
      refusals.push({ rule: "manifest-unreadable", pointer });
      continue;
    }
    for (let item = 0; item < items.length; item += 1) {
      refusals.push({ rule: "engine-facet-without-call", pointer: `${pointer}/${item}` });
    }
  }
}

/** The refusals of each engine's facets. */
function readEngines(manifest: Fields, refusals: DefinitionRefusal[]): void {
  const read = own(manifest, "engines", "/manifest/engines", refusals);
  if (read.kind === "accessor") return;
  const engines = valueOf(read);
  if (!Array.isArray(engines)) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/engines" });
    return;
  }
  for (let index = 0; index < engines.length; index += 1) {
    const at = `/manifest/engines/${index}`;
    const item = own(engines, String(index), at, refusals);
    if (item.kind === "accessor") continue;
    const engine = fieldsOf(valueOf(item));
    if (engine === undefined) refusals.push({ rule: "manifest-unreadable", pointer: at });
    else readFacets(engine, at, refusals);
  }
}

/** The refusals of the implementation against the facets the manifest offers. */
function readImpl(value: unknown, offers: Partial<Record<string, boolean>>, refusals: DefinitionRefusal[]): void {
  const impl = fieldsOf(value);
  for (const key of Object.keys(impl ?? {})) {
    if (!IMPL_KEYS.includes(key)) refusals.push({ rule: "impl-key-unknown", pointer: `/impl/${token(key)}`, key });
  }
  for (const call of ["open", "close"]) {
    const pointer = `/impl/${call}`;
    const read = own(impl, call, pointer, refusals);
    if (read.kind !== "accessor" && typeof valueOf(read) !== "function") {
      refusals.push({ rule: "call-missing", pointer, name: call });
    }
  }
  const consoleRead = own(impl, "console", "/impl/console", refusals);
  if (consoleRead.kind === "accessor") return;
  const consoleImpl = fieldsOf(valueOf(consoleRead));
  for (const key of Object.keys(consoleImpl ?? {})) {
    if (!CONSOLE_KEYS.includes(key)) {
      refusals.push({ rule: "impl-key-unknown", pointer: `/impl/console/${token(key)}`, key });
    }
  }
  const execute = own(consoleImpl, "execute", "/impl/console/execute", refusals);
  if (execute.kind !== "accessor" && typeof valueOf(execute) !== "function") {
    refusals.push({ rule: "call-missing", pointer: "/impl/console/execute", name: "console.execute" });
  }
  for (const facet of CONSOLE_FACETS) {
    const offered = offers[facet];
    const pointer = `/impl/console/${facet}`;
    const name = `console.${facet}`;
    const read = own(consoleImpl, facet, pointer, refusals);
    if (read.kind === "accessor") continue;
    if (offered === true && typeof valueOf(read) !== "function") {
      refusals.push({ rule: "facet-unimplemented", pointer, name });
    } else if (offered === false && read.kind === "data") {
      refusals.push({ rule: "facet-undeclared", pointer, name });
    }
  }
}

/**
 * Every way `value` is not a provider module record this SDK serves, in the order the record is read: its keys, the
 * two contracts, the manifest's calls, its engines' facets, and the implementation. A value that is not a plain record
 * with exactly its three keys, or one built against another contract, is refused without reading further.
 *
 * Every key the check reads is read by its own property descriptor, so a getter is never called: an accessor is
 * refused as `property-not-data`, and nothing under it is read or refused. The check never throws for a value that is
 * not a Proxy.
 */
export function checkProviderModule(value: unknown): readonly DefinitionRefusal[] {
  if (!isPlainRecord(value)) return [{ rule: "module-not-a-record", pointer: "" }];
  const keyRefusals: DefinitionRefusal[] = [
    ...Object.keys(value).filter((key) => !RECORD_KEYS.includes(key)),
    ...RECORD_KEYS.filter((key) => !Object.hasOwn(value, key)),
  ].map((key) => ({ rule: "module-not-a-record", pointer: "", key }));
  if (keyRefusals.length > 0) return keyRefusals;

  const refusals: DefinitionRefusal[] = [];
  const manifestRead = own(value, "manifest", "/manifest", refusals);
  if (manifestRead.kind === "accessor") return refusals;
  const manifest = fieldsOf(valueOf(manifestRead));
  if (manifest === undefined) return [{ rule: "manifest-unreadable", pointer: "/manifest" }];
  const contract = own(value, "contract", "/contract", refusals);
  if (contract.kind === "data" && contract.value !== PROVIDER_CONTRACT) {
    refusals.push(contractRefusal(contract.value, "/contract"));
  }
  const manifestContract = own(manifest, "contract", "/manifest/contract", refusals);
  if (manifestContract.kind === "absent") {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/contract" });
  } else if (manifestContract.kind === "data" && manifestContract.value !== PROVIDER_CONTRACT) {
    refusals.push(contractRefusal(manifestContract.value, "/manifest/contract"));
  }
  if (refusals.length > 0) return refusals;

  const offers = readCalls(manifest, refusals);
  readEngines(manifest, refusals);
  const impl = own(value, "impl", "/impl", refusals);
  if (impl.kind === "data") readImpl(impl.value, offers, refusals);
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
 * A refusal in one sentence for people, naming where it is and, for a key, which, each quoted as a JSON string so the
 * sentence stays one line; never a value of the manifest or the implementation.
 */
export function definitionRefusalSentence(refusal: DefinitionRefusal): string {
  const at = refusal.pointer === "" ? "the top level" : JSON.stringify(refusal.pointer);
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
    case "property-not-data":
      return `The value at ${at} is an accessor, whose getter was not called, where the provider contract reads only a data property.`;
    case "facet-undeclared":
      return `The implementation has the key${name} at ${at}, a console facet the manifest declares not-offered.`;
    case "facet-unimplemented":
      return `The manifest offers the console facet${name}, for which the implementation has no function of its own at ${at}.`;
    case "engine-facet-without-call":
      return `The engine facet at ${at} is offered, and this provider contract has no call that serves it yet.`;
  }
}
