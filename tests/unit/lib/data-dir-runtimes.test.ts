/**
 * `canonicalPath` (src/lib/data-dir.ts) on paths whose symbolic links never end, or end only after many missing
 * components, on the runtimes production runs: one Node child per binary that NODE_TRANSPORT_NODES lists (or the node on
 * PATH), each with a 256 MB heap, and one Bun child, `process.execPath`.
 *
 * These shapes run in children only, never in this process: a walk that does not bound the links it follows never
 * returns on them, so each child has a deadline after which it is killed, and the test reads only whether it exited on
 * its own and the report it printed. Each child runs one bundle that Bun.build({ target: "node" }) makes of the data
 * directory and provider file modules around the text of `runCases`; it makes its links in a scratch directory of its
 * own, takes its storage location there, runs every case and prints one JSON report.
 *
 * The cases:
 * - a link whose target leads back to itself through a missing directory (`a -> missing/../a`), which the filesystem
 *   answers as missing at `missing`, so its own link limit never sees a loop;
 * - two links that lead to each other the same way;
 * - 30 links each adding 500 missing components (`L<i> -> L<i+1>/m/.../m`), every target under the 1023 bytes macOS
 *   allows a link's target, so the walk collects 15,000 names before it reaches the end.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type * as fsModule from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as osModule from "node:os";
import { tmpdir } from "node:os";
import type * as pathModule from "node:path";
import { delimiter, join } from "node:path";
import type { canonicalPath } from "@/lib/data-dir";
import { PATH_NOT_CHECKED, type admittedFileConnection } from "@/lib/db/provider-files";

const ROOT = join(import.meta.dir, "..", "..", "..");
const DATA_DIR = join(ROOT, "src/lib/data-dir.ts");
const PROVIDER_FILES = join(ROOT, "src/lib/db/provider-files.ts");

/** How long a child may run before it is killed; every case returns in well under a second when the walk is bounded. */
const CHILD_DEADLINE_MS = 30_000;

/** What a call threw, or that it returned. */
interface Outcome {
  readonly returned: boolean;
  readonly name?: string;
  readonly code?: unknown;
  readonly message?: string;
  readonly causeCode?: unknown;
}

interface Report {
  readonly runtime: string;
  readonly self: { readonly canonical: Outcome; readonly admission: Outcome };
  readonly pair: { readonly canonical: Outcome; readonly admission: Outcome };
  readonly deep: Outcome;
}

