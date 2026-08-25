/**
 * Static lint over the copy-paste `helm` recipes in charts/libredb-studio/README.md.
 *
 * A README recipe is not executable, so nothing rendered it and both hazards below
 * shipped. Measured on 2026-08-25 against helm v4.1.3 and the real chart:
 *
 *  1. **Type coercion.** `--set extraEnv[0].value=true` renders `value: true`, an
 *     unquoted YAML boolean, and `core/v1.EnvVar.value` is a string - the API server
 *     rejects the manifest with `invalid type for io.k8s.api.core.v1.EnvVar.value: got
 *     "bool", expected "string"`. The shell strips the README's `"true"` quotes before
 *     helm ever sees them, so writing them in the recipe does not help. Nor does the
 *     chart's own schema: `values.schema.json` types `extraEnv` as an array of plain
 *     objects, so the boolean passes `helm template` and `helm lint --strict` alike.
 *     The same holds for `ingress.annotations.*`, which is a `map[string]string`:
 *     `--set …/limit-rpm=120` rendered `limit-rpm: 120` as an integer.
 *     `--set-string` is the fix, and it is why tests/unit/helm-chart-agent.test.ts
 *     records the agent off-switch being moved to a values field that renders a quoted
 *     string - to delete this trap rather than keep explaining it.
 *  2. **Shell globbing.** An unquoted `extraEnv[0]` is a glob pattern in zsh, the
 *     default shell on macOS and on this project's dev machines. It does not reach
 *     helm at all: the command dies with `zsh: no matches found:
 *     extraEnv[0].name=CSP_REPORT_ONLY`. Bash without `failglob` passes it through, so
 *     the recipe works for some readers and not others.
 *
 * Both are mechanical, so they are checked mechanically here rather than left to the
 * next reviewer's eye. This test deliberately does NOT require `--set-string`
 * everywhere: a value that cannot coerce (a URL, `websecure`) is correct with plain
 * `--set`, and demanding otherwise would train the rule into noise.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const README = "charts/libredb-studio/README.md";

interface SetArg {
  /** "--set" or "--set-string" */
  flag: string;
  /** the argument as written, quotes included */
  raw: string;
  /** the argument with one layer of surrounding quotes removed */
  value: string;
  quoted: boolean;
  line: number;
}

/**
 * Collects every --set/--set-string argument inside ```bash fences. Only fenced
 * shell blocks are recipes; prose mentions `extraEnv[0]` in backticks and must not
 * be flagged.
 */
function collectSetArgs(markdown: string): SetArg[] {
  const args: SetArg[] = [];
  let inBash = false;
  const lines = markdown.split("\n");

  for (const [index, line] of lines.entries()) {
    if (line.startsWith("```")) {
      inBash = line.startsWith("```bash");
      continue;
    }
    if (!inBash) continue;

    // A quoted argument may contain spaces, so match the quoted form first. The bare
    // form must accept backslashes: an annotation key escapes its dots, and excluding
    // `\` truncated the token before the `=`, hiding the very defect this file lints.
    // matchAll, not exec: two --set flags can share one line.
    for (const match of line.matchAll(/--set(-string)?\s+("([^"]*)"|'([^']*)'|(\S+))/g)) {
      const bare = match[5];
      args.push({
        flag: match[1] ? "--set-string" : "--set",
        raw: match[2],
        value: match[3] ?? match[4] ?? bare ?? "",
        quoted: bare === undefined,
        line: index + 1,
      });
    }
  }

  return args;
}

/**
 * YAML 1.1 plain scalars that are NOT strings - what `--set` hands the API server.
 *
 * The inner quotes are stripped first because the shell strips them too: the original
 * `--set extraEnv[0].value="true"` LOOKS quoted in the README and still rendered
 * `value: true`. A recipe that writes them is the defect, not the cure.
 */
function coercesToNonString(rawValue: string): boolean {
  const value = /^(["'])(.*)\1$/.exec(rawValue)?.[2] ?? rawValue;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  return ["true", "false", "yes", "no", "on", "off", "null", "~"].includes(value.toLowerCase());
}

/** Chart paths whose Kubernetes destination is typed as a string. */
function needsString(key: string): boolean {
  return /^extraEnv\[\d+\]\.value$/.test(key) || key.startsWith("ingress.annotations.");
}

const setArgs = collectSetArgs(readFileSync(join(ROOT, README), "utf8"));

describe("chart README helm recipes", () => {
  test("the fenced recipes are found at all (guards the fence parser itself)", () => {
    // A parser that silently matched nothing would make every assertion below vacuous.
    expect(setArgs.length).toBeGreaterThan(40);
    expect(setArgs.some((a) => a.value.startsWith("extraEnv["))).toBe(true);
    expect(setArgs.some((a) => a.flag === "--set-string")).toBe(true);
  });

  test("every bracket argument is quoted, or zsh globs it before helm runs", () => {
    const unquoted = setArgs
      .filter((a) => a.value.includes("[") && !a.quoted)
      .map((a) => `${README}:${a.line}  ${a.flag} ${a.raw}`);

    expect(unquoted).toEqual([]);
  });

  test("no --set passes a coercible value into a string-typed field", () => {
    const coerced = setArgs
      .filter((a) => a.flag === "--set")
      .map((a) => ({ arg: a, eq: a.value.indexOf("=") }))
      .filter(
        ({ arg, eq }) => eq > 0 && needsString(arg.value.slice(0, eq)) && coercesToNonString(arg.value.slice(eq + 1)),
      )
      .map(({ arg }) => `${README}:${arg.line}  ${arg.flag} ${arg.raw}`);

    expect(coerced).toEqual([]);
  });
});
