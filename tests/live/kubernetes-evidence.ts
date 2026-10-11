/**
 * The Kubernetes evidence harness: it runs the scenarios of tests/live/kubernetes-evidence-plan.ts for one fixture set
 * against the throwaway k3d cluster of docker/kubernetes/ that set names, through the real provider, and writes each
 * persona's exchanges as tests/fixtures/kubernetes/<set>/<persona>.json, plus a manifest.json naming the Studio
 * commit, the harness files that differ from it, the image, the server version, the date and each scenario's counts.
 *
 * The requests are the provider's own, recorded at its transport seam around the shared node transport, so a replay
 * of a capture answers exactly the requests the same provider sends: the integration test and the end-to-end stub
 * server both match on the request line. The connections come from the persona kubeconfigs that
 * docker/kubernetes/seed.sh wrote, read through the browser importer, so the import is exercised on real k3d files
 * too. Every exchange goes through tests/helpers/kubernetes-evidence-scrub.ts, and nothing at all is written while any
 * file still holds a token, a certificate, a key, a JWT or an address; a step whose answer does not show what the plan
 * expects stops the run, and nothing is written either.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the cluster seeded:
 *   bun tests/live/kubernetes-evidence.ts --set v1.35.5 --env <K8S_ENV_DIR>
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ImportedContext } from "@/lib/connection-import";
import { probePastPage } from "@/lib/api/page-probe";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import type { DatabaseConnection } from "@/lib/types";
import { importKubeconfig } from "@/lib/kubernetes/kubeconfig-import";
import {
  type KubernetesExchange,
  KubernetesEvidenceLeakError,
  KubernetesEvidenceScrubber,
  redactForTerminal,
} from "../helpers/kubernetes-evidence-scrub";
import { KUBERNETES_PLANTED_NAMESPACES } from "../helpers/kubernetes-markers";
import { recordingTransport } from "../helpers/kubernetes-replay";
import {
  EVIDENCE_TARGETS,
  type EvidenceScenario,
  type EvidenceSet,
  type EvidenceStep,
  gridShows,
} from "./kubernetes-evidence-plan";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/kubernetes");
const QUERY_TIMEOUT_MS = 30_000;

/** What a capture depends on besides the cluster. */
const HARNESS_PATHS = [
  "docker/kubernetes/",
  "tests/helpers/kubernetes-evidence-scrub.ts",
  "tests/helpers/kubernetes-replay.ts",
  "tests/helpers/kubernetes-markers.ts",
  "tests/live/kubernetes-evidence-plan.ts",
  "tests/live/kubernetes-evidence.ts",
];

/** Whether `dir` is `root` or below it, by `paths`' rules: its separator, and on Windows its drive and case. */
export function insideDirectory(root: string, dir: string, paths: typeof path.posix = path): boolean {
  const relative = paths.relative(paths.resolve(root), paths.resolve(dir));
  return (
    relative === "" || (relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative))
  );
}

/** The command line: `--set <set> --env <dir>`, or the sentence it is refused with. */
export function runArguments(argv: readonly string[]): { readonly set: EvidenceSet; readonly envDir: string } {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const set = value("--set");
  const envDir = value("--env");
  if (set === undefined || !Object.hasOwn(EVIDENCE_TARGETS, set)) {
    throw new Error(`--set takes one of ${Object.keys(EVIDENCE_TARGETS).join(", ")}`);
  }
  if (envDir === undefined || !path.isAbsolute(envDir)) {
    throw new Error("--env takes the absolute K8S_ENV_DIR that docker/kubernetes/seed.sh wrote");
  }
  if (insideDirectory(ROOT, envDir)) {
    throw new Error("--env must be outside the repository: it holds tokens and a client key");
  }
  return { set: set as EvidenceSet, envDir };
}

