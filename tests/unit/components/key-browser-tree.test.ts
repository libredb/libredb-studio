import { describe, test, expect } from "bun:test";
import {
  buildKeyTree,
  filterKeyTree,
  flattenKeyTree,
  isUnderPrefix,
  keyName,
  keyRowNames,
  keyTreeWindow,
  KEY_ROW_HEIGHT,
  prefixPattern,
  sentPattern,
  splitKey,
  KEY_SEPARATOR,
  type KeyTreeNode,
  type KeyTreeRow,
} from "@/components/key-browser/tree";
import { keyScanShape } from "@/lib/db/types";

/** The child segments of a node, which is what most of these assertions are about. */
function segments(node: KeyTreeNode): string[] {
  return node.children.map((child) => child.segment);
}

/** One node by path, so an assertion can name the folder it is about rather than walk. */
function at(root: KeyTreeNode, ...path: string[]): KeyTreeNode {
  let node = root;
  for (const segment of path) {
    const next = node.children.find((child) => child.segment === segment);
    if (next === undefined) throw new Error(`no child "${segment}" under ${JSON.stringify(node.path)}`);
    node = next;
  }
  return node;
}

describe("splitKey()", () => {
  test("splits on the one separator the tree is built from", () => {
    expect(KEY_SEPARATOR).toBe(":");
    expect(splitKey("app:cache:user:1")).toEqual(["app", "cache", "user", "1"]);
  });

  test("a key with no separator is one segment", () => {
    expect(splitKey("healthcheck")).toEqual(["healthcheck"]);
  });

  test("an empty key is one empty segment rather than no segments", () => {
    // Redis accepts the empty string as a key. `"".split(":")` already answers `[""]`, and this
    // pins it because the alternative spelling (`[]`) would make such a key vanish from the tree
    // while still counting toward the root.
    expect(splitKey("")).toEqual([""]);
  });

  test("empty segments are kept, because the key really does contain them", () => {
    // `:foo`, `foo:` and `a::b` are three distinct keys on the server. Collapsing the empty
    // segment would draw them as the same path and merge three keys into one row.
    expect(splitKey(":foo")).toEqual(["", "foo"]);
    expect(splitKey("foo:")).toEqual(["foo", ""]);
    expect(splitKey("a::b")).toEqual(["a", "", "b"]);
  });
});

describe("buildKeyTree()", () => {
  test("an empty input is an empty root", () => {
    const root = buildKeyTree([]);

    expect(root.segment).toBe("");
    expect(root.path).toEqual([]);
    expect(root.children).toEqual([]);
    expect(root.count).toBe(0);
    expect(root.isKey).toBe(false);
  });

  test("a key with no separator is a single leaf", () => {
    const root = buildKeyTree(["healthcheck"]);

    expect(segments(root)).toEqual(["healthcheck"]);
    expect(root.count).toBe(1);
    expect(at(root, "healthcheck")).toMatchObject({ path: ["healthcheck"], count: 1, isKey: true, children: [] });
  });

  test("counts every key at or under a node, and nothing above it", () => {
    const root = buildKeyTree(["app:env", "app:cache:ttl", "user:1001:name"]);

    // The root counts everything the walk saw: it is the one number a caller can compare against
    // the progress indicator, and it counts DISTINCT keys rather than rows drawn.
    expect(root.count).toBe(3);
    expect(at(root, "app").count).toBe(2);
    expect(at(root, "app", "env").count).toBe(1);
    expect(at(root, "app", "cache").count).toBe(1);
    expect(at(root, "user").count).toBe(1);
    // A leaf carries the count of the keys that end there, which is one by definition — two keys
    // cannot share a full name.
    expect(at(root, "app", "cache", "ttl").count).toBe(1);
  });

  test("a node is both a key and a folder when a key is a prefix of another", () => {
    // The case the tree exists for, and the one a naive build gets wrong: `app` is a real key AND
    // the parent of `app:env`, so it must draw as an expandable row that is also openable.
    const root = buildKeyTree(["app", "app:env"]);
    const app = at(root, "app");

    expect(app.isKey).toBe(true);
    expect(segments(app)).toEqual(["env"]);
    expect(app.count).toBe(2);
    expect(root.count).toBe(2);
  });

  test("absorbs duplicate keys across pages rather than counting them twice", () => {
    // `SCAN` may hand the same key back on a second batch while the table rehashes, so the caller
    // feeds pages in without deduplicating them first. A double-count here would put a folder's
    // badge above the progress bar that is meant to account for it.
    const root = buildKeyTree(["app:env", "app:env", "app:cache:ttl", "app:env"]);

    expect(root.count).toBe(2);
    expect(at(root, "app").count).toBe(2);
    expect(at(root, "app", "env").count).toBe(1);
  });

  test("drives a node's path from its ancestors", () => {
    const root = buildKeyTree(["app:cache:user:1"]);

    expect(at(root, "app", "cache", "user", "1").path).toEqual(["app", "cache", "user", "1"]);
    // A folder's path is the segments ABOVE it, so a caller never has to re-derive a prefix from
    // the name it is looking at.
    expect(at(root, "app", "cache").path).toEqual(["app", "cache"]);
  });

  test("puts folders before leaves, ahead of the alphabetical order", () => {
    // `zzz` sorts after `aaa` and is drawn first because it is a folder: the tree groups what can
    // be expanded, and a list that interleaved the two would make a reader scan every row to find
    // the one twisty they were looking for.
    const root = buildKeyTree(["aaa", "zzz:inner"]);

    expect(segments(root)).toEqual(["zzz", "aaa"]);
  });

  test("orders sibling segments the way a person reads numbered keys", () => {
    const root = buildKeyTree(["user:10", "user:2", "user:1"]);

    // Numeric collation, so `2` precedes `10` instead of following it the way a byte comparison
    // would have it.
    expect(segments(at(root, "user"))).toEqual(["1", "2", "10"]);
  });

  test("gives empty segments their own rows instead of merging the keys that carry them", () => {
    const root = buildKeyTree([":foo", "foo:", "a::b"]);

    // Three keys, and none of them collapses into another: the empty segment is a segment.
    expect(root.count).toBe(3);
    expect(segments(root)).toEqual(["", "a", "foo"]);
    expect(at(root, "", "foo").isKey).toBe(true);
    expect(at(root, "foo", "").isKey).toBe(true);
    expect(at(root, "a", "", "b").isKey).toBe(true);
  });

  test("is a pure function of the keys, so a restarted walk rebuilds the same tree", () => {
    const keys = ["app:env", "app:cache:ttl", "user:1001:name"];

    // The panel accumulates its pages and rebuilds; that is only safe because two calls with the
    // same keys agree, including on ordering. A tree mutated in place would have two sources of
    // truth for its counts the moment a walk restarted from cursor "0".
    expect(buildKeyTree(keys)).toEqual(buildKeyTree([...keys]));
  });
});

