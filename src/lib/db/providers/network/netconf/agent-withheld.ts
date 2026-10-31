/**
 * What agent mode withholds on a NETCONF device, decided from the YANG modules the device itself serves.
 *
 * A device's configuration and state are its management data, so the agent reads them. Withheld, because they hold
 * what the device is reached and authorized with, are these kinds, each named by its own identifier:
 *
 *   ietf-keystore            the module whole: every node in its namespace (RFC 9642, the device's keys)
 *   ietf-netconf-acm         the module whole: every node in its namespace (RFC 8341, the access control rules)
 *   nacm:default-deny-all    every data node a module marks with this extension, and its subtree (RFC 8341 section
 *                            3.5.1.2: the protocol's own mark for a node too sensitive to read by default)
 *   crypt-hash               every leaf whose type is `crypt-hash` of iana-crypt-hash or of ietf-system (RFC 7317
 *                            section 5), or a typedef or union that derives from it
 *   ietf-crypto-types secret every node of the `private-key-type`, `key-type` and `password-type` choices of
 *                            ietf-crypto-types (RFC 9640 section 2.1): cleartext, hidden and encrypted private keys,
 *                            symmetric keys and passwords
 *   unresolved leafref       every leafref whose target Studio cannot find in the modules the device serves, and
 *                            every leaf whose type names a typedef no module the device serves declares (what it
 *                            derives from is unknown, so it could be a password hash or a leafref to a withheld node)
 *
 * A leafref carries the value of the leaf it points at, so a leafref that may point at a withheld node, through its
 * own `type leafref`, a typedef or a union deriving from one, a relative path anchored at the leaf, or another
 * leafref, is withheld with that node's kind, to a fixed point; one whose path steps into ietf-keystore or
 * ietf-netconf-acm is withheld with that module's kind (RFC 9642's `asymmetric-key-ref` is such a typedef).
 *
 * The marks, the types and the choices are read from the module texts the device serves with `<get-schema>`, never
 * from a list of node names Studio keeps: a node is withheld because its own module says what it is. RFC 9640 defines
 * no key typedef, so the key material is reached through its choices, and its cleartext leaves also carry the
 * default-deny-all mark. A list whose key leaf is withheld is withheld entry by entry, since an entry's path would
 * carry the key (`keyed by a withheld leaf`).
 *
 * WHY BY NAME CHAIN, AND WHY THAT ERRS TOWARD WITHHOLDING. A YANG grouping's nodes take the namespace of the module
 * that uses them, and `uses`, `augment` and `refine` are not expanded here, so a marked node is recorded as the chain
 * of data-node names from where it is declared (a grouping's root, an augment's target, a module's top), and an
 * element is withheld when the names of its own ancestors and itself end with that chain. Two nodes with one name chain
 * are both withheld whichever one carries the mark; nothing marked is ever missed for a namespace it took on use.
 */
import { declareMetadataOnly, projectMetadata, type MetadataProjection } from "@/lib/db/redaction/metadata-only";
import type { PathNode } from "./keypath";
import { READER_LIMITS, type XmlElement } from "./reader-port";
import { parseYangText, type YangStatement, YangTextError } from "./yangtree";

/** The withheld kinds, by the identifier each is named with. */
export type NetconfWithheldKind =
  | "ietf-keystore"
  | "ietf-netconf-acm"
  | "nacm:default-deny-all"
  | "crypt-hash"
  | "ietf-crypto-types secret"
  | "keyed by a withheld leaf"
  | "unresolved leafref";

/** The two modules withheld whole, with the namespaces RFC 9642 and RFC 8341 register for them. */
export const NETCONF_WITHHELD_MODULES: Readonly<Record<"ietf-keystore" | "ietf-netconf-acm", string>> = Object.freeze({
  "ietf-keystore": "urn:ietf:params:xml:ns:yang:ietf-keystore",
  "ietf-netconf-acm": "urn:ietf:params:xml:ns:yang:ietf-netconf-acm",
});

