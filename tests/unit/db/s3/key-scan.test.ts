/**
 * The Keys panel pages over S3: the declaration, every option refusal before any request, the
 * root level from ListBuckets paged locally by name, a level from ListObjectsV2 with `delimiter=/`, a plain walk of
 * one bucket, the size descriptors, the skipped count, and the cursor's foreign and scope refusals; every page meets
 * the Keys panel's level contract.
 */
import { describe, expect, test } from "bun:test";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { encodeS3Cursor, S3_CURSOR_SENTENCES } from "@/lib/db/providers/objectstore/s3/cursor";
import {
  readS3KeyScanOptions,
  S3_KEY_SCAN,
  S3_KEY_SCAN_SENTENCES as S,
  scanS3KeysPage,
} from "@/lib/db/providers/objectstore/s3/key-scan";
import type { KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import {
  bucketsXml,
  errorXml,
  type FakeS3Handler,
  fakeS3Surface,
  objectsXml,
  xmlAnswer,
} from "../../../helpers/s3-fake-transport";

const CALL = { signal: new AbortController().signal, deadline: Date.now() + 60_000 };
const PINNED = { database: "sales" };

function scan(handler: FakeS3Handler, options: Partial<KeyScanOptions>, overrides = {}) {
  const { surface, fake } = fakeS3Surface(handler, overrides);
  const page = scanS3KeysPage(surface, { cursor: "0", count: 500, ...options }, CALL);
  return { page, fake };
}

async function refusedBeforeAnyRequest(options: Partial<KeyScanOptions>, overrides = {}): Promise<string> {
  const { page, fake } = scan(
    () => {
      throw new Error("no request may be sent");
    },
    options,
    overrides,
  );
  const error = await page.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DatabaseConfigError);
  expect(fake.exchanges).toHaveLength(0);
  return (error as Error).message;
}

/** The Keys panel's level checks on a page: count, no repeat, prefixes one level deeper. */
function meetsLevelContract(page: KeyScanPage, pattern: string, count: number): void {
  const prefixes = page.prefixes ?? [];
  expect(page.keys.length + prefixes.length).toBeLessThanOrEqual(count);
  expect(new Set(prefixes).size).toBe(prefixes.length);
  for (const prefix of prefixes) {
    expect(prefix.startsWith(pattern) && prefix.endsWith("/")).toBe(true);
    expect(prefix.slice(pattern.length, -1).includes("/")).toBe(false);
  }
  for (const key of page.keys) {
    expect(key.startsWith(pattern)).toBe(true);
    expect(key.slice(pattern.length).includes("/")).toBe(false);
  }
}

test("the declaration", () => {
  expect(S3_KEY_SCAN).toStrictEqual({
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "none",
    levels: { rootKind: "bucket" },
  });
});

describe("option refusals, before any request", () => {
  test.each([0, 1_001, 1.5])("count %p", async (count) => {
    expect(await refusedBeforeAnyRequest({ count, level: true })).toBe("A page holds 1 to 1,000 entries.");
  });

  test("a database", async () => {
    expect(await refusedBeforeAnyRequest({ database: 1, level: true })).toBe(
      "An S3 connection walks one key space of buckets and keys, so a page names no database.",
    );
  });

  test("a lone surrogate", async () => {
    expect(await refusedBeforeAnyRequest({ pattern: "sales/\uD800", level: true })).toBe(
      "The prefix holds a character that is not text, so it names no exact key: type it again.",
    );
  });

  test("a key part over 1,024 UTF-8 bytes", async () => {
    expect(await refusedBeforeAnyRequest({ pattern: `sales/${"ü".repeat(513)}`, level: true })).toBe(
      "A prefix holds at most 1,024 bytes after the bucket name.",
    );
  });

  test.each([
    ["../", true, {}],
    ["a b/", true, {}],
    [`${"a".repeat(256)}/`, true, {}],
    ["../x", false, {}],
    ["../", true, PINNED],
    ["a b/x", false, PINNED],
  ])("the bucket rule refuses %p (level %p)", async (pattern, level, overrides) => {
    const bucket = pattern.slice(0, pattern.indexOf("/"));
    expect(await refusedBeforeAnyRequest({ pattern, ...(level ? { level: true } : {}) }, overrides)).toBe(
      S.bucketPattern(bucket),
    );
  });

  test("a pinned connection refuses another bucket", async () => {
    expect(await refusedBeforeAnyRequest({ pattern: "other/", level: true }, PINNED)).toBe(
      "This connection reads only bucket sales: start the prefix with sales/.",
    );
    expect(await refusedBeforeAnyRequest({ pattern: "x" }, PINNED)).toBe(S.outsidePin("sales"));
  });

  test("a plain walk naming no bucket, with no pin", async () => {
    expect(await refusedBeforeAnyRequest({ pattern: "" })).toBe(
      "A walk of keys only reads one bucket: start the prefix with the bucket name and a slash, or set Bucket on the connection.",
    );
  });

  test("readS3KeyScanOptions reads the scope", () => {
    expect(readS3KeyScanOptions({ cursor: "0", count: 5, pattern: "sales/2026/", level: true })).toEqual({
      cursor: "0",
      count: 5,
      level: true,
      bucket: "sales",
      prefix: "2026/",
    });
    expect(readS3KeyScanOptions({ cursor: "0", count: 5, pattern: "sa", level: true })).toMatchObject({
      bucket: null,
      prefix: "sa",
    });
    expect(readS3KeyScanOptions({ cursor: "0", count: 5 }, "sales")).toMatchObject({
      bucket: "sales",
      prefix: "",
      level: false,
    });
  });
});

