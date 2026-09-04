/**
 * Drift guard for #554: text files must check out with LF on every platform,
 * including Windows clones with core.autocrlf=true (which made the byte-for-byte
 * channels:showcase:check fail on a clean tree, see #550). Guards the rule that
 * fixes it and the older #114 executable-source rules that must survive.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const gitattributes = readFileSync(join(dirname(import.meta.dir), "..", ".gitattributes"), "utf8");

describe(".gitattributes line-ending policy (#554)", () => {
  test("normalizes every text file to LF on checkout", () => {
    expect(gitattributes).toContain("* text=auto eol=lf");
  });

  test("keeps the explicit #114 executable-source rules", () => {
    for (const pattern of ["*.go", "*.sh", "*.mjs", "*.tmpl"]) {
      expect(gitattributes).toContain(`${pattern} text eol=lf`);
    }
  });
});
