/**
 * FIFOs for the tests that prove a database path never blocks the server, and the child process each
 * such test runs its open in.
 *
 * Opening a FIFO for reading waits for a writer, synchronously, on the thread that asked. Code under
 * test that regressed to opening one would block the test process itself, where no per-test timeout
 * can fire, and the suite would hang instead of failing. So a test that hands a FIFO to the code under
 * test does it in a child bun process that is killed after a hard limit, and reads what the child
 * reported, or how it ended when it never did.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { howItFailed } from "./spawn-outcome";

/**
 * Null on Linux and macOS, a reason on Windows, which has no FIFO in its filesystem (a Windows named
 * pipe lives in its own namespace), no socket file Node or Bun will listen on, and no file symlink
 * without a privilege a standard account lacks. Platform rather than a probe, for the reason
 * MISSING_POSIX_FILE_MODES in posix-tools.ts gives: a probe that answers "no" on Linux would turn a
 * real regression into a skip.
 */
export const MISSING_POSIX_SPECIAL_FILES: string | null =
  process.platform === "win32"
    ? "FIFOs, socket files and file symlinks: Windows has no mkfifo, Node and Bun listen on a named pipe there, and a file symlink needs a privilege"
    : null;

/**
 * The child's hard limit. A child that imports a provider and is refused at once reported in well
 * under a second (measured on bun 1.4.2), so only a blocked open comes near it, even on a loaded CI
 * machine.
 */
export const CHILD_HARD_TIMEOUT_MS = 15_000;

/** The per-test timeout of a test that waits on such a child: above the hard limit, so the kill is what reports. */
export const CHILD_TEST_TIMEOUT_MS = CHILD_HARD_TIMEOUT_MS + 5_000;

/** Marks the child's report among whatever else it prints: a provider logs to stdout. */
const REPORT_MARKER = "special-files-report ";

/** Make a FIFO at `target` with mkfifo(1), since neither Node nor Bun has a call for it. */
export function makeFifo(target: string, mode = "644"): void {
  const made = Bun.spawnSync(["mkfifo", "-m", mode, target], { stdout: "pipe", stderr: "pipe" });
  if (made.exitCode !== 0) throw new Error(`mkfifo ${target} ${howItFailed(made)}: ${made.stderr.toString()}`);
}

/** What a child reported, or how it ended without a report. */
export interface ChildOutcome {
  /** The value the child passed to `report`, or null when it never did. */
  readonly report: unknown;
  /** Null when the child reported, else how it ended, `was killed by SIGKILL` at the hard limit included, and its stderr. */
  readonly failure: string | null;
}

/**
 * Run `body`, the text of a module that calls `report(value)` once, in a child bun process killed at
 * `hardLimitMs`. A test asserts the whole outcome, so a child that hung reads as a `failure` naming
 * the kill rather than as a missing value.
 */
export async function runInChild(body: string, hardLimitMs = CHILD_HARD_TIMEOUT_MS): Promise<ChildOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "special-files-child-"));
  try {
    const script = join(dir, "child.ts");
    const report = `const report = (value: unknown) => console.log(${JSON.stringify(REPORT_MARKER)} + JSON.stringify(value));`;
    writeFileSync(script, `${report}\n${body}\nprocess.exit(0);\n`);
    const child = Bun.spawn([process.execPath, script], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: hardLimitMs,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    const line = stdout.split("\n").find((entry) => entry.startsWith(REPORT_MARKER));
    return {
      report: line === undefined ? null : JSON.parse(line.slice(REPORT_MARKER.length)),
      failure: line === undefined ? `${howItFailed(child)} (hard limit ${hardLimitMs} ms): ${stderr}` : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Construct the provider `exportName` of the module at `modulePath` on `config`, connect it in a
 * child, and report the error's class and message, or that it connected.
 */
export function connectInChild(
  modulePath: string,
  exportName: string,
  config: Record<string, unknown>,
  execution: Record<string, unknown> = {},
): Promise<ChildOutcome> {
  return runInChild(
    [
      `const { ${exportName}: Provider } = await import(${JSON.stringify(modulePath)});`,
      `const provider = new Provider(${JSON.stringify(config)}, {}, ${JSON.stringify(execution)});`,
      "try {",
      "  await provider.connect();",
      "  await provider.disconnect();",
      "  report({ connected: true });",
      "} catch (error) {",
      "  report({ connected: false, error: error.constructor.name, message: error.message });",
      "}",
    ].join("\n"),
  );
}