/** The connection a persona kubeconfig describes, read through the browser importer. */
export function connectionOf(context: ImportedContext, persona: string): DatabaseConnection {
  const { host, port, password, database, apiPath, tlsServerName } = context.fields;
  if (host === undefined || port === undefined) throw new Error(`the ${persona} kubeconfig names no server`);
  return {
    id: `kubernetes-evidence-${persona}`,
    name: `kubernetes evidence ${persona}`,
    type: "kubernetes",
    host,
    port: Number(port),
    ...(password === undefined ? {} : { password }),
    ...(database === undefined ? {} : { database }),
    ...(apiPath === undefined ? {} : { apiPath }),
    ...(tlsServerName === undefined ? {} : { tlsServerName }),
    ...(context.ssl?.mode === undefined ? {} : { ssl: { ...context.ssl, mode: context.ssl.mode } }),
    createdAt: new Date(0),
  };
}

function studioCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function uncommitted(): string[] {
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...HARNESS_PATHS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return status
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3))
    .sort();
}

/**
 * One statement as `POST /api/db/query` runs it from the editor: prepared with the grid's default page, then run with
 * the route's probe row (`probePastPage`), so a replay answers exactly the requests the browser's run sends.
 */
export async function runAsTheQueryRoute(provider: KubernetesProvider, text: string) {
  const options = { limit: DEFAULT_QUERY_LIMIT, offset: 0, unlimited: false };
  const prepared = provider.prepareQuery(text, options);
  return provider.query(probePastPage(provider, text, options, prepared).query);
}

/** One step against the provider; a step whose answer is not what the plan expects throws a sentence naming it. */
async function runStep(provider: KubernetesProvider, step: EvidenceStep): Promise<void> {
  const fail = (what: string) => {
    throw new Error(`step ${JSON.stringify(step)}: ${what}`);
  };
  switch (step.op) {
    case "connect": {
      await provider.connect();
      const warnings = provider
        .connectWarnings()
        .map((warning) => warning.message)
        .join("\n");
      for (const words of step.warns ?? []) if (!warnings.includes(words)) fail(`no warning holds "${words}"`);
      return;
    }
    case "containers": {
      const containers = (await provider.listContainers()).map((container) => container.path.join("/"));
      if (JSON.stringify(containers.slice(0, step.first.length)) !== JSON.stringify(step.first)) {
        fail(`the containers start ${JSON.stringify(containers.slice(0, step.first.length))}`);
      }
      return;
    }
    case "count": {
      const counts = await provider.countObjects([step.container]);
      for (const kind of step.unavailable ?? []) {
        if (!("unavailable" in (counts[kind] ?? {}))) fail(`${kind} is not unavailable`);
      }
      return;
    }
    case "list": {
      let objects: Awaited<ReturnType<KubernetesProvider["listObjects"]>>;
      try {
        objects = await provider.listObjects([step.container], step.kind);
      } catch (error) {
        if (step.refused === true) return;
        throw error;
      }
      if (step.refused === true) fail("it was not refused");
      if (step.holds !== undefined && !objects.some((object) => object.path.at(-1) === step.holds)) {
        fail(`the listing holds no ${step.holds}`);
      }
      return;
    }
    case "source": {
      try {
        await provider.readObjectSource([step.container, step.name], step.kind);
      } catch (error) {
        if (step.refused === true) return;
        throw error;
      }
      if (step.refused === true) fail("it was not refused");
      return;
    }
    case "walk": {
      const sourceKinds = new Set(
        (provider.getCapabilities().objectKinds ?? []).filter((kind) => kind.hasSource === true).map((kind) => kind.id),
      );
      const counts = await provider.countObjects([step.container]);
      for (const kind of Object.keys(counts)) {
        if ("unavailable" in counts[kind]) fail(`${kind} is unavailable`);
        const objects = await provider.listObjects([step.container], kind);
        await provider.describeObjects([step.container], kind);
        const first = objects[0];
        if (first === undefined) continue;
        await provider.describeObject(first.path, kind);
        if (sourceKinds.has(kind)) await provider.readObjectSource(first.path, kind);
      }
      return;
    }
    case "health": {
      await provider.getHealth();
      return;
    }
    case "overview": {
      await provider.getOverview();
      return;
    }
    case "statement": {
      let result: Awaited<ReturnType<typeof runAsTheQueryRoute>>;
      try {
        result = await runAsTheQueryRoute(provider, step.text);
      } catch (error) {
        if (step.refused === true) return;
        throw error;
      }
      if (step.refused === true) fail("it was not refused");
      if (step.shows !== undefined && !gridShows(result.rows, step.shows)) {
        fail(`the grid shows no ${JSON.stringify(step.shows)}`);
      }
      return;
    }
  }
}

