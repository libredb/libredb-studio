/**
 * Threat: an allowlist that hides a real credential.
 *
 * The historical sweep found 24 matches and classified all 24 as fabricated.
 * That classification lives in `.gitleaksignore` as exact fingerprints
 * (tests/unit/gitleaksignore.test.ts covers its shape) - not here. This file
 * used to also carry the classification as `[[allowlists]]` entries, but a
 * `paths` allowlist for a rule that matches by SHAPE rather than by issuer
 * (generic-api-key, jwt, private-key, curl-auth-user) exempts every future
 * finding of that shape anywhere under the path, not just the historical one
 * it was written for. Verified live 2026-08-09 against gitleaks 8.30.1: a
 * `paths = ['^tests/']` allowlist silently swallowed a freshly planted,
 * real-shaped secret added to a brand-new file under tests/, and a `paths`
 * entry scoped to a single known file did the same for a real-shaped secret
 * added next to the known fixture in that file. A fingerprint - the exact
 * `commit:file:rule:startline` gitleaks reports - does not have that failure
 * mode: a real secret added later, even the exact same fabricated literal in
 * a new commit, produces a different fingerprint and is still reported.
 *
 * `.gitleaks.toml` keeps the `[[allowlists]]` mechanism available for the
 * different problem it actually solves well - a rule that is unconditionally
 * noisy for a known, reviewable reason - and this file guards the shape any
 * future entry there must have, so a future maintainer silencing a noisy
 * path does not reopen the gap above.
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

  test("carries no allowlists today - the 24 known findings are fingerprints in .gitleaksignore", () => {
    // Not a requirement that this file must stay empty forever - a record of
    // the current, expected state, so a reader knows the loops below are
    // vacuous by design rather than by accident (the same pattern
    // tests/unit/trivyignore-policy.test.ts uses for its own empty file).
    expect(allowlists).toHaveLength(0);
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

  test("no allowlist is scoped by path - a future one should be scoped by value or fingerprint", () => {
    // The gap this whole file exists to prevent: a `paths` entry exempts
    // every future finding under that path, not just the one it was written
    // for. `.gitleaksignore` (exact fingerprints) and `regexes` +
    // `regexTarget` (exact values) do not have that failure mode; `paths`
    // does, which is why every allowlist here is one of the other two shapes.
    for (const entry of allowlists) {
      expect(entry.paths).toBeUndefined();
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
