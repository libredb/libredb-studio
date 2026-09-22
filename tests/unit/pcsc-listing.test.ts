/**
 * The size gate for the SUSE PCSC listing body.
 *
 * `deploy/rancher/pcsc-listing.html` is pasted verbatim into the listing at
 * https://www.suse.com/pcsc/ by the SUSE partner team, whose page template holds at most
 * 1494 characters, markup for the bullet list included. On 2026-09-23 they declined an
 * update because the copy we sent was longer than that, which is how the limit was
 * learned: nothing on our side counted it. The accuracy of the same file is gated by
 * `tests/unit/marketplace-copy.test.ts` and `tests/unit/lib/catalog-copy-engine-count.test.ts`;
 * this file checks only what the template accepts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LISTING = readFileSync(join(import.meta.dir, "../../deploy/rancher/pcsc-listing.html"), "utf8");

/** The template's limit, as the SUSE partner team stated it. */
const PCSC_LIMIT = 1494;

/**
 * The body as it is pasted: without the trailing newline an editor adds. Line breaks are
 * counted as two characters, because the text reaches the page through a mail client and
 * a web form, either of which may send CRLF, and we do not know which way SUSE counts.
 * The worst case is the only count that cannot be wrong.
 */
function pastedLength(text: string): number {
  const body = text.replace(/\n+$/, "");
  return body.length + (body.match(/\n/g)?.length ?? 0);
}

describe("the PCSC listing fits the SUSE template", () => {
  test(`is at most ${PCSC_LIMIT} characters, markup and CRLF line breaks included`, () => {
    expect(pastedLength(LISTING)).toBeLessThanOrEqual(PCSC_LIMIT);
  });

  test("the length counts every line break twice", () => {
    expect(pastedLength("ab\ncd\n")).toBe(6);
    expect(pastedLength("ab")).toBe(2);
  });

  test("uses only the bullet-list markup the page renders", () => {
    // The listing renders inside a <pre>, so paragraphs are plain text separated by blank
    // lines and the one list is <ul>/<li>. Any other tag is markup SUSE would have to
    // strip or that would render literally, and either way the count above is wrong.
    const tags = [...LISTING.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)].map((m) => m[1].toLowerCase());
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set(["ul", "li"]));
  });

  test("carries no leading whitespace a paste would keep", () => {
    expect(LISTING).toBe(LISTING.trimStart());
  });
});
