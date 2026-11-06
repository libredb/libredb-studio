/**
 * Unit tests for .github/workflows/claude-plugin-mirror.yml and scripts/sync-claude-plugin-mirror.sh.
 *
 * Why a test for YAML: the workflow holds a token that can push to libredb/libredb-studio-claude-plugin,
 * the read-only copy of the Claude Code plugin that Anthropic's plugin directory reads, and what
 * matters is in its wiring. The token must reach one step and no other, that step must run nothing but
 * the sync, the workflow must sync main alone and never with force, and a run without the token must
 * fail rather than leave the copy stale.
 *
 * The two guard steps run here in bash, and the script runs end to end against local bare
 * repositories, from a depth-1 clone as actions/checkout makes one, so what reaches the copy is what
 * the directory would see.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { platformTimeoutMs } from "../helpers/platform-timeout";
import { describeIfPosixShell, posixShell } from "../helpers/posix-tools";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  "runs-on"?: string;
  environment?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, { branches?: string[]; paths?: string[]; inputs?: unknown } | null>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  env?: Record<string, string>;
  jobs: Record<string, Job>;
}

const ROOT = join(import.meta.dir, "../..");
const WORKFLOW_PATH = ".github/workflows/claude-plugin-mirror.yml";
const SCRIPT_PATH = "scripts/sync-claude-plugin-mirror.sh";
const raw = readFileSync(join(ROOT, WORKFLOW_PATH), "utf8");
const script = readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
const workflow = parseYaml(raw) as Workflow;
const sync = workflow.jobs.sync;
const steps = sync?.steps ?? [];
const TOKEN = "${{ secrets.PLUGIN_MIRROR_TOKEN }}";
const STEP_NAMES = [
  "Refuse a ref other than main",
  "Require PLUGIN_MIRROR_TOKEN",
  "Checkout main",
  "Push the plugin to libredb/libredb-studio-claude-plugin",
];
const stepNamed = (name: string): Step | undefined => steps.find((step) => step.name === name);
const [refStep, tokenStep, checkoutStep, pushStep] = STEP_NAMES.map(stepNamed);

describe("the Claude plugin mirror workflow", () => {
  test("runs on a push to main that touches the plugin, LICENSE, itself or its script, and by hand", () => {
    expect(Object.keys(workflow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push?.branches).toEqual(["main"]);
    expect(workflow.on.push?.paths).toEqual(["plugins/libredb-studio/**", "LICENSE", WORKFLOW_PATH, SCRIPT_PATH]);
    expect(workflow.on.workflow_dispatch ?? {}).toEqual({});
  });

  test("gives GITHUB_TOKEN read access only, syncs one run at a time and names the copy once", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({ group: "claude-plugin-mirror", "cancel-in-progress": false });
    expect(workflow.env).toEqual({ MIRROR: "libredb/libredb-studio-claude-plugin" });
  });

  test("has one job, in this repository alone, in the claude-plugin-mirror environment, with four steps", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["sync"]);
    expect(sync.if).toBe("github.repository == 'libredb/libredb-studio'");
    expect(sync["runs-on"]).toBe("ubuntu-latest");
    expect(sync.environment).toBe("claude-plugin-mirror");
    expect(sync["timeout-minutes"]).toBe(10);
    expect(sync.env).toBeUndefined();
    expect(sync.permissions).toBeUndefined();
    expect(steps.map((step) => step.name)).toEqual(STEP_NAMES);
  });

  test("interpolates no expression into a shell script and never traces one", () => {
    for (const step of steps) expect(step.run ?? "").not.toContain("${{");
    for (const text of [raw, script]) {
      expect(text).not.toContain("set -x");
      expect(text).not.toContain("xtrace");
      expect(text).not.toContain("printenv");
      expect(text).not.toMatch(/GIT_TRACE|GIT_CURL_VERBOSE/);
    }
  });

  test("hands the guard steps the ref and the token's presence, never the token", () => {
    expect(refStep?.env).toEqual({ REF: "${{ github.ref }}" });
    expect(tokenStep?.env).toEqual({ TOKEN_PRESENT: "${{ secrets.PLUGIN_MIRROR_TOKEN != '' }}" });
  });

  test("hands the token to the push step alone, as GH_TOKEN, and nothing reads it by name", () => {
    const holders = steps.filter((step) => Object.values(step.env ?? {}).includes(TOKEN));
    expect(holders).toEqual([pushStep as Step]);
    expect(pushStep?.env).toEqual({ GH_TOKEN: TOKEN });
    expect(JSON.stringify(workflow).split("secrets.").length - 1).toBe(2);
    for (const step of steps) expect(step.run ?? "").not.toContain("GH_TOKEN");
    expect(script).not.toContain("GH_TOKEN");
    expect(script).not.toContain("PLUGIN_MIRROR_TOKEN");
  });

  test("holds no expression but the ref, the token's presence and the token, each where it belongs", () => {
    const found: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (typeof node === "string") {
        for (const match of node.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) found.push(`${at}: ${match[1]?.trim()}`);
      } else if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${at}.${index}`));
      } else if (node !== null && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) walk(value, at === "" ? key : `${at}.${key}`);
      }
    };
    walk(workflow, "");
    expect(Object.keys(workflow)).toEqual(["name", "on", "permissions", "concurrency", "env", "jobs"]);
    expect(Object.keys(workflow.on.push ?? {})).toEqual(["branches", "paths"]);
    expect(found).toEqual([
      "jobs.sync.steps.0.env.REF: github.ref",
      "jobs.sync.steps.1.env.TOKEN_PRESENT: secrets.PLUGIN_MIRROR_TOKEN != ''",
      "jobs.sync.steps.3.env.GH_TOKEN: secrets.PLUGIN_MIRROR_TOKEN",
    ]);
    expect(Object.keys(sync).sort()).toEqual(["environment", "if", "name", "runs-on", "steps", "timeout-minutes"]);
    expect(steps.map((step) => Object.keys(step).sort())).toEqual([
      ["env", "name", "run"],
      ["env", "name", "run"],
      ["name", "uses", "with"],
      ["env", "name", "run"],
    ]);
  });

  test("checks out main itself, without credentials, with a checkout pinned by commit, between the guards and the push", () => {
    const uses = steps.filter((step) => step.uses !== undefined);
    expect(uses).toEqual([checkoutStep as Step]);
    expect(checkoutStep?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    const line = raw.split("\n").find((text) => text.includes(`uses: ${checkoutStep?.uses}`));
    expect(line).toMatch(/ # v\d/);
    expect(checkoutStep?.with).toEqual({ ref: "refs/heads/main", "persist-credentials": false });
    expect(steps.indexOf(checkoutStep as Step)).toBe(2);
  });

  test("runs only the sync where the token is, and git or gh nowhere else", () => {
    expect(pushStep?.run?.trim().split("\n")).toEqual([
      "set -euo pipefail",
      "gh auth setup-git",
      `bash ${SCRIPT_PATH} . "$RUNNER_TEMP/claude-plugin-mirror" "https://github.com/\${MIRROR}.git"`,
    ]);
    for (const step of steps.filter((each) => each !== pushStep)) {
      expect(step.run ?? "").not.toMatch(/\b(git|gh)\b/);
    }
  });

  test("pushes main only, once for real and once as a dry run, never with force, and never turns TLS off", () => {
    const pushes = script
      .replace(/\\\n\s*/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#") && /\bgit\b.*\bpush\b/.test(line));
    expect(pushes).toEqual([
      'git -C "$WORK" push --dry-run --quiet "$COPY_URL" "$PARENT:refs/heads/main"',
      'git -C "$WORK" push --quiet "$COPY_URL" "$COMMIT:refs/heads/main"',
    ]);
    for (const text of [raw, script]) {
      expect(text).not.toMatch(/--force|--mirror|--delete|--all\b|--tags|--prune| -f /);
      expect(text).not.toMatch(/\s"?\+["$\w]/);
      expect(text).not.toMatch(/sslVerify|SSL_NO_VERIFY|insteadOf/i);
    }
  });

  test("runs no third-party code: no package manager, runtime or download", () => {
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/\b(npm|npx|bun|node|curl|wget|pip)\b/);
    }
    expect(steps.filter((step) => step.uses !== undefined).map((step) => step.uses?.split("@")[0])).toEqual([
      "actions/checkout",
    ]);
  });

  test("mirrors the folder the repository's marketplace names, and runs on the paths that build the copy", () => {
    const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8")) as {
      plugins: { source: string }[];
    };
    const folder = marketplace.plugins[0]?.source.replace(/^\.\//, "");
    expect(/^PLUGIN_DIR="([^"]+)"$/m.exec(script)?.[1]).toBe(folder);
    const called = /^bash (\S+\.sh) /m.exec(pushStep?.run ?? "")?.[1];
    expect(called).toBe(SCRIPT_PATH);
    expect(workflow.on.push?.paths).toEqual(expect.arrayContaining([`${folder}/**`, "LICENSE", WORKFLOW_PATH, called]));
  });

  test("is named in docs/MCP.md by the copy it pushes to, and its token in docs/DISTRIBUTION.md", () => {
    expect(readFileSync(join(ROOT, "docs/MCP.md"), "utf8")).toContain(`https://github.com/${workflow.env?.MIRROR}`);
    const row = readFileSync(join(ROOT, "docs/DISTRIBUTION.md"), "utf8")
      .split("\n")
      .find((line) => line.startsWith("| `PLUGIN_MIRROR_TOKEN` |"));
    expect(row).toContain("`claude-plugin-mirror.yml`");
    expect(row).toContain("`libredb/libredb-studio-claude-plugin`");
    expect(row).toContain("`claude-plugin-mirror` environment");
    expect(row).toContain("Contents read and write");
  });
});

