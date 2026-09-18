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
 * the value somewhere else in the row. It assigns nothing in the `NAME=value` sense and a
 * reader still reads a working login out of it, which is how
 * `| `ADMIN_PASSWORD` | `example-not-a-real-password` |` passed this guard - measured, on the most common
 * table shape in these files.
 *
 * WHICH cell holds the value is not answerable by position. The tables actually written here
 * are `| Variable | Required | Description |` (README.md:640, DOCKERHUB.md:184), where a
 * default is written inside the description as ``(default: `x`)`` - the `ADMIN_EMAIL` row
 * does exactly that - and `| Variable | Source | Conditional |` (docs/HELM_CHART.md:166),
 * where the second cell is a chart value PATH. Reading the cell after the name misses the
 * first and reports `secrets.adminPassword` as a published password in the second, which is
 * the failure that gets a guard deleted by the next person it stops.
 *
 * So a row is read by what the table says about itself, not by where a cell sits:
 *
 * 1. A column whose HEADER names values - `Value`, `Default`, `Example`, `Sample` - holds
 *    values, and is read as one. `Required`, `Source`, `Conditional`, `Notes`, `Description`
 *    and every header not recognised describe something ABOUT the variable, never its value,
 *    so nothing is read from them positionally.
 * 2. A cell in ANY column that writes a default in words - ``default: `x` ``, `defaults to x`,
 *    ``default `x` `` - is read, because that phrasing is itself the assignment. A bare word
 *    counts only when the phrase separates it (`default: x`, not `by default the account ...`)
 *    AND the value ends the cell: prose carries on in words, which is the same thing
 *    VALUE_ENDS says one line up.
 * 3. With no header row at all - a row quoted on its own - only the cell after the name is
 *    read. That is the single positional convention left when nothing has been declared.
 * 4. A two-column table offers no column to choose between: whatever its header calls that
 *    one cell, it is everything the table says about the variable, so a value written there
 *    AS a value - `x` or **x** - is read as one. deploy/koyeb/README.md:68 and
 *    deploy/kubero/README.md:56 are that table, headed `Notes`, and a bare word in them is a
 *    note (`auto-generated`) while a marked-up one is a credential, measured on both.
 *
 * Read in a table, a value that spells the variable's own name is a reference to the setting
 * and not its value: `secrets.adminPassword`, `secrets.jwtSecret.fromExistingSecret`,
 * `admin-password`. The chart's `existingSecretKeys` exemption above is the same collision in
 * YAML; this is it in Markdown. It is deliberately narrow - `ADMIN_PASSWORD=admin-password`
 * in a shell line is still read as an assignment by the rule below.
 */
const VALUE_COLUMN = /\b(?:value|values|default|defaults|example|examples|sample|samples)\b/i;

/** The `| --- | --- |` rule, which is the only thing that makes the line above it a header. */
function isTableRule(line: string): boolean {
  return /^\s*\|[\s:|-]*-[\s:|-]*$/.test(line);
}

/**
 * The header cells governing each line, and which lines are the table's own scaffolding.
 * docs/STORAGE.md:388 writes `| `STORAGE_ENCRYPTION_KEY` | Key used |` as a HEADER; a header
 * states a column, it does not publish a value, so it is not read as a row.
 */
function tableStructure(lines: string[]): { header: string[] | null; structural: boolean }[] {
  const rows = lines.map(() => ({ header: null as string[] | null, structural: false }));
  for (const [index, line] of lines.entries()) {
    if (index === 0 || !isTableRule(line) || !/^\s*\|/.test(lines[index - 1])) continue;
    const header = lines[index - 1].split("|").map((cell) => cell.trim());
    rows[index - 1].structural = true;
    rows[index].structural = true;
    for (let row = index + 1; row < lines.length && /^\s*\|/.test(lines[row]) && !isTableRule(lines[row]); row += 1) {
      rows[row].header = header;
    }
  }
  return rows;
}

/**
 * A cell that is nothing but a value: a code span, a bold run, or a bare token. A space in it
 * makes it a sentence - `Admin password`, `generated on first run`, `32+ chars, set your own`
 * - and a cell of punctuation is an em dash for "none".
 */
function cellValue(cell: string, markedUp = false): string | null {
  const text = cell.trim();
  if (markedUp && !/^(?:`[\s\S]*`|\*\*[\s\S]*\*\*)$/.test(text)) return null;
  const bare = cell
    .trim()
    .replace(/^\*\*([\s\S]*)\*\*$/, "$1")
    .trim()
    .replace(/^`([\s\S]*)`$/, "$1")
    .trim()
    .replace(/^\*\*([\s\S]*)\*\*$/, "$1")
    .trim();
  if (bare === "" || /\s/.test(bare)) return null;
  const value = usableValue(bare);
  return value !== null && /[A-Za-z0-9]/.test(value) ? value : null;
}

