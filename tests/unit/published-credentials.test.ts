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
 *
 * This applies to `NAME: value` only. `NAME=value` needs none of it: a sentence does not
 * write an equals sign, so whatever follows the value is the rest of a command line - the
 * image name of a `docker run`, an `&& echo`, a second statement. Requiring one of these
 * four after an `=` is what let `docker run -e ADMIN_PASSWORD=example-fake-password img` publish a
 * working login, measured.
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
  // A printf format is a hole the value is poured into, not the value:
  // `printf 'ADMIN_PASSWORD=%s\n' "$APP_ADMIN_PASSWORD"` writes the password from a variable.
  // Only a run made ENTIRELY of specifiers and escapes counts, so `%s-2026` is still a value.
  if (/^(?:%[-#0 +'0-9.]*[a-zA-Z]|\\[nrt0])+$/.test(value)) return null;
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
 * A Markdown table row, which is how a README lists its variables: the name in one cell and
 * the value in the next. It assigns nothing in the `NAME=value` sense and a reader still
 * reads a working login out of it, which is how `| `ADMIN_PASSWORD` | `example-not-a-real-password` |`
 * passed this guard - measured, on the most common table shape in these files.
 *
 * Only a value cell written as a code span with no space inside it counts. That is what
 * tells the value column from the description column beside it: `| `ADMIN_PASSWORD` | Admin
 * password |` is a table OF variables, not a table of credentials, and flagging those would
 * light up every README here and get this guard deleted by the next person it stopped.
 */
function tableAssignments(lines: string[], name: string): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    for (const [index, cell] of cells.entries()) {
      if (cell.replace(/`/g, "").trim() !== name) continue;
      const span = /^`([^`\s]+)`$/.exec(cells[index + 1] ?? "");
      if (span === null) continue;
      const value = usableValue(span[1]);
      // A cell of punctuation - an em dash for "none", a lone hyphen - is not a password.
      if (value !== null && /[A-Za-z0-9]/.test(value)) found.push(value);
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
    // A quoted value is taken whole. Reading up to the first space instead stopped at the
    // first word, and a value with a space in it then looked like a value followed by prose,
    // which the check below reads as a sentence: `ADMIN_PASSWORD="example fake admin password"` was
    // published that way, measured, and so was a 42-character JWT_SECRET.
    const assigned = /^\s*([=:])\s*("[^"]*"|'[^']*'|\S+)([\s\S]*)$/.exec(rest);
    if (assigned === null) continue;
    if (assigned[1] === ":" && !VALUE_ENDS.test(assigned[3])) continue;
    const value = usableValue(assigned[2]);
    if (value !== null) found.push(value);
  }
  return [...found, ...pairedAssignments(lines, name), ...tableAssignments(lines, name)];
}

/**
 * Words that stand in for a password in the slot a login example puts one. A schema or an
 * API table writes the TYPE there, and a sentence writes an instruction - which is why a
 * value with a space in it is never read as one.
 */
const JSON_PASSWORD_STANDINS = new Set(["string", "password", "secret", "null", "undefined", "admin", "user"]);

/**
 * A login example's JSON body, which names no environment variable at all and so was read
 * by none of the rules above: `-d '{"email": "...", "password": "example-fake-login"}'` published a
 * working login in docs/API_DOCS.md twice, in a cURL block and a fetch() block, and the
 * same string had already been removed from CONTRIBUTING.md by hand.
 *
 * What makes it a LOGIN body is the `email` beside it, and that is the whole test. The same
 * documentation is full of CONNECTION bodies - `host`, `port`, `database`, `user`,
 * `password` - and the password in one of those is the READER'S own database, sampled as
 * `postgres` or `password123`. Nothing this project ships is reachable with those, and
 * flagging them would put this guard in the way of writing a connection example at all.
 *
 * Of what is left, only a double-quoted literal that reads as a value counts: a space in it
 * makes it an instruction, and a `your-` prefix makes it a placeholder.
 */
function jsonPasswordValues(text: string): string[] {
  const found: string[] = [];
  // `email` on either side of `password`, within one small object - not across a document.
  const inLoginBody =
    /"email"\s*:[\s\S]{0,120}?"(?:password|newPassword|currentPassword)"\s*:\s*"([^"]*)"|"(?:password|newPassword|currentPassword)"\s*:\s*"([^"]*)"[\s\S]{0,120}?"email"\s*:/g;
  for (const match of text.matchAll(inLoginBody)) {
    const value = usableValue(match[1] ?? match[2] ?? "");
    if (value === null || /\s/.test(value) || /^your[-_]/i.test(value)) continue;
    if (JSON_PASSWORD_STANDINS.has(value.toLowerCase())) continue;
    found.push(value);
  }
  return found;
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

  test("hands no working password to a login example", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const value of jsonPasswordValues(readFileSync(file, "utf8"))) offenders.push(`${file}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  test("reads a password out of a login body, and leaves a schema alone", () => {
    const caught = (text: string) => jsonPasswordValues(text);
    // The two shapes that were in docs/API_DOCS.md, one cURL and one fetch().
    expect(caught(`-d '{"email": "admin@libredb.org", "password": "example-fake-login"}'`)).toEqual(["example-fake-login"]);
    expect(caught(`body: JSON.stringify({ "email": "a@b.c", "password": "example-not-a-real-password" })`)).toEqual(["example-not-a-real-password"]);
    // The password before the email reads the same way.
    expect(caught(`{\n  "password": "example-fake-login",\n  "email": "admin@libredb.org"\n}`)).toEqual(["example-fake-login"]);

    // A CONNECTION body is the reader's own database, not an account this project ships.
    expect(caught(`{"host": "127.0.0.1", "user": "postgres", "password": "postgres"}`)).toEqual([]);
    expect(caught(`{"host": "h", "port": 8091, "user": "Administrator", "password": "password123"}`)).toEqual([]);

    // And the stand-ins, or every API table in docs/ fails this guard.
    expect(caught(`{"email": "a@b.c", "password": "string"}`)).toEqual([]);
    expect(caught(`{"email": "a@b.c", "password": "your-password"}`)).toEqual([]);
    expect(caught(`{"email": "a@b.c", "password": "your admin password"}`)).toEqual([]);
    expect(caught(`{"email": "a@b.c", "password": "<your password>"}`)).toEqual([]);
    expect(caught(`{"email": "a@b.c", "password": "$ADMIN_PASSWORD"}`)).toEqual([]);
    expect(caught(`{"email": "a@b.c", "password": ""}`)).toEqual([]);
    expect(caught(`| \`password\` | string | required |`)).toEqual([]);
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

  test("reads the four shapes a reviewer published a working password through", () => {
    const caught = (text: string, name: string) => assignments(text, name);

    // 1. The variable table, which is how every README here lists its settings. The name and
    // the value are two cells of one row and nothing between them is an assignment.
    expect(caught("| `ADMIN_PASSWORD` | `example-not-a-real-password` | the admin login |", "ADMIN_PASSWORD")).toEqual([
      "example-not-a-real-password",
    ]);
    expect(caught("| ADMIN_PASSWORD | `example-not-a-real-password` |", "ADMIN_PASSWORD")).toEqual(["example-not-a-real-password"]);

    // 2. A shell line that carries on after the value.
    expect(caught("export ADMIN_PASSWORD=example-not-a-real-password && echo ok", "ADMIN_PASSWORD")).toEqual(["example-not-a-real-password"]);

    // 3. A value with a space in it, which used to be read as one word plus prose.
    expect(caught('ADMIN_PASSWORD="example fake admin password"', "ADMIN_PASSWORD")).toEqual(["example fake admin password"]);
    expect(caught("USER_PASSWORD='example fake user password'", "USER_PASSWORD")).toEqual(["example fake user password"]);
    // The same hole let a secret through, and a secret is judged by its LENGTH, so reading
    // one word of it hid a value the server would have accepted.
    const secret = caught('JWT_SECRET="a secret long enough to be accepted here"', "JWT_SECRET");
    expect(secret).toEqual(["a secret long enough to be accepted here"]);
    expect(secret[0].length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH);

    // 4. `docker run` with the image name after the value, rather than another flag.
    expect(caught("docker run -e ADMIN_PASSWORD=example-not-a-real-password libredb/libredb-studio", "ADMIN_PASSWORD")).toEqual([
      "example-not-a-real-password",
    ]);
  });

  test("stays quiet on the innocent shapes nearest to those four", () => {
    const caught = (text: string, name: string) => assignments(text, name);

    // A table OF variables. The cell beside the name is a description, and if these fired
    // the guard would be deleted by the next person it stopped.
    expect(caught("| `ADMIN_PASSWORD` | Admin password | no |", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("| `ADMIN_PASSWORD` | `generated on first run` |", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("| `ADMIN_PASSWORD` | - | printed to the log |", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("| `ADMIN_PASSWORD` | `<your password>` |", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("| Variable | Value |\n| --- | --- |", "ADMIN_PASSWORD")).toEqual([]);

    // A printf format is the hole a value is poured into, not the value. This one is in
    // deploy/azure/src/install.sh and the password it writes comes from a variable.
    expect(caught(`printf 'ADMIN_PASSWORD=%s\\n' "$APP_ADMIN_PASSWORD"`, "ADMIN_PASSWORD")).toEqual([]);

    // A quoted stand-in is still a stand-in.
    expect(caught('ADMIN_PASSWORD="<your admin password>"', "ADMIN_PASSWORD")).toEqual([]);
    expect(caught('ADMIN_PASSWORD=""', "ADMIN_PASSWORD")).toEqual([]);

    // And prose still reads as prose, with a colon and without one.
    expect(caught("ADMIN_PASSWORD: generated on first run and printed", "ADMIN_PASSWORD")).toEqual([]);
    expect(caught("Set ADMIN_PASSWORD to a value of your own", "ADMIN_PASSWORD")).toEqual([]);
  });
});
