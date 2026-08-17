import "../setup-dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { GitHubRepoLink } from "@/components/github-repo-link";
import { STAR_PROMPT_QUERY_THRESHOLD, recordQuerySuccess } from "@/lib/community/star-prompt";

describe("GitHubRepoLink", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test("links to the repository in a new tab, with an accessible name", () => {
    const { container } = render(<GitHubRepoLink />);
    const link = container.querySelector("a");

    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://github.com/libredb/libredb-studio");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link!.getAttribute("aria-label")).toBe("LibreDB Studio on GitHub");
    // An icon-only link must never be announced as a button (jsx-a11y gate).
    expect(link!.getAttribute("role")).toBeNull();
  });

  /**
   * The mark is inlined rather than imported: lucide-react 1.x dropped every
   * brand icon, so the octocat now lives in this component. It must stay hidden
   * from assistive technology - the anchor's aria-label is the accessible name -
   * and must paint with `currentColor` so the caller keeps owning the colour.
   */
  test("renders the GitHub mark inline, hidden from assistive technology", () => {
    const { container } = render(<GitHubRepoLink />);
    const svg = container.querySelector("a > svg");

    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("fill")).toBe("currentColor");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
    expect(svg!.getAttribute("class")).toContain("w-3.5");
    expect(svg!.getAttribute("class")).toContain("h-3.5");
    // The real octocat mark, not an approximation. Pinning both ends of the path
    // is what makes this an assertion: a length check passes against any 200-odd
    // characters of invented or truncated data, which is the exact failure mode
    // of hand-inlining an SVG - a malformed path renders a blob and no gate sees it.
    const paths = svg!.querySelectorAll("path");
    expect(paths.length).toBe(1);
    const d = paths[0]!.getAttribute("d")!;
    expect(d.startsWith("M12 .297c-6.63 0-12 5.373-12 12")).toBe(true);
    expect(d.endsWith("0-6.627-5.373-12-12-12")).toBe(true);
    // Filled, never stroked: the mark is a solid glyph, unlike the lucide
    // outline icons it sits beside.
    expect(svg!.getAttribute("stroke")).toBeNull();
  });

  /**
   * The caller owns spacing, sizing AND colour: this link sits in fixed dark
   * chrome (the studio headers) and in theme-token chrome (the sidebar), and
   * merging two competing text colours here would rely on tailwind-merge
   * resolving a custom token, which it silently does not.
   */
  test("keeps the caller's own spacing and colour", () => {
    const { container } = render(<GitHubRepoLink className="mx-2 text-zinc-400 hover:text-white" />);
    const link = container.querySelector("a")!;

    expect(link.className).toContain("mx-2");
    expect(link.className).toContain("text-zinc-400");
    expect(link.className).toContain("hover:text-white");
    expect(link.className).toContain("transition-colors");
  });

  /**
   * Someone who has already followed this link has answered the invitation; the
   * one-shot toast must not ask again afterwards.
   */
  test("following the link marks the star prompt handled", () => {
    const { container } = render(<GitHubRepoLink />);

    fireEvent.click(container.querySelector("a")!);

    for (let i = 0; i < STAR_PROMPT_QUERY_THRESHOLD + 1; i++) {
      expect(recordQuerySuccess()).toBe(false);
    }
  });

  /**
   * A refusing store (Safari private mode, quota exceeded) must not turn a click
   * on a link into an exception - the navigation matters, the bookkeeping does not.
   */
  test("a click cannot throw where the store refuses writes", () => {
    const realSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };

    try {
      const { container } = render(<GitHubRepoLink />);
      expect(() => fireEvent.click(container.querySelector("a")!)).not.toThrow();
    } finally {
      localStorage.setItem = realSetItem;
    }
  });
});