describe("the root level", () => {
  test("pinned: the one folder, with no request", async () => {
    const run = (pattern: string) =>
      scan(
        () => {
          throw new Error("no request");
        },
        { pattern, level: true },
        PINNED,
      );
    for (const pattern of ["", "sa", "sales"]) {
      const { page, fake } = run(pattern);
      // oxlint-disable-next-line no-await-in-loop -- each pattern is checked on its own, one after another.
      expect(await page).toEqual({ keys: [], prefixes: ["sales/"], cursor: "0", types: {}, total: 0 });
      expect(fake.exchanges).toHaveLength(0);
    }
    expect((await run("x").page).prefixes).toEqual([]);
  });

  test("unpinned: a shuffled, duplicated ListBuckets answer pages neither skipping nor repeating", async () => {
    const answers = [
      ["delta", "alpha", "charlie", "alpha", "bravo", "echo"],
      ["echo", "bravo", "delta", "charlie", "alpha"],
      ["charlie", "echo", "alpha", "delta", "bravo", "bravo"],
    ];
    let call = 0;
    const { surface, fake } = fakeS3Surface(() => xmlAnswer(bucketsXml(answers[call++])));
    const seen: string[] = [];
    let cursor = "0";
    do {
      // oxlint-disable-next-line no-await-in-loop -- each page's cursor comes from the page before it.
      const page = await scanS3KeysPage(surface, { cursor, count: 2, pattern: "", level: true }, CALL);
      meetsLevelContract(page, "", 2);
      seen.push(...(page.prefixes ?? []));
      cursor = page.cursor;
    } while (cursor !== "0");
    expect(seen).toEqual(["alpha/", "bravo/", "charlie/", "delta/", "echo/"]);
    expect(fake.lines()).toEqual(Array(3).fill("GET /?max-buckets=10000"));
  });

  test("a name filter, count 1 and 1,000, and a cursor of the last name", async () => {
    const names = ["sales", "sandbox", "other"];
    const one = await scan(() => xmlAnswer(bucketsXml(names)), { pattern: "sa", count: 1, level: true }).page;
    expect(one.prefixes).toEqual(["sales/"]);
    expect(one.cursor).toBe(encodeS3Cursor({ bucket: null, prefix: "sa", level: true, after: "sales" }));
    const all = await scan(() => xmlAnswer(bucketsXml(names)), { pattern: "", count: 1_000, level: true }).page;
    expect(all).toMatchObject({ prefixes: ["other/", "sales/", "sandbox/"], cursor: "0" });
  });

  test("a bucket name holding a slash is counted in skipped; a name failing the bucket rule is still listed", async () => {
    const page = await scan(() => xmlAnswer(bucketsXml(["a/b", "My Bucket", "sales"])), { level: true }).page;
    expect(page.prefixes).toEqual(["My Bucket/", "sales/"]);
    expect(page.skipped).toEqual({
      count: 1,
      reason:
        "Names that are not UTF-8 text, and bucket names holding a slash, cannot be shown or opened, so they are counted here and not listed.",
    });
  });
  test("a slash name is counted once, on the first page of the walk, and only when the filter keeps it", async () => {
    const answer = () => xmlAnswer(bucketsXml(["x/y", "a1", "a2", "a3"]));
    const { surface } = fakeS3Surface(answer);
    const first = await scanS3KeysPage(surface, { cursor: "0", count: 2, pattern: "", level: true }, CALL);
    expect(first.prefixes).toEqual(["a1/", "a2/"]);
    expect(first.skipped?.count).toBe(1);
    const second = await scanS3KeysPage(surface, { cursor: first.cursor, count: 2, pattern: "", level: true }, CALL);
    expect(second.prefixes).toEqual(["a3/"]);
    expect(second.skipped).toBeUndefined();
    const filtered = await scan(() => xmlAnswer(bucketsXml(["x/y", "q/z", "a1", "a2", "a3"])), {
      pattern: "a",
      count: 2,
      level: true,
    }).page;
    expect(filtered.prefixes).toEqual(["a1/", "a2/"]);
    expect(filtered.skipped).toBeUndefined();
    const kept = await scan(() => xmlAnswer(bucketsXml(["x/y", "q/z", "a1"])), { pattern: "x", level: true }).page;
    expect(kept).toMatchObject({ prefixes: [], skipped: { count: 1 } });
  });

  test("a refused ListBuckets reads as the provider's sentence for that verb", async () => {
    const { page, fake } = scan(() => xmlAnswer(errorXml("AccessDenied", "Access Denied"), 403), { level: true });
    const error = await page.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "This access key may not list buckets (s3:ListAllMyBuckets). The server answers the same way for a bucket that does not exist. A key limited to some buckets works with one of them under Bucket.",
    );
    expect(fake.lines()).toEqual(["GET /?max-buckets=10000"]);
  });
});

