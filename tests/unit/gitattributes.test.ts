/**
 * Drift guard for #554: text files must check out with LF on every platform,
 * including Windows clones with core.autocrlf=true (which made the byte-for-byte
 * channels:showcase:check fail on a clean tree, see #550). Guards the rule that
 * fixes it and the older #114 executable-source rules that must survive.
 *
 * Each rule is matched as a whole line rather than as a substring, so that a
 * commented-out rule (`# * text=auto eol=lf`) fails the guard instead of
 * silently satisfying it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const gitattributes = readFileSync(join(dirname(import.meta.dir), "..", ".gitattributes"), "utf8");

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A rule counts only when it sits on its own line, uncommented and in full.
const expectRule = (rule: string): void => {
  expect(gitattributes).toMatch(new RegExp(`^${escapeRegExp(rule)}$`, "m"));
};

describe(".gitattributes line-ending policy (#554)", () => {
  test("normalizes every text file to LF on checkout", () => {
    expectRule("* text=auto eol=lf");
  });

  test("keeps the explicit #114 executable-source rules", () => {
    for (const pattern of ["*.go", "*.sh", "*.mjs", "*.tmpl"]) {
      expectRule(`${pattern} text eol=lf`);
    }
  });
});
