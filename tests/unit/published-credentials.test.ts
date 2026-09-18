import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";

// A copy-and-run example that carries a password IS a published credential, whatever the
// value is called. `a-placeholder-shaped-value` read as a placeholder and signed in; example-not-a-real-password
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
 *
 * `render.yaml`, the root `Dockerfile` and `.github/workflows` are here because a file
 * does not have to be prose to hand a reader a working login: a Blueprint deploys from a
 * fork as it stands, the Dockerfile's ENV lands in every published image, and a workflow
 * is the copy-paste source for anyone wiring up the same pipeline.
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
  "render.yaml",
  "Dockerfile",
  ".github/workflows",
];

/** Anything a person pastes or a package installs. `.txt` is in it because Helm's NOTES.txt is. */
const READABLE = /\.(md|ya?ml|toml|sh|env|json|txt)$|(^|\/)(env|\.env[^/]*|Dockerfile)$/;

/**
 * Names a credential is written under. The chart spells the same three in camelCase, and a
 * value in `values.yaml` ships with the chart, so both spellings are read.
 */
const PASSWORD_NAMES = ["ADMIN_PASSWORD", "USER_PASSWORD", "adminPassword", "userPassword"];

/**
 * Secrets the server measures before it accepts them. STORAGE_ENCRYPTION_KEY sits next to
 * JWT_SECRET here because it is enforced against the same constant (see
 * src/lib/storage/encryption.ts) and, when it is set, it is the key every saved connection
 * password is sealed with.
 */
const SECRET_NAMES = ["JWT_SECRET", "STORAGE_ENCRYPTION_KEY"];

/**
 * Values CI passes to `bun run build` so the bundle compiles. They are consumed inside the
 * runner and reach no image, no chart and no reader. Exempted by exact string, not by
 * directory: any OTHER value assigned in a workflow still fails this guard.
 */
const CI_BUILD_PLACEHOLDERS = new Set(["test-secret-for-ci-build-only-32ch", "test-admin", "test-user"]);

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
 * What may follow the value and still leave it a value.
 *
 * The original rule was that the value had to be the LAST thing on the line, which is what
 * tells an assignment from a sentence. It also hid every credential with anything after it:
 * the second `-e` of a one-line `docker run`, a trailing `# comment`, the closing wall of a
 * Markdown table cell. So the line no longer has to end - the VALUE has to end, at one of
 * the four things that end one. Prose carries on in words, and a word matches none of these,
 * so `ADMIN_PASSWORD: generated on first run` is still a sentence and still unflagged.
 */
