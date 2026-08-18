import "../setup-dom";
import React from "react";
import { CommunitySection } from "@/components/community-section";
import { SOCIAL_LINKS } from "@/lib/social-links";

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

describe("CommunitySection", () => {
  afterEach(() => {
    cleanup();
  });

  const REPO_URL = "https://github.com/libredb/libredb-studio";

  // The six action cards were removed with the login redesign: every one of them pointed at
  // a path under the repository, so the hero spent six lines saying "GitHub" six times. What
  // is left names the repository once and lets the social row carry the rest.
  describe.each(["desktop", "mobile"] as const)("Repository line (%s variant)", (variant) => {
    test("names the project as open source and links the repository once", () => {
      const { container, getByText } = render(<CommunitySection variant={variant} />);
      expect(getByText(/Open source/i)).not.toBeNull();

      const repoAnchors = container.querySelectorAll(`a[href="${REPO_URL}"]`);
      expect(repoAnchors.length).toBe(1);
      expect(repoAnchors[0].getAttribute("target")).toBe("_blank");
      expect(repoAnchors[0].getAttribute("rel")).toBe("noopener noreferrer");
    });

    test("renders the divider that separates it from the block above", () => {
      const { container } = render(<CommunitySection variant={variant} />);
      expect(container.querySelector(variant === "desktop" ? ".bg-fill-strong" : ".bg-muted")).not.toBeNull();
    });

    test("carries no action cards any more", () => {
      const { queryByText } = render(<CommunitySection variant={variant} />);
      for (const gone of ["Join the Community", "Star & Fork", "Open an Issue", "Discussions", "Translate"]) {
        expect(queryByText(gone)).toBeNull();
      }
    });
  });

  // Every assertion below is driven from SOCIAL_LINKS rather than from a second literal
  // list: the whole point of the module is that the row and the data cannot disagree, and
  // a test carrying its own copy of the destinations would not notice if they did.
  describe.each(["desktop", "mobile"] as const)("Social row (%s variant)", (variant) => {
    test("renders exactly one anchor per social link", () => {
      const { container } = render(<CommunitySection variant={variant} />);
      for (const link of SOCIAL_LINKS) {
        const anchors = container.querySelectorAll(`a[aria-label="${link.label}"]`);
        expect(anchors.length).toBe(1);
      }
    });

    test("each social anchor carries its href and opens safely in a new tab", () => {
      const { container } = render(<CommunitySection variant={variant} />);
      for (const link of SOCIAL_LINKS) {
        const anchor = container.querySelector(`a[aria-label="${link.label}"]`);
        expect(anchor).not.toBeNull();
        expect(anchor!.getAttribute("href")).toBe(link.href);
        expect(anchor!.getAttribute("target")).toBe("_blank");
        // Both tokens matter: noopener denies the opened tab a handle on window.opener,
        // noreferrer keeps the login URL out of the destination's referrer log.
        const rel = anchor!.getAttribute("rel") ?? "";
        expect(rel.split(/\s+/)).toContain("noopener");
        expect(rel.split(/\s+/)).toContain("noreferrer");
      }
    });

    test("each social anchor is named by its label alone", () => {
      // The links are icon-only, so aria-label is the only accessible name they have.
      const { getByLabelText } = render(<CommunitySection variant={variant} />);
      for (const link of SOCIAL_LINKS) {
        const anchor = getByLabelText(link.label);
        expect(anchor.tagName).toBe("A");
        expect(anchor.textContent).toBe("");
      }
    });

    test("each social anchor renders its icon as an svg", () => {
      const { container } = render(<CommunitySection variant={variant} />);
      for (const link of SOCIAL_LINKS) {
        const anchor = container.querySelector(`a[aria-label="${link.label}"]`);
        expect(anchor!.querySelector("svg")).not.toBeNull();
      }
    });

    test("each social anchor keeps a tap target of at least 24px square", () => {
      // h-8/w-8 is 32px. Anything smaller than 24px fails the WCAG 2.2 target-size
      // minimum, and an icon-only row is exactly where that is easy to get wrong.
      const { container } = render(<CommunitySection variant={variant} />);
      for (const link of SOCIAL_LINKS) {
        const anchor = container.querySelector(`a[aria-label="${link.label}"]`);
        expect(anchor!.className).toContain("h-8");
        expect(anchor!.className).toContain("w-8");
      }
    });

    test("no social anchor claims the button role", () => {
      // A link that navigates is a link; role="button" on an anchor is banned here.
      const { container } = render(<CommunitySection variant={variant} />);
      for (const link of SOCIAL_LINKS) {
        const anchor = container.querySelector(`a[aria-label="${link.label}"]`);
        expect(anchor!.getAttribute("role")).toBeNull();
      }
    });
  });
});