describe("flattenKeyTree()", () => {
  const KEYS = ["app:env", "app:cache:ttl", "healthcheck"];

  /** Rows as `label@depth`, spelling the load-more row `more` so both shapes fit one assertion. */
  const labels = (rows: readonly KeyTreeRow[]): string[] =>
    rows.map((row) => `${row.kind === "loadMore" ? "more" : row.node.segment}@${row.depth}`);

  test("draws the top level when nothing is open", () => {
    const rows = flattenKeyTree(buildKeyTree(KEYS), () => false);

    // Folders before leaves, as the tree orders them: `app` and then `healthcheck`.
    expect(rows.map((row) => [row.kind, row.depth])).toEqual([
      ["node", 0],
      ["node", 0],
    ]);
    expect(labels(rows)).toEqual(["app@0", "healthcheck@0"]);
    expect(rows.every((row) => row.kind === "node" && row.folder === (row.node.segment === "app"))).toBe(true);
  });

  test("walks into an open path and deepens each level", () => {
    const root = buildKeyTree(KEYS);
    // Only the top level is open, so `cache` is drawn and its own child is not.
    const rows = flattenKeyTree(root, (path) => path.length === 1 && path[0] === "app");

    expect(labels(rows)).toEqual(["app@0", "cache@1", "env@1", "healthcheck@0"]);

    // Opening one more level is a property of the PATH and not of the row, which is what makes a
    // second sibling's children stay closed while the first one's open.
    const deeper = flattenKeyTree(root, (path) => path.length <= 2 && path[0] === "app");
    expect(labels(deeper)).toEqual(["app@0", "cache@1", "ttl@2", "env@1", "healthcheck@0"]);
  });

  test("calls a node that is both a key and a folder a folder", () => {
    const rows = flattenKeyTree(buildKeyTree(["app", "app:env"]), () => false);

    // `app` is a real key and the parent of one. It has to draw as openable, and it is the only
    // node here where `isKey` and `folder` are both true.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "node", depth: 0, folder: true });
    expect(rows[0].kind === "node" && rows[0].node.isKey).toBe(true);
  });

  test("puts a load-more row AFTER the children it follows, one level deeper", () => {
    const rows = flattenKeyTree(
      buildKeyTree(KEYS),
      (path) => path[0] === "app",
      () => true,
    );

    // After `cache`'s own child, and beside it rather than under it: the row is a sibling of the
    // children, which is what makes it read as "and there is more where these came from".
    expect(labels(rows)).toEqual(["app@0", "cache@1", "ttl@2", "more@2", "env@1", "more@1", "healthcheck@0"]);
    const more = rows.filter((row) => row.kind === "loadMore");
    expect(more.map((row) => row.path)).toEqual([["app", "cache"], ["app"]]);
  });

  test("emits no load-more row for a folder that is closed", () => {
    // A collapsed folder has no children on screen for more to follow, so the row would be an
    // offer with nothing above it to continue.
    const rows = flattenKeyTree(
      buildKeyTree(KEYS),
      () => false,
      () => true,
    );

    expect(labels(rows)).toEqual(["app@0", "healthcheck@0"]);
  });

  test("emits no load-more row for a leaf, whatever the predicate says", () => {
    // A key is not a prefix, so there is nothing under it to ask about — and a caller that answered
    // `true` for every path must not turn a leaf into a folder.
    const rows = flattenKeyTree(
      buildKeyTree(["healthcheck"]),
      () => true,
      () => true,
    );

    expect(labels(rows)).toEqual(["healthcheck@0"]);
  });
});

