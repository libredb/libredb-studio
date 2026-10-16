import { QueryError } from "@/lib/db/errors";

/**
 * The key names of a YANG list, read from module text (issue #1724).
 *
 * A list's entries can only be addressed by its key leaves, and the key statement is the only place
 * that names them. This reads it lexically, without compiling the module: a statement tree, the way
 * `yang-parser` does lexical analysis and nothing more.
 *
 * MEASURED 2026-10-13 across nine real modules, 37 lists in all: every one of the 37 carried a
 * `key` statement in the module that declares the list, including `ietf-netconf-server`, which the
 * issue names as the hardest case. Twenty six of the 37 are declared inside a `grouping`, and
 * `ietf-netconf-server` alone carries 13 prefixed `uses` statements and two `augment` statements.
 * So the difficulty is not finding the key once the right module is in hand. It is knowing which
 * module declares the list, because the data appears in another module's tree through `uses` or
 * `augment`, and answering one question can need more than one module's text.
 *
 * The scanner was tested against a module holding three lists, one keyed, one with no key and one
 * whose `key` appears only inside a comment: it reported both of the last two as keyless by name,
 * so the 37 of 37 above is not the answer of a scanner that cannot see a missing key (K-110).
 */

export interface YangList {
  readonly name: string;
  /** The key leaf names in key statement order, or an empty list for a keyless list. */
  readonly keys: readonly string[];
  /** True when the list is declared inside a grouping, so its data appears wherever `uses` pulls it. */
  readonly inGrouping: boolean;
}

export interface YangScan {
  readonly lists: readonly YangList[];
  /** Prefixed `uses` statements, which name a grouping from another module. */
  readonly externalUses: readonly string[];
  readonly augments: readonly string[];
}

/** Bounds, because module text arrives from a device. */
export interface YangLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
}

/**
 * Where the two numbers come from, and where they do not.
 *
 * MEASURED 2026-10-13, over 59 module texts fetched from the Netopeer2 fixture with `get-schema`:
 * 890,070 bytes in all, the largest 118,482 bytes for `iana-tls-cipher-suite-algs`; and the deepest
 * module nested 11 brace levels, `ietf-tcp-client`, with a median of 5.
 *
 * So `maxBytes` is about 35 times the largest module text read and `maxDepth` about 6 times the
 * deepest nesting read. Both are STILL DEFAULTS. These 59 modules are the ones this fixture loads,
 * and a vendor's own models are UNMEASURED: a large platform module can be far bigger than any
 * IETF one here, and the depth figure says what these modules do, not what YANG allows. The caps
 * exist because the text arrives from a device, and a device that answers more than this is
 * refused with a sentence rather than read; the numbers themselves should be revised against the
 * first real device, not defended.
 */
export const YANG_LIMITS: YangLimits = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxDepth: 64 });

/**
 * Refusals here are `QueryError` for the reason given in `keypath.ts`: only that type, or a
 * `TimeoutError`, becomes a stated refusal, and module text arrives from a device, so its refusal
 * is a thing the user has to be told.
 */

/**
 * Removes comments and neutralises quoted text.
 *
 * Quoted text is replaced character by character rather than removed, so that every brace and
 * semicolon inside a string stops counting while the offsets of everything after it stay put. A
 * scanner that deleted strings instead would report positions that do not exist in the file, which
 * is the mistake that produced two wrong line citations elsewhere in this work.
 */
function neutralise(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out.push(text[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      out.push("  ");
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(ch);
      i += 1;
      while (i < text.length && text[i] !== quote) {
        const inner = text[i] ?? "";
        if (inner === "\\" && quote === '"') {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(inner === "\n" ? "\n" : inner === "{" || inner === "}" || inner === ";" ? "." : inner);
        i += 1;
      }
      if (i < text.length) {
        out.push(quote);
        i += 1;
      }
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join("");
}

/**
 * Scans one module's text for its lists, their key names, and the statements that make a list's
 * data appear somewhere else.
 */
export function scanYangModule(text: string, limits: YangLimits = YANG_LIMITS): YangScan {
  if (text.length > limits.maxBytes) {
    throw new QueryError(`this module's text is larger than the ${limits.maxBytes} byte cap`);
  }
  const clean = neutralise(text);
  const lists: YangList[] = [];
  const externalUses: string[] = [];
  const augments: string[] = [];
  // The statement stack holds keywords, so a list knows whether a grouping encloses it.
  const stack: string[] = [];
  let pending: { keyword: string; argument: string } | null = null;
  const openLists: { name: string; inGrouping: boolean; keys: string[]; depth: number }[] = [];

  const token = /([A-Za-z0-9_:.+-]+)|(\{)|(\})|(;)/g;
  for (let match = token.exec(clean); match !== null; match = token.exec(clean)) {
    const [whole] = match;
    if (whole === "{") {
      if (stack.length >= limits.maxDepth) throw new QueryError("this module nests deeper than the depth cap");
      const keyword = pending?.keyword ?? "";
      stack.push(keyword);
      if (keyword === "list") {
        const entry = {
          name: pending?.argument ?? "",
          inGrouping: stack.includes("grouping"),
          keys: [] as string[],
          depth: stack.length,
        };
        openLists.push(entry);
      }
      pending = null;
      continue;
    }
    if (whole === "}") {
      const closing = stack.pop();
      if (closing === "list") {
        const entry = openLists.pop();
        if (entry) lists.push({ name: entry.name, keys: entry.keys, inGrouping: entry.inGrouping });
      }
      pending = null;
      continue;
    }
    if (whole === ";") {
      if (pending?.keyword === "key") {
        const target = openLists.at(-1);
        if (target) target.keys.push(...pending.argument.replace(/"/g, "").trim().split(/\s+/).filter(Boolean));
      }
      if (pending?.keyword === "uses" && pending.argument.includes(":")) externalUses.push(pending.argument);
      pending = null;
      continue;
    }
    // A keyword, or the argument of the keyword before it.
    if (pending === null) {
      pending = { keyword: whole, argument: "" };
      if (whole === "augment") {
        // The target is quoted text; take the rest of the statement as the argument.
        const rest = /\s*("[^"]*"|[^{;]*)/.exec(clean.slice(match.index + whole.length));
        augments.push((rest?.[1] ?? "").replace(/"/g, "").trim());
      }
    } else {
      pending = {
        keyword: pending.keyword,
        argument: pending.argument === "" ? whole : `${pending.argument} ${whole}`,
      };
    }
  }
  return { lists, externalUses, augments };
}

/** The key names of one list by name, or an empty list where the module declares none. */
export function keyNamesOf(scan: YangScan, listName: string): readonly string[] {
  return scan.lists.find((list) => list.name === listName)?.keys ?? [];
}
