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

function readme(engines = ENGINES, commands = COMMANDS, indent = ""): string {
  return `# Title\n\nprose\n\n${engineTable(engines, indent)}\n\nmore prose\n\n${installTable(commands, indent)}\n`;
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
      `# Title\n\n${engineTable(ENGINES)}\n\n` +
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
