/**
 * What agent mode withholds on a NETCONF device, decided from the YANG modules the device itself serves.
 *
 * A device's configuration and state are its management data, so the agent reads them. Withheld, because they hold
 * what the device is reached and authorized with, are five kinds, each named by its own identifier:
 *
 *   ietf-keystore            the module whole: every node in its namespace (RFC 9642, the device's keys)
 *   ietf-netconf-acm         the module whole: every node in its namespace (RFC 8341, the access control rules)
 *   nacm:default-deny-all    every data node a module marks with this extension, and its subtree (RFC 8341 section
 *                            3.5.1.2: the protocol's own mark for a node too sensitive to read by default)
 *   crypt-hash               every leaf whose type is `crypt-hash` of iana-crypt-hash or of ietf-system (RFC 7317
 *                            section 5), or a typedef or union that derives from it, and every leafref to such a leaf
 *   ietf-crypto-types secret every node of the `private-key-type`, `key-type` and `password-type` choices of
 *                            ietf-crypto-types (RFC 9640 section 2.1): cleartext, hidden and encrypted private keys,
 *                            symmetric keys and passwords
 *
 * The marks, the types and the choices are read from the module texts the device serves with `<get-schema>`, never
 * from a list of node names Studio keeps: a node is withheld because its own module says what it is. RFC 9640 defines
 * no key typedef, so the key material is reached through its choices, and its cleartext leaves also carry the
 * default-deny-all mark. A list whose key leaf is withheld is withheld entry by entry, since an entry's path would
 * carry the key.
 *
 * WHY BY NAME CHAIN, AND WHY THAT ERRS TOWARD WITHHOLDING. A YANG grouping's nodes take the namespace of the module
 * that uses them, and `uses`, `augment` and `refine` are not expanded here, so a marked node is recorded as the chain
 * of data-node names from where it is declared (a grouping's root, an augment's target, a module's top), and an
 * element is withheld when the names of its own ancestors and itself end with that chain. Two nodes with one name chain
 * are both withheld whichever one carries the mark; nothing marked is ever missed for a namespace it took on use.
 */
import { declareMetadataOnly, projectMetadata, type MetadataProjection } from "@/lib/db/redaction/metadata-only";
import type { PathNode } from "./keypath";
import type { XmlElement } from "./reader-port";
import { parseYangText, type YangStatement, YangTextError } from "./yangtree";

/** The withheld kinds, by the identifier each is named with. */
export type NetconfWithheldKind =
  | "ietf-keystore"
  | "ietf-netconf-acm"
  | "nacm:default-deny-all"
  | "crypt-hash"
  | "ietf-crypto-types secret"
  | "keyed by a withheld leaf";

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
});

/**
 * Every withheld kind named with its own identifier and its reason, the sentence every agent-facing text on NETCONF
 * uses. No kind is grouped under a parent that would read as wider than it is.
 */
export const NETCONF_WITHHELD_TEXT =
  "Withheld from agent mode, decided from the YANG modules the device itself serves: the ietf-keystore module whole (the device's keys); the ietf-netconf-acm module whole (its access control groups and rules); every data node a module marks nacm:default-deny-all, with its subtree; every leaf typed crypt-hash (a password hash, of iana-crypt-hash or ietf-system, or a type derived from it); the private-key-type, key-type and password-type choices of ietf-crypto-types (private keys, symmetric keys and passwords); and every entry of a list keyed by a withheld leaf. A withheld node answers its path and its reason, never its value; every other node, configuration and state alike, is read.";

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

interface Signature {
  readonly chain: readonly string[];
  readonly kind: NetconfWithheldKind;
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
export const NETCONF_WITHHELD_PROJECTION: MetadataProjection<NetconfWithheldRow> = Object.freeze([
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

/** A leafref path's node names, predicates, `..` and `current()` dropped. */
function leafrefSteps(path: string | undefined): string[] {
  return steps((path ?? "").replace(/\[[^\]]*\]/g, "")).filter((step) => step !== ".." && step !== "current()");
}

/** Whether `chain` ends with `tail`. */
const endsWith = (chain: readonly string[], tail: readonly string[]): boolean =>
  tail.length <= chain.length && tail.every((name, index) => chain[chain.length - tail.length + index] === name);

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

/** The withheld policy of one device, compiled from every module text it served. */
export class NetconfWithheldPolicy {
  private constructor(
    private readonly signatures: readonly Signature[],
    /** Namespace to withheld module. */
    private readonly namespaces: ReadonlyMap<string, "ietf-keystore" | "ietf-netconf-acm">,
    /** List name to every key leaf name any module declares for a list of that name. */
    private readonly listKeys: ReadonlyMap<string, ReadonlySet<string>>,
  ) {}

  /**
   * The policy of a device: the library it answered and the text of every module and submodule in it. Throws a
   * `YangTextError` for a text that cannot be read, so the read it was for is refused rather than answered unchecked.
   */
  static compile(library: readonly NetconfLibraryModule[], texts: readonly NetconfModuleText[]): NetconfWithheldPolicy {
    const modules = texts.map(readModule);
    const namespaces = new Map<string, "ietf-keystore" | "ietf-netconf-acm">();
    for (const [name, namespace] of Object.entries(NETCONF_WITHHELD_MODULES) as [
      "ietf-keystore" | "ietf-netconf-acm",
      string,
    ][]) {
      namespaces.set(namespace, name);
      const served = library.find((entry) => entry.name === name)?.namespace;
      if (served !== undefined) namespaces.set(served, name);
    }

    // Typedefs that are a password hash, to a fixed point: a typedef deriving from one is one.
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
    const hashTypes = new Set<string>(CRYPT_HASH_TYPEDEFS);
    const isHash = (type: YangStatement, read: ReadModule): boolean =>
      (type.argument !== undefined && hashTypes.has(resolve(type.argument, read))) ||
      type.children.some((member) => member.keyword === "type" && isHash(member, read));
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, { type, read }] of typedefs) {
        if (!hashTypes.has(name) && isHash(type, read)) {
          hashTypes.add(name);
          grew = true;
        }
      }
    }

