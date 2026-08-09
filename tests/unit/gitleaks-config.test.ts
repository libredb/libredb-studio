/**
 * Threat: an allowlist that hides a real credential.
 *
 * The historical sweep found 24 matches and classified all 24 as fabricated, so
 * .gitleaks.toml exists to make the incremental scan start from zero. The way
 * that file goes wrong is not a wrong regex - it is a future maintainer
 * silencing one noisy path by adding a `paths` entry with no `targetRules`,
 * which exempts that path from EVERY gitleaks rule, including the AWS, GCP,
 * Slack and Stripe rules that have never produced a false positive here.
 *
 * Parsed with Bun.TOML rather than imported: `import x from "*.toml"` is a bun
 * loader feature that `tsc --noEmit` rejects, and typecheck is a required gate.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

interface Allowlist {
  description?: string;
  targetRules?: string[];
  paths?: string[];
  regexes?: string[];
  regexTarget?: string;
}

const raw = fs.readFileSync(path.join(__dirname, "../../.gitleaks.toml"), "utf8");
const config = Bun.TOML.parse(raw) as {
  extend?: { useDefault?: boolean };
  allowlists?: Allowlist[];
};
const allowlists = config.allowlists ?? [];

describe(".gitleaks.toml", () => {
  test("extends gitleaks' own rule set instead of vendoring a copy", () => {
    // A vendored rule set stops moving when the pinned scanner moves, and the
    // gap is invisible: the scan still passes, it just stops looking for the
    // provider tokens the new rules added.
    expect(config.extend?.useDefault).toBe(true);
  });

  test("has allowlists at all - the sweep found 24 fabricated matches to classify", () => {
    expect(allowlists.length).toBeGreaterThan(0);
  });

  test("every allowlist is scoped to named rules", () => {
    for (const entry of allowlists) {
      expect({ description: entry.description, scoped: (entry.targetRules ?? []).length > 0 }).toEqual({
        description: entry.description,
        scoped: true,
      });
    }
  });

  test("every allowlist explains itself", () => {
    // The description is what a reviewer reads three months from now to decide
    // whether the exemption is still true.
    for (const entry of allowlists) {
      expect((entry.description ?? "").trim().length).toBeGreaterThan(40);
    }
  });

  test("no allowlist matches every path", () => {
    // '.*', '^.*$', '' and '/' all exempt the whole repository.
    const catchAll = new Set(["", ".*", "^.*$", "^", "/", "^/"]);
    for (const entry of allowlists) {
      for (const p of entry.paths ?? []) {
        expect({ path: p, catchAll: catchAll.has(p.trim()) }).toEqual({ path: p, catchAll: false });
      }
    }
  });

  test("no allowlist exempts the application source tree wholesale", () => {
    // A single file is a reviewable exemption; the tree is not.
    for (const entry of allowlists) {
      for (const p of entry.paths ?? []) {
        expect({ path: p, tree: /^\^?src\/?\$?$|^\^src\/(\*|\.\*)?$/.test(p.trim()) }).toEqual({
          path: p,
          tree: false,
        });
      }
    }
  });

  test("a value-based allowlist says which part of the finding it matches", () => {
    // Without regexTarget, gitleaks matches the regex against the whole line,
    // so '^StrongPass\\d+$' would silently never match and the exemption would
    // look present while doing nothing.
    for (const entry of allowlists) {
      if ((entry.regexes ?? []).length > 0) {
        expect(entry.regexTarget).toBe("secret");
      }
    }
  });
});
