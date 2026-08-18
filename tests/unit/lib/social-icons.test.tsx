import { describe, test, expect } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GitHubIcon,
  LinkedInIcon,
  XIcon,
  YouTubeIcon,
  InstagramIcon,
  RedditIcon,
  DockerIcon,
} from "@/components/icons/social-icons";

describe("social-icons", () => {
  const icons = [
    { name: "GitHubIcon", Component: GitHubIcon },
    { name: "LinkedInIcon", Component: LinkedInIcon },
    { name: "XIcon", Component: XIcon },
    { name: "YouTubeIcon", Component: YouTubeIcon },
    { name: "InstagramIcon", Component: InstagramIcon },
    { name: "RedditIcon", Component: RedditIcon },
    { name: "DockerIcon", Component: DockerIcon },
  ];

  for (const { name, Component } of icons) {
    test(`${name} renders an SVG element`, () => {
      const html = renderToStaticMarkup(React.createElement(Component, { className: "w-4 h-4" }));
      expect(html).toContain("<svg");
      expect(html).toContain("w-4 h-4");
    });

    test(`${name} passes extra props`, () => {
      const html = renderToStaticMarkup(
        React.createElement(Component, { "data-testid": `icon-${name}` } as React.SVGAttributes<SVGSVGElement>),
      );
      expect(html).toContain(`data-testid="icon-${name}"`);
    });

    test(`${name} inherits its colour and takes its size from the class alone`, () => {
      // The same component is rendered twice on the login page: once inside the hero's
      // pinned-dark subtree and once in the mobile block that follows the theme. A baked
      // brand colour would be illegible in one of the two, so every mark is currentColor.
      // Hard width/height attributes would likewise beat the caller's size classes.
      const html = renderToStaticMarkup(React.createElement(Component, { className: "w-4 h-4" }));
      expect(html).toContain("currentColor");
      expect(html).toContain('viewBox="0 0 24 24"');
      // Only the root tag is checked: inner rects legitimately carry width/height in the
      // 24-unit user space, which the viewBox scales. It is a width on <svg> itself that
      // would freeze the rendered size and beat the caller's classes.
      const rootTag = html.slice(0, html.indexOf(">") + 1);
      expect(rootTag).not.toMatch(/\swidth="/);
      expect(rootTag).not.toMatch(/\sheight="/);
    });
  }
});