/** Why each kind is withheld, the words every agent-facing sentence uses. */
export const NETCONF_WITHHELD_REASONS: Readonly<Record<NetconfWithheldKind, string>> = Object.freeze({
  "ietf-keystore": "the ietf-keystore module holds the device's private and symmetric keys",
  "ietf-netconf-acm": "the ietf-netconf-acm module holds the device's access control groups and rules",
  "nacm:default-deny-all":
    "its module marks it nacm:default-deny-all, the NETCONF access control model's mark for a node too sensitive to read by default",
  "crypt-hash": "its type is crypt-hash, a password hash",
  "ietf-crypto-types secret": "it holds a private key, a symmetric key or a password of ietf-crypto-types",
  "keyed by a withheld leaf": "the list is keyed by a withheld leaf, so an entry's path would carry it",
  "unresolved leafref":
    "its type is a leafref whose target, or a typedef whose declaration, Studio cannot find in the YANG modules the device serves, so it could carry a withheld value",
});

/**
 * Every withheld kind named with its own identifier and its reason, the sentence every agent-facing text on NETCONF
 * uses. No kind is grouped under a parent that would read as wider than it is.
 */
export const NETCONF_WITHHELD_TEXT =
  "Withheld from agent mode, decided from the YANG modules the device itself serves: the ietf-keystore module whole (the device's keys); the ietf-netconf-acm module whole (its access control groups and rules); every data node a module marks nacm:default-deny-all, with its subtree; every leaf typed crypt-hash (a password hash, of iana-crypt-hash or ietf-system, or a type derived from it); the private-key-type, key-type and password-type choices of ietf-crypto-types (private keys, symmetric keys and passwords); every leafref that may point at a withheld node, which is withheld as that node is; every unresolved leafref, one whose target cannot be found in the device's modules, and every leaf whose type names a typedef no module the device serves declares; and every entry of a list keyed by a withheld leaf. A withheld node answers its path and its reason, never its value; every other node, configuration and state alike, is read.";

/** The roots of the crypt-hash kind: the typedef RFC 7317 defines, in the module that now holds it and in its first home. */
const CRYPT_HASH_TYPEDEFS: readonly string[] = Object.freeze(["iana-crypt-hash:crypt-hash", "ietf-system:crypt-hash"]);

/** RFC 9640's choices of secret material, in ietf-crypto-types. */
const CRYPTO_TYPES_MODULE = "ietf-crypto-types";
const CRYPTO_SECRET_CHOICES: ReadonlySet<string> = new Set(["private-key-type", "key-type", "password-type"]);

const NACM_MODULE = "ietf-netconf-acm";
const DENY_ALL = "default-deny-all";

/** The statements that name a data node, and so a step of an element's name chain. */
const DATA_NODES: ReadonlySet<string> = new Set(["container", "list", "leaf", "leaf-list", "anydata", "anyxml"]);
/** Schema-only steps: present in the schema, absent from the data, so they add nothing to a chain. */
const TRANSPARENT: ReadonlySet<string> = new Set(["choice", "case"]);

/** One module or submodule entry of the device's YANG library. */
export interface NetconfLibraryModule {
  readonly name: string;
  readonly revision?: string;
  readonly namespace?: string;
  readonly submodules: readonly { readonly name: string; readonly revision?: string }[];
}

/** One module text the device served for this check. */
export interface NetconfModuleText {
  readonly name: string;
  readonly text: string;
}

/** What a chain or a namespace meets. */
export interface NetconfWithheldMatch {
  readonly kind: NetconfWithheldKind;
}

/** One withheld node of an answer: its path of names and its kind, never a value. */
export interface NetconfWithheldNode {
  readonly path: string;
  readonly kind: NetconfWithheldKind;
}

/** The withheld nodes of one answer, as the metadata-only projection states them: path, kind and how many. */
export interface NetconfWithheldRow {
  readonly path: string;
  readonly kind: NetconfWithheldKind;
  readonly nodes: number;
}

/** What a withheld node is answered with: its path and reason, never a value (`metadataOnly`'s one operation). */
const NETCONF_WITHHELD_PROJECTION: MetadataProjection<NetconfWithheldRow> = Object.freeze([
  { column: "path", kind: "name", read: (row: NetconfWithheldRow) => row.path },
  { column: "withheld", kind: "name", read: (row: NetconfWithheldRow) => row.kind },
  { column: "nodes", kind: "count", read: (row: NetconfWithheldRow) => row.nodes },
]);

/** What `ProviderCapabilities.metadataOnly` states for NETCONF: the withheld report's columns and kinds. */
export const NETCONF_METADATA_ONLY = declareMetadataOnly({ withheld: NETCONF_WITHHELD_PROJECTION });