const SHELL = posixShell("bash");

describeIfPosixShell("bash", "the mirror workflow's guard steps", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Runs a step's own shell as Actions runs it, with PATH, the workflow's env and the step's env only. */
  function runStep(step: Step | undefined, env: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "plugin-mirror-step-"));
    roots.push(root);
    const file = join(root, "step.sh");
    writeFileSync(file, step?.run ?? "exit 99");
    const child = Bun.spawnSync([SHELL as string, "--noprofile", "--norc", "-eo", "pipefail", file], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...workflow.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
  }

  test("the ref step passes main and refuses every other ref by name", () => {
    expect(runStep(refStep, { REF: "refs/heads/main" }).code).toBe(0);
    for (const ref of ["refs/heads/feature", "refs/tags/1.2.0", "refs/heads/main-old"]) {
      const run = runStep(refStep, { REF: ref });
      expect({ ref, failed: run.code !== 0 }).toEqual({ ref, failed: true });
      expect(run.output).toContain("::error::");
      expect(run.output).toContain(ref);
    }
  });

  test("the token step passes a present token and fails a missing one by name", () => {
    expect(runStep(tokenStep, { TOKEN_PRESENT: "true" }).code).toBe(0);
    for (const present of ["false", ""]) {
      const run = runStep(tokenStep, { TOKEN_PRESENT: present });
      expect({ present, failed: run.code !== 0 }).toEqual({ present, failed: true });
      expect(run.output).toContain("::error::");
      expect(run.output).toContain("PLUGIN_MIRROR_TOKEN");
    }
  });
});

