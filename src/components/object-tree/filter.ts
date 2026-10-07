/**
 * The object tree's filter, over what the tree has ALREADY READ and nothing else (U25).
 *
 * Pure and DOM-free, like `flatten.ts`, and for a reason that matters more here: a filter that
 * could ask for a read would turn every keystroke into catalog traffic, which is the whole-database
 * read #789 removed. So the filter is a function of the cache, and `useTreeNodes` keeps deriving its
 * reads from the UNFILTERED rows. What the filter cannot see is REPORTED rather than hidden or read:
 * `useTreeNodes` counts the unread folders and the reader decides whether to read them.
 *
 * Only OBJECT rows are matched. A container or a folder is shown as the path to a match, and a
 * column as the content of an open matching object; matching their own names would answer a
 * different question ("which schema is this") with the same box. Column-name filtering is the
 * remaining half of U25.
 */
import type { Container, DatabaseObject } from "@/lib/db/types";
import { containerRowId, type TreeRowModel } from "./flatten";

/** `""` is "not filtering", so whitespace alone never hides the tree. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * The expansion set the filtered walk uses: the reader's own, plus every known container and every
 * READ folder, minus what the reader collapsed while filtering.
 *
 * A folder enters only once its objects are cached, which is what keeps this set from implying a
 * read: an open folder with no cached objects would draw nothing anyway, and the walk is never what
 * issues reads. Object ids come only from the reader's own set, so columns show where the reader
 * opened them and nowhere else.
 */
export function searchExpanded(
  expanded: ReadonlySet<string>,
  containers: readonly Container[],
  objects: Readonly<Record<string, readonly DatabaseObject[]>>,
  collapsed: ReadonlySet<string>,
): ReadonlySet<string> {
  const open = new Set(expanded);
  for (const container of containers) open.add(containerRowId(container.path));
  for (const folderId of Object.keys(objects)) open.add(folderId);
  for (const id of collapsed) open.delete(id);
  return open;
}

export interface FilteredRows {
  readonly rows: readonly TreeRowModel[];
  /** Matching OBJECT rows, which is the number the status line reads out. */
  readonly matches: number;
}

function matchRange(label: string, needle: string): readonly [number, number] | undefined {
  const folded = label.toLowerCase();
  const start = folded.indexOf(needle);
  if (start < 0) return undefined;
  return folded.length === label.length ? [start, start + needle.length] : [0, 0];
}

/**
 * The rows that survive `needle`: each matching object, every ancestor of it, and every row under
 * it (its open columns), in walk order.
 *
 * `aria-setsize` and `aria-posinset` are recomputed over the SURVIVING sibling groups, because the
 * tree pattern requires them to describe the group that is rendered, which is the contract
 * `flattenTree` already keeps. Every survivor's ancestors survive too, so a row's parent is the
 * nearest earlier survivor that is shallower than it.
 */
export function filterRows(rows: readonly TreeRowModel[], needle: string): FilteredRows {
  const keep = new Array<boolean>(rows.length).fill(false);
  const ranges = new Map<number, readonly [number, number]>();
  const ancestors: number[] = [];
  let matches = 0;
  let insideDepth = -1;

  rows.forEach((row, index) => {
    while (ancestors.length > 0 && rows[ancestors[ancestors.length - 1]].depth >= row.depth) ancestors.pop();
    if (insideDepth >= 0 && row.depth > insideDepth) {
      keep[index] = true;
    } else {
      insideDepth = -1;
      const range = row.kind === "object" ? matchRange(row.label, needle) : undefined;
      if (range !== undefined) {
        matches += 1;
        ranges.set(index, range);
        keep[index] = true;
        for (const ancestor of ancestors) keep[ancestor] = true;
        insideDepth = row.depth;
      }
    }
    ancestors.push(index);
  });

  const kept = rows.flatMap((row, index) => (keep[index] ? [{ row, index }] : []));
  const parentOf: number[] = [];
  const sizes = new Map<number, number>();
  const stack: number[] = [];
  kept.forEach(({ row }, position) => {
    while (stack.length > 0 && kept[stack[stack.length - 1]].row.depth >= row.depth) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1;
    parentOf.push(parent);
    sizes.set(parent, (sizes.get(parent) ?? 0) + 1);
    stack.push(position);
  });

  const seen = new Map<number, number>();
  const filtered = kept.map(({ row, index }, position): TreeRowModel => {
    const parent = parentOf[position];
    const posInSet = (seen.get(parent) ?? 0) + 1;
    seen.set(parent, posInSet);
    const match = ranges.get(index);
    return { ...row, setSize: sizes.get(parent) ?? posInSet, posInSet, ...(match === undefined ? {} : { match }) };
  });
  return { rows: filtered, matches };
}