describe("a level inside a bucket", () => {
  test("keys and folders joined to the bucket, a folder marker kept, sizes in words, the token in the cursor", async () => {
    const { surface, fake } = fakeS3Surface(() =>
      xmlAnswer(
        objectsXml({
          keys: [
            { key: "dir/", size: 0 },
            { key: "dir/a.csv", size: 1536 },
          ],
          prefixes: ["dir/sub/"],
          truncated: true,
          token: "next+1",
        }),
      ),
    );
    const page = await scanS3KeysPage(surface, { cursor: "0", count: 3, pattern: "sales/dir/", level: true }, CALL);
    expect(fake.lines()).toEqual(["GET /sales?delimiter=%2F&encoding-type=url&list-type=2&max-keys=3&prefix=dir%2F"]);
    expect(page).toEqual({
      keys: ["sales/dir/", "sales/dir/a.csv"],
      prefixes: ["sales/dir/sub/"],
      cursor: encodeS3Cursor({ bucket: "sales", prefix: "dir/", level: true, token: "next+1" }),
      types: { "sales/dir/": formatBytes(0), "sales/dir/a.csv": formatBytes(1536) },
      total: 0,
    });
    expect(page.types["sales/dir/a.csv"]).toBe("1.5 KB");
    meetsLevelContract(page, "sales/dir/", 3);
    await scanS3KeysPage(surface, { cursor: page.cursor, count: 3, pattern: "sales/dir/", level: true }, CALL);
    expect(fake.lines()[1]).toBe(
      "GET /sales?continuation-token=next%2B1&delimiter=%2F&encoding-type=url&list-type=2&max-keys=3&prefix=dir%2F",
    );
  });

  test("a MinIO folder with a space: the url-encoded '+' is read back as a space and sent as %20", async () => {
    // The first page answers the folder; the folder's own page is empty, as a real level below it would be.
    const answers = [objectsXml({ prefixes: ["sp/with+space/"], encoding: "url" }), objectsXml({ encoding: "url" })];
    let call = 0;
    const { surface, fake } = fakeS3Surface(() => xmlAnswer(answers[call++]));
    const page = await scanS3KeysPage(surface, { cursor: "0", count: 10, pattern: "sales/sp/", level: true }, CALL);
    expect(page.prefixes).toEqual(["sales/sp/with space/"]);
    await scanS3KeysPage(
      surface,
      { cursor: "0", count: 10, pattern: (page.prefixes as string[])[0], level: true },
      CALL,
    );
    expect(fake.lines()[1]).toContain("prefix=sp%2Fwith%20space%2F");
    expect(fake.lines()[1]).not.toContain("+");
  });

  test("an empty truncated page keeps its cursor, so the next page can still be read", async () => {
    const page = await scan(() => xmlAnswer(objectsXml({ truncated: true, token: "t" })), {
      pattern: "sales/",
      level: true,
    }).page;
    expect(page).toEqual({
      keys: [],
      prefixes: [],
      cursor: encodeS3Cursor({ bucket: "sales", prefix: "", level: true, token: "t" }),
      types: {},
      total: 0,
    });
  });

  test("a page holding a repeated key, a key below the level or a folder outside it is the page sentence", async () => {
    const cases: [string, Parameters<typeof objectsXml>[0], string][] = [
      ["sales/b/", { keys: ["b/a.txt", "b/a.txt"] }, 'the key "b/a.txt" twice'],
      ["sales/b/", { keys: ["b/deep/x.txt"] }, 'the key "b/deep/x.txt" outside the level asked for'],
      ["sales/b/a", { prefixes: ["q/r/"] }, 'the folder "q/r/" outside the level asked for'],
      ["sales/b/a", { prefixes: ["zz/"] }, 'the folder "zz/" outside the level asked for'],
    ];
    for (const [pattern, answer, what] of cases) {
      const { page } = scan(() => xmlAnswer(objectsXml(answer)), { pattern, count: 10, level: true });
      // oxlint-disable-next-line no-await-in-loop -- each answer is checked on its own, one after another.
      const error = await page.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe(
        `The server answered list bucket "sales" with ${what}, which a page cannot hold, so the page was not shown.`,
      );
    }
  });

  test("undecodable names are counted in skipped", async () => {
    const page = await scan(() => xmlAnswer(objectsXml({ keys: ["%FF", "ok"], encoding: "url" })), {
      pattern: "sales/",
      level: true,
    }).page;
    expect(page.keys).toEqual(["sales/ok"]);
    expect(page.skipped?.count).toBe(1);
  });

  test("a plain walk has no delimiter and no prefixes; on a pinned connection an empty pattern walks the pin", async () => {
    const { page, fake } = scan(() => xmlAnswer(objectsXml({ keys: ["a/b.csv"] })), { pattern: "" }, PINNED);
    const answer = await page;
    expect(fake.lines()).toEqual(["GET /sales?encoding-type=url&list-type=2&max-keys=500&prefix="]);
    expect(answer.keys).toEqual(["sales/a/b.csv"]);
    expect(answer.prefixes).toBeUndefined();
  });
});