const VALUE_ENDS = /^\s*(?:#|$)|^\s*\||^\s+-{1,2}[A-Za-z]|^\s+[A-Za-z_][A-Za-z_0-9.]*\s*=/;

/**
 * The enclosing YAML key of every line, by indentation.
 *
 * Only one caller needs it: the chart's `existingSecretKeys:` block maps chart fields to the
 * key NAMES inside someone else's Secret (`adminPassword: admin-password`), which are names,
 * not passwords. Skipping that block and nothing else keeps `secrets.adminPassword`, one
 * level up in the same file, fully checked.
 */
function enclosingKeys(lines: string[]): string[] {
  const parents: string[] = [];
  const stack: { indent: number; key: string }[] = [];
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      parents.push(stack.length > 0 ? stack[stack.length - 1].key : "");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    parents.push(stack.length > 0 ? stack[stack.length - 1].key : "");
    const opener = /^\s*([A-Za-z_][\w-]*):\s*(?:#.*)?$/.exec(line);
    if (opener !== null) stack.push({ indent, key: opener[1] });
  }
  return parents;
}

/**
 * The value a reader would end up running, or null when the text stands in for one: a shell
 * variable, a template placeholder, or prose where a value belongs. `...` is the last of those.
 */
function usableValue(raw: string): string | null {
  const value = raw.replace(/^["'`]+/, "").replace(/[\\,"'`.|]+$/, "");
  if (value === "" || value === "..." || /^\$/.test(value) || value.startsWith("{{") || value.startsWith("<")) {
    return null;
  }
  return value;
}

/**
 * The other way a deployment file writes an environment variable: the name on one line and
 * the value on the next. A Render Blueprint (`- key: ADMIN_PASSWORD` / `value: example-fake-password`)
 * and a Kubernetes manifest (`- name: ...` / `value: ...`) both do it, and to a reader that
 * takes one line at a time the name and the value are two unrelated lines.
 *
 * Only the first entry after the name is read. `sync: false`, `valueFrom:` and
 * `secretKeyRef:` all say the value is supplied elsewhere, and none of them is a value.
 */
function pairedAssignments(lines: string[], name: string): string[] {
  const found: string[] = [];
  const declares = new RegExp(`^\\s*-?\\s*(?:key|name):\\s*["']?${name}["']?\\s*$`);
  for (const [index, line] of lines.entries()) {
    if (!declares.test(line)) continue;
    for (const next of lines.slice(index + 1)) {
      if (next.trim() === "" || next.trim().startsWith("#")) continue;
      const assigned = /^\s*value:\s*(\S+)([\s\S]*)$/.exec(next);
      if (assigned !== null && VALUE_ENDS.test(assigned[2])) {
        const value = usableValue(assigned[1]);
        if (value !== null) found.push(value);
      }
      break;
    }
  }
  return found;
}

/**
 * `NAME=value` in a shell example, or `NAME: value` in a compose one - plus the two-line
 * form above, because a credential does not stop working for being written across two lines.
 */
function assignments(text: string, name: string): string[] {
  const found: string[] = [];
  const lines = text.split("\n");
  const parents = enclosingKeys(lines);
  for (const [index, line] of lines.entries()) {
    const at = line.indexOf(name);
    if (at === -1) continue;
    // A longer name ending in this one is a different variable: PG_PASSWORD is not
    // ADMIN_PASSWORD, and the `B` of an encoded `%5B` is not one either. The dot covers the
    // camelCase half: `secrets.adminPassword` is a Helm path typed on a command line, which
    // the note at the top of this file says is deliberately out of scope.
    if (at > 0 && /[A-Za-z_0-9.]/.test(line[at - 1])) continue;
    if (parents[index] === "existingSecretKeys") continue;
    const rest = line.slice(at + name.length).replace(/\\\s*$/, "");
    const assigned = /^\s*[=:]\s*(\S+)([\s\S]*)$/.exec(rest);
    if (assigned === null) continue;
    if (!VALUE_ENDS.test(assigned[2])) continue;
    const value = usableValue(assigned[1]);
    if (value !== null) found.push(value);
  }
  return [...found, ...pairedAssignments(lines, name)];
}

function publishedValues(file: string, name: string): string[] {
  const values = assignments(readFileSync(file, "utf8"), name);
  if (!file.startsWith(".github/workflows/")) return values;
  return values.filter((value) => !CI_BUILD_PLACEHOLDERS.has(value));
}

describe("the documentation publishes no credential that works", () => {
  const files = documentationFiles();

  test("finds the files it is meant to be reading", () => {
    expect(files).toContain("README.md");
    expect(files).toContain("DOCKERHUB.md");
    expect(files).toContain(".env.example");
    expect(files).toContain("README_zh.md");
    expect(files).toContain("packaging/linux/env");
    expect(files).toContain("render.yaml");
    expect(files).toContain("Dockerfile");
    expect(files).toContain(".github/workflows/ci.yml");
    expect(files).toContain("charts/libredb-studio/templates/NOTES.txt");
    expect(files).toContain("charts/libredb-studio/values.yaml");
    expect(files.length).toBeGreaterThan(40);
  });

  test("assigns no admin or user password anywhere", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const name of PASSWORD_NAMES) {
        for (const value of publishedValues(file, name)) offenders.push(`${file}: ${name}=${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("assigns no secret the server would accept", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const name of SECRET_NAMES) {
        for (const value of publishedValues(file, name)) {
          // Under the minimum is the point: a deployment left as it stands stops at boot and
          // says why, rather than coming up on a secret printed in a public file.
          if (value.length >= JWT_SECRET_MIN_LENGTH) offenders.push(`${file}: ${name}=${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("reads a value that is not the last thing on its line, and still not prose", () => {
    const caught = (text: string, name: string) => assignments(text, name);
    // The shapes that got past the old "value must end the line" rule.
    expect(caught("docker run -e ADMIN_PASSWORD=example-fake-password -e HOSTNAME=db \\", "ADMIN_PASSWORD")).toEqual(["example-fake-password"]);
    expect(caught("      ADMIN_PASSWORD: example-fake-password  # the login", "ADMIN_PASSWORD")).toEqual(["example-fake-password"]);
    expect(caught("| `ADMIN_PASSWORD=example-fake-password` | the admin login |", "ADMIN_PASSWORD")).toEqual(["example-fake-password"]);
    expect(caught("  adminPassword: example-fake-password", "adminPassword")).toEqual(["example-fake-password"]);
    expect(caught("      - key: ADMIN_PASSWORD\n        value: example-fake-password", "ADMIN_PASSWORD")).toEqual(["example-fake-password"]);
    expect(caught("            - name: ADMIN_PASSWORD\n              value: example-fake-password", "ADMIN_PASSWORD")).toEqual([
      "example-fake-password",
    ]);
    // ...and the shapes that must stay quiet, or a maintainer deletes this guard.
    expect(caught("ADMIN_PASSWORD: generated on first run", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught('  adminPassword: "{{ .Values.secrets.adminPassword }}"', "adminPassword")).toEqual([]);
    expect(caught("  ADMIN_PASSWORD=$ADMIN_PASSWORD", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("  ADMIN_PASSWORD=$(openssl rand -base64 32)", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("      PG_ADMIN_PASSWORD: pgpass", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("      KC_BOOTSTRAP_ADMIN_PASSWORD: kcadmin", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("ADMIN_PASSWORD=<your-password>", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("ADMIN_PASSWORD=...", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("  --set secrets.adminPassword=example-fake-helm-password", "adminPassword")).toEqual([]);
    expect(caught("secrets:\n  existingSecretKeys:\n    adminPassword: admin-password", "adminPassword")).toEqual([]);
    expect(caught("      - key: ADMIN_PASSWORD\n        sync: false", "ADMIN_PASSWORD")).toEqual([]);
    expect(
      caught(
        "      - name: ADMIN_PASSWORD\n        valueFrom:\n          secretKeyRef:\n            key: a",
        "ADMIN_PASSWORD",
      ),
    ).toEqual([]);
  });
});