/** Runs every case. SELF-CONTAINED ON PURPOSE: each child runs this function's own text, so it names only its arguments. */
function runCases(
  canonical: typeof canonicalPath,
  admitted: typeof admittedFileConnection,
  fs: typeof fsModule,
  path: typeof pathModule,
  os: typeof osModule,
  runtime: string,
): Report {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libredb-link-walk-")));
  process.env.STORAGE_SQLITE_PATH = path.join(dir, "data", "libredb-storage.db");
  const outcome = (run: () => unknown): Outcome => {
    try {
      run();
      return { returned: true };
    } catch (error) {
      const thrown = error as Error & { code?: unknown; cause?: { code?: unknown } };
      return {
        returned: false,
        name: thrown.name,
        code: thrown.code,
        message: String(thrown.message).slice(0, 300),
        causeCode: thrown.cause?.code,
      };
    }
  };
  const admit = (database: string) => () =>
    admitted({ id: "walk", name: "walk", type: "duckdb", database, createdAt: new Date(0) } as never);
  try {
    // Joined by hand, not with path.join, which would fold `missing/..` away before the link is made.
    const back = (name: string) => ["missing", "..", name].join(path.sep);
    const self = path.join(dir, "self");
    fs.symlinkSync(back("self"), self);
    const pairA = path.join(dir, "pair-a");
    fs.symlinkSync(back("pair-b"), pairA);
    fs.symlinkSync(back("pair-a"), path.join(dir, "pair-b"));
    const deep = path.join(dir, "deep");
    fs.mkdirSync(deep);
    const missing = Array.from({ length: 500 }, () => "m").join(path.sep);
    for (let i = 0; i < 30; i++) {
      fs.symlinkSync(path.join(i === 29 ? "end" : `L${i + 1}`, missing), path.join(deep, `L${i}`));
    }
    return {
      runtime,
      self: { canonical: outcome(() => canonical(self)), admission: outcome(admit(self)) },
      pair: { canonical: outcome(() => canonical(pairA)), admission: outcome(admit(pairA)) },
      deep: outcome(() => canonical(path.join(deep, "L0"))),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH; an empty list or no node fails by name. */
function nodeBinaries(): string[] {
  const listed = process.env.NODE_TRANSPORT_NODES;
  const nodes = listed === undefined ? [Bun.which("node")] : listed.split(delimiter).filter((entry) => entry !== "");
  if (nodes.length === 0 || nodes.includes(null)) {
    throw new Error("No Node binary: set NODE_TRANSPORT_NODES or put Node 24 or later on PATH");
  }
  return nodes as string[];
}

/** A child's run: how it ended, and the report it printed when it exited on its own. */
interface Run {
  readonly label: string;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly stderr: string;
  readonly report?: Report;
}

let dir: string;
const runs: Run[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "data-dir-runtimes-"));
  writeFileSync(
    join(dir, "child.ts"),
    [
      'import * as fs from "node:fs";',
      'import * as os from "node:os";',
      'import * as path from "node:path";',
      `import { canonicalPath } from ${JSON.stringify(DATA_DIR)};`,
      `import { admittedFileConnection } from ${JSON.stringify(PROVIDER_FILES)};`,
      `const runCases = ${runCases.toString()};`,
      "const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;",
      "const report = runCases(canonicalPath, admittedFileConnection, fs, path, os, runtime);",
      'process.stdout.write(JSON.stringify(report) + "\\n");',
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [join(dir, "child.ts")], target: "node", format: "esm", outdir: dir });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  const commands: [string, string[]][] = [
    ...nodeBinaries().map((node): [string, string[]] => [
      `node ${node}`,
      [node, "--max-old-space-size=256", join(dir, "child.js")],
    ]),
    [`bun ${process.execPath}`, [process.execPath, join(dir, "child.js")]],
  ];
  const settled = await Promise.all(
    commands.map(async ([label, command]): Promise<Run> => {
      const child = Bun.spawn(command, {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", NODE_ENV: "production" },
        timeout: CHILD_DEADLINE_MS,
        killSignal: "SIGKILL",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const last = stdout.trim().split("\n").at(-1) ?? "";
      const report = exitCode === 0 ? (JSON.parse(last) as Report) : undefined;
      const signalCode = child.signalCode === null ? null : String(child.signalCode);
      return { label, exitCode, signalCode, stderr: stderr.slice(-2000), report };
    }),
  );
  runs.push(...settled);
}, CHILD_DEADLINE_MS * 3);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("canonicalPath on links that never end, in a child per runtime", () => {
  test("a child ran for every listed Node and for Bun, and each exited on its own before its deadline", () => {
    expect(runs.length).toBe(nodeBinaries().length + 1);
    for (const { label, exitCode, signalCode, stderr } of runs) {
      expect({ label, exitCode, signalCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({
        label,
        exitCode: 0,
        signalCode: null,
        stderr: "",
      });
    }
  });

  for (const shape of ["self", "pair"] as const) {
    const described = shape === "self" ? "leads back to itself" : "and another lead to each other";
    test(`a path whose link ${described} through a missing directory is refused with ELOOP within the deadline, and a connection naming it is refused by name, on every runtime`, () => {
      for (const { label, report } of runs) {
        expect({ label, canonical: report?.[shape].canonical }).toMatchObject({
          label,
          canonical: { returned: false, name: "Error", code: "ELOOP" },
        });
        const admission = report?.[shape].admission;
        expect({ label, admission }).toMatchObject({
          label,
          admission: { returned: false, name: "DatabaseConfigError", causeCode: "ELOOP" },
        });
        expect([label, admission?.message?.startsWith(`${PATH_NOT_CHECKED}: `)]).toEqual([label, true]);
      }
    });
  }

  test("a path whose links are within the limit is resolved or refused by name however many components each link adds, never by the runtime's stack limit, on every runtime", () => {
    for (const { label, report } of runs) {
      const deep = report?.deep;
      expect([label, deep === undefined]).toEqual([label, false]);
      if (deep?.returned) continue;
      expect([label, deep?.name]).not.toEqual([label, "RangeError"]);
      expect([label, typeof deep?.code]).toEqual([label, "string"]);
    }
  });
});