/** The text a withheld node's place in an answer holds: never its value. */
export const WITHHELD_CELL = "[withheld]";

/** The names of a schema node identifier's steps, prefixes and predicates dropped. */
function steps(argument: string | undefined): string[] {
  return (argument ?? "")
    .split("/")
    .filter((step) => step !== "")
    .map((step) => {
      const colon = step.indexOf(":");
      return colon === -1 ? step : step.slice(colon + 1);
    });
}

/**
 * The longest chain kept: its last names. No answer nests deeper than the reader's depth cap, so a longer chain can only
 * be the same node as an element by its end, and keeping the end alone matches at least as many elements, never fewer.
 */
const bounded = (chain: readonly string[]): readonly string[] =>
  chain.length > READER_LIMITS.maxDepth ? chain.slice(-READER_LIMITS.maxDepth) : chain;

/** One step of a leafref path once its predicates are dropped: an identifier, prefixed or not, and nothing else. */
const LEAFREF_STEP = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

const argumentOf = (statement: YangStatement, keyword: string): string | undefined =>
  statement.children.find((child) => child.keyword === keyword)?.argument;

/** One module text read: its module, its own prefix, and the modules its prefixes name. */
interface ReadModule {
  /** The module the text belongs to: its own name, or a submodule's `belongs-to`. */
  readonly module: string;
  readonly prefixes: ReadonlyMap<string, string>;
  readonly body: YangStatement;
}

function readModule(entry: NetconfModuleText): ReadModule {
  const [body, ...rest] = parseYangText(entry.text);
  if (body === undefined || rest.length > 0 || (body.keyword !== "module" && body.keyword !== "submodule")) {
    throw new YangTextError("a module text holds something other than one module or submodule");
  }
  const belongsTo = body.children.find((child) => child.keyword === "belongs-to");
  const owner = body.keyword === "module" ? (body.argument ?? "") : (belongsTo?.argument ?? "");
  if (owner === "") throw new YangTextError("a module text names no module");
  const prefixes = new Map<string, string>();
  const own = body.keyword === "module" ? argumentOf(body, "prefix") : belongsTo && argumentOf(belongsTo, "prefix");
  if (own !== undefined) prefixes.set(own, owner);
  for (const imported of body.children.filter((child) => child.keyword === "import")) {
    const prefix = argumentOf(imported, "prefix");
    if (prefix !== undefined && imported.argument !== undefined) prefixes.set(prefix, imported.argument);
  }
  return { module: owner, prefixes, body };
}

/** How many statements a module text holds, counted without recursion. */
function statementsIn(body: YangStatement): number {
  let count = 0;
  const pending: YangStatement[] = [body];
  for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
    count += 1;
    pending.push(...statement.children);
  }
  return count;
}

/** A prefixed reference's module and name, a bare one belonging to `home`. */
function resolve(reference: string, read: ReadModule): string {
  const colon = reference.indexOf(":");
  if (colon === -1) return `${read.module}:${reference}`;
  const owner = read.prefixes.get(reference.slice(0, colon)) ?? reference.slice(0, colon);
  return `${owner}:${reference.slice(colon + 1)}`;
}

/** Whether a statement carries the default-deny-all extension of ietf-netconf-acm. */
function deniesAll(statement: YangStatement, read: ReadModule): boolean {
  return statement.children.some((child) => {
    const colon = child.keyword.indexOf(":");
    if (colon === -1 || child.keyword.slice(colon + 1) !== DENY_ALL) return false;
    // An unbound prefix is read as the mark: a text that names an extension it never imported is no reason to read on.
    const owner = read.prefixes.get(child.keyword.slice(0, colon));
    return owner === undefined || owner === NACM_MODULE;
  });
}

type WithheldModule = "ietf-keystore" | "ietf-netconf-acm";
const isWithheldModule = (module: string): module is WithheldModule => Object.hasOwn(NETCONF_WITHHELD_MODULES, module);

/**
 * What a leafref path points at: a withheld module, when any step names one; a chain of node names, a relative path
 * anchored at the leaf's own chain, `..` popping a step; or undefined, a path Studio cannot read (none, `deref()`, a
 * step that is not an identifier), which is answered as an unresolved leafref.
 */
type LeafrefTarget = { readonly module: WithheldModule } | { readonly chain: readonly string[] } | undefined;

