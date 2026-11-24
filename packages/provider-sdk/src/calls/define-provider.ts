/**
 * The provider module record and its check (docs/providers/CONTRACT.md, clauses C-1, C-3, C-4, C-67, C-71 and C-72).
 *
 * A package's entry default-exports what `defineProvider` returns: `{ contract, manifest, impl }`. `checkProviderModule`
 * reads any value as such a record and answers every way it is not one, each a refusal naming its rule and a JSON
 * Pointer into the record. The loader runs it on the entry's default export, so a record another copy of the SDK built
 * is checked by the host's copy.
 *
 * The check reads only what the calls need: the two contracts, the manifest's `calls` segment, its console facets, its
 * object facets, its maintenance facets and its monitoring facets, each engine's facets, of each maintenance spec only
 * whether it previews, and the implementation's functions. An engine's maintenance operation is admitted only where the
 * manifest offers `maintenance.run`, a spec that previews only where it offers `maintenance.preview`, and an offered
 * monitoring panel only where it offers `monitoring.panel`, and an agent reading only where the call that serves it is
 * offered: a panel reading where it offers `monitoring.panel`, and health always, since the health call is mandatory.
 * Validating the manifest against the schema is the loader's, which holds the schema bytes; a
 * manifest is typed `unknown` here and read defensively, because a JSON import's type is wider than the manifest's and
 * a cast would hide a mismatch. Every key the check reads is read as an own data property, by its descriptor: a method
 * a class instance inherits is not read, and a getter is never called but refused, so the functions checked are the
 * functions the host calls. No refusal carries a value of the manifest or the implementation; a contract is named only
 * when it has the form `MAJOR.MINOR`.
 */
import { type Fields, fieldsOf, isPlainRecord, type OwnRead, readOwn, token, valueOf } from "./records";
import {
  AGENT_READING_PANELS,
  CONSOLE_FACETS,
  EXECUTE_REQUEST_FIELDS,
  MAINTENANCE_FACETS,
  MONITORING_FACETS,
  OBJECTS_FACETS,
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
  "impl-segment-not-a-record",
  "call-missing",
  "facet-undeclared",
  "facet-unimplemented",
  "engine-facet-call-not-offered",
] as const);

export type DefinitionRefusalRule = (typeof DEFINITION_REFUSAL_RULES)[number];

