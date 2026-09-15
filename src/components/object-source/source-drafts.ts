import { SOURCE_CHARACTER_LIMIT } from "@/lib/db/object-kinds";
import type { ObjectEditRevision } from "@/lib/db/types";

/**
 * The unsaved edit of ONE part of an object's definition, held in this browser (#789 Phase 3,
 * from discussion #778).
 *
 * PURE FUNCTIONS OVER AN INJECTED `Storage`, no hook and no DOM, so the whole eviction
 * arithmetic is unit-testable without a browser. Every function takes `Storage | null` because
 * a shell that has no local storage at all is a state this module answers rather than throws on.
 *
 * DECISION H2, and it is the constraint this file exists to satisfy: the draft lives under its
 * OWN bounded key, with its own budget, its own try/catch and a VISIBLE failure, and the
 * workspace blob is not touched. `src/hooks/use-tab-manager.ts:213` writes that blob with no
 * try/catch inside a 500 ms timer, and a throw there stops tab persistence for the WHOLE
 * workspace in silence, which is filed defect X14: it was reproduced through the product's own
 * New tab button, with zero toasts, zero alerts and the word "quota" nowhere in the document.
 * Nothing here can make X14 worse, because nothing here writes that key.
 *
 * THE BOUND IS IN CHARACTERS, because the unit is ambiguous by a factor of two here. MEASURED on
 * Chrome 152: the origin ceiling is exactly 5,242,880 UTF-16 code units, counted as the sum of
 * `key.length + value.length` over every key, which is 5 MiB of CHARACTERS and twice the byte
 * budget the phrase "about 5 MiB" at `use-tab-manager.ts:52` is usually read as.
 *
 * EVICTION COUNTS ITS OWN KEYS AND NEVER ASKS THE BROWSER. MEASURED on Chrome 152:
 * `navigator.storage.estimate()` reported `usage: 0` while localStorage held 5,242,880
 * characters, so a policy that asked the browser how full it is would read zero at the exact
 * moment it mattered.
 *
 * ONE KEY AND NOT ONE PER CONNECTION, because the budget is a property of the SET: counting one
 * serialized string is one read, and a per-connection key would have to enumerate the store to
 * learn the same number. The cost of the choice is ORPHAN DRAFTS: deleting a connection leaves
 * its drafts behind, since nothing in this module knows the connection is gone. The bound plus
 * oldest-first eviction is what makes that harmless rather than a leak: an orphan is a record
 * under the same budget as every live draft, it is evicted before any newer draft is, and it is
 * unreachable, since the only reader asks for a key built from a connection id that no longer
 * resolves.
 *
 * THE FOUR FAILURE REASONS ARE FOUR AND NOT THREE, and the fourth is named rather than folded
 * into the nearest one. The three obvious ones are a caught `QuotaExceededError`, a text above
 * `SOURCE_CHARACTER_LIMIT`, and no storage at all. The fourth is a draft that is UNDER the read
 * bound and still larger than the whole budget once serialized, which a text made mostly of
 * newlines and quotes reaches at about 520,000 characters because each one costs two characters
 * escaped. Folding it into `too-long` would print "longer than the 1,000,000 characters this
 * definition can be read at" over a 600,000-character text, which is false, and a reader acting
 * on a false reason shortens a text that was never too long.
 */
export interface SourceDraft {
  readonly text: string;
  /** Epoch ms. The eviction order and the "edited ..." label. */
  readonly savedAt: number;
  /**
   * What the part's revision was when this draft was started, carried OPAQUELY so the restore
   * banner can say whether the definition moved under the draft. It is NOT a second copy of the
   * text: one maximal draft already costs 988,287 characters serialized, measured by writing it.
   */
  readonly base: ObjectEditRevision;
}

/**
 * The one key. Versioned, so a later shape change is a new key rather than a migration over a
 * record a previous release wrote.
 */
export const DRAFT_KEY = "libredb_source_drafts_v1";