function leafrefTarget(chain: readonly string[], path: string | undefined, read: ReadModule): LeafrefTarget {
  if (path === undefined) return undefined;
  const bare = path.replace(/\[[^\]]*\]/g, "").trim();
  const absolute = bare.startsWith("/");
  const parts = (absolute ? bare.slice(1) : bare).split("/").map((part) => part.trim());
  let up = 0;
  if (!absolute) while (parts[up] === "..") up += 1;
  const rest = parts.slice(up);
  // RFC 7950 section 9.9.2: a relative path starts with at least one `..`, and names at least one node.
  if ((!absolute && up === 0) || rest.length === 0) return undefined;
  const names: string[] = [];
  for (const step of rest) {
    if (!LEAFREF_STEP.test(step)) return undefined;
    const qualified = resolve(step, read);
    const colon = qualified.indexOf(":");
    const owner = qualified.slice(0, colon);
    if (isWithheldModule(owner)) return { module: owner };
    names.push(qualified.slice(colon + 1));
  }
  return { chain: bounded([...chain.slice(0, Math.max(0, chain.length - up)), ...names]) };
}

/** What a type carries: whether it is a password hash, and the leafref paths it holds through its unions and typedefs. */
interface TypeFacts {
  readonly hash: boolean;
  readonly leafrefs: readonly { readonly path: string | undefined; readonly read: ReadModule }[];
}
const NO_FACTS: TypeFacts = Object.freeze({ hash: false, leafrefs: Object.freeze([]) });
const HASH_FACTS: TypeFacts = Object.freeze({ hash: true, leafrefs: Object.freeze([]) });

/** RFC 7950 section 4.2.4's built-in types: a type argument outside this set names a typedef. */
const BUILT_IN_TYPES: ReadonlySet<string> = new Set([
  "binary",
  "bits",
  "boolean",
  "decimal64",
  "empty",
  "enumeration",
  "identityref",
  "instance-identifier",
  "int8",
  "int16",
  "int32",
  "int64",
  "string",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
]);

/** How many typedefs and unions one type may derive through; a deeper one refuses the read as unreadable. */
export const MAX_TYPE_DERIVATION = 64;
/** Leafref paths one type may hold; past it the leaf is withheld as an unresolved leafref. */
const MAX_TYPE_LEAFREFS = 32;

/** One node of the chain index: a name chain read from its last name back, so a chain's suffixes are its ancestors. */
interface ChainNode {
  readonly up: ChainNode | undefined;
  readonly next: Map<string, ChainNode>;
  /** The kind this chain is withheld for, the first one given, and the order it was given in. */
  held?: { readonly kind: NetconfWithheldKind; readonly order: number };
  /** A data node some module declares has this chain. */
  declared?: true;
  /** This chain or one ending with it is declared. */
  declaredBelow?: true;
  /** A chain this one ends with is withheld (this node or one above it): the kind that reached it first. */
  covered?: NetconfWithheldKind;
  /** A withheld chain ends with this one (this node or one below it): the kind that reached it first. */
  heldBelow?: NetconfWithheldKind;
  /** Leafrefs pointing at this chain, waiting for it to be withheld. */
  waiting?: LeafrefEntry[];
}

interface LeafrefEntry {
  readonly node: ChainNode;
  done: boolean;
}

/** The total a device's module texts may hold for one read's check; past it the read is refused, never checked in part. */
export interface NetconfSchemaBudget {
  readonly maxTexts: number;
  readonly maxBytes: number;
  readonly maxStatements: number;
}

/**
 * MEASURED: the fixture serves 59 texts, about 890 KB, and the check compiles them in about 45 ms; a synthetic set at
 * this budget, every statement a leaf or a leafref, compiles in about a second. The whole check is synchronous once the
 * texts are read, so this bound is what keeps one device from holding the server's event loop.
 */
export const NETCONF_SCHEMA_BUDGET: NetconfSchemaBudget = Object.freeze({
  maxTexts: 1_000,
  maxBytes: 16 * 1024 * 1024,
  maxStatements: 400_000,
});

/** The device's module texts are past `NETCONF_SCHEMA_BUDGET`, so its withheld nodes are not decided for this read. */
export class NetconfSchemaBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetconfSchemaBudgetError";
    Object.setPrototypeOf(this, NetconfSchemaBudgetError.prototype);
  }
}