/** One way a value is not a provider module record. */
export interface DefinitionRefusal {
  readonly rule: DefinitionRefusalRule;
  /** A JSON Pointer into the record; the empty string is the record itself. */
  readonly pointer: string;
  /**
   * The key, for a record or implementation key the contract does not define, a record key that is missing, or an
   * implementation segment that is not a record.
   */
  readonly key?: string;
  /** The call or facet, by its contract name, such as `console.cancel` or `objects.tree`. */
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
const IMPL_KEYS: readonly string[] = Object.freeze([
  "open",
  "close",
  "health",
  "console",
  "objects",
  "maintenance",
  "monitoring",
]);
/** The mandatory calls at the top level of the implementation, in the order they are read. */
const MANDATORY_CALLS: readonly string[] = Object.freeze(["open", "close", "health"]);
const CONSOLE_KEYS: readonly string[] = Object.freeze(["execute", ...CONSOLE_FACETS]);
const OFFERS: readonly unknown[] = Object.freeze(["offered", "not-offered"]);
const REQUEST_FIELDS: readonly unknown[] = EXECUTE_REQUEST_FIELDS;
/**
 * The longest engine list the schema admits, its `/properties/engines/maxItems`; packages/provider-sdk/tests holds it
 * to the schema file.
 */
const ENGINES_MAX = 64;
/**
 * The longest maintenance, maintenance specs and agent readings lists the schema admits, each list's `maxItems` under
 * `/$defs/facets/properties`: the size of the maintenance or readings vocabulary, since each item is listed once and a
 * spec is stated once for each operation listed.
 */
const FACET_LISTS_MAX: Readonly<Record<"maintenance" | "maintenanceSpecs" | "agentReadings", number>> = Object.freeze({
  maintenance: 11,
  maintenanceSpecs: 11,
  agentReadings: 6,
});
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
  fields: unknown,
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

/** A facet's offer, by its contract name such as `console.cancel`: `true` when offered, `false` when not. */
type Offers = Partial<Record<string, boolean>>;

/**
 * The offers of `facets` in `segment`, the manifest's `calls.<segment>`, each recorded under its contract name, with a
 * refusal for every offer that is missing, of the wrong type or an accessor.
 */
function readOffers(
  segment: Fields,
  name: string,
  facets: readonly string[],
  offers: Offers,
  refusals: DefinitionRefusal[],
): void {
  for (const facet of facets) {
    const pointer = `/manifest/calls/${name}/${facet}`;
    const read = own(segment, facet, pointer, refusals);
    if (read.kind === "accessor") continue;
    const offer = valueOf(read);
    if (OFFERS.includes(offer)) offers[`${name}.${facet}`] = offer === "offered";
    else refusals.push({ rule: "manifest-unreadable", pointer });
  }
}

/**
 * The manifest's console, object, maintenance and monitoring facet offers, by contract name, each `true` when offered,
 * `false` when not, and absent when it cannot be read, with a refusal for every key the check reads that is missing, of
 * the wrong type or an accessor.
 */
function readCalls(manifest: Fields, refusals: DefinitionRefusal[]): Offers {
  const offers: Offers = {};
  const calls = manifestRecord(manifest, "calls", "/manifest/calls", refusals);
  if (calls === undefined) return offers;
  const consoleCalls = manifestRecord(calls, "console", "/manifest/calls/console", refusals);
  if (consoleCalls !== undefined) {
    const execute = manifestRecord(consoleCalls, "execute", "/manifest/calls/console/execute", refusals);
    if (execute !== undefined) readHonours(execute, refusals);
    readOffers(consoleCalls, "console", CONSOLE_FACETS, offers, refusals);
  }
  const objectsCalls = manifestRecord(calls, "objects", "/manifest/calls/objects", refusals);
  if (objectsCalls !== undefined) readOffers(objectsCalls, "objects", OBJECTS_FACETS, offers, refusals);
  const maintenanceCalls = manifestRecord(calls, "maintenance", "/manifest/calls/maintenance", refusals);
  if (maintenanceCalls !== undefined) {
    readOffers(maintenanceCalls, "maintenance", MAINTENANCE_FACETS, offers, refusals);
  }
  const monitoringCalls = manifestRecord(calls, "monitoring", "/manifest/calls/monitoring", refusals);
  if (monitoringCalls !== undefined) readOffers(monitoringCalls, "monitoring", MONITORING_FACETS, offers, refusals);
  return offers;
}

/**
 * The facet list `list` of an engine's `facets`, or undefined with a refusal at its pointer: `property-not-data` for
 * an accessor, `manifest-unreadable` for a value that is no list or is longer than the schema admits, refused by its
 * length before any item is read, since a sparse array's length bounds no loop over it.
 */
function facetList(
  facets: Fields,
  list: keyof typeof FACET_LISTS_MAX,
  pointer: string,
  refusals: DefinitionRefusal[],
): readonly unknown[] | undefined {
  const read = own(facets, list, pointer, refusals);
  if (read.kind === "accessor") return undefined;
  const items = valueOf(read);
  if (Array.isArray(items) && items.length <= FACET_LISTS_MAX[list]) return items;
  refusals.push({ rule: "manifest-unreadable", pointer });
  return undefined;
}

/**
 * The refusals of an engine's monitoring panels: each must be a facet offer, and an offered one is refused by name as
 * `engine-facet-call-not-offered` where the manifest declares `monitoring.panel` not-offered. An offer that could not
 * be read refuses nothing more here, since its own refusal names it.
 */
function readMonitoring(facets: Fields, at: string, offers: Offers, refusals: DefinitionRefusal[]): void {
  const monitoring = manifestRecord(facets, "monitoring", `${at}/facets/monitoring`, refusals);
  if (monitoring === undefined) return;
  for (const panel of Object.keys(monitoring)) {
    const pointer = `${at}/facets/monitoring/${token(panel)}`;
    const read = own(monitoring, panel, pointer, refusals);
    if (read.kind === "accessor") continue;
    const offer = valueOf(read);
    if (!OFFERS.includes(offer)) refusals.push({ rule: "manifest-unreadable", pointer });
    else if (offer === "offered" && offers["monitoring.panel"] === false) {
      refusals.push({ rule: "engine-facet-call-not-offered", pointer, name: "monitoring.panel" });
    }
  }
}

/**
 * The refusals of an engine's maintenance list: each operation listed is refused by name as
 * `engine-facet-call-not-offered` where the manifest declares `maintenance.run` not-offered. An offer that could not be
 * read refuses nothing more here, since its own refusal names it; no item is read, since its vocabulary is the
 * validator's.
 */
function readMaintenance(facets: Fields, at: string, offers: Offers, refusals: DefinitionRefusal[]): void {
  const pointer = `${at}/facets/maintenance`;
  const items = facetList(facets, "maintenance", pointer, refusals);
  if (items === undefined || offers["maintenance.run"] !== false) return;
  for (let item = 0; item < items.length; item += 1) {
    refusals.push({ rule: "engine-facet-call-not-offered", pointer: `${pointer}/${item}`, name: "maintenance.run" });
  }
}

/**
 * The refusals of an engine's maintenance specs, of which only `preview` is read: each spec must be a record whose
 * `preview` is a boolean, and one that previews is refused by name as `engine-facet-call-not-offered` where the
 * manifest declares `maintenance.preview` not-offered. Every other rule of a spec is the validator's.
 */
function readMaintenanceSpecs(facets: Fields, at: string, offers: Offers, refusals: DefinitionRefusal[]): void {
  const pointer = `${at}/facets/maintenanceSpecs`;
  const specs = facetList(facets, "maintenanceSpecs", pointer, refusals);
  if (specs === undefined) return;
  for (let index = 0; index < specs.length; index += 1) {
    const spec = manifestRecord(specs, String(index), `${pointer}/${index}`, refusals);
    if (spec === undefined) continue;
    const previewPointer = `${pointer}/${index}/preview`;
    const read = own(spec, "preview", previewPointer, refusals);
    if (read.kind === "accessor") continue;
    const preview = valueOf(read);
    if (typeof preview !== "boolean") refusals.push({ rule: "manifest-unreadable", pointer: previewPointer });
    else if (preview && offers["maintenance.preview"] === false) {
      refusals.push({ rule: "engine-facet-call-not-offered", pointer: previewPointer, name: "maintenance.preview" });
    }
  }
}

/**
 * The refusals of an engine's agent readings: a panel reading, one `AGENT_READING_PANELS` names a panel for, is refused
 * by name as `engine-facet-call-not-offered` where the manifest declares `monitoring.panel` not-offered, and `health`,
 * which the mandatory health call serves, is never refused. An offer that could not be read refuses nothing more here,
 * since its own refusal names it; an item outside the readings vocabulary is the validator's.
 */
function readAgentReadings(facets: Fields, at: string, offers: Offers, refusals: DefinitionRefusal[]): void {
  const pointer = `${at}/facets/agentReadings`;
  const items = facetList(facets, "agentReadings", pointer, refusals);
  if (items === undefined || offers["monitoring.panel"] !== false) return;
  for (let index = 0; index < items.length; index += 1) {
    const read = own(items, String(index), `${pointer}/${index}`, refusals);
    if (read.kind === "accessor") continue;
    const reading = valueOf(read);
    const isReading = typeof reading === "string" && Object.hasOwn(AGENT_READING_PANELS, reading);
    if (isReading && AGENT_READING_PANELS[reading as keyof typeof AGENT_READING_PANELS] !== null) {
      refusals.push({
        rule: "engine-facet-call-not-offered",
        pointer: `${pointer}/${index}`,
        name: "monitoring.panel",
      });
    }
  }
}

/**
 * The refusals of one engine's facets, in the order the schema states them: its monitoring panels, its maintenance
 * list, its maintenance specs and its agent readings.
 */
function readFacets(engine: Fields, at: string, offers: Offers, refusals: DefinitionRefusal[]): void {
  const facets = manifestRecord(engine, "facets", `${at}/facets`, refusals);
  if (facets === undefined) return;
  readMonitoring(facets, at, offers, refusals);
  readMaintenance(facets, at, offers, refusals);
  readMaintenanceSpecs(facets, at, offers, refusals);
  readAgentReadings(facets, at, offers, refusals);
}

/**
 * The refusals of each engine's facets. An engine list longer than the schema admits is refused as
 * `manifest-unreadable` by its length, before any engine is read: a sparse array's length bounds no loop over it.
 */
function readEngines(manifest: Fields, offers: Offers, refusals: DefinitionRefusal[]): void {
  const read = own(manifest, "engines", "/manifest/engines", refusals);
  if (read.kind === "accessor") return;
  const engines = valueOf(read);
  if (!Array.isArray(engines) || engines.length > ENGINES_MAX) {
    refusals.push({ rule: "manifest-unreadable", pointer: "/manifest/engines" });
    return;
  }
  for (let index = 0; index < engines.length; index += 1) {
    const at = `/manifest/engines/${index}`;
    const item = own(engines, String(index), at, refusals);
    if (item.kind === "accessor") continue;
    const engine = fieldsOf(valueOf(item));
    if (engine === undefined) refusals.push({ rule: "manifest-unreadable", pointer: at });
    else readFacets(engine, at, offers, refusals);
  }
}

/**
 * The refusals of `facets` under `segmentImpl`, the implementation's `<segment>`, against the offers the manifest
 * declares: an offered facet with no function of its own, and a key for one declared not-offered.
 */
function readFacetImpls(
  segmentImpl: Fields | undefined,
  segment: string,
  facets: readonly string[],
  offers: Offers,
  refusals: DefinitionRefusal[],
): void {
  for (const facet of facets) {
    const name = `${segment}.${facet}`;
    const offered = offers[name];
    const pointer = `/impl/${segment}/${facet}`;
    const read = own(segmentImpl, facet, pointer, refusals);
    if (read.kind === "accessor") continue;
    if (offered === true && typeof valueOf(read) !== "function") {
      refusals.push({ rule: "facet-unimplemented", pointer, name });
    } else if (offered === false && read.kind === "data") {
      refusals.push({ rule: "facet-undeclared", pointer, name });
    }
  }
}

/**
 * The implementation's `<segment>` read as a record, with an `impl-key-unknown` refusal for each key not in `keys`.
 * A segment that is present and not a record, such as `null`, a string or an array, is refused by name as
 * `impl-segment-not-a-record`, and like an accessor nothing under it is read; an absent one, or one that is
 * `undefined`, reads as a record of no key.
 */
function segmentOf(
  impl: Fields | undefined,
  segment: string,
  keys: readonly string[],
  refusals: DefinitionRefusal[],
): { readonly unread: true } | { readonly unread: false; readonly fields: Fields | undefined } {
  const pointer = `/impl/${segment}`;
  const read = own(impl, segment, pointer, refusals);
  if (read.kind === "accessor") return { unread: true };
  const value = valueOf(read);
  const fields = fieldsOf(value);
  if (value !== undefined && fields === undefined) {
    refusals.push({ rule: "impl-segment-not-a-record", pointer, key: segment });
    return { unread: true };
  }
  for (const key of Object.keys(fields ?? {})) {
    if (!keys.includes(key)) {
      refusals.push({ rule: "impl-key-unknown", pointer: `/impl/${segment}/${token(key)}`, key });
    }
  }
  return { unread: false, fields };
}

/** The refusals of the implementation against the facets the manifest offers. */
function readImpl(value: unknown, offers: Offers, refusals: DefinitionRefusal[]): void {
  const impl = fieldsOf(value);
  for (const key of Object.keys(impl ?? {})) {
    if (!IMPL_KEYS.includes(key)) refusals.push({ rule: "impl-key-unknown", pointer: `/impl/${token(key)}`, key });
  }
  for (const call of MANDATORY_CALLS) {
    const pointer = `/impl/${call}`;
    const read = own(impl, call, pointer, refusals);
    if (read.kind !== "accessor" && typeof valueOf(read) !== "function") {
      refusals.push({ rule: "call-missing", pointer, name: call });
    }
  }
  const consoleSegment = segmentOf(impl, "console", CONSOLE_KEYS, refusals);
  if (!consoleSegment.unread) {
    const consoleImpl = consoleSegment.fields;
    const execute = own(consoleImpl, "execute", "/impl/console/execute", refusals);
    if (execute.kind !== "accessor" && typeof valueOf(execute) !== "function") {
      refusals.push({ rule: "call-missing", pointer: "/impl/console/execute", name: "console.execute" });
    }
    readFacetImpls(consoleImpl, "console", CONSOLE_FACETS, offers, refusals);
  }
  const objectsSegment = segmentOf(impl, "objects", OBJECTS_FACETS, refusals);
  if (!objectsSegment.unread) readFacetImpls(objectsSegment.fields, "objects", OBJECTS_FACETS, offers, refusals);
  const maintenanceSegment = segmentOf(impl, "maintenance", MAINTENANCE_FACETS, refusals);
  if (!maintenanceSegment.unread) {
    readFacetImpls(maintenanceSegment.fields, "maintenance", MAINTENANCE_FACETS, offers, refusals);
  }
  const monitoringSegment = segmentOf(impl, "monitoring", MONITORING_FACETS, refusals);
  if (!monitoringSegment.unread) {
    readFacetImpls(monitoringSegment.fields, "monitoring", MONITORING_FACETS, offers, refusals);
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
  readEngines(manifest, offers, refusals);
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
 * makes the clone throw its `DataCloneError`. The implementation, its `console`, and its `objects`, `maintenance` and
 * `monitoring`, where it has them, are frozen in place, so the functions the check read are the ones the host calls.
 *
 * @throws {ProviderDefinitionError} With every refusal `checkProviderModule` answers, before anything is cloned or
 * frozen.
 */
export function defineProvider<Handle>(manifest: unknown, impl: ProviderImpl<Handle>): ProviderModule {
  const refusals = checkProviderModule({ contract: PROVIDER_CONTRACT, manifest, impl });
  if (refusals.length > 0) throw new ProviderDefinitionError(refusals);
  const copy = deepFreeze(structuredClone(manifest));
  Object.freeze(impl.console);
  if (impl.objects !== undefined) Object.freeze(impl.objects);
  if (impl.maintenance !== undefined) Object.freeze(impl.maintenance);
  if (impl.monitoring !== undefined) Object.freeze(impl.monitoring);
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
    case "impl-segment-not-a-record":
      return `The implementation segment ${key} at ${at} is not a record of its calls, an object that is not an array, so nothing under it was read.`;
    case "call-missing":
      return `The implementation has no function of its own at ${at} for a mandatory call${name}.`;
    case "property-not-data":
      return `The value at ${at} is an accessor, whose getter was not called, where the provider contract reads only a data property.`;
    case "facet-undeclared":
      return `The implementation has the key${name} at ${at}, a facet the manifest declares not-offered.`;
    case "facet-unimplemented":
      return `The manifest offers the facet${name}, for which the implementation has no function of its own at ${at}.`;
    case "engine-facet-call-not-offered":
      return `The engine facet at ${at} is offered, and the manifest does not offer the call${name} that serves it.`;
  }
}