describe("isUnderPrefix()", () => {
  test("compares segment by segment rather than by characters", () => {
    // The reason this is not `key.startsWith(`${prefix}:`)`: both spellings of a prefix agree here,
    // but only one agrees about `app:envelope`.
    expect(isUnderPrefix("app:env", ["app"])).toBe(true);
    expect(isUnderPrefix("app:cache:ttl", ["app", "cache"])).toBe(true);
    expect(isUnderPrefix("app:envelope", ["app", "env"])).toBe(false);
    expect(isUnderPrefix("apple:env", ["app"])).toBe(false);
  });

  test("a key is not under itself", () => {
    // `app` is a prefix of `app:env` and NOT under `app`; it IS the prefix. Treating it as under
    // would make a scoped walk for `app` hand back `app` itself, which the tree already draws as its
    // own row.
    expect(isUnderPrefix("app", ["app"])).toBe(false);
  });

  test("holds for the empty-segment keys a scoped walk can really return", () => {
    expect(isUnderPrefix("app::ttl", ["app", ""])).toBe(true);
    expect(isUnderPrefix(":app:ttl", [""])).toBe(true);
  });
});

describe("filterKeyTree()", () => {
  const KEYS = ["app:cache:ttl", "app:env", "user:1001:name", "healthcheck"];

  test("returns the tree untouched for a blank term", () => {
    const root = buildKeyTree(KEYS);

    // Identity rather than a copy, so a panel that filters on every keystroke does no work until
    // somebody types a character, and "no filter" cannot drift from "no filter applied".
    expect(filterKeyTree(root, "")).toBe(root);
    expect(filterKeyTree(root, "   ")).toBe(root);
  });

  test("keeps everything under a segment that matches", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "cache");

    // The whole subtree, not just the row named `cache`: somebody who typed a prefix is asking
    // what is under it.
    expect(segments(filtered)).toEqual(["app"]);
    expect(segments(at(filtered, "app"))).toEqual(["cache"]);
    expect(at(filtered, "app", "cache", "ttl").isKey).toBe(true);
  });

  test("keeps the ancestors that lead to a match and drops the siblings beside them", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "1001");

    expect(segments(filtered)).toEqual(["user"]);
    expect(segments(at(filtered, "user"))).toEqual(["1001"]);
    // `app` and `healthcheck` are gone, and `user` survives only as the path to the match.
    expect(at(filtered, "user", "1001", "name").isKey).toBe(true);
  });

  test("matches without regard to case", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "HEALTH");

    expect(segments(filtered)).toEqual(["healthcheck"]);
  });

  test("answers an empty tree rather than nothing when no segment matches", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "nothing-here");

    // One shape to draw an empty state over, rather than a null every caller has to remember.
    expect(filtered.children).toEqual([]);
    expect(filtered.segment).toBe("");
  });

  test("keeps the sample's own counts rather than the narrowed view's", () => {
    const root = buildKeyTree(KEYS);
    const filtered = filterKeyTree(root, "1001");

    // `user` holds one key and its count says so. A count recomputed from the filtered tree would
    // read differently on every keystroke for the same folder, which is how a reader stops
    // trusting the number.
    expect(at(filtered, "user").count).toBe(at(root, "user").count);
    expect(filtered.count).toBe(root.count);
  });

  /**
   * A TERM WITH A `:` IN IT NAMES A PATH, and no single segment can contain one.
   *
   * The box takes two kinds of answer and a reader cannot tell which it wants: a word narrows to a
   * branch, and the rest of a key's own name finds that key. A segment-only test answered "no match"
   * for the most specific input there is — the one a person types when they already know what they
   * are looking for.
   */
  describe("a term that names a path rather than a segment", () => {
    const NESTED = ["queue:jobs:failed:2026:09:23:abc", "queue:jobs:ok:2026:10:01:def", "queue:other"];

    test("finds the key and keeps the path that leads to it", () => {
      const filtered = filterKeyTree(buildKeyTree(NESTED), "queue:jobs:failed:2026:09:23");

      expect(segments(filtered)).toEqual(["queue"]);
      expect(segments(at(filtered, "queue"))).toEqual(["jobs"]);
      expect(segments(at(filtered, "queue", "jobs"))).toEqual(["failed"]);
      expect(at(filtered, "queue", "jobs", "failed", "2026", "09", "23", "abc").isKey).toBe(true);
      // The sibling branch under the same parent is gone: a path is a narrower question than a word.
      expect(segments(at(filtered, "queue", "jobs"))).not.toContain("ok");
    });

    test("answers a partial path, which is what a reader has when they are still looking", () => {
      const filtered = filterKeyTree(buildKeyTree(NESTED), "failed:2026:09");

      expect(at(filtered, "queue", "jobs", "failed", "2026", "09", "23", "abc").isKey).toBe(true);
      expect(segments(at(filtered, "queue", "jobs"))).not.toContain("ok");
    });

    test("keeps the WHOLE subtree of a folder whose own name is the match", () => {
      const filtered = filterKeyTree(buildKeyTree(NESTED), "queue:jobs");

      // `queue:jobs` is a path AND a branch: everything under it is what was asked for, exactly as
      // when a single segment matches.
      expect(segments(at(filtered, "queue", "jobs")).sort()).toEqual(["failed", "ok"]);
      expect(filtered.children.length).toBe(1);
    });

    test("matches the full name without regard to case too", () => {
      const filtered = filterKeyTree(buildKeyTree(NESTED), "QUEUE:JOBS:FAILED");

      expect(at(filtered, "queue", "jobs", "failed", "2026", "09", "23", "abc").isKey).toBe(true);
    });

    test("answers a middle fragment, which is what a reader has when they know a number", () => {
      const keys = ["app:123:kkk", "app:456:kkk"];

      // `includes` and not `startsWith`: the box takes ANY part of a name, at any depth.
      expect(segments(at(filterKeyTree(buildKeyTree(keys), "123"), "app"))).toEqual(["123"]);
      expect(at(filterKeyTree(buildKeyTree(keys), "123"), "app", "123", "kkk").isKey).toBe(true);
      expect(filterKeyTree(buildKeyTree(keys), "123").count).toBe(2);
    });

    test("answers a partial path that crosses a segment boundary", () => {
      const keys = ["app:123:kkk", "app:123:mmm"];

      // `123:k` is not a segment and not a key: it is the middle of one name, which is the shape a
      // reader produces by reading the tree from left to right.
      const filtered = filterKeyTree(buildKeyTree(keys), "123:k");

      expect(segments(at(filtered, "app", "123"))).toEqual(["kkk"]);
      expect(at(filtered, "app", "123", "kkk").isKey).toBe(true);
    });

    test("accepts a folder's advertised `prefix:*` form, which is what the row shows", () => {
      const filtered = filterKeyTree(buildKeyTree(NESTED), "queue:jobs:*");

      // The tree DRAWS a folder as `queue:jobs:*`, so a reader copying one has typed a `*` no key
      // contains. Dropping that one trailing form is the difference between "no match" and the
      // branch they were pointing at.
      expect(segments(filtered)).toEqual(["queue"]);
      expect(segments(at(filtered, "queue", "jobs")).sort()).toEqual(["failed", "ok"]);
    });

    test("keeps a `*` anywhere else literal, because a key may really contain one", () => {
      const keys = ["odd*key:1", "oddkey:1"];

      expect(segments(filterKeyTree(buildKeyTree(keys), "odd*k"))).toEqual(["odd*key"]);
    });

    test("treats `:*` alone as no filter rather than as a term nothing matches", () => {
      const root = buildKeyTree(NESTED);

      expect(filterKeyTree(root, ":*")).toBe(root);
    });
  });
});

