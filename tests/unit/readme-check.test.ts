import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkReadmes,
  commandSpans,
  engineNames,
  findEngineTable,
  findInstallTable,
  hasPlainHttpWarning,
  hasTranslationBanner,
  parseTables,
} from "../../scripts/readme-check.mjs";

// The localized READMEs (#317) duplicate the engine table and the install
// commands from README.md, and nothing else in the repo notices when they
// drift. The bugs this guard exists to catch are real ones that shipped in
// review: a Homebrew row missing `brew trust`, a Helm row that only added a
// repo, and an engine list that would silently keep saying ten after an
// eleventh provider lands.
const SCRIPT = path.resolve(import.meta.dir, "../../scripts/readme-check.mjs");
const workDir = mkdtempSync(path.join(tmpdir(), "readme-check-test-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function engineTable(engines: string[], indent = ""): string {
  const header = `${indent}| Database | Driver | Features |\n${indent}| :--- | :--- | :--- |\n`;
  return header + engines.map((e) => `${indent}| **${e}** | \`drv\` | stuff |`).join("\n");
}

function installTable(commands: string[], indent = ""): string {
  const header = `${indent}| Channel | Command |\n${indent}| :--- | :--- |\n`;
  return header + commands.map((c, i) => `${indent}| **c${i}** | \`${c}\` |`).join("\n");
}

const ENGINES = ["PostgreSQL", "MySQL", "Redis"];
const COMMANDS = ["docker run -d ghcr.io/libredb/libredb-studio:latest", "sudo snap install libredb-studio"];

/**
 * The blockquote every README carries under its quickstart. Only its shape matters to the
 * guard - a blockquote naming the variable - so the fixture text need not match the real one.
 */
const WARNING = "> Reaching Studio at anything but localhost or HTTPS needs `AUTH_COOKIE_SECURE=false`.";

/**
 * The blockquote every localized README carries above its first heading. Only its shape
 * matters to the guard - a blockquote linking to README.md - so the fixture need not be in
 * any of the five languages.
 */
const BANNER = "> This translation may lag behind the [English version](README.md).";

function readme(engines = ENGINES, commands = COMMANDS, indent = ""): string {
  return `# Title\n\n${BANNER}\n\nprose\n\n${WARNING}\n\n${engineTable(engines, indent)}\n\nmore prose\n\n${installTable(commands, indent)}\n`;
}

/** The same file with its banner removed, for the exemption and the negative case. */
function withoutBanner(text: string): string {
  return text.replace(`${BANNER}\n\n`, "");
}

/** The same file with its warning blockquote removed, for the negative cases. */
function withoutWarning(text: string): string {
  return text.replace(`${WARNING}\n\n`, "");
}

function runCLI(files: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const root = mkdtempSync(path.join(workDir, "root-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content);
  }
  const result = Bun.spawnSync(["node", SCRIPT, "--root", root]);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("parseTables", () => {
  test("returns header and rows for each table, ignoring prose", () => {
    const tables = parseTables(readme());
    expect(tables).toHaveLength(2);
    expect(tables[0].header).toEqual(["Database", "Driver", "Features"]);
    expect(tables[0].rows).toHaveLength(3);
    expect(tables[0].rows[0]).toEqual(["**PostgreSQL**", "`drv`", "stuff"]);
  });

  test("tolerates the leading indentation README.md uses on its install table", () => {
    const tables = parseTables(readme(ENGINES, COMMANDS, "  "));
    expect(tables).toHaveLength(2);
    expect(tables[1].rows).toHaveLength(2);
  });

  test("ignores a pipe block with no delimiter row", () => {
    expect(parseTables("| not | a table |\n| still | not |\n")).toEqual([]);
  });

  test("ignores a delimiter row with no data rows", () => {
    expect(parseTables("| a | b |\n| :--- | :--- |\n")).toEqual([]);
  });
});

describe("table lookup", () => {
  test("finds the engine table by its PostgreSQL row, not by heading text", () => {
    const table = findEngineTable(parseTables(readme()));
    expect(table?.rows).toHaveLength(3);
  });

  test("finds the install table by its docker run command", () => {
    const table = findInstallTable(parseTables(readme()));
    expect(table?.rows).toHaveLength(2);
  });

  test("returns null when the marker row is absent", () => {
    const tables = parseTables(readme(["MySQL"], ["npx @libredb/studio"]));
    expect(findEngineTable(tables)).toBeNull();
    expect(findInstallTable(tables)).toBeNull();
  });
});

describe("extraction", () => {
  test("engineNames strips the bold markers and keeps document order", () => {
    expect(engineNames(findEngineTable(parseTables(readme()))!)).toEqual(ENGINES);
  });

  test("engineNames skips a row whose first cell is not bold", () => {
    const table = { header: ["a"], rows: [["**PostgreSQL**"], ["plain"]] };
    expect(engineNames(table)).toEqual(["PostgreSQL"]);
  });

  test("commandSpans collects every code span in the table", () => {
    expect(commandSpans(findInstallTable(parseTables(readme()))!)).toEqual(COMMANDS);
  });

  test("commandSpans collects both commands from a two-command cell", () => {
    const table = { header: ["a", "b"], rows: [["**Flatpak**", "`one`<br>`two`"]] };
    expect(commandSpans(table)).toEqual(["one", "two"]);
  });

  test("commandSpans returns nothing for a link-only row", () => {
    const table = { header: ["a", "b"], rows: [["**deb**", "[Releases](https://example.com)"]] };
    expect(commandSpans(table)).toEqual([]);
  });

  test("commandSpans ignores code-formatted notes outside the command column", () => {
    // README.md's install table has a Notes column carrying `brew update` and
    // `sudo snap logs libredb-studio`. Those are not install commands, and
    // admitting them would let a localized file put a note in its Command cell.
    const table = {
      header: ["Channel", "Command", "Notes"],
      rows: [["**Homebrew**", "`brew install x`", "run `brew update` first"]],
    };
    expect(commandSpans(table)).toEqual(["brew install x"]);
  });

  test("commandSpans skips a row with no command column at all", () => {
    expect(commandSpans({ header: ["a", "b"], rows: [["only one cell"]] })).toEqual([]);
  });
});

describe("hasPlainHttpWarning", () => {
  // README.md carried the variable only as a row of its environment table, where a reader
  // following the quickstart never reaches it, while all five translations carried the
  // warning as a blockquote right under the quickstart. The blockquote is what the guard
  // keys on, because it is the one form that survives translation: the heading text is in
  // Chinese, Japanese, Spanish, Urdu and Hindi, but `AUTH_COOKIE_SECURE` is not.
  test("accepts a blockquote naming the variable", () => {
    expect(hasPlainHttpWarning(readme())).toBe(true);
  });

  test("rejects a file that names the variable only in a table row", () => {
    const tableOnly = "| `AUTH_COOKIE_SECURE` | no | drops the Secure flag |\n";
    expect(hasPlainHttpWarning(tableOnly)).toBe(false);
  });

  test("rejects a file that does not name the variable at all", () => {
    expect(hasPlainHttpWarning(withoutWarning(readme()))).toBe(false);
  });

  test("accepts the indented blockquote form", () => {
    expect(hasPlainHttpWarning("  > set `AUTH_COOKIE_SECURE=false` on a LAN")).toBe(true);
  });

  test("rejects a blockquote that does not name the variable", () => {
    expect(hasPlainHttpWarning("> Need Helm, Homebrew, Snap, winget, or deb/rpm?")).toBe(false);
  });
});

describe("hasTranslationBanner", () => {
  // Invariants 1 to 3 cannot see feature lists, counts, dates or measured numbers, so a
  // localized README can be stale in ways the guard never reports (#1055). The banner is
  // how the reader learns that. It has to sit above the first heading, because a banner
  // below the fold warns nobody, and it has to link to README.md, because naming the file
  // that wins is the whole content of the warning.
  test("accepts a blockquote above the first heading linking to README.md", () => {
    expect(hasTranslationBanner(`# Title\n\n${BANNER}\n\n## Quick Start\n\nprose\n`)).toBe(true);
  });

  test("rejects a banner that sits below the first heading", () => {
    expect(hasTranslationBanner(`# Title\n\n## Quick Start\n\n${BANNER}\n`)).toBe(false);
  });

  test("rejects a file with no banner at all", () => {
    expect(hasTranslationBanner("# Title\n\nprose\n\n## Quick Start\n")).toBe(false);
  });

  test("rejects a blockquote that does not link to README.md", () => {
    expect(hasTranslationBanner("> Need Helm, Homebrew, Snap, winget, or deb/rpm?\n\n## Quick Start\n")).toBe(false);
  });

  test("accepts the RTL span form README_ur.md uses", () => {
    const rtl = '> <span dir="rtl">aa [bb](README.md) cc</span>';
    expect(hasTranslationBanner(`# Title\n\n${rtl}\n\n## Quick Start\n`)).toBe(true);
  });

  test("accepts a file that has no heading at all", () => {
    expect(hasTranslationBanner(`# Title\n\n${BANNER}\n`)).toBe(true);
  });

  test("rejects a prose line that links to README.md without the blockquote", () => {
    expect(hasTranslationBanner("See the [English version](README.md).\n\n## Quick Start\n")).toBe(false);
  });
});

describe("checkReadmes", () => {
  const canonical = readme();

  test("accepts a localized file that mirrors the engines and abridges the commands", () => {
    const localized = readme(ENGINES, [COMMANDS[0]]);
    expect(checkReadmes({ canonical, localized: [{ name: "README_zh.md", text: localized }] })).toEqual([]);
  });

  test("rejects a localized file missing an engine", () => {
    const localized = readme(["PostgreSQL", "MySQL"]);
    const violations = checkReadmes({ canonical, localized: [{ name: "README_zh.md", text: localized }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("README_zh.md");
    expect(violations[0]).toContain("Redis");
  });

  test("rejects a localized file claiming an engine README.md does not list", () => {
    const localized = readme([...ENGINES, "Trino"]);
    const violations = checkReadmes({ canonical, localized: [{ name: "README_ja.md", text: localized }] });
    expect(violations[0]).toContain("Trino");
  });

  test("rejects a command that does not appear verbatim in README.md", () => {
    // The Snap row shipped in #317 without its `sudo`. Keep the Docker row so
    // the table is still findable - the paraphrase is what must be caught.
    const localized = readme(ENGINES, [COMMANDS[0], "snap install libredb-studio"]);
    const violations = checkReadmes({ canonical, localized: [{ name: "README_zh.md", text: localized }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("snap install libredb-studio");
  });

  test("rejects a localized command that only appears in README.md's Notes column", () => {
    const withNotes =
      `# Title\n\n${WARNING}\n\n${engineTable(ENGINES)}\n\n` +
      "| Channel | Command | Notes |\n| :--- | :--- | :--- |\n" +
      `| **Docker** | \`${COMMANDS[0]}\` | run \`brew update\` first |\n`;
    const localized = readme(ENGINES, [COMMANDS[0], "brew update"]);
    const violations = checkReadmes({ canonical: withNotes, localized: [{ name: "README_zh.md", text: localized }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("brew update");
  });

  test("reports every localized file, not just the first", () => {
    const broken = readme(["PostgreSQL"]);
    const violations = checkReadmes({
      canonical,
      localized: [
        { name: "README_zh.md", text: broken },
        { name: "README_ja.md", text: broken },
      ],
    });
    expect(violations).toHaveLength(2);
  });

  test("reports a canonical file with no engine table instead of throwing", () => {
    const violations = checkReadmes({ canonical: "# nothing", localized: [{ name: "README_zh.md", text: canonical }] });
    expect(violations[0]).toContain("README.md");
    expect(violations[0]).toContain("engine table");
  });

  test("reports a localized file with no install table", () => {
    const localized = `# Title\n\n${engineTable(ENGINES)}\n`;
    const violations = checkReadmes({ canonical, localized: [{ name: "README_zh.md", text: localized }] });
    expect(violations[0]).toContain("install table");
  });

  test("reports README.md when it is the file missing the plain-HTTP warning", () => {
    // The direction that actually shipped: every translation warned and the canonical
    // file did not, so the guard has to check the canonical side too.
    const violations = checkReadmes({
      canonical: withoutWarning(canonical),
      localized: [{ name: "README_zh.md", text: readme() }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("README.md");
    expect(violations[0]).toContain("AUTH_COOKIE_SECURE");
  });

  test("reports a localized file missing its translation-lag banner", () => {
    const localized = withoutBanner(readme());
    const violations = checkReadmes({ canonical, localized: [{ name: "README_zh.md", text: localized }] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("README_zh.md");
    expect(violations[0]).toContain("translation-lag banner");
  });

  test("exempts README.md from the banner: it is the file the banner points at", () => {
    const violations = checkReadmes({
      canonical: withoutBanner(canonical),
      localized: [{ name: "README_zh.md", text: readme() }],
    });
    expect(violations).toEqual([]);
  });

  test("reports a localized file missing the plain-HTTP warning", () => {
    const violations = checkReadmes({
      canonical,
      localized: [{ name: "README_ja.md", text: withoutWarning(readme()) }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("README_ja.md");
  });

  test("a file missing both the warning and an engine reports both", () => {
    const localized = withoutWarning(readme(["PostgreSQL", "MySQL"]));
    const violations = checkReadmes({ canonical, localized: [{ name: "README_zh.md", text: localized }] });
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes("Redis"))).toBe(true);
    expect(violations.some((v) => v.includes("AUTH_COOKIE_SECURE"))).toBe(true);
  });
});

describe("readme-check CLI", () => {
  test("passes on a consistent set and names the invariant it checked", () => {
    const { exitCode, stdout } = runCLI({
      "README.md": readme(),
      "README_zh.md": readme(ENGINES, [COMMANDS[0]]),
      "README_ja.md": readme(),
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("OK");
    expect(stdout).toContain("3 engines");
  });

  test("fails with the drift on stderr and points at the fix", () => {
    const { exitCode, stderr } = runCLI({
      "README.md": readme(),
      "README_zh.md": readme(["PostgreSQL", "MySQL"]),
      "README_ja.md": readme(),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Redis");
    expect(stderr).toContain("README.md");
  });

  test("skips a localized file that does not exist", () => {
    const { exitCode, stdout } = runCLI({ "README.md": readme(), "README_ja.md": readme() });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("README_ja.md");
    expect(stdout).not.toContain("README_zh.md");
  });

  test("fails when README.md itself is missing", () => {
    const { exitCode, stderr } = runCLI({ "README_zh.md": readme() });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("README.md");
  });

  test("defaults to the repo root and passes on the real files", () => {
    const result = Bun.spawnSync(["node", SCRIPT]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("OK");
  });
});