/** The withheld policy of one device, compiled from every module text it served. */
export class NetconfWithheldPolicy {
  private constructor(
    /** Every chain the check met, indexed from its last name back. */
    private readonly root: ChainNode,
    /** Namespace to withheld module. */
    private readonly namespaces: ReadonlyMap<string, WithheldModule>,
    /** List name to every key leaf name any module declares for a list of that name. */
    private readonly listKeys: ReadonlyMap<string, ReadonlySet<string>>,
  ) {}

  /**
   * The policy of a device: the library it answered and the text of every module and submodule in it. Throws a
   * `YangTextError` for a text that cannot be read, and a `NetconfSchemaBudgetError` for texts past `budget` in all, so
   * the read it was for is refused rather than answered unchecked. Linear in the texts' statements: every lookup walks
   * one chain of the index, and every node of the index is reached at most once per direction.
   */
  static compile(
    library: readonly NetconfLibraryModule[],
    texts: readonly NetconfModuleText[],
    budget: NetconfSchemaBudget = NETCONF_SCHEMA_BUDGET,
  ): NetconfWithheldPolicy {
    if (texts.length > budget.maxTexts) {
      throw new NetconfSchemaBudgetError(`the device serves more than ${budget.maxTexts} module texts`);
    }
    if (texts.reduce((sum, entry) => sum + entry.text.length, 0) > budget.maxBytes) {
      throw new NetconfSchemaBudgetError(`the device's module texts hold more than ${budget.maxBytes} bytes`);
    }
    let statements = 0;
    const modules = texts.map((entry) => {
      const read = readModule(entry);
      statements += statementsIn(read.body);
      if (statements > budget.maxStatements) {
        throw new NetconfSchemaBudgetError(
          `the device's module texts hold more than ${budget.maxStatements} statements`,
        );
      }
      return read;
    });
    const namespaces = new Map<string, WithheldModule>();
    for (const [name, namespace] of Object.entries(NETCONF_WITHHELD_MODULES) as [WithheldModule, string][]) {
      namespaces.set(namespace, name);
      const served = library.find((entry) => entry.name === name)?.namespace;
      if (served !== undefined) namespaces.set(served, name);
    }

    const typedefs = new Map<string, { type: YangStatement; read: ReadModule }>();
    const collect = (statement: YangStatement, read: ReadModule): void => {
      for (const child of statement.children) {
        if (child.keyword === "typedef" && child.argument !== undefined) {
          const type = child.children.find((inner) => inner.keyword === "type");
          if (type !== undefined) typedefs.set(`${read.module}:${child.argument}`, { type, read });
        }
        collect(child, read);
      }
    };
    for (const read of modules) collect(read.body, read);

    // What each typedef carries, each worked out once whatever order the typedefs are declared in.
    const derived = new Map<string, TypeFacts | "deriving">();
    const factsOf = (type: YangStatement, read: ReadModule, depth: number): TypeFacts => {
      if (depth > MAX_TYPE_DERIVATION) {
        throw new YangTextError(`a type derives through more than ${MAX_TYPE_DERIVATION} typedefs or unions`);
      }
      const argument = type.argument;
      if (argument === undefined) return NO_FACTS;
      if (argument === "leafref") return { hash: false, leafrefs: [{ path: argumentOf(type, "path"), read }] };
      if (argument === "union") {
        const members = type.children
          .filter((member) => member.keyword === "type")
          .map((member) => factsOf(member, read, depth + 1));
        const leafrefs = members.flatMap((member) => member.leafrefs);
        return {
          hash: members.some((member) => member.hash),
          // Past the cap, one path Studio cannot read stands for them all: the leaf is withheld, never read unchecked.
          leafrefs: leafrefs.length > MAX_TYPE_LEAFREFS ? [{ path: undefined, read }] : leafrefs,
        };
      }
      if (BUILT_IN_TYPES.has(argument)) return NO_FACTS;
      const name = resolve(argument, read);
      if (CRYPT_HASH_TYPEDEFS.includes(name)) return HASH_FACTS;
      const typedef = typedefs.get(name);
      // A typedef no served module declares could derive from anything, a password hash or a leafref to a withheld node
      // among them, so it stands as one path Studio cannot read: the leaf is withheld as unresolved, never read as plain.
      if (typedef === undefined) return { hash: false, leafrefs: [{ path: undefined, read }] };
      const known = derived.get(name);
      if (known === "deriving") throw new YangTextError("a typedef derives from itself");
      if (known !== undefined) return known;
      derived.set(name, "deriving");
      const facts = factsOf(typedef.type, typedef.read, depth + 1);
      derived.set(name, facts);
      return facts;
    };

    const signatures: { chain: readonly string[]; kind: NetconfWithheldKind }[] = [];
    const declared: (readonly string[])[] = [];
    const leafrefs: { chain: readonly string[]; facts: TypeFacts }[] = [];
    const listKeys = new Map<string, Set<string>>();
    const add = (chain: readonly string[], kind: NetconfWithheldKind): void => {
      if (chain.length > 0) signatures.push({ chain, kind });
    };
    /** A leaf's or a deviation's type: a password hash, or the leafrefs it holds, each resolved below. */
    const typed = (chain: readonly string[], type: YangStatement | undefined, read: ReadModule): void => {
      if (type === undefined || chain.length === 0) return;
      const facts = factsOf(type, read, 0);
      if (facts.hash) add(chain, "crypt-hash");
      else if (facts.leafrefs.length > 0) leafrefs.push({ chain, facts });
    };

    const walk = (
      statements: readonly YangStatement[],
      chain: readonly string[],
      read: ReadModule,
      inherited: NetconfWithheldKind | undefined,
    ): void => {
      for (const statement of statements) {
        const { keyword } = statement;
        if (DATA_NODES.has(keyword) && statement.argument !== undefined) {
          const here = bounded([...chain, statement.argument]);
          declared.push(here);
          const marked = inherited ?? (deniesAll(statement, read) ? "nacm:default-deny-all" : undefined);
          if (marked !== undefined) add(here, marked);
          else
            typed(
              here,
              statement.children.find((child) => child.keyword === "type"),
              read,
            );
          if (keyword === "list") {
            const keys = listKeys.get(statement.argument) ?? new Set<string>();
            for (const key of (argumentOf(statement, "key") ?? "").split(/\s+/)) if (key !== "") keys.add(key);
            listKeys.set(statement.argument, keys);
          }
          walk(statement.children, here, read, marked);
        } else if (TRANSPARENT.has(keyword)) {
          const secret =
            keyword === "choice" &&
            read.module === CRYPTO_TYPES_MODULE &&
            CRYPTO_SECRET_CHOICES.has(statement.argument ?? "");
          const marked =
            inherited ??
            (secret ? "ietf-crypto-types secret" : deniesAll(statement, read) ? "nacm:default-deny-all" : undefined);
          walk(statement.children, chain, read, marked);
        } else if (keyword === "grouping") {
          walk(statement.children, [], read, undefined);
        } else if (keyword === "augment") {
          walk(statement.children, bounded([...chain, ...steps(statement.argument)]), read, inherited);
        } else if (keyword === "uses") {
          for (const child of statement.children) {
            const target = bounded([...chain, ...steps(child.argument)]);
            if (child.keyword === "refine" && (inherited !== undefined || deniesAll(child, read))) {
              add(target, inherited ?? "nacm:default-deny-all");
            } else if (child.keyword === "augment") {
              walk(child.children, target, read, inherited);
            }
          }
        } else if (keyword === "deviation") {
          const target = bounded(steps(statement.argument));
          for (const deviate of statement.children.filter((child) => child.keyword === "deviate")) {
            if (deniesAll(deviate, read)) add(target, "nacm:default-deny-all");
            else
              typed(
                target,
                deviate.children.find((child) => child.keyword === "type"),
                read,
              );
          }
        } else if (keyword === "module" || keyword === "submodule") {
          walk(statement.children, [], read, undefined);
        }
        // rpc, action, notification, typedef, identity, extension and the rest hold no node a read answers.
      }
    };
    for (const read of modules) walk([read.body], [], read, undefined);

    // The index of every chain met, from its last name back: a chain's ancestors are the chains it ends with, and its
    // descendants the chains that end with it, which are the two ways a name chain may be the same node as another.
    const root: ChainNode = { up: undefined, next: new Map() };
    const nodeOf = (chain: readonly string[]): ChainNode => {
      let node = root;
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const name = chain[index] as string;
        let next = node.next.get(name);
        if (next === undefined) {
          next = { up: node, next: new Map(), ...(node.covered === undefined ? {} : { covered: node.covered }) };
          node.next.set(name, next);
        }
        node = next;
      }
      return node;
    };
    for (const chain of declared) {
      const node = nodeOf(chain);
      node.declared = true;
      for (let at: ChainNode | undefined = node; at !== undefined && at.declaredBelow === undefined; at = at.up) {
        at.declaredBelow = true;
      }
    }