/** One persona's scenario: its exchanges, recorded at the transport seam. */
async function runScenario(
  scenario: EvidenceScenario,
  context: ImportedContext,
): Promise<readonly KubernetesExchange[]> {
  const sink: KubernetesExchange[] = [];
  const provider = new KubernetesProvider(
    connectionOf(context, scenario.persona),
    { queryTimeout: QUERY_TIMEOUT_MS },
    { createTransport: recordingTransport(createNodeTransport, sink) },
  );
  try {
    for (const step of scenario.steps) await runStep(provider, step);
  } finally {
    await provider.disconnect();
  }
  return sink;
}

async function main(argv: readonly string[]): Promise<void> {
  const { set, envDir } = runArguments(argv);
  const target = EVIDENCE_TARGETS[set];
  const contexts = new Map<string, ImportedContext>();
  for (const scenario of target.scenarios) {
    const file = path.join(envDir, target.cluster, `${scenario.persona}.yaml`);
    const imported = importKubeconfig(readFileSync(file, "utf8"));
    const context = imported.contexts[0];
    if (context === undefined) throw new Error(`${file}: ${imported.refusals.join(" ")}`);
    contexts.set(scenario.persona, context);
  }
  const secrets = {
    tokens: [...contexts.values()].flatMap((context) =>
      context.fields.password === undefined ? [] : [context.fields.password],
    ),
    pems: [...contexts.values()].flatMap((context) =>
      [context.ssl?.caCert, context.ssl?.clientCert, context.ssl?.clientKey].filter(
        (pem): pem is string => pem !== undefined,
      ),
    ),
    plantedNamespaces: KUBERNETES_PLANTED_NAMESPACES,
  };
  try {
    const scrubber = new KubernetesEvidenceScrubber(secrets);
    const files: Record<string, unknown> = {};
    const scenarios: { persona: string; steps: number; exchanges: number }[] = [];
    let serverVersion: string | undefined;
    for (const scenario of target.scenarios) {
      const context = contexts.get(scenario.persona);
      if (context === undefined) throw new Error(`no kubeconfig for ${scenario.persona}`);
      const exchanges = (await runScenario(scenario, context)).map((exchange) => scrubber.exchange(exchange));
      const version = exchanges.find((exchange) => exchange.request.path === "/version");
      if (version !== undefined)
        serverVersion = (JSON.parse(version.response.text) as { gitVersion?: string }).gitVersion;
      files[`${scenario.persona}.json`] = { persona: scenario.persona, exchanges };
      scenarios.push({ persona: scenario.persona, steps: scenario.steps.length, exchanges: exchanges.length });
    }
    if (serverVersion === undefined || !serverVersion.startsWith(target.gitVersion)) {
      throw new Error(`the server answered ${serverVersion ?? "no version"}, not ${target.gitVersion}`);
    }
    files["manifest.json"] = {
      set,
      cluster: target.cluster,
      image: target.image,
      serverVersion,
      studioCommit: studioCommit(),
      uncommitted: uncommitted(),
      date: new Date().toISOString().slice(0, 10),
      scenarios,
    };
    const rendered = scrubber.render(files);
    const directory = path.join(OUT, set);
    if (existsSync(directory)) {
      const stray = readdirSync(directory).filter((name) => !Object.hasOwn(rendered, name));
      if (stray.length > 0) throw new Error(`${directory} holds files this run does not write: ${stray.join(", ")}`);
    }
    mkdirSync(directory, { recursive: true });
    for (const [name, text] of Object.entries(rendered)) writeFileSync(path.join(directory, name), text);
    console.log(`wrote ${Object.keys(rendered).length} files to ${path.relative(ROOT, directory)}`);
  } catch (error) {
    if (error instanceof KubernetesEvidenceLeakError) {
      console.error(`${error.message}\n${error.findings.join("\n")}`);
    } else {
      console.error(
        redactForTerminal(error instanceof Error ? (error.stack ?? error.message) : String(error), secrets),
      );
    }
    process.exit(1);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
