import { QueryError } from "@/lib/db/errors";

/**
 * The key path of the `netconf` provider, phase 1 (issue #1724).
 *
 * The grammar is RFC 8040 section 3.5.3 api-path: `/` between nodes, a module name prefix where
 * the module changes, list keys after `=` in key statement order separated by `,`, and reserved
 * characters percent encoded.
 *
 * It was chosen because key values hold the separator. MEASURED 2026-10-13: `ge-0/0/0` on
 * Netopeer2 and `Ethernet1/0` on gnxi. Sixteen values were round tripped through this encoder,
 * among them both quote kinds, `] [ = \`, a space, the `]]>]]>` framing marker as data, a two byte
 * and a four byte character, an empty value and the already escaped text `%2F`. All sixteen
 * decoded back to the original and none kept a `/` after encoding.
 *
 * Two orderings are wrong here and both compile. MEASURED 2026-10-13 under Bun 1.4.2 and
 * Node 24.14.0:
 *   1. The default sort is not UTF-8 byte order. On `U+FFFD, U+10000, U+E000, U+1F600, z` the
 *      default sort puts U+10000 before U+FFFD, where UTF-8 byte order puts U+FFFD first, because
 *      it compares UTF-16 code units and a surrogate pair starts at U+D800.
 *   2. Sorting the escaped text is a third order again, because `%` is 0x25 and sorts before every
 *      letter: `%EF%BF%BD` precedes `z` where the decoded value follows it.
 * So a level page sorts DECODED values with `compareUtf8` and escapes afterwards.
 */

/**
 * Refusals here are `QueryError`, not a class of this file's own.
 *
 * MEASURED on `origin/main`: only a `QueryError` or a `TimeoutError` is turned into a stated
 * refusal by the surfaces that catch one (`providers/platform/kubernetes/objects.ts:348`,
 * `isQueryError` in `src/lib/db/errors.ts`). A refusal thrown as a plain `Error` passes as an
 * unexpected failure and the sentence it carries never reaches the user, which for this file means
 * a key value the user typed is rejected with no explanation of what is wrong with it.
 *
 * It is not a subclass either: the shared error constructors end with
 * `Object.setPrototypeOf(this, <Base>.prototype)`, so a class extending one is not an instance of
 * itself. The base type is what the house reads, so the base type is what is thrown.
 */

/**
 * Percent encodes one segment or key value.
 *
 * Ill formed text is refused rather than encoded. MEASURED 2026-10-13: a lone surrogate makes
 * `encodeURIComponent` throw, so the check that the existing Firestore provider performs with
 * `isWellFormed()` is load bearing and not decoration.
 */
export function encodeSegment(text: string): string {
  if (!text.isWellFormed()) {
    throw new QueryError("a key value has to be text: this one holds an unpaired surrogate");
  }
  return encodeURIComponent(text).replace(/[!'()*]/g, (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function decodeSegment(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new QueryError("a key path segment holds a percent escape that is not valid");
  }
}

/**
 * The YANG identifier grammar of RFC 7950 section 6.2, which every node name and module name
 * follows. A node name becomes an element name in the subtree filter, so a segment outside it is
 * refused before any request is built. Key values are data rather than names and are not held to it.
 */
const YANG_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Answers `name` when it is a YANG identifier, and refuses it naming `segment` otherwise. */
export function assertYangIdentifier(name: string, segment: string = name): string {
  if (YANG_IDENTIFIER.test(name)) return name;
  throw new QueryError(
    `the path segment ${JSON.stringify(segment)} is not a YANG identifier: a node or module name starts with a letter or an underscore and holds only letters, digits, underscores, hyphens and dots, and "/" separates segments`,
  );
}

/**
 * UTF-8 byte order, by code point.
 *
 * The same comparison the Firestore provider performs. It is required rather than preferred: the
 * level contract asks for UTF-8 byte order and the default sort does not give it (see above).
 */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i) ?? 0;
    const y = b.codePointAt(j) ?? 0;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  return j < b.length ? -1 : 0;
}

export interface PathNode {
  /** The module name, present only where the module changes from the node before it. */
  readonly module?: string;
  readonly name: string;
  /** List keys in key statement order. Absent for a container or a leaf. */
  readonly keys?: readonly string[];
  /**
   * The names of the key leaves, in the same order as `keys`.
   *
   * They come from the list's own `key` statement in the module text, which the provider fetches
   * once with `<get-schema>`. MEASURED 2026-10-13 across nine real modules: all 37 lists carried a
   * `key` statement in the module that declares the list, 26 of them inside a `grouping`, so the
   * names are always available to a reader that can follow `uses` across modules. A list whose key
   * names are unknown is shown by position and its entries cannot be opened, which is how RFC 8040
   * section 3.5.3 treats a keyless list.
   */
  readonly keyNames?: readonly string[];
}

/** Builds the api-path form of a node chain. */
export function buildKeyPath(nodes: readonly PathNode[]): string {
  return nodes
    .map((node) => {
      const head = node.module ? `${node.module}:${node.name}` : node.name;
      if (!node.keys || node.keys.length === 0) return head;
      return `${head}=${node.keys.map(encodeSegment).join(",")}`;
    })
    .join("/");
}

/** Reads an api-path back into its nodes. The inverse of `buildKeyPath`. */
export function parseKeyPath(path: string): readonly PathNode[] {
  if (path === "") return [];
  return path.split("/").map((piece) => {
    const at = piece.indexOf("=");
    const head = at === -1 ? piece : piece.slice(0, at);
    const colon = head.indexOf(":");
    const moduleName = colon === -1 ? undefined : assertYangIdentifier(head.slice(0, colon), piece);
    const name = assertYangIdentifier(colon === -1 ? head : head.slice(colon + 1), piece);
    if (at === -1) return moduleName ? { module: moduleName, name } : { name };
    const keys = piece
      .slice(at + 1)
      .split(",")
      .map(decodeSegment);
    return moduleName ? { module: moduleName, name, keys } : { name, keys };
  });
}

export interface LevelEntry {
  /** The decoded name of a child. Sorting happens on this, never on its escaped form. */
  readonly name: string;
  readonly kind: "folder" | "key";
}

export interface LevelPage {
  readonly entries: readonly LevelEntry[];
  /**
   * The last entry returned, spelled as the level contract asks: start after semantics, so a list
   * whose order changes between calls neither skips nor repeats an entry. It carries no server
   * state, so it stays valid in any process that serves the connection.
   */
  readonly cursor: string | null;
}

/**
 * Builds one level page from everything the server returned for that level.
 *
 * The server answers a level unpaged, so this removes repeats, sorts in UTF-8 byte order on the
 * DECODED name, takes the first `count` entries after the cursor and spells the cursor as the last
 * entry returned. MEASURED 2026-10-13: Netopeer2 keeps list keys at a max-depth cut, 5000 of 5000
 * interfaces came back carrying their key leaf and nothing else at max-depth 2, so the children of
 * a level are what the server already answers and this function never trims a subtree.
 */
export function levelPage(all: readonly LevelEntry[], cursor: string | null, count: number): LevelPage {
  if (count < 1) throw new QueryError("a level page holds at least one entry");
  const seen = new Set<string>();
  const unique: LevelEntry[] = [];
  for (const entry of all) {
    const id = `${entry.kind}:${entry.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(entry);
  }
  unique.sort((a, b) => compareUtf8(a.name, b.name));
  const after = cursor === null ? unique : unique.filter((entry) => compareUtf8(entry.name, cursor) > 0);
  const entries = after.slice(0, count);
  const last = entries[entries.length - 1];
  return { entries, cursor: last ? last.name : null };
}