    // Withholding a chain withholds every leafref whose target may be the same node: a target ending with it (below it
    // in the index) or one it ends with (above it). Each node is covered once and marked once, so this is linear.
    let order = 0;
    const queue: { node: ChainNode; kind: NetconfWithheldKind }[] = [];
    const release = (node: ChainNode, kind: NetconfWithheldKind): void => {
      for (const entry of node.waiting ?? []) {
        if (!entry.done) {
          entry.done = true;
          queue.push({ node: entry.node, kind });
        }
      }
      delete node.waiting;
    };
    const drain = (): void => {
      for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
        const { node, kind } = item;
        if (node.held !== undefined) continue;
        node.held = { kind, order };
        order += 1;
        if (node.covered === undefined) {
          const below: ChainNode[] = [node];
          for (let at = below.pop(); at !== undefined; at = below.pop()) {
            at.covered = kind;
            release(at, kind);
            for (const next of at.next.values()) if (next.covered === undefined) below.push(next);
          }
        }
        for (let at: ChainNode | undefined = node; at !== undefined && at.heldBelow === undefined; at = at.up) {
          at.heldBelow = kind;
          release(at, kind);
        }
      }
    };
    for (const { chain, kind } of signatures) {
      queue.push({ node: nodeOf(chain), kind });
      drain();
    }

    // A leafref carries the value of the leaf it points at, so one that may point at a withheld node is withheld too,
    // to a fixed point; one whose target no module declares is withheld as unresolved, never read unchecked.
    const resolved = (node: ChainNode): boolean => {
      if (node.declaredBelow === true) return true;
      for (let at = node.up; at !== undefined; at = at.up) if (at.declared === true) return true;
      return false;
    };
    for (const { chain, facts } of leafrefs) {
      const entry: LeafrefEntry = { node: nodeOf(chain), done: false };
      const targets = facts.leafrefs.map(({ path, read }) => leafrefTarget(chain, path, read));
      const nodes = targets.flatMap((target) =>
        target !== undefined && "chain" in target ? [nodeOf(target.chain)] : [],
      );
      const now =
        targets.find((target): target is { module: WithheldModule } => target !== undefined && "module" in target)
          ?.module ??
        nodes.map((node) => node.covered ?? node.heldBelow).find((kind) => kind !== undefined) ??
        (targets.includes(undefined) || !nodes.every(resolved) ? "unresolved leafref" : undefined);
      if (now !== undefined) {
        entry.done = true;
        queue.push({ node: entry.node, kind: now });
      } else {
        for (const node of nodes) (node.waiting ??= []).push(entry);
      }
      drain();
    }
    return new NetconfWithheldPolicy(root, namespaces, listKeys);
  }

  /** The withheld module a namespace or a module name belongs to, or undefined. */
  moduleOf(namespace: string | undefined, moduleName?: string): NetconfWithheldMatch | undefined {
    const byNamespace = namespace === undefined ? undefined : this.namespaces.get(namespace);
    if (byNamespace !== undefined) return { kind: byNamespace };
    if (moduleName === "ietf-keystore" || moduleName === "ietf-netconf-acm") return { kind: moduleName };
    return undefined;
  }

  /** The kind a chain of element names meets: of the withheld chains it ends with, the one withheld first. */
  chainMatch(chain: readonly string[]): NetconfWithheldMatch | undefined {
    let node: ChainNode | undefined = this.root;
    let first: ChainNode["held"];
    for (let index = chain.length - 1; index >= 0 && node !== undefined; index -= 1) {
      node = node.next.get(chain[index] as string);
      const held = node?.held;
      if (held !== undefined && (first === undefined || held.order < first.order)) first = held;
    }
    return first === undefined ? undefined : { kind: first.kind };
  }

  /**
   * Why a read of `path` is refused before it is sent, or undefined: a node of it inside a withheld module or a withheld
   * node, or a key it filters on that is a withheld leaf, which would make the read an oracle on that leaf's value.
   * `namespaceOf` is this device's library, by module name.
   */
  pathRefusal(
    path: readonly PathNode[],
    namespaceOf: (module: string) => string | undefined,
  ): (NetconfWithheldMatch & { readonly at: string }) | undefined {
    const chain: string[] = [];
    for (const node of path) {
      chain.push(node.name);
      const at = chain.join("/");
      const inModule = node.module === undefined ? undefined : this.moduleOf(namespaceOf(node.module), node.module);
      if (inModule !== undefined) return { ...inModule, at };
      const inNode = this.chainMatch(chain);
      if (inNode !== undefined) return { ...inNode, at };
      if (node.keys !== undefined) {
        const written = node.keys.map((_, position) => node.keyNames?.[position] ?? "name");
        for (const key of [...written, ...(this.listKeys.get(node.name) ?? [])]) {
          if (this.chainMatch([...chain, key]) !== undefined) return { kind: "keyed by a withheld leaf", at };
        }
      }
    }
    return undefined;
  }

  /**
   * The data an answer may carry: every withheld node replaced by an empty element holding `WITHHELD_CELL`, every entry
   * of a list keyed by a withheld leaf dropped, and the path and kind of each, never a value. `emptied` holds every
   * element left with no child because each one was such an entry. `top` names the module of each top-level element by
   * its namespace, for the paths.
   */
  prune(
    data: XmlElement,
    top: (namespace: string | undefined) => string | undefined,
  ): { data: XmlElement; withheld: NetconfWithheldNode[]; emptied: ReadonlySet<XmlElement> } {
    const withheld: NetconfWithheldNode[] = [];
    const emptied = new Set<XmlElement>();
    const pathOf = (chain: readonly string[], namespace: string | undefined): string => {
      const owner = top(namespace);
      return owner === undefined ? chain.join("/") : `${owner}:${chain.join("/")}`;
    };
    /** The element with its withheld children replaced, or "entry" when its own key leaf is withheld. */
    const visit = (
      element: XmlElement,
      chain: readonly string[],
      topNamespace: string | undefined,
    ): XmlElement | "entry" => {
      const keys = this.listKeys.get(element.name);
      const children: XmlElement[] = [];
      let dropped = false;
      for (const child of element.children) {
        const here = [...chain, child.name];
        const namespace = chain.length === 0 ? child.namespace : topNamespace;
        const match = this.moduleOf(child.namespace) ?? this.chainMatch(here);
        if (match !== undefined) {
          if (keys?.has(child.name) === true && chain.length > 0) return "entry";
          withheld.push({ path: pathOf(here, namespace), kind: match.kind });
          children.push({
            name: child.name,
            namespace: child.namespace,
            attributes: new Map(),
            children: [],
            text: WITHHELD_CELL,
            bindings: new Map(),
          });
          continue;
        }
        const visited = visit(child, here, namespace);
        if (visited === "entry") {
          withheld.push({ path: pathOf(here, namespace), kind: "keyed by a withheld leaf" });
          dropped = true;
          continue;
        }
        children.push(visited);
      }
      const pruned = { ...element, children };
      if (dropped && children.length === 0) emptied.add(pruned);
      return pruned;
    };
    // The root is the reply's `<data>`, never a list entry: an entry is answered "entry" only below it.
    return { data: visit(data, [], undefined) as XmlElement, withheld, emptied };
  }
}

/** The withheld nodes of one answer as rows of path, kind and count, through the metadata-only projection. */
export function withheldRows(nodes: readonly NetconfWithheldNode[]): NetconfWithheldRow[] {
  const counted = new Map<string, NetconfWithheldRow>();
  for (const node of nodes) {
    const key = `${node.kind}\u0000${node.path}`;
    const held = counted.get(key);
    counted.set(key, { path: node.path, kind: node.kind, nodes: (held?.nodes ?? 0) + 1 });
  }
  const rows = [...counted.values()];
  projectMetadata(NETCONF_WITHHELD_PROJECTION, rows);
  return rows;
}

/** The warning one withheld row is answered with: its path, how many, and the reason of its kind. */
export function withheldWarning(row: NetconfWithheldRow): string {
  const count = row.nodes === 1 ? "is" : `(${row.nodes} nodes) are`;
  return `${row.path} ${count} withheld from agent mode (${row.kind}): ${NETCONF_WITHHELD_REASONS[row.kind]}, so its value is not answered.`;
}
