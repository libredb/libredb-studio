/**
 * Unit tests for `.gitleaksignore`'s shape (security programme control 2.1).
 *
 * Gitleaks 8.30.1 has no `[[allowlists]]` field for a single-finding
 * suppression: its TOML schema only accepts `commits`, `paths`, `regexes` or
 * `stopwords` (verified live 2026-08-09 - a config with any other key fails
 * to load). The exact `commit:file:rule:startline` fingerprint mechanism is a
 * separate file, `.gitleaksignore`, one fingerprint per line, read by
 * default from the scan's working directory. This file guards its shape: a
 * malformed or wildcard-ish line here would either do nothing (a typo'd
 * fingerprint silently never matches, which is safe but confusing) or, if
 * gitleaks is ever asked to interpret it more loosely, could over-match - so
 * every line is checked to be either a full-line comment or exactly one
 * well-formed fingerprint.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const file = path.join(__dirname, "../../.gitleaksignore");
const lines = fs.readFileSync(file, "utf8").split("\n");

// The file segment (`[^:\s]+`) already matches `/`, so no separate
// slash-delimited grouping is needed. A previous version had one anyway -
// `[^:\s]+(?:\/[^:\s]+)*` - which let the same slash be consumed by either
// alternative, an ambiguity CodeQL (js/redos) flagged as exponential
// backtracking on a long enough run of `/` before a non-matching suffix. The
// colon delimiters between fingerprint fields make one `[^:\s]+` per segment
// unambiguous - there is no repetition left to backtrack over.
const FINGERPRINT = /^[0-9a-f]{40}:[^:\s]+:[a-z0-9-]+:[0-9]+$/;

const contentLines = lines.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));

describe(".gitleaksignore", () => {
  test("has fingerprint entries - the sweep found 24 fabricated matches to classify", () => {
    expect(contentLines).toHaveLength(24);
  });

  test("every non-comment, non-blank line is a well-formed fingerprint", () => {
    // commit:file:rule:startline. A line that fails this is either a stray
    // typo (harmless - it just never matches) or, worse, something looser
    // that could match more than intended.
    for (const line of contentLines) {
      expect({ line, wellFormed: FINGERPRINT.test(line) }).toEqual({ line, wellFormed: true });
    }
  });

  test("every fingerprint names a full 40-character commit SHA, not an abbreviation", () => {
    // A short SHA is ambiguous as history grows and is not what gitleaks
    // itself prints in a finding's Fingerprint field.
    for (const line of contentLines) {
      const sha = line.split(":")[0];
      expect({ line, shaLength: sha.length }).toEqual({ line, shaLength: 40 });
    }
  });

  test("no fingerprint names a rule this repository has not actually seen suppressed for", () => {
    // Scoped to the four rules the historical sweep classified
    // (tests/unit/gitleaks-config.test.ts's own docstring: jwt, generic-api-key,
    // private-key, curl-auth-user). A fingerprint for any other rule is not
    // impossible in principle, but today would mean an unreviewed addition.
    const knownRules = new Set(["jwt", "generic-api-key", "private-key", "curl-auth-user"]);
    for (const line of contentLines) {
      const rule = line.split(":")[2];
      expect({ line, knownRule: knownRules.has(rule) }).toEqual({ line, knownRule: true });
    }
  });

  test("every fingerprint is unique - a duplicate suppresses nothing extra and just hides drift", () => {
    expect(new Set(contentLines).size).toBe(contentLines.length);
  });
});