describe("keyTreeWindow()", () => {
  test("mounts everything it has when the box has not been measured", () => {
    // Height 0 is a box that is `display:none` or has not been laid out: guessing a height there would
    // hide rows a reader cannot yet scroll to, behind a scrollbar they will not see. The honest
    // reading of "I do not know how tall this is" is "show what I have".
    expect(keyTreeWindow(10_000, 0, 0)).toEqual([0, 10_000]);
    expect(keyTreeWindow(0, 0, 0)).toEqual([0, 0]);
  });

  test("mounts what fits plus the overscan, and follows the scroll", () => {
    // 240px is ten rows of 24, plus four kept mounted beyond each edge.
    expect(keyTreeWindow(10_000, 0, 240)).toEqual([0, 18]);
    // Scrolled fifty rows down: the window slides with it rather than widening.
    expect(keyTreeWindow(10_000, KEY_ROW_HEIGHT * 50, 240)).toEqual([46, 64]);
  });

  test("never mounts past the end, and a short list is whole", () => {
    expect(keyTreeWindow(10_000, KEY_ROW_HEIGHT * 10_000, 240)).toEqual([9_982, 10_000]);
    expect(keyTreeWindow(5, KEY_ROW_HEIGHT * 50, 240)).toEqual([0, 5]);
    expect(keyTreeWindow(5, 0, 240)).toEqual([0, 5]);
  });

  test("shifts to CONTAIN a focused row rather than widening", () => {
    // Focus cannot move to a node that is not in the DOM, so the window follows it: the first row at
    // the top of a scrolled list stays mounted...
    expect(keyTreeWindow(10_000, KEY_ROW_HEIGHT * 50, 240, 0)).toEqual([0, 18]);
    // ...and so does the last one, which a scroll alone would have left eight hundred rows below.
    expect(keyTreeWindow(10_000, KEY_ROW_HEIGHT * 50, 240, 9_999)).toEqual([9_982, 10_000]);
  });

  test("focusing a row near the top still mounts something", () => {
    // THE REGRESSION. The scroll-derived start subtracts the overscan, so anywhere in the first four
    // rows it was negative, and the focus branch passed that negative straight to the caller. A
    // negative start is not an early window: `slice(-4, 14)` counts from the END, so a forty-row list
    // came back EMPTY and the panel drew nothing below the filter box - not even the database row.
    // Clicking a row is what sets a focus first, which is why this only showed up after a click.
    for (let focus = 0; focus < 4; focus += 1) {
      expect(keyTreeWindow(40, 0, 240, focus)).toEqual([0, 18]);
    }
    // The same blanking, reached a second way: a focused index that outlives its rows (a rescan, or
    // collapsing the folder above it) points past the end, and the window must still mount the list.
    expect(keyTreeWindow(10, 0, 240, 40)).toEqual([0, 10]);
    expect(keyTreeWindow(5, KEY_ROW_HEIGHT * 50, 240, 7)).toEqual([0, 5]);
    // And the invariants those cases were breaking, over a spread of counts, scrolls and foci: rows
    // must actually come back, the focused row must be among them, and the rows a reader can see must
    // be mounted rather than scrolled past.
    for (let count = 0; count <= 60; count += 7) {
      for (const scrollTop of [0, KEY_ROW_HEIGHT, KEY_ROW_HEIGHT * 3, KEY_ROW_HEIGHT * 30]) {
        const firstVisible = Math.floor(scrollTop / KEY_ROW_HEIGHT);
        for (const focus of [-1, 0, 1, 3, 8, 30, count - 1]) {
          const [start, end] = keyTreeWindow(count, scrollTop, 240, focus);
          const mounted = Array.from({ length: count }, (_, index) => index).slice(start, end);
          expect(start).toBeGreaterThanOrEqual(0);
          if (count > 0) expect(mounted.length).toBeGreaterThan(0);
          if (focus >= 0 && focus < count) expect(mounted).toContain(focus);
          // The scroll-derived window is the one that owes the reader their viewport. A focus window
          // deliberately trades coverage for containment, so it makes no such promise.
          if (focus < 0) {
            for (let row = firstVisible; row < Math.min(firstVisible + 10, count); row += 1) {
              expect(mounted).toContain(row);
            }
          }
        }
      }
    }
  });
});