/** `default:`, `defaults to`, `default is`, or `default` with the value marked up after it. */
const DEFAULT_PHRASE = /\bdefaults?\b(\s+(?:to|is)\b|\s*[:=])?\s*/gi;

/**
 * The values a cell writes as the default. A marked-up value (`x` or **x**) needs no
 * separator; a bare one needs `:`, `=`, `to` or `is` in front of it and nothing but the end
 * of the cell or a closing punctuation behind it, so `defaults to a value of your own` stays
 * a sentence.
 */
function defaultValues(cell: string): string[] {
  const found: string[] = [];
  for (const match of cell.matchAll(DEFAULT_PHRASE)) {
    const rest = cell.slice(match.index + match[0].length);
    const marked = /^(?:`([^`|]+)`|\*\*([^*|]+)\*\*)/.exec(rest);
    if (marked !== null) {
      const value = cellValue(marked[1] ?? marked[2] ?? "");
      if (value !== null) found.push(value);
      continue;
    }
    if (match[1] === undefined) continue;
    const bare = /^([A-Za-z0-9][^\s|]*?)(?=[),;]|\s*$)/.exec(rest);
    const value = bare === null ? null : cellValue(bare[1]);
    if (value !== null) found.push(value);
  }
  return found;
}

/** Whether the text is the variable's own name rather than a value of it. */
function namesItself(value: string, name: string): boolean {
  const flatten = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = flatten(name);
  return flatten(value) === target || value.split(/[./_:-]/).some((part) => flatten(part) === target);
}

function tableAssignments(lines: string[], name: string): string[] {
  const found: string[] = [];
  const structure = tableStructure(lines);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*\|/.test(line) || structure[index].structural) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const header = structure[index].header;
    for (const [column, cell] of cells.entries()) {
      if (cell.replace(/`/g, "").trim() !== name) continue;
      const lone = cells.filter((other, at) => at !== column && other !== "").length === 1;
      for (const [other, text] of cells.entries()) {
        if (other === column) continue;
        const declared =
          header === null ? other === column + 1 : VALUE_COLUMN.test(header[other] ?? "") || (lone && text !== "");
        const markedUp = header !== null && !VALUE_COLUMN.test(header[other] ?? "");
        const values = [...(declared ? [cellValue(text, markedUp)] : []), ...defaultValues(text)];
        for (const value of values) {
          if (value !== null && !namesItself(value, name)) found.push(value);
        }
      }
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
 * `postgres` or `example-fake-connection-pw`. Nothing this project ships is reachable with those, and
 * flagging them would put this guard in the way of writing a connection example at all.
 *
 * Of what is left, only a QUOTED literal that reads as a value counts: a space in it makes it
 * an instruction, and a `your-` prefix makes it a placeholder. Single quotes and a bare key
 * count as much as double ones - `{ email: 'a@b.c', password: 'example-fake-login' }` is how a
 * JavaScript object literal is written and how docs/API_DOCS.md wrote the second of its two,
 * so requiring double quotes read one of that file's two published logins and walked past the
 * other, measured. What stays unquoted is an expression, not a literal: the fetch() example
 * now reads `password: process.env.ADMIN_PASSWORD`, which publishes nothing.
 */