/**
 * 1,048,576 characters, which is 20 percent of the measured origin ceiling, and it is counted as
 * `DRAFT_KEY.length + JSON.stringify(store).length`, which is how the origin ceiling itself is
 * counted.
 *
 * MEASURED: one maximal draft costs 988,287 characters serialized, so the budget holds exactly
 * one of those plus headroom, or dozens of ordinary ones, since `app.order_total`'s whole
 * definition is 197 characters. Four fifths of the origin stays with the workspace blob, the
 * history, the saved queries and the snapshots, which is what keeps H2's promise honest rather
 * than nominal.
 */
export const DRAFT_BUDGET_CHARACTERS = 1_048_576;

/** Which of the four public failures a write landed in. Readers branch on this id, never on prose. */
export type DraftFailure = "quota" | "budget" | "too-long" | "unavailable";

export type DraftWrite =
  | { readonly ok: true; readonly evicted: readonly string[] }
  | { readonly ok: false; readonly reason: DraftFailure };

/**
 * The pane's own address plus the part id, and NO new identity scheme: the address is the same
 * string `ObjectSourceView` builds for the Monaco model path, so a draft and the editor holding
 * it are keyed alike.
 */
export function draftKeyFor(address: string, partId: string): string {
  return `${address}/${partId}`;
}

/**
 * Every arm here has its own population in the test file, because an arm whose false branch is
 * never taken is 100 percent line-covered and certifies nothing.
 *
 * NO `Array.isArray` ARM, and its absence is measured rather than assumed. This predicate only
 * ever sees the output of `JSON.parse`, and a JSON array carries no named member, so `text` on
 * one is `undefined` and the `text` arm has already refused it: the array arm could never be the
 * decider. MEASURED: with the arm present, deleting it left the suite at 20 pass 0 fail, which is
 * a guard over an empty population rather than a pass, and a probe comparing the two predicates
 * over six parsed bodies and every member of each found 0 disagreements. The array case that IS
 * real is the STORE itself being an array, which `readStore` refuses, and the only population
 * that can see THAT guard is an array whose elements are well-formed drafts, which the test file
 * builds.
 *
 * `base` is checked for being an OBJECT and no further. It is carried opaquely, and the module
 * that acts on it is the restore banner, which compares it rather than destructuring it, so a
 * walk of `ObjectEditRevision`'s arms would be this module asserting a contract it does not own
 * and would go stale the moment that union grows one. A scalar is still rejected: the banner
 * compares `base` against the part's current revision, and `5` would reach that comparison as a
 * revision.
 */
function isDraftShape(value: unknown): value is SourceDraft {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== "string") return false;
  if (typeof candidate.savedAt !== "number") return false;
  return typeof candidate.base === "object" && candidate.base !== null;
}

/**
 * The whole store, or an empty one, WITH EVERY ENTRY ALREADY WALKED. A parse failure, a store
 * that is not a record, and a store that is an array all answer `{}`, and an entry that is not a
 * draft is dropped from the record rather than carried into it: this value feeds an editor, and a
 * half-written record must never reach it.
 *
 * THE FILTER IS HERE AND NOT AT THE READ, because the WRITE path walks the same bytes and used to
 * trust them. MEASURED on the pre-filter module, with a store this module did not write: an entry
 * of `null` raised `TypeError: null is not an object (evaluating 'entry.savedAt')` out of
 * `oldestDroppable`, and an entry with no `savedAt` was never selectable as a victim at all, since
 * `undefined < Infinity` is false, so eviction answered "no droppable neighbour" with a droppable
 * record sitting right there and every later write was refused `budget` permanently. The
 * population is tampering, an extension, or a future writer of this key rather than this
 * repository today, which is why it is robustness; declaring that population real for the read and
 * not for the write was the defect.
 */