describe("the ARIA pair every row carries", () => {
  // Its OWN fixture, with a folder that has a child and a key that is nested three deep: enough to
  // have three levels, and a load-more row at two of them.
  const NESTED = ["app:cache:ttl", "app:env", "user:1001:name", "healthcheck"];

  test("numbers the treeitems of a level against each other, and leaves the button out", () => {
    const rows = flattenKeyTree(
      buildKeyTree(NESTED),
      () => true,
      () => true,
    );
    const items = rows.filter((row) => row.kind !== "loadMore");
    const byDepth = new Map<number, KeyTreeRow[]>();
    for (const row of items) byDepth.set(row.depth, [...(byDepth.get(row.depth) ?? []), row]);

    // Every level's set is complete (1..n) and every member agrees on its size, which is what a screen
    // reader is told when the window has hidden the rest of the list.
    expect(byDepth.size).toBeGreaterThan(1);
    for (const group of byDepth.values()) {
      expect(group.map((row) => row.posInSet)).toEqual(group.map((_, index) => index + 1));
      for (const row of group) expect(row.setSize).toBe(group.length);
    }

    // There ARE load-more rows here, and they are exactly what would inflate those sets: a button has
    // no `aria-posinset` of its own, so it is counted by nobody.
    const buttons = rows.filter((row) => row.kind === "loadMore");
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((row) => row.setSize === 0 && row.posInSet === 0)).toBe(true);
  });

  test("puts a load-more row beside the children of the folder it belongs to", () => {
    const rows = flattenKeyTree(
      buildKeyTree(NESTED),
      () => true,
      () => true,
    );
    const depthOf = (path: string): number | undefined =>
      rows.find((row) => row.kind === "node" && row.node.path.join(":") === path)?.depth;

    // `cache` is a folder with one child: its button is drawn one level deeper than `cache`, which is
    // the same level as `ttl` — the claim the window computes each row's `top` from, and the reason
    // grouping by depth puts the button in the same neighbourhood as the children it follows.
    const folder = depthOf("app:cache");
    const child = depthOf("app:cache:ttl");
    const button = rows.find((row) => row.kind === "loadMore" && row.path.join(":") === "app:cache");
    expect(folder).toBeDefined();
    expect(child).toBeDefined();
    expect(button).toBeDefined();
    expect(folder).toBe((child as number) - 1);
    expect(button?.depth).toBe(child);
  });
});