function jsonPasswordValues(text: string): string[] {
  const found: string[] = [];
  // `email` on either side of `password`, within one small object - not across a document.
  const key = `["']?\\b(?:newPassword|currentPassword|password)\\b["']?\\s*:`;
  const email = `["']?\\bemail\\b["']?\\s*:`;
  const inLoginBody = new RegExp(
    `${email}[\\s\\S]{0,120}?${key}\\s*(["'])((?:(?!\\1).)*)\\1|${key}\\s*(["'])((?:(?!\\3).)*)\\3[\\s\\S]{0,120}?${email}`,
    "g",
  );
  for (const match of text.matchAll(inLoginBody)) {
    const value = usableValue(match[2] ?? match[4] ?? "");
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
    // The two shapes that were really in docs/API_DOCS.md, copied from it: the cURL body at
    // line 1685 and the fetch() body at line 1769. The second is a JavaScript object literal
    // - bare key, single quotes - and a rule that required double quotes read the first and
    // walked past the second, which is how that file published two logins and reported one.
    expect(caught(`  -d '{"email": "admin@libredb.org", "password": "example-fake-login"}' \\`)).toEqual(["example-fake-login"]);
    expect(caught(`    body: JSON.stringify({ email: 'admin@libredb.org', password: 'example-fake-login' }),`)).toEqual([
      "example-fake-login",
    ]);
    // The same fetch() body written as JSON throughout, which is the other way it gets typed.
    expect(caught(`body: JSON.stringify({ "email": "a@b.c", "password": "example-not-a-real-password" })`)).toEqual(["example-not-a-real-password"]);
    // The password before the email reads the same way, in either quoting.
    expect(caught(`{\n  "password": "example-fake-login",\n  "email": "admin@libredb.org"\n}`)).toEqual(["example-fake-login"]);
    expect(caught(`{ password: 'example-fake-login', email: 'admin@libredb.org' }`)).toEqual(["example-fake-login"]);

    // An unquoted value is an expression, not a literal: this is what docs/API_DOCS.md:1773
    // reads now, and it publishes nothing.
    expect(
      caught(`body: JSON.stringify({ email: 'admin@libredb.org', password: process.env.ADMIN_PASSWORD }),`),
    ).toEqual([]);

    // A CONNECTION body is the reader's own database, not an account this project ships.
    expect(caught(`{"host": "127.0.0.1", "user": "postgres", "password": "postgres"}`)).toEqual([]);
    expect(caught(`{ host: 'h', user: 'postgres', password: 'postgres' }`)).toEqual([]);
    expect(caught(`{"host": "h", "port": 8091, "user": "Administrator", "password": "example-fake-connection-pw"}`)).toEqual([]);

    // And the stand-ins, or every API table in docs/ fails this guard.
    expect(caught(`{"email": "a@b.c", "password": "string"}`)).toEqual([]);
    expect(caught(`{ email: 'a@b.c', password: 'string' }`)).toEqual([]);
    expect(caught(`{ email: 'a@b.c', password: 'your-password' }`)).toEqual([]);
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
    const secret = caught('JWT_SECRET="an example fake secret of forty chars xx"', "JWT_SECRET");
    expect(secret).toEqual(["an example fake secret of forty chars xx"]);
    expect(secret[0].length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH);

    // 4. `docker run` with the image name after the value, rather than another flag.
    expect(caught("docker run -e ADMIN_PASSWORD=example-not-a-real-password libredb/libredb-studio", "ADMIN_PASSWORD")).toEqual([
      "example-not-a-real-password",
    ]);
  });

  test("reads a value a table hides past the cell after the name", () => {
    const caught = (text: string, name = "ADMIN_PASSWORD") => assignments(text, name);

    // README.md:640 and DOCKERHUB.md:184 are shaped `| Variable | Required | Description |`.
    // The cell after the name is a tick or a cross, and the value goes inside the description
    // - which is where the ADMIN_EMAIL row directly above already writes its own default.
    const required = "| Variable | Required | Description |\n|----------|----------|-------------|\n";
    expect(caught(required + "| `ADMIN_PASSWORD` | Yes | Admin password (default: `example-not-a-real-password`) |")).toEqual([
      "example-not-a-real-password",
    ]);
    expect(caught(required + "| `ADMIN_PASSWORD` | No | Admin password, defaults to `example-not-a-real-password` |")).toEqual([
      "example-not-a-real-password",
    ]);
    expect(caught(required + "| `ADMIN_PASSWORD` | No | Admin password (default: example-not-a-real-password) |")).toEqual([
      "example-not-a-real-password",
    ]);
    expect(caught(required + "| `ADMIN_PASSWORD` | No | Admin password (default: **example-not-a-real-password**) |")).toEqual([
      "example-not-a-real-password",
    ]);

    // A column the header calls a value is one, wherever it sits and however it is marked up.
    const valued = "| Variable | Value | Description |\n|---|---|---|\n";
    expect(caught(valued + "| `ADMIN_PASSWORD` | `example-not-a-real-password` | the admin login |")).toEqual(["example-not-a-real-password"]);
    expect(caught(valued + "| `ADMIN_PASSWORD` | example-not-a-real-password | the admin login |")).toEqual(["example-not-a-real-password"]);
    expect(caught(valued + "| `ADMIN_PASSWORD` | **example-not-a-real-password** | the admin login |")).toEqual(["example-not-a-real-password"]);

    // A secret is judged by its length, so a table that hides one is the same hole twice.
    const table = "| Variable | Default |\n|---|---|\n| `JWT_SECRET` | `example-fake-secret-not-a-real-x` |";
    const secret = caught(table, "JWT_SECRET");
    expect(secret).toEqual(["example-fake-secret-not-a-real-x"]);
    expect(secret[0].length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH);

    // A two-column table has no column to choose between - deploy/koyeb/README.md:68 heads
    // its one cell `Notes` - so a value written there AS a value is read as one.
    const notes = "| Variable | Notes |\n|----------|-------|\n";
    expect(caught(notes + "| `JWT_SECRET` | `example-fake-secret-not-a-real-x` |", "JWT_SECRET")).toEqual([
      "example-fake-secret-not-a-real-x",
    ]);
    expect(caught(notes + "| `ADMIN_PASSWORD` | **example-not-a-real-password** |")).toEqual(["example-not-a-real-password"]);

    // With no header row the row is a fragment, and the cell after the name is all there is.
    expect(caught("| `ADMIN_PASSWORD` | example-not-a-real-password |")).toEqual(["example-not-a-real-password"]);
    expect(caught("| `ADMIN_PASSWORD` | **example-not-a-real-password** |")).toEqual(["example-not-a-real-password"]);
  });

  test("leaves a table that names a source, a requirement or a note alone", () => {
    const caught = (text: string, name = "ADMIN_PASSWORD") => assignments(text, name);

    // docs/HELM_CHART.md:166 is `| Variable | Source | Conditional |` and its second cell is
    // a chart value PATH. Read positionally it reports the path as a published password, and
    // `secrets.jwtSecret.fromExistingSecret` is 37 characters, so it would fail the "no
    // secret the server would accept" test outright. This is the misfire that gets a guard
    // weakened or deleted by the next person it stops.
    const source = "| Variable | Source | Conditional |\n|----------|--------|-------------|\n";
    expect(caught(source + "| `ADMIN_PASSWORD` | `secrets.adminPassword` | When local auth |")).toEqual([]);
    const path = source + "| `JWT_SECRET` | `secrets.jwtSecret.fromExistingSecret` | Always |";
    expect(caught(path, "JWT_SECRET")).toEqual([]);
    expect(caught(source + "| `ADMIN_PASSWORD` | `admin-password` | When local auth |")).toEqual([]);
    expect(caught(source + "| `ADMIN_PASSWORD` | string | When local auth |")).toEqual([]);
    expect(caught(source + "| `ADMIN_PASSWORD` | none | When local auth |")).toEqual([]);
    expect(caught(source + "| `ADMIN_PASSWORD` | yes | When local auth |")).toEqual([]);

    // The rows as README.md:640 and DOCKERHUB.md:186 actually write them: where the password
    // comes from, never what it is.
    const required = "| Variable | Required | Description |\n|----------|----------|-------------|\n";
    const real = "| `ADMIN_PASSWORD` | @(autogenerated) | Admin password; auto-generated on first run |";
    expect(caught(required + real)).toEqual([]);
    const optional = "| `USER_PASSWORD` | No | Never generated - the account exists only when you set it |";
    expect(caught(required + optional, "USER_PASSWORD")).toEqual([]);

    // docs/API_DOCS.md:1835 is a row ABOUT `USER_EMAIL` that names `USER_PASSWORD` in passing
    // and carries a default of its own. The subject of a row is the cell the name fills.
    const other =
      "| `USER_EMAIL` | No | Login email (default `user@libredb.org`, only read when `USER_PASSWORD` is set) |";
    expect(caught(required + other, "USER_PASSWORD")).toEqual([]);

    // deploy/koyeb/README.md:68 and deploy/railway/PUBLISH.md:31, measured as written. In a
    // two-column table an unmarked cell is the note it is headed as, however few words it is.
    const notes = "| Variable | Notes |\n|---|---|\n| `JWT_SECRET` | 32+ chars, set your own |";
    expect(caught(notes, "JWT_SECRET")).toEqual([]);
    expect(
      caught("| Variable | Notes |\n|---|---|\n| `JWT_SECRET` | auto-generated by Cosmos |", "JWT_SECRET"),
    ).toEqual([]);
    expect(caught("| Variable | Notes |\n|---|---|\n| `ADMIN_PASSWORD` | auto-generated |")).toEqual([]);
    expect(caught("| Variable | Notes | When |\n|---|---|---|\n| `ADMIN_PASSWORD` | `auto` | Always |")).toEqual([]);
    const railway =
      "| Variable | Value | Description |\n|---|---|---|\n| `ADMIN_PASSWORD` | `${{ secret(16) }}` | Auto |";
    expect(caught(railway)).toEqual([]);

    // docs/STORAGE.md:388 writes the name in a HEADER cell. A header states what a column
    // holds; it does not publish a value.
    const heading =
      "| `STORAGE_ENCRYPTION_KEY` | Key used |\n|---|---|\n| unset (default) | Derived from `JWT_SECRET` |";
    expect(caught(heading, "STORAGE_ENCRYPTION_KEY")).toEqual([]);

    // And a description that says the word "default" without assigning one.
    expect(caught(required + "| `ADMIN_PASSWORD` | No | By default the account password is generated |")).toEqual([]);
    expect(caught(required + "| `ADMIN_PASSWORD` | No | Defaults to a value of your own choosing |")).toEqual([]);
    expect(caught(required + "| `ADMIN_PASSWORD` | No | Generated by default; printed once |")).toEqual([]);
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
