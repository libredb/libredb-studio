/**
 * Unit tests for .trivyignore.yaml's suppression policy (security programme
 * control 2.1).
 *
 * Why a test for YAML: .trivyignore.yaml's own header and SECURITY.md both
 * promise that every suppression carries a written justification and an
 * expiry date no more than 90 days out. Measured on Trivy 0.73.0 against a
 * real advisory, none of that is mechanically enforced by the scanner itself:
 * an entry with no `expired_at` suppresses forever, an entry with no
 * `statement` suppresses just as well, and a ten-year `expired_at` suppresses
 * for ten years - only an already-expired entry is re-reported. The prose is
 * real; nothing here made it true.
 *
 * The file has zero entries today, which makes every loop below vacuous - the
 * same argument tests/unit/gitleaks-config.test.ts already makes for its own
 * allowlists staying non-empty. Vacuous is fine: the point is that the FIRST
 * entry anyone adds is checked against the policy this file's header states,
 * not merely trusted to follow it.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Suppression {
  id?: string;
  statement?: string;
  expired_at?: string;
}

const file = path.join(__dirname, "../../.trivyignore.yaml");
const doc = parseYaml(fs.readFileSync(file, "utf8")) as { vulnerabilities?: Suppression[] };
const vulnerabilities = doc.vulnerabilities ?? [];

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

describe(".trivyignore.yaml suppression policy", () => {
  test("parses as a YAML document with a vulnerabilities list", () => {
    expect(Array.isArray(vulnerabilities)).toBe(true);
  });

  test("is empty today - the CRITICAL/fixable threshold covers everything else", () => {
    // Not a requirement that this file must stay empty forever. A record of
    // the current, expected state, so a reader knows the loops below are
    // vacuous by design rather than by accident.
    expect(vulnerabilities).toHaveLength(0);
  });

  test("every suppression names the advisory it suppresses", () => {
    for (const entry of vulnerabilities) {
      expect((entry.id ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  test("every suppression carries a statement of meaningful length", () => {
    // "Not exploitable" on its own is not a statement - the file's own header
    // and SECURITY.md both require a reachability argument or a named
    // blocking dependency. A length floor cannot verify the argument is
    // sound, but it is the mechanical minimum a written justification implies,
    // and it is exactly what was missing before this test existed.
    for (const entry of vulnerabilities) {
      expect((entry.statement ?? "").trim().length).toBeGreaterThan(40);
    }
  });

  test("every suppression carries an expired_at that parses as a real date", () => {
    for (const entry of vulnerabilities) {
      const parsed = new Date(entry.expired_at ?? "");
      expect(Number.isNaN(parsed.getTime())).toBe(false);
    }
  });

  test("no suppression's expired_at is more than 90 days out", () => {
    // Trivy re-reports an expired entry (verified 2026-08-09 against Trivy
    // 0.73.0), but nothing mechanical stops a ten-year expired_at from
    // suppressing forever until that date arrives - which is not a review
    // date, it is a decision to never review again.
    const now = Date.now();
    for (const entry of vulnerabilities) {
      const parsed = new Date(entry.expired_at ?? "");
      expect(parsed.getTime() - now).toBeLessThanOrEqual(NINETY_DAYS_MS);
    }
  });
});