function readStore(storage: Storage): Record<string, SourceDraft> {
  let parsed: unknown;
  try {
    const held = storage.getItem(DRAFT_KEY);
    if (held === null) return {};
    parsed = JSON.parse(held);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const store: Record<string, SourceDraft> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (isDraftShape(entry)) store[key] = entry;
  }
  return store;
}

/** The cost the origin itself charges: the key's own characters plus the serialized value's. */
function costOf(store: Record<string, SourceDraft>): number {
  return DRAFT_KEY.length + JSON.stringify(store).length;
}

/** The oldest entry by `savedAt` that is not the draft being written. Ties keep the first seen. */
function oldestDroppable(store: Record<string, SourceDraft>, keep: string): string | undefined {
  let chosen: string | undefined;
  let chosenAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of Object.entries(store)) {
    if (key === keep) continue;
    if (entry.savedAt < chosenAt) {
      chosen = key;
      chosenAt = entry.savedAt;
    }
  }
  return chosen;
}

export function readDraft(storage: Storage | null, key: string): SourceDraft | undefined {
  if (storage === null) return undefined;
  // No second shape check here: `readStore` has already dropped everything that is not a draft,
  // and a guard whose false branch cannot be reached is the exact defect this module was reviewed
  // for. The index is `SourceDraft | undefined` in fact, and typed so.
  const store: Partial<Record<string, SourceDraft>> = readStore(storage);
  return store[key];
}

/**
 * Writes one draft, evicting other drafts oldest-first while the store is over budget, and
 * answering one of the four reasons rather than throwing any of them.
 *
 * THE DRAFT BEING WRITTEN IS NEVER EVICTED, which is what makes the `budget` reason reachable at
 * all: an entry that cannot fit the budget alone has no droppable neighbour left, and a policy
 * that let the target be dropped would answer `ok: true` over a store that does not hold it.
 *
 * Nothing is stored on any refusal: the eviction runs over a copy, and the single `setItem` is
 * the last thing that happens.
 */
export function writeDraft(storage: Storage | null, key: string, draft: SourceDraft): DraftWrite {
  if (storage === null) return { ok: false, reason: "unavailable" };
  if (draft.text.length > SOURCE_CHARACTER_LIMIT) return { ok: false, reason: "too-long" };

  const next: Record<string, SourceDraft> = { ...readStore(storage), [key]: draft };
  const evicted: string[] = [];
  while (costOf(next) > DRAFT_BUDGET_CHARACTERS) {
    const victim = oldestDroppable(next, key);
    if (victim === undefined) return { ok: false, reason: "budget" };
    delete next[victim];
    evicted.push(victim);
  }

  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(next));
  } catch {
    // X14's whole lesson: the silent version is indistinguishable from working. The origin is
    // shared with everything else this application stores, so a throw here is reachable well
    // inside our own budget and its reason has to reach the reader.
    return { ok: false, reason: "quota" };
  }
  return { ok: true, evicted };
}

/**
 * Removes one draft and leaves the others. Best effort and void: the caller is the successful
 * apply and the explicit Discard, and neither has anything to do with a storage failure. The
 * `setItem` is guarded for the same reason `writeDraft`'s is, one step further: a throw out of
 * this call would break a successful apply's own handler, which is a worse outcome than a draft
 * that outlives the text it was an edit of.
 *
 * VOID MEANS THE CALLER CANNOT TELL "dropped" FROM "the browser refused", and the consequence of
 * a refusal after a SUCCESSFUL apply is a restore banner on the next mount offering the pre-apply
 * text with no reason attached. The signal exists but it is not this answer: it is a RE-READ.
 * `readDraft` on the same key still answers the draft after a refused drop, asserted in the test
 * file, so the pane that calls this can distinguish the two states and give the banner its
 * "another tab" grammar. Nothing in this module builds that banner (#789).
 */
export function dropDraft(storage: Storage | null, key: string): void {
  if (storage === null) return;
  const next = readStore(storage);
  delete next[key];
  try {
    storage.setItem(DRAFT_KEY, JSON.stringify(next));
  } catch {
    return;
  }
}