const SCRIPT = join(ROOT, SCRIPT_PATH);
const BOT = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
const PLUGIN = "plugins/libredb-studio";
const QUIET_GIT = "[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[receive]\n\tautogc = false\n";
const FIXTURE_IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const ERROR_LINE = /\b(error|fatal|warning)\b/i;
const TIMEOUT = platformTimeoutMs(40_000);
/** Stands in for the token the push step hands the script as GH_TOKEN; no run may print it. */
const CANARY = "mirror-canary-value";
/** Git configuration reads a backslash as an escape, so every path it or the script gets uses forward slashes. */
const slash = (path: string): string => path.replaceAll("\\", "/");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  scratch: string;
}

describeIfPosixShell("bash", "scripts/sync-claude-plugin-mirror.sh", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  class Fixture {
    readonly root = mkdtempSync(join(tmpdir(), "plugin-mirror-"));
    readonly home = join(this.root, "home");
    readonly source = join(this.root, "source");
    readonly copy = join(this.root, "copy.git");
    readonly env: Record<string, string> = {};
    private runs = 0;

    constructor() {
      roots.push(this.root);
      mkdirSync(this.home);
      writeFileSync(join(this.home, "gitconfig"), QUIET_GIT);
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined && !name.toUpperCase().startsWith("GIT_")) this.env[name] = value;
      }
      this.env.GIT_CONFIG_GLOBAL = slash(join(this.home, "gitconfig"));
      this.env.GIT_CONFIG_NOSYSTEM = "1";
      this.env.XDG_CONFIG_HOME = this.home;
      this.env.GH_TOKEN = CANARY;
      this.git(this.root, "init", "-q", "-b", "main", this.source);
      this.write("LICENSE", "MIT License\n");
      this.write("README.md", "# Studio\n");
      this.commit("first");
      this.write(`${PLUGIN}/.claude-plugin/plugin.json`, '{ "name": "libredb-studio" }\n');
      this.write(
        `${PLUGIN}/.claude-plugin/icon.png`,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      );
      this.write(`${PLUGIN}/README.md`, "# Plugin\n");
      this.write(`${PLUGIN}/skills/libredb-studio/SKILL.md`, "---\nname: libredb-studio\n---\n");
      this.write("src/index.ts", "export {};\n");
      this.write("docs/MCP.md", "# MCP\n");
      this.write(".github/workflows/ci.yml", "name: CI\n");
      this.write(".claude-plugin/marketplace.json", "{}\n");
      this.write("plugins/other-plugin/README.md", "# Other\n");
      this.commit("second");
      this.git(this.root, "init", "-q", "--bare", "-b", "main", this.copy);
    }

    git(cwd: string, ...args: string[]): string {
      return this.gitWith(this.env, cwd, ...args);
    }

    gitWith(env: Record<string, string>, cwd: string, ...args: string[]): string {
      const child = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
      return child.stdout.toString().trim();
    }

    write(path: string, content: string | Buffer, base = this.source): void {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), content);
    }

    remove(path: string): void {
      this.git(this.source, "rm", "-q", "-r", path);
    }

    commit(message: string, cwd = this.source): string {
      this.git(cwd, "add", "-A");
      this.git(cwd, ...FIXTURE_IDENTITY, "commit", "-q", "-m", message);
      return this.git(cwd, "rev-parse", "HEAD");
    }

    /** A fresh depth-1 clone of the source, as actions/checkout makes one. */
    checkout(): string {
      const path = join(this.root, `checkout-${++this.runs}`);
      this.git(this.root, "clone", "-q", "--depth", "1", pathToFileURL(this.source).href, path);
      return path;
    }

    sync(checkout = this.checkout(), url = slash(this.copy), env = this.env): Run {
      const scratch = join(this.root, `work-${++this.runs}`);
      const child = Bun.spawnSync([SHELL as string, slash(SCRIPT), slash(checkout), slash(scratch), url], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const run = { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), scratch };
      expect(`${run.stdout}${run.stderr}`).not.toContain(CANARY);
      return run;
    }

    /** The copy's main, or null when it has none. */
    main(): string | null {
      const child = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/heads/main"], {
        cwd: this.copy,
        env: this.env,
        stdout: "pipe",
      });
      return child.exitCode === 0 ? child.stdout.toString().trim() : null;
    }

    copyGit(...args: string[]): string {
      return this.git(this.copy, ...args);
    }

    files(): string[] {
      return this.copyGit("ls-tree", "-r", "--name-only", "main").split("\n");
    }

    changes(): string[] {
      return this.copyGit("diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "main").split("\n");
    }

    parents(commit = "main"): string[] {
      return this.copyGit("rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
    }

    /** A git configuration under which every push to the copy goes to a path that does not exist. */
    refusingEnv(): Record<string, string> {
      const config = join(this.home, "refusing-gitconfig");
      const missing = slash(join(this.root, "nowhere.git"));
      writeFileSync(config, `${QUIET_GIT}[url "${missing}"]\n\tpushInsteadOf = ${slash(this.copy)}\n`);
      return { ...this.env, GIT_CONFIG_GLOBAL: slash(config) };
    }
  }

  const errorLines = (run: Run): string[] => run.stderr.split("\n").filter((line) => ERROR_LINE.test(line));

  test(
    "the first sync pushes one root commit holding the plugin folder and LICENSE, by github-actions[bot]",
    () => {
      const fixture = new Fixture();
      const checkout = fixture.checkout();
      const sha = fixture.git(checkout, "rev-parse", "HEAD");
      const run = fixture.sync(checkout);
      expect(run.code).toBe(0);
      expect(errorLines(run)).toEqual([]);
      const main = fixture.main();
      expect(fixture.parents()).toEqual([]);
      expect(fixture.copyGit("rev-list", "--count", "main")).toBe("1");
      expect(fixture.copyGit("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
      expect(fixture.files()).toEqual([
        ".claude-plugin/icon.png",
        ".claude-plugin/plugin.json",
        "LICENSE",
        "README.md",
        "skills/libredb-studio/SKILL.md",
      ]);
      const top = fixture
        .copyGit("ls-tree", "main")
        .split("\n")
        .filter((line) => !line.endsWith("\tLICENSE"));
      expect(top).toEqual(fixture.git(checkout, "ls-tree", `HEAD:${PLUGIN}`).split("\n"));
      expect(fixture.copyGit("rev-parse", "main:LICENSE")).toBe(fixture.git(checkout, "rev-parse", "HEAD:LICENSE"));
      expect(fixture.copyGit("log", "-1", "--format=%s", "main")).toBe(
        `Sync ${PLUGIN} from libredb/libredb-studio@${sha}`,
      );
      expect(fixture.copyGit("log", "-1", "--format=%b", "main")).toContain(
        `https://github.com/libredb/libredb-studio/tree/${sha}/${PLUGIN}`,
      );
      expect(fixture.copyGit("log", "-1", "--format=%an <%ae>", "main")).toBe(BOT);
      expect(fixture.copyGit("log", "-1", "--format=%cn <%ce>", "main")).toBe(BOT);
      expect(run.stdout.startsWith(`Pushed ${main} to ${slash(fixture.copy)} main:`)).toBe(true);
      expect(run.stdout.split("\n").filter((line) => /^[ADM]\t/.test(line))).toEqual([
        "A\t.claude-plugin/icon.png",
        "A\t.claude-plugin/plugin.json",
        "A\tLICENSE",
        "A\tREADME.md",
        "A\tskills/libredb-studio/SKILL.md",
      ]);
    },
    TIMEOUT,
  );

  test(
    "reads committed objects only, and leaves the checkout as it found it",
    () => {
      const fixture = new Fixture();
      const checkout = fixture.checkout();
      fixture.write(`${PLUGIN}/UNTRACKED.md`, "untracked\n", checkout);
      fixture.write(`${PLUGIN}/README.md`, "# Edited, not committed\n", checkout);
      fixture.write("LICENSE", "Edited, not committed\n", checkout);
      const state = () => [
        fixture.git(checkout, "status", "--porcelain"),
        fixture.git(checkout, "for-each-ref"),
        fixture.git(checkout, "count-objects", "-v"),
      ];
      const before = state();
      expect(fixture.sync(checkout).code).toBe(0);
      expect(state()).toEqual(before);
      expect(existsSync(join(checkout, ".git", "FETCH_HEAD"))).toBe(false);
      expect(fixture.files()).not.toContain("UNTRACKED.md");
      expect(fixture.copyGit("rev-parse", "main:README.md")).toBe(
        fixture.git(checkout, "rev-parse", `HEAD:${PLUGIN}/README.md`),
      );
      expect(fixture.copyGit("rev-parse", "main:LICENSE")).toBe(fixture.git(checkout, "rev-parse", "HEAD:LICENSE"));
    },
    TIMEOUT,
  );

  test(
    "makes no commit when neither the plugin folder nor LICENSE changed",
    () => {
      const fixture = new Fixture();
      expect(fixture.sync().code).toBe(0);
      const main = fixture.main();
      const again = fixture.sync();
      expect(again.code).toBe(0);
      expect(again.stdout).toContain("nothing to push");
      expect(errorLines(again)).toEqual([]);
      expect(fixture.main()).toBe(main);
      fixture.write("src/index.ts", "export const changed = true;\n");
      fixture.write("README.md", "# Studio, changed\n");
      fixture.commit("outside the plugin");
      const outside = fixture.sync();
      expect(outside.code).toBe(0);
      expect(outside.stdout).toContain("nothing to push");
      expect(errorLines(outside)).toEqual([]);
      expect(fixture.main()).toBe(main);
    },
    TIMEOUT,
  );

  test(
    "pushes one commit per change, on top of the copy's main, naming the new source commit",
    () => {
      const fixture = new Fixture();
      expect(fixture.sync().code).toBe(0);
      const previous = fixture.main();
      fixture.write(`${PLUGIN}/skills/libredb-studio/SKILL.md`, "---\nname: libredb-studio\n---\nChanged.\n");
      fixture.remove(`${PLUGIN}/.claude-plugin/icon.png`);
      fixture.write(`${PLUGIN}/skills/libredb-studio/reference.md`, "# Reference\n");
      const sha = fixture.commit("change the plugin");
      expect(fixture.sync().code).toBe(0);
      expect(fixture.copyGit("rev-list", "--count", "main")).toBe("2");
      expect(fixture.copyGit("for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
      expect(fixture.parents()).toEqual([previous as string]);
      expect(fixture.changes()).toEqual([
        "D\t.claude-plugin/icon.png",
        "M\tskills/libredb-studio/SKILL.md",
        "A\tskills/libredb-studio/reference.md",
      ]);
      expect(fixture.copyGit("log", "-1", "--format=%s", "main")).toBe(
        `Sync ${PLUGIN} from libredb/libredb-studio@${sha}`,
      );
    },
    TIMEOUT,
  );

  test(
    "pushes one commit when LICENSE alone changed",
    () => {
      const fixture = new Fixture();
      expect(fixture.sync().code).toBe(0);
      const previous = fixture.main();
      fixture.write("LICENSE", "MIT License\n\nCopyright LibreDB\n");
      fixture.commit("license");
      expect(fixture.sync().code).toBe(0);
      expect(fixture.parents()).toEqual([previous as string]);
      expect(fixture.changes()).toEqual(["M\tLICENSE"]);
    },
    TIMEOUT,
  );

  test(
    "replaces a commit made on the copy by hand with the next sync, on top of it",
    () => {
      const fixture = new Fixture();
      expect(fixture.sync().code).toBe(0);
      const hand = join(fixture.root, "hand");
      fixture.git(fixture.root, "clone", "-q", pathToFileURL(fixture.copy).href, hand);
      fixture.write("stray.txt", "stray\n", hand);
      fixture.write("README.md", "# Edited on the copy\n", hand);
      const handCommit = fixture.commit("by hand", hand);
      fixture.git(hand, "push", "-q", "origin", "main");
      expect(fixture.main()).toBe(handCommit);
      const checkout = fixture.checkout();
      expect(fixture.sync(checkout).code).toBe(0);
      expect(fixture.parents()).toEqual([handCommit]);
      expect(fixture.files()).not.toContain("stray.txt");
      expect(fixture.copyGit("rev-parse", "main:README.md")).toBe(
        fixture.git(checkout, "rev-parse", `HEAD:${PLUGIN}/README.md`),
      );
      for (const line of fixture.copyGit("rev-list", "--parents", "main").split("\n")) {
        expect(line.split(" ").length).toBeLessThanOrEqual(2);
      }
    },
    TIMEOUT,
  );

  const refusals: [string, (fixture: Fixture) => void, string][] = [
    ["a source without the plugin folder", (fixture) => fixture.remove(PLUGIN), `has no ${PLUGIN} folder`],
    ["a source without LICENSE", (fixture) => fixture.remove("LICENSE"), "has no LICENSE file"],
    [
      "a plugin folder with a LICENSE of its own",
      (fixture) => fixture.write(`${PLUGIN}/LICENSE`, "Apache-2.0\n"),
      "has a LICENSE of its own",
    ],
  ];
  for (const [name, change, reason] of refusals) {
    test(
      `refuses ${name}, and pushes nothing`,
      () => {
        const fixture = new Fixture();
        expect(fixture.sync().code).toBe(0);
        const main = fixture.main();
        change(fixture);
        fixture.commit(name);
        const run = fixture.sync();
        expect(run.code).not.toBe(0);
        expect(run.stderr).toContain(reason);
        expect(fixture.main()).toBe(main);
      },
      TIMEOUT,
    );
  }

  test(
    "fails when the copy cannot be read",
    () => {
      const fixture = new Fixture();
      const run = fixture.sync(fixture.checkout(), slash(join(fixture.root, "missing.git")));
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain("could not read");
    },
    TIMEOUT,
  );

  test(
    "fails when the copy refuses the push, with a change and with nothing to push",
    () => {
      const fixture = new Fixture();
      expect(fixture.sync().code).toBe(0);
      const main = fixture.main();
      const refusing = fixture.refusingEnv();
      expect(fixture.sync(fixture.checkout(), slash(fixture.copy), refusing).code).not.toBe(0);
      fixture.write(`${PLUGIN}/README.md`, "# Plugin, changed\n");
      fixture.commit("change");
      expect(fixture.sync(fixture.checkout(), slash(fixture.copy), refusing).code).not.toBe(0);
      expect(fixture.main()).toBe(main);
    },
    TIMEOUT,
  );

  test(
    "refuses a copy URL with credentials without printing them or creating the scratch directory",
    () => {
      const fixture = new Fixture();
      const run = fixture.sync(fixture.checkout(), "https://someone@example.invalid/copy.git");
      expect(run.code).toBe(2);
      expect(run.stderr).not.toContain("someone@");
      expect(existsSync(run.scratch)).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "refuses a scratch directory that exists, and leaves it as it was",
    () => {
      const fixture = new Fixture();
      const scratch = join(fixture.root, "existing");
      mkdirSync(scratch);
      writeFileSync(join(scratch, "keep.txt"), "keep\n");
      const child = Bun.spawnSync(
        [SHELL as string, slash(SCRIPT), slash(fixture.checkout()), slash(scratch), slash(fixture.copy)],
        { env: fixture.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(child.exitCode).not.toBe(0);
      expect(readFileSync(join(scratch, "keep.txt"), "utf8")).toBe("keep\n");
      expect(fixture.main()).toBeNull();
    },
    TIMEOUT,
  );

  test("fails with its usage when it gets fewer than three arguments", () => {
    const child = Bun.spawnSync([SHELL as string, slash(SCRIPT), "only-one"], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(2);
    expect(child.stderr.toString()).toContain("usage");
  });
});