/**
 * The tree in a declared shape (spec 3.4, 4.6): etcd's `/`, its prefix pattern, and the root row a
 * leading separator makes. Every helper above ran with no shape, which is Redis's, and answers as it
 * always did; everything below hands the shape a production caller reads from `keyScanShape`.
 */
const ETCD = keyScanShape({
  defaultCount: 500,
  maxCount: 1000,
  separator: "/",
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "walk",
});

/**
 * Review Focus 1: keys whose bytes or shape strain the path model. Each is a key etcd can hold, and
 * each must come back from the tree as exactly the string it went in as: an empty segment, a trailing
 * separator (the directory marker, which is also the start of its folder's range), the separator
 * alone, a space, both quotes, a newline, `#`, `$`, a leading `-` in a segment and in the key, and a
 * key with no leading separator at all.
 */
const STRAINING_KEYS = [
  "/a//b",
  "/app/",
  "/app/cfg",
  "/",
  "/sp ace/k",
  "/q'uo\"te/k",
  "/nl\nx/k",
  "/#h/k",
  "/$d/k",
  "/-lead/k",
  "-top",
  "plain",
];

/** Every node of a tree, depth first, the root excluded. */
function everyNode(root: KeyTreeNode): KeyTreeNode[] {
  return root.children.flatMap((child) => [child, ...everyNode(child)]);
}

