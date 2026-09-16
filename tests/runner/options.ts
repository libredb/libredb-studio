/**
 * The test runner's command line.
 *
 * Every option is `--name=value`; a value written as a separate argument is
 * refused with the form that works, rather than being read as a selector and
 * silently running the wrong thing. An unknown option is refused by name for the
 * same reason: a forwarded bun flag goes after `--`, where it is visible.
 *
 * That refusal also names the trap a contributor is most likely to have hit, because
 * the obvious command does not work: measured on bun 1.4.2, `bun run test -- --bail`
 * reaches this parser as `["--bail"]`, since `bun run` consumes the first `--` itself,
 * and so does bun when the `--` sits straight after the script path. Only
 * `bun tests/run-tests.ts <selector> -- <flags>` arrives whole.
 */

export type RunnerOptions = {
  /** Paths naming what to run; empty means every discovered test file. */
  selectors: string[];
  /** How many test files run at once, each in its own bun process. */
  jobs: number;
  /** Collect an lcov report per file. */
  coverage: boolean;
  /** Where the per-file reports go, one subdirectory per file. */
  coverageDir: string;
  /** When set, merge the per-file reports into this path after the run. */
  mergeInto: string | null;
  /** How long one file may take before the runner kills it and fails it. */
  fileTimeoutMs: number;
  /** Print what would run and exit. */
  list: boolean;
  /** Arguments after `--`, handed to every `bun test` child verbatim. */
  bunArgs: string[];
};

export const DEFAULT_COVERAGE_DIR = "coverage/raw";

/**
 * Five minutes. No single test file comes near it (the slowest in this repository
 * is about 25 seconds), so it only ever fires on a hang - which it then reports as
 * that file's failure, with its output, instead of letting a CI job sit until the
 * job timeout kills the whole run with nothing to read.
 */
export const DEFAULT_FILE_TIMEOUT_MS = 300_000;

/**
 * The per-test timeout the runner gives its children on Windows, in place of bun's
 * own 5000ms default.
 *
 * Measured on windows-latest: filesystem work under the user's temp directory is
 * intermittently slow there and returns transient sharing violations (EPERM, EBUSY,
 * ENOENT on a rename) that the libraries doing the work retry. The retries are
 * correct; they are just not free. Across three CI runs, six tests in four unrelated
 * files - the flat-zip packer, the agent run store, the SQLite provider and the agent
 * investigation - each died between 5003ms and 5522ms, all of them doing temp I/O or
 * spawning a process, and none of them on Linux or macOS.
 *
 * So 5000ms is not a budget anybody chose for Windows, it is a default that happens to
 * sit just under what that machine costs. Raising it here does not hide a hang: a file
 * that genuinely stops is still killed and reported by DEFAULT_FILE_TIMEOUT_MS above,
 * which is an order of magnitude larger again.
 */
export const WINDOWS_PER_TEST_TIMEOUT_MS = 30_000;

/**
 * The `--timeout` a child is started with, or nothing at all.
 *
 * Windows only, and deliberately not "a bigger number everywhere": Linux is the leg
 * that has to keep failing when a test really does get slow, and it is the leg every
 * contributor and the coverage gate run on.
 */
export function perTestTimeoutArgs(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [`--timeout=${WINDOWS_PER_TEST_TIMEOUT_MS}`] : [];
}

function positiveInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} needs a whole number of 1 or more, got "${raw}".`);
  }
  return value;
}

export function parseRunnerArgs(argv: string[], { cpuCount }: { cpuCount: number }): RunnerOptions {
  const options: RunnerOptions = {
    selectors: [],
    jobs: Math.max(1, cpuCount),
    coverage: false,
    coverageDir: DEFAULT_COVERAGE_DIR,
    mergeInto: null,
    fileTimeoutMs: DEFAULT_FILE_TIMEOUT_MS,
    list: false,
    bunArgs: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;

    if (arg === "--") {
      options.bunArgs = argv.slice(index + 1);
      break;
    }

    if (!arg.startsWith("-")) {
      options.selectors.push(arg);
      continue;
    }

    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg : arg.slice(0, separator);
    const value = separator === -1 ? null : arg.slice(separator + 1);

    switch (name) {
      case "--coverage":
        options.coverage = true;
        break;
      case "--list":
        options.list = true;
        break;
      case "--jobs":
        if (value === null)
          throw new Error(`${name} takes its value with an equals sign, as ${name}=${argv[index + 1] ?? "N"}.`);
        options.jobs = positiveInteger(name, value);
        break;
      case "--file-timeout":
        if (value === null)
          throw new Error(`${name} takes its value with an equals sign, as ${name}=${argv[index + 1] ?? "SECONDS"}.`);
        options.fileTimeoutMs = positiveInteger(name, value) * 1000;
        break;
      case "--coverage-dir":
        if (value === null)
          throw new Error(`${name} takes its value with an equals sign, as ${name}=${argv[index + 1] ?? "DIR"}.`);
        options.coverageDir = value;
        break;
      case "--merge-into":
        if (value === null)
          throw new Error(`${name} takes its value with an equals sign, as ${name}=${argv[index + 1] ?? "FILE"}.`);
        options.mergeInto = value;
        options.coverage = true;
        break;
      default:
        throw new Error(
          `Unknown option "${name}". The runner's own options are --jobs, --coverage, --coverage-dir, --merge-into, --file-timeout and --list; everything for bun test goes after --. ` +
            "If you did write one: `bun run` removes the first --, and so does bun when it sits straight after the script path, " +
            "so the form that arrives whole is `bun tests/run-tests.ts <selector> -- <flags>`.",
        );
    }
  }

  return options;
}