    const signatures: Signature[] = [];
    const listKeys = new Map<string, Set<string>>();
    const leafrefs: { chain: readonly string[]; target: readonly string[] }[] = [];
    const add = (chain: readonly string[], kind: NetconfWithheldKind): void => {
      if (chain.length > 0) signatures.push({ chain: [...chain], kind });
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
          const here = [...chain, statement.argument];
          const marked = inherited ?? (deniesAll(statement, read) ? "nacm:default-deny-all" : undefined);
          const type = statement.children.find((child) => child.keyword === "type");
          if (marked !== undefined) add(here, marked);
          else if (type !== undefined && isHash(type, read)) add(here, "crypt-hash");
          else if (type?.argument !== undefined && resolve(type.argument, read).endsWith(":leafref")) {
            leafrefs.push({ chain: here, target: leafrefSteps(argumentOf(type, "path")) });
          }
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
          walk(statement.children, [...chain, ...steps(statement.argument)], read, inherited);
        } else if (keyword === "uses") {
          for (const child of statement.children) {
            const target = [...chain, ...steps(child.argument)];
            if (child.keyword === "refine" && (inherited !== undefined || deniesAll(child, read))) {
              add(target, inherited ?? "nacm:default-deny-all");
            } else if (child.keyword === "augment") {
              walk(child.children, target, read, inherited);
            }
          }
        } else if (keyword === "deviation") {
          const target = steps(statement.argument);
          for (const deviate of statement.children.filter((child) => child.keyword === "deviate")) {
            const type = deviate.children.find((child) => child.keyword === "type");
            if (deniesAll(deviate, read)) add(target, "nacm:default-deny-all");
            else if (type !== undefined && isHash(type, read)) add(target, "crypt-hash");
          }
        } else if (keyword === "module" || keyword === "submodule") {
          walk(statement.children, [], read, undefined);
        }
        // rpc, action, notification, typedef, identity, extension and the rest hold no node a read answers.
      }
    };
    for (const read of modules) walk([read.body], [], read, undefined);

    // A leafref carries the value of the leaf it points at, so one pointing at a withheld leaf is withheld too: its
    // target's steps end with a withheld chain, or, two steps or more, are the end of one.
    const pointed = [...signatures];
    for (const leafref of leafrefs) {
      const target = leafref.target;
      const hit = pointed.find(
        (signature) => endsWith(target, signature.chain) || (target.length >= 2 && endsWith(signature.chain, target)),
      );
      if (hit !== undefined) add(leafref.chain, hit.kind);
    }
    return new NetconfWithheldPolicy(signatures, namespaces, listKeys);
  }

  /** The withheld module a namespace or a module name belongs to, or undefined. */
  moduleOf(namespace: string | undefined, moduleName?: string): NetconfWithheldMatch | undefined {
    const byNamespace = namespace === undefined ? undefined : this.namespaces.get(namespace);
    if (byNamespace !== undefined) return { kind: byNamespace };
    if (moduleName === "ietf-keystore" || moduleName === "ietf-netconf-acm") return { kind: moduleName };
    return undefined;
  }

  /** The kind a chain of element names meets: a signature it ends with. */
  chainMatch(chain: readonly string[]): NetconfWithheldMatch | undefined {
    const signature = this.signatures.find((entry) => endsWith(chain, entry.chain));
    return signature === undefined ? undefined : { kind: signature.kind };
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
   * of a list keyed by a withheld leaf dropped, and the path and kind of each, never a value. `top` names the module of
   * each top-level element by its namespace, for the paths.
   */
  prune(
    data: XmlElement,
    top: (namespace: string | undefined) => string | undefined,
  ): { data: XmlElement; withheld: NetconfWithheldNode[] } {
    const withheld: NetconfWithheldNode[] = [];
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
          continue;
        }
        children.push(visited);
      }
      return { ...element, children };
    };
    // The root is the reply's `<data>`, never a list entry: an entry is answered "entry" only below it.
    return { data: visit(data, [], undefined) as XmlElement, withheld };
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