describe("cursor refusals", () => {
  test("a text the panel did not write, before any request", async () => {
    expect(await refusedBeforeAnyRequest({ cursor: "s3c:1:@", pattern: "sales/", level: true })).toBe(
      S3_CURSOR_SENTENCES.foreign,
    );
    expect(await refusedBeforeAnyRequest({ cursor: "x".repeat(16_391), pattern: "sales/", level: true })).toBe(
      S3_CURSOR_SENTENCES.foreign,
    );
  });

  test("a cursor of another bucket, prefix or level, before any request", async () => {
    const other = encodeS3Cursor({ bucket: "sales", prefix: "a/", level: true, token: "t" });
    expect(await refusedBeforeAnyRequest({ cursor: other, pattern: "sales/b/", level: true })).toBe(
      S3_CURSOR_SENTENCES.scope,
    );
    expect(await refusedBeforeAnyRequest({ cursor: other, pattern: "sales/a/" })).toBe(S3_CURSOR_SENTENCES.scope);
  });

  test("a well-formed hand-written token reaches the server, whose 400 is E23", async () => {
    const forged = encodeS3Cursor({ bucket: "sales", prefix: "", level: true, token: "forged" });
    const { page, fake } = scan(() => xmlAnswer(errorXml("InvalidRequest", "Invalid continuation token"), 400), {
      cursor: forged,
      pattern: "sales/",
      level: true,
    });
    const error = await page.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      "The server refused this page's continuation token: list this folder again from its start.",
    );
    expect(fake.exchanges).toHaveLength(1);
  });
});
