/**
 * What a test file needs from the machine it runs on, and what the runner does about it.
 *
 * A file declares a requirement with one line of its own, `// @requires helm`, and the runner
 * reads it before starting the file:
 *
 * - where the requirement is met, the file runs like any other;
 * - where it is not, the file is not started, and the summary names it under the reason, once;
 * - where the run REQUIRES it (`LIBREDB_REQUIRE_HELM=1`, which every CI job that runs the suite
 *   sets), a missing requirement stops the whole run before anything starts.
 *
 * The chart tests are why this exists. They drive the real `helm` binary against a PostgreSQL
 * subchart that has to be downloaded, and a contributor who never touches the chart should not
 * have to install either to see `bun run test` go green. The decision is made per FILE rather
 * than per test because every one of those files needs Helm for everything it does: skipping
 * inside them would list about 180 test names on a machine without Helm, where one line per file
 * says the same thing. CI keeps them mandatory, so nothing is quietly left out of the gate.
 *
 * `tests/unit/test-runner-requirements.test.ts` holds the marker true of the whole tree in both
 * directions: a file that runs helm declares it, and a file that declares it runs helm.
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export type Capability = "helm";

const KNOWN: readonly Capability[] = ["helm"];

/** The marker, alone on its line. Anywhere else (quoted, indented) it is not a declaration. */
const MARKER = /^\/\/ @requires ([a-z][a-z-]*)[ \t]*$/gm;

export type NotRunFile = { file: string; reason: string };

export function parseRequirements(source: string, file: string): Capability[] {
  const found: Capability[] = [];
  for (const match of source.matchAll(MARKER)) {
    const name = match[1] as string;
    if (!(KNOWN as readonly string[]).includes(name)) {
      throw new Error(`${file} declares "@requires ${name}", and the runner knows only: ${KNOWN.join(", ")}.`);
    }
    if (!found.includes(name as Capability)) found.push(name as Capability);
  }
  return found;
}

export type HelmProbe = {
  which: (name: string) => string | null;
  subchartBuilt: () => boolean;
};

/**
 * Why Helm is not usable here, or null when it is.
 *
 * Usable means two things, because every `helm template` of this chart needs both: the binary,
 * and the chart's PostgreSQL dependency built into `charts/libredb-studio/charts/`, which is
 * gitignored and so absent from every fresh clone. Without it Helm refuses every render with
 * "missing in charts/ directory: postgresql", whatever the render asks for.
 */
export function missingHelm(probe: HelmProbe): string | null {
  if (probe.which("helm") === null) {
    return "Helm is not installed. The chart tests drive the real helm binary; install Helm 4.1.3 to run them (CONTRIBUTING.md, Prerequisites).";
  }
  if (!probe.subchartBuilt()) {
    return "The chart's postgresql dependency is not built, and every chart render needs it. Run: helm repo add bitnami https://charts.bitnami.com/bitnami, then helm dependency build charts/libredb-studio --skip-refresh";
  }
  return null;
}

export function systemHelmProbe(root: string): HelmProbe {
  return {
    which: (name) => Bun.which(name),
    subchartBuilt: () => {
      const vendored = path.join(root, "charts/libredb-studio/charts");
      return (
        existsSync(vendored) &&
        readdirSync(vendored).some((entry) => entry.startsWith("postgresql-") && entry.endsWith(".tgz"))
      );
    },
  };
}

/** The capabilities this run may not do without, from the environment. */
export function requiredCapabilities(env: Record<string, string | undefined>): Set<Capability> {
  const value = env.LIBREDB_REQUIRE_HELM;
  if (value === undefined || value === "" || value === "0") return new Set();
  if (value === "1") return new Set(["helm"]);
  throw new Error(
    `LIBREDB_REQUIRE_HELM must be 1 or 0, got "${value}": a typo must not quietly make the chart tests optional.`,
  );
}

/**
 * Splits the selection into the files that run and the files that cannot run here.
 *
 * Each capability is asked about once, however many files need it. A selection in which nothing
 * can run is an error rather than an empty green run, which is the one outcome a test runner must
 * never produce.
 */
export function planRequirements({
  files,
  readSource,
  missing,
  required,
}: {
  files: string[];
  readSource: (file: string) => string;
  missing: Record<Capability, () => string | null>;
  required: ReadonlySet<Capability>;
}): { run: string[]; notRun: NotRunFile[] } {
  const answers = new Map<Capability, string | null>();
  const ask = (capability: Capability): string | null => {
    if (!answers.has(capability)) answers.set(capability, missing[capability]());
    return answers.get(capability) ?? null;
  };

  const run: string[] = [];
  const notRun: NotRunFile[] = [];
  for (const file of files) {
    const blocking = parseRequirements(readSource(file), file)
      .map((capability) => ({ capability, reason: ask(capability) }))
      .find((entry): entry is { capability: Capability; reason: string } => entry.reason !== null);

    if (blocking === undefined) {
      run.push(file);
      continue;
    }
    if (required.has(blocking.capability)) {
      throw new Error(
        `${file} needs ${blocking.capability}, and LIBREDB_REQUIRE_HELM=1 says this run must include it: ${blocking.reason}`,
      );
    }
    notRun.push({ file, reason: blocking.reason });
  }

  if (run.length === 0 && notRun.length > 0) {
    throw new Error(
      `None of the ${notRun.length} selected ${notRun.length === 1 ? "file" : "files"} can run here: ${(notRun[0] as NotRunFile).reason}`,
    );
  }
  return { run, notRun };
}
