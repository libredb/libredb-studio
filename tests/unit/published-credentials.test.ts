import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";

// A copy-and-run example that carries a password IS a published credential, whatever the
// value is called. `set_a_real_password` read as a placeholder and signed in; LibreDB.2026
// was repeated underneath as the login to use; change-me-to-a-random-32-char-string is 36
// characters, so it clears the minimum and the server accepts it - and with
// STORAGE_ENCRYPTION_KEY unset it is also what saved connection passwords are sealed with.
//
// The rule these files follow instead: set no password, and say where the generated one is
// printed. This guard exists because each of those three was removed by hand and nothing
// stopped the next one going in.
//
// Helm's `--set secrets.adminPassword=` is deliberately not covered. The chart's values are
// empty by default and the template requires them, so nothing is carried into a deployment:
// the reader types the value on a command line and can see they are typing a password.

/**
 * Where a reader copies from. Not only Markdown, and not only one README: the last hole
 * this guard missed was `.env.example`, which README tells you to copy and run, and the
 * one before it was a translation nobody was scanning.
 */
const ROOTS = [
  "README.md",
  "README_es.md",
  "README_hi.md",
  "README_ja.md",
  "README_ur.md",
  "README_zh.md",
  "DOCKERHUB.md",
  "CONTRIBUTING.md",
  ".env.example",
  "docs",
  "deploy",
  "packaging",
  "charts",
  "operator",
];

/** Anything a person pastes or a package installs. */
const READABLE = /\.(md|ya?ml|toml|sh|env|json)$|(^|\/)(env|\.env[^/]*|Dockerfile)$/;

function documentationFiles(): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(join(path, entry));
      }
    } else if (READABLE.test(path)) {
      out.push(path);
    }
  };
  for (const root of ROOTS) walk(root);
  for (const entry of readdirSync(".")) {
    if (/^docker-compose.*\.ya?ml$/.test(entry) || entry === "fly.toml" || entry === "database-compose.yml") {
      out.push(entry);
    }
  }
  return out;
}

/**
 * `NAME=value` in a shell example, or `NAME: value` in a compose one.
 *
 * The value has to be the LAST thing on the line. That is what tells an assignment from a
 * sentence: `ADMIN_PASSWORD: generated on first run` is prose about the variable, and
 * flagging it would make this guard the kind a maintainer deletes.
 */
function assignments(text: string, name: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const at = line.indexOf(name);
    if (at === -1) continue;
    // A longer name ending in this one is a different variable: PG_PASSWORD is not
    // ADMIN_PASSWORD, and the `B` of an encoded `%5B` is not one either.
    if (at > 0 && /[A-Z_0-9]/.test(line[at - 1])) continue;
    const rest = line.slice(at + name.length);
    const assigned = /^\s*[=:]\s*(\S+)\s*$/.exec(rest.replace(/\\\s*$/, ""));
    if (assigned === null) continue;
    const value = assigned[1].replace(/^["'`]+/, "").replace(/[\\,"'`.]+$/, "");
    // A shell variable, a template placeholder, or prose standing in for a value the reader
    // supplies. `...` is the last of those.
    if (value === "" || value === "..." || /^\$/.test(value) || value.startsWith("{{") || value.startsWith("<")) {
      continue;
    }
    found.push(value);
  }
  return found;
}

describe("the documentation publishes no credential that works", () => {
  const files = documentationFiles();

  test("finds the files it is meant to be reading", () => {
    expect(files).toContain("README.md");
    expect(files).toContain("DOCKERHUB.md");
    expect(files).toContain(".env.example");
    expect(files).toContain("README_zh.md");
    expect(files).toContain("packaging/linux/env");
    expect(files.length).toBeGreaterThan(40);
  });

  test("assigns no admin or user password anywhere", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const name of ["ADMIN_PASSWORD", "USER_PASSWORD"]) {
        for (const value of assignments(text, name)) offenders.push(`${file}: ${name}=${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("assigns no JWT_SECRET the server would accept", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const value of assignments(text, "JWT_SECRET")) {
        // Under the minimum is the point: a deployment left as it stands stops at boot and
        // says why, rather than coming up on a secret printed in a public file.
        if (value.length >= JWT_SECRET_MIN_LENGTH) offenders.push(`${file}: JWT_SECRET=${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