describe("the tree in a declared shape", () => {
  test("splits on the declared separator, and a leading one is an empty first segment", () => {
    expect(splitKey("/apisix/routes/1", ETCD)).toEqual(["", "apisix", "routes", "1"]);
    expect(splitKey("/", ETCD)).toEqual(["", ""]);
    expect(splitKey("/a//b", ETCD)).toEqual(["", "a", "", "b"]);
    expect(splitKey("/app/", ETCD)).toEqual(["", "app", ""]);
    // No leading separator, no empty segment: such a key stands beside the root row, not under it.
    expect(splitKey("k3s/x", ETCD)).toEqual(["k3s", "x"]);
    // Under this shape a colon is data.
    expect(splitKey("/a:b/c", ETCD)).toEqual(["", "a:b", "c"]);
  });

  test("joins every path back to the key it came from", () => {
    // `keyName` is the inverse of `splitKey`, which is what lets every surface address a key by the
    // name the tree gives it (Review Focus 1).
    for (const key of STRAINING_KEYS) expect(keyName(splitKey(key, ETCD), ETCD)).toBe(key);
    expect(keyName([""], ETCD)).toBe("");
    expect(keyName(["", "apisix"], ETCD)).toBe("/apisix");
    // With no shape handed, Redis's `:`, and its leading colon is kept the same way.
    expect(keyName(["", "foo"])).toBe(":foo");
  });

  test("draws a key that starts with the separator under the root row, beside one that does not", () => {
    const root = buildKeyTree(["/apisix/routes/1", "/feature-flag", "k3s/x", "plain"], ETCD);

    // The root row is the node of the empty first segment; `k3s` and `plain` have no leading `/` and
    // stand beside it (spec 4.6: five of the layouts R09 read have none).
    expect(segments(root)).toEqual(["", "k3s", "plain"]);
    expect(at(root, "").count).toBe(2);
    expect(segments(at(root, ""))).toEqual(["apisix", "feature-flag"]);
    expect(at(root, "", "apisix", "routes", "1")).toMatchObject({ path: ["", "apisix", "routes", "1"], isKey: true });
  });

  test("names every node of a straining key space by its stored string, and never with an empty name", () => {
    const root = buildKeyTree(STRAINING_KEYS, ETCD);
    const keys = everyNode(root)
      .filter((node) => node.isKey)
      .map((node) => keyName(node.path, ETCD));

    // Every key the tree holds is one that went in, and every one that went in is held.
    expect(keys.sort()).toEqual([...STRAINING_KEYS].sort());
    for (const node of everyNode(root)) {
      const names = keyRowNames(node, node.children.length > 0, ETCD);
      expect(names.label).not.toBe("");
      expect(names.title).not.toBe("");
      expect(names.toggle).not.toBe("");
      expect(`${names.label}${names.title}${names.toggle}`).not.toContain("�");
    }
  });

  test("gives the root row, a folder, a key and a directory marker their names", () => {
    const root = buildKeyTree(["/apisix/routes/1", "/app/", "/app/cfg"], ETCD);

    // The root row: a folder whose full name is empty, so its twisty names the separator instead.
    expect(keyRowNames(at(root, ""), true, ETCD)).toEqual({ label: "/*", title: "/*", toggle: "/" });
    expect(keyRowNames(at(root, "", "apisix"), true, ETCD)).toEqual({
      label: "apisix/*",
      title: "/apisix/*",
      toggle: "/apisix",
    });
    // A key says its FULL name, and `/app/`, the directory marker, is a key under the folder `app/*`.
    expect(keyRowNames(at(root, "", "apisix", "routes", "1"), false, ETCD)).toMatchObject({
      label: "/apisix/routes/1",
      title: "/apisix/routes/1",
    });
    expect(keyRowNames(at(root, "", "app", ""), false, ETCD)).toMatchObject({ label: "/app/", title: "/app/" });
  });

  test("keeps Redis's names, apart from the root row's twisty", () => {
    const root = buildKeyTree(["app", "app:env", ":foo"]);

    expect(keyRowNames(at(root, "app"), true)).toEqual({
      label: "app",
      title: "app is a key of this database and a prefix: app:*",
      toggle: "app",
    });
    expect(keyRowNames(at(root, "app", "env"), false)).toMatchObject({ label: "app:env", title: "app:env" });
    // `:foo` makes Redis's own root row: its label and title are today's `:*`, and its twisty, which
    // announced an empty name before, names the separator.
    expect(keyRowNames(at(root, ""), true)).toEqual({ label: ":*", title: ":*", toggle: ":" });
  });

  test("holds a key to its prefix segment by segment under the declared separator", () => {
    expect(isUnderPrefix("/apisix/routes/1", ["", "apisix"], ETCD)).toBe(true);
    expect(isUnderPrefix("/apisixx/y", ["", "apisix"], ETCD)).toBe(false);
    // The directory marker is under its folder, and the folder's own name is not.
    expect(isUnderPrefix("/app/", ["", "app"], ETCD)).toBe(true);
    expect(isUnderPrefix("/app", ["", "app"], ETCD)).toBe(false);
    // Everything that starts with the separator is under the root row, and nothing else is.
    expect(isUnderPrefix("/", [""], ETCD)).toBe(true);
    expect(isUnderPrefix("k3s/x", [""], ETCD)).toBe(false);
  });

  test("builds a prefix etcd can walk, unescaped and with no star", () => {
    expect(prefixPattern("/apisix/routes/*", ETCD)).toBe("/apisix/routes/");
    expect(prefixPattern(keyName(["", "apisix"], ETCD), ETCD)).toBe("/apisix/");
    expect(prefixPattern(keyName([""], ETCD), ETCD)).toBe("/");
    // A glob metacharacter, a space, both quotes, a `$` and a `-` are bytes of the prefix.
    expect(prefixPattern("/a[b] *?$'\"-/*", ETCD)).toBe("/a[b] *?$'\"-/");
    // A path whose last segment is empty is the prefix of the keys under that empty segment.
    expect(prefixPattern(keyName(["", "a", ""], ETCD), ETCD)).toBe("/a//");
  });

  test("keeps the glob pattern when no shape is handed", () => {
    expect(prefixPattern("user:*")).toBe("user:*");
    expect(prefixPattern("user")).toBe("user:*");
    expect(prefixPattern("a[b:*")).toBe("a\\[b:*");
  });

  test("sends the typed prefix, dropping only the star of a trailing separator and star", () => {
    expect(sentPattern("/apisix/routes/*", ETCD)).toBe("/apisix/routes/");
    expect(sentPattern("/app/", ETCD)).toBe("/app/");
    expect(sentPattern("/app", ETCD)).toBe("/app");
    expect(sentPattern("/*", ETCD)).toBe("/");
    // A star anywhere else is data, and nothing is trimmed: a prefix is bytes.
    expect(sentPattern("/a*b/", ETCD)).toBe("/a*b/");
    expect(sentPattern("*", ETCD)).toBe("*");
    expect(sentPattern(" a/*", ETCD)).toBe(" a/");
    // With no shape handed the text is the reader's own glob, untouched.
    expect(sentPattern("app:*")).toBe("app:*");
    expect(sentPattern(" app:* ")).toBe(" app:* ");
  });

  /**
   * The filter, by the full name every node is known by (spec 4.6). `pruneKeyTree` used to build a
   * name by appending to its parent's, and a parent whose own name was empty (the root row) lost the
   * leading separator: `/a/b` was matched as `a/b`, so a typed full key found nothing.
   */
  test("finds a full key that starts with the separator", () => {
    const root = buildKeyTree(["/apisix/routes/1", "/apisix/plugins", "/feature-flag", "k3s/x"], ETCD);
    const filtered = filterKeyTree(root, "/apisix/routes/1", ETCD);

    expect(segments(filtered)).toEqual([""]);
    expect(segments(at(filtered, "", "apisix"))).toEqual(["routes"]);
    expect(at(filtered, "", "apisix", "routes", "1").isKey).toBe(true);
  });

  test("finds a prefix that starts with the separator, and its whole branch", () => {
    const root = buildKeyTree(["/apisix/routes/1", "/apisix/plugins", "/feature-flag", "k3s/x"], ETCD);

    // `/apisix/` names the branch, and `/apisix/*`, the folder's advertised name, means the same.
    for (const term of ["/apisix/", "/apisix/*"]) {
      const filtered = filterKeyTree(root, term, ETCD);
      expect(segments(filtered)).toEqual([""]);
      expect(segments(at(filtered, ""))).toEqual(["apisix"]);
      expect(segments(at(filtered, "", "apisix")).sort()).toEqual(["plugins", "routes"]);
    }
  });

  test("finds a key with no leading separator beside the root row", () => {
    const filtered = filterKeyTree(buildKeyTree(["/apisix/routes/1", "k3s/x", "k3s/y"], ETCD), "k3s/x", ETCD);

    expect(segments(filtered)).toEqual(["k3s"]);
    expect(segments(at(filtered, "k3s"))).toEqual(["x"]);
  });

  test("keeps a Redis key's leading colon, the same fix with no shape handed", () => {
    // Before the fix `:foo` was matched as `foo`, and typing its full name found nothing.
    const filtered = filterKeyTree(buildKeyTree([":foo", "bar"]), ":foo");

    expect(segments(filtered)).toEqual([""]);
    expect(at(filtered, "", "foo").isKey).toBe(true);
  });

  test("finds every straining key by its own full name", () => {
    const root = buildKeyTree(STRAINING_KEYS, ETCD);

    for (const key of STRAINING_KEYS) {
      const found = everyNode(filterKeyTree(root, key, ETCD))
        .filter((node) => node.isKey)
        .map((node) => keyName(node.path, ETCD));
      expect({ key, found: found.includes(key) }).toEqual({ key, found: true });
    }
  });

  test("reads a separator of more than one character in every helper", () => {
    // `separator` is any string, so the folder mark is the separator and a star whatever its length,
    // and every helper strips or appends exactly that mark rather than a fixed two characters.
    const wide = keyScanShape({ defaultCount: 1, maxCount: 1, separator: "::", pattern: "prefix" });
    const wideGlob = keyScanShape({ defaultCount: 1, maxCount: 1, separator: "::" });

    expect(splitKey("a::b::c", wide)).toEqual(["a", "b", "c"]);
    expect(prefixPattern("a::b::*", wide)).toBe("a::b::");
    expect(prefixPattern("a::b::*", wideGlob)).toBe("a::b::*");
    expect(sentPattern("a::b::*", wide)).toBe("a::b::");

    const root = buildKeyTree(["a::b", "a::c"], wide);
    // The folder mark alone is no filter, and a folder's advertised name finds that folder's branch,
    // the key named exactly `a::b` included.
    expect(filterKeyTree(root, "::*", wide)).toBe(root);
    expect(segments(at(filterKeyTree(root, "a::b::*", wide), "a"))).toEqual(["b"]);
    expect(keyRowNames(at(root, "a"), true, wide)).toEqual({ label: "a::*", title: "a::*", toggle: "a" });
  });
});
