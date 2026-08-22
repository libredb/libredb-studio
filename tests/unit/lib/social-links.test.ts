import { describe, expect, test } from "bun:test";
import { SOCIAL_LINKS } from "@/lib/social-links";

describe("social-links", () => {
  test("lists the eight maintainer-confirmed destinations in row order", () => {
    expect(SOCIAL_LINKS.map((link) => link.id)).toEqual([
      "github",
      "linkedin",
      "x",
      "youtube",
      "instagram",
      "reddit",
      "dockerhub",
      "sponsor",
    ]);
  });

  test("every id is unique", () => {
    const ids = SOCIAL_LINKS.map((link) => link.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every href is unique", () => {
    // A duplicated href means one row silently points somewhere it was not meant to;
    // the icons differ, so nothing else in the UI would reveal it.
    const hrefs = SOCIAL_LINKS.map((link) => link.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("every href is an absolute https URL", () => {
    for (const link of SOCIAL_LINKS) {
      // A relative href resolves against whatever host the app is deployed on, and a
      // plain-http one downgrades the front door. Both are silent in a unit render.
      const url = new URL(link.href);
      expect(url.protocol).toBe("https:");
      expect(link.href.startsWith("https://")).toBe(true);
    }
  });

  test("every label is a non-empty string", () => {
    // The label is the only accessible name an icon-only link has.
    for (const link of SOCIAL_LINKS) {
      expect(link.label.trim().length).toBeGreaterThan(0);
    }
  });

  test("every entry carries a renderable icon", () => {
    // Both component shapes count: the hand-drawn marks are plain functions, while
    // lucide's Heart (reused for Sponsor) is a forwardRef object.
    for (const link of SOCIAL_LINKS) {
      expect(["function", "object"]).toContain(typeof link.icon);
      expect(link.icon).toBeTruthy();
    }
  });

  test("points at the libredb org on every platform except GitHub Sponsors", () => {
    // The handle is "libredb" everywhere. GitHub Sponsors is the one exception: it is
    // tied to the maintainer account, not to the organisation.
    for (const link of SOCIAL_LINKS) {
      if (link.id === "sponsor") {
        expect(link.href).toBe("https://github.com/sponsors/cevheri");
        continue;
      }
      expect(link.href.toLowerCase()).toContain("libredb");
    }
  });
});
