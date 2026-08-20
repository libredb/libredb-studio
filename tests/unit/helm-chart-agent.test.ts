/**
 * The chart's `agent` block (#331 T8).
 *
 * T5 made agent availability DERIVED — a configured model plus a writable ledger —
 * and left `LIBREDB_AGENT_ENABLED` as the explicit off-switch whose default is
 * *auto*. The chart is the last place that still stated the pre-T5 default, and a
 * chart that hard-codes a value would undo the derivation for every Kubernetes
 * install. So the rules under test are:
 *
 *  1. **A default render writes no `LIBREDB_AGENT_ENABLED`, and DOES write the
 *     ledger directory.** The second half is not a duplicated default for its own
 *     sake, it is the release topology: `image.tag` defaults to `.Chart.AppVersion`,
 *     and the Dockerfile's `WORKFLOW_LOCAL_DATA_DIR` landed after that app version
 *     was tagged. So the image a default install actually pulls has no such ENV, its
 *     ledger resolves to `.workflow-data` under `WORKDIR /app`, and
 *     `readOnlyRootFilesystem: true` makes that unwritable — the probe answers
 *     `LEDGER_UNAVAILABLE` on a chart that advertises a working agent. The chart
 *     reaches users before the image does, so the chart sets it. Both copies name the
 *     same path and a test below holds them to it.
 *  2. **The off-switch is a values field, not an `extraEnv` recipe.** `agent.enabled:
 *     false` writes the variable as a STRING, which is what removes the `--set-string`
 *     trap the README used to have to explain (`EnvVar.value` is a string, and a bare
 *     `--set …=true` renders an unquoted YAML `true` the API server rejects).
 *  3. **Multi-replica with a possible agent fails to render.** The zero-config ledger
 *     takes file locks and each pod gets its own `emptyDir`, so a run started on one
 *     pod is invisible to the next request. The only backend that lifts it
 *     (`@workflow/world-postgres`) is not loadable in the published image at all
 *     (docs/BACKLOG.md B16), so the message has to say that rather than sell an
 *     opt-in that does not exist yet.
 *
 * Exercises real `helm template` output — no reimplementation of the templates.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const ROOT = join(import.meta.dir, "../..");
const CHART_DIR = join(ROOT, "charts/libredb-studio");
const read = (relative: string): string => readFileSync(join(ROOT, relative), "utf8");

// Long enough for values.schema.json's 32-char minimum: every multi-replica case
// below would otherwise stop at the zero-config JWT guard, which fires first and
// would make these tests pass for the wrong reason.
//
// Words rather than hex, deliberately. The first version of this line was a run of
// hex digits, which the secret scanner read as a generic API key on entropy alone
// and failed the build — correctly, because a scanner cannot tell a fixture from a
// credential by looking at it. A value that says what it is costs nothing here and
// keeps the scanner's judgement sharp; do not "tidy" it back into random-looking
// characters.
const JWT = ["--set", "secrets.jwtSecret=not-a-secret-helm-template-fixture-value"];

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

function helmTemplate(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", "release-under-test", CHART_DIR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

/** The container's env list from a render that must succeed. */
function containerEnv(args: string[] = []): EnvVar[] {
  const run = helmTemplate(args);
  if (run.exitCode !== 0) {
    throw new Error(`helm template failed (exit ${run.exitCode}): ${run.stderr}`);
  }
  const docs = parseAllDocuments(run.stdout).map((doc) => doc.toJSON() as { kind?: string; spec?: never });
  const deployment = docs.find((doc) => doc?.kind === "Deployment") as
    | { spec: { template: { spec: { containers: Array<{ env?: EnvVar[] }> } } } }
    | undefined;
  if (!deployment) throw new Error("no Deployment manifest found in rendered chart output");
  return deployment.spec.template.spec.containers[0].env ?? [];
}

const named = (env: EnvVar[], name: string): EnvVar | undefined => env.find((entry) => entry.name === name);

/** The one directory the chart, the image, compose and the docs all have to name. */
const LEDGER_PATH = "/app/data/workflow";

describe("a default render leaves the runtime's own answer alone", () => {
  test("no LIBREDB_AGENT_ENABLED is written, so availability stays derived", () => {
    expect(named(containerEnv(), "LIBREDB_AGENT_ENABLED")).toBeUndefined();
  });

  test("the ledger directory IS written, inside the volume mounted on /app/data", () => {
    // The regression this exists for: without it the agent resolves `.workflow-data`
    // under WORKDIR /app, which readOnlyRootFilesystem makes unwritable, and every
    // run refuses with LEDGER_UNAVAILABLE on a default install.
    expect(named(containerEnv(), "WORKFLOW_LOCAL_DATA_DIR")?.value).toBe(LEDGER_PATH);
    expect(LEDGER_PATH.startsWith("/app/data/")).toBe(true);
  });

  test("the chart's copy of the ledger path is the Dockerfile's, character for character", () => {
    // Two writers of one default only stay harmless while they agree. The chart must
    // set it because the released image predates the ENV; when that image ships, the
    // two must still name the same directory or a pod's ledger moves on upgrade.
    const runner = read("Dockerfile").split(/^FROM .* AS runner$/m)[1] ?? "";
    expect(runner).toContain(`ENV WORKFLOW_LOCAL_DATA_DIR=${LEDGER_PATH}`);
    expect(named(containerEnv(), "WORKFLOW_LOCAL_DATA_DIR")?.value).toBe(LEDGER_PATH);
  });

  test("no WORKFLOW_TARGET_WORLD is written: the backend selection stays the operator's", () => {
    const targets = containerEnv().filter((entry) => entry.name === "WORKFLOW_TARGET_WORLD");
    expect(targets).toEqual([]);
  });

  test("the ledger path is written before extraEnv, so an operator can move it", () => {
    const env = containerEnv([
      "--set",
      "extraEnv[0].name=WORKFLOW_LOCAL_DATA_DIR",
      "--set",
      "extraEnv[0].value=/app/data/elsewhere",
    ]);
    const positions = env.flatMap((entry, index) => (entry.name === "WORKFLOW_LOCAL_DATA_DIR" ? [index] : []));
    expect(positions.length).toBe(2);
    expect(env[positions[0]].value).toBe(LEDGER_PATH);
    expect(env[positions[1]].value).toBe("/app/data/elsewhere");
  });

  test("the default install still renders (the agent guard cannot fire at one replica)", () => {
    expect(helmTemplate([]).exitCode).toBe(0);
  });
});

describe("agent.enabled is the explicit off-switch", () => {
  test("false writes LIBREDB_AGENT_ENABLED as the string the API server accepts", () => {
    const flag = named(containerEnv(["--set", "agent.enabled=false"]), "LIBREDB_AGENT_ENABLED");
    // Not `false` the boolean: EnvVar.value is a string, and the chart quoting it
    // is what makes `--set-string` unnecessary for an operator.
    expect(flag?.value).toBe("false");
    expect(typeof flag?.value).toBe("string");
  });

  test("true is accepted and explicit, and is also written as a string", () => {
    const flag = named(containerEnv(["--set", "agent.enabled=true"]), "LIBREDB_AGENT_ENABLED");
    expect(flag?.value).toBe("true");
  });

  test("the flag is written before extraEnv, so an extraEnv entry still overrides it", () => {
    const env = containerEnv([
      "--set",
      "agent.enabled=false",
      "--set",
      "extraEnv[0].name=LIBREDB_AGENT_ENABLED",
      "--set-string",
      "extraEnv[0].value=true",
    ]);
    const positions = env.flatMap((entry, index) => (entry.name === "LIBREDB_AGENT_ENABLED" ? [index] : []));
    expect(positions.length).toBe(2);
    expect(env[positions[0]].value).toBe("false");
    expect(env[positions[1]].value).toBe("true");
  });
});

describe("multi-replica with an agent that could run fails to render", () => {
  const MODEL = ["--set", "secrets.llmApiKey=sk-test-key", "--set", "config.llmProvider=openai"];

  test("a configured model plus replicaCount 2 is refused", () => {
    const run = helmTemplate([...MODEL, "--set", "replicaCount=2", ...JWT]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("WORKFLOW_TARGET_WORLD=@workflow/world-postgres");
  });

  test("the message says what to do, in this chart's own values", () => {
    const run = helmTemplate([...MODEL, "--set", "replicaCount=2", ...JWT]);
    expect(run.stderr).toContain("replicaCount=1");
    expect(run.stderr).toContain("agent.enabled=false");
  });

  test("the message says the postgres world is not loadable in the published image (B16)", () => {
    // The honest half: this is not merely unconfigured, it is unsupported today.
    // A message that only said "set WORKFLOW_TARGET_WORLD" would send an operator
    // to a variable that changes nothing in the image they are running.
    const run = helmTemplate([...MODEL, "--set", "replicaCount=2", ...JWT]);
    expect(run.stderr).toMatch(/B16/);
    expect(run.stderr).toMatch(/image/i);
  });

  test("ollama needs no key, so it counts as a configured model too", () => {
    const run = helmTemplate(["--set", "config.llmProvider=ollama", "--set", "replicaCount=2", ...JWT]);
    expect(run.exitCode).not.toBe(0);
  });

  /**
   * The two key-optional providers, taken from the app rather than from memory:
   * `validateConfig` (src/lib/llm/utils/config.ts) demands an API key for `gemini`
   * and `openai` only. `ollama` needs neither key nor URL, and `custom` needs
   * LLM_API_URL — which can arrive from a Secret or extraEnv the chart cannot read,
   * so an inline key is the wrong thing to require of it. Both must count, or a
   * multi-replica install of either renders happily and then derives an available
   * agent on every pod, which is the exact state this guard exists to prevent.
   */
  test.each(["ollama", "custom"])("%s configures a model with no inline key, and is refused at 2 replicas", (p) => {
    const run = helmTemplate(["--set", `config.llmProvider=${p}`, "--set", "replicaCount=2", ...JWT]);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("agent.enabled=false");
  });

  test("the key-optional set is exactly the schema enum minus the key-requiring providers", () => {
    // A provider added to values.schema.json without being classified here would
    // reopen the hole silently, so the enum itself is the fixture.
    const schema = JSON.parse(read("charts/libredb-studio/values.schema.json"));
    const enumerated: string[] = schema.properties.config.properties.llmProvider.enum;
    expect(enumerated.filter((value) => value !== "").sort()).toEqual(["custom", "gemini", "ollama", "openai"]);
    // gemini/openai carry no inline key here, so they must NOT fire the guard.
    for (const provider of ["gemini", "openai"]) {
      const run = helmTemplate(["--set", `config.llmProvider=${provider}`, "--set", "replicaCount=2", ...JWT]);
      expect(run.exitCode).toBe(0);
    }
  });

  test("agent.enabled=true is refused above one replica even with no model in values", () => {
    const run = helmTemplate(["--set", "agent.enabled=true", "--set", "replicaCount=3", ...JWT]);
    expect(run.exitCode).not.toBe(0);
  });

  test("an HPA that can reach two pods is the same hazard", () => {
    const run = helmTemplate([...MODEL, "--set", "autoscaling.enabled=true", ...JWT]);
    expect(run.exitCode).not.toBe(0);
  });
});

describe("the guard refuses only what is actually broken", () => {
  const MODEL = ["--set", "secrets.llmApiKey=sk-test-key", "--set", "config.llmProvider=openai"];

  test("multi-replica with no model in values renders: no model, no agent, no hazard", () => {
    // The regression this prevents: every existing HA install of Studio, none of
    // which configured AI, must keep rendering after this chart version.
    expect(helmTemplate(["--set", "replicaCount=3", ...JWT]).exitCode).toBe(0);
  });

  test("multi-replica with the agent switched off renders", () => {
    expect(helmTemplate([...MODEL, "--set", "replicaCount=3", "--set", "agent.enabled=false", ...JWT]).exitCode).toBe(
      0,
    );
  });

  test("the postgres world supplied through extraEnv lifts the guard", () => {
    // Accepted because image.repository/tag are overridable: an operator on an
    // image that carries the world is not blocked by our own image's gap.
    const run = helmTemplate([
      ...MODEL,
      "--set",
      "replicaCount=3",
      "--set",
      "extraEnv[0].name=WORKFLOW_TARGET_WORLD",
      "--set",
      "extraEnv[0].value=@workflow/world-postgres",
      ...JWT,
    ]);
    expect(run.exitCode).toBe(0);
  });

  test("a different WORKFLOW_TARGET_WORLD value does not lift it", () => {
    const run = helmTemplate([
      ...MODEL,
      "--set",
      "replicaCount=3",
      "--set",
      "extraEnv[0].name=WORKFLOW_TARGET_WORLD",
      "--set",
      "extraEnv[0].value=local",
      ...JWT,
    ]);
    expect(run.exitCode).not.toBe(0);
  });

  test("an HPA ignored by SQLite storage does not fire the guard", () => {
    // autoscalingEnabled is already false there (single-writer), so the deployment
    // stays at replicaCount: refusing that render would be a false failure.
    const run = helmTemplate([
      ...MODEL,
      "--set",
      "config.storageProvider=sqlite",
      "--set",
      "autoscaling.enabled=true",
      ...JWT,
    ]);
    expect(run.exitCode).toBe(0);
  });
});

/**
 * A stated blind spot is a promise about the unstated rest. The list named two of
 * the three ways an LLM configuration reaches the pod unseen, and naming
 * `extraEnvFrom` while omitting `extraEnv` reads as "extraEnv is inspected" — so a
 * reader stops checking exactly where the hole is. These tests pin the truth of each
 * hole by rendering, and pin the documentation to the same set.
 */
describe("the guard's blind spots are real, and completely listed", () => {
  const holes = [
    { name: "extraEnv", args: ["--set", "extraEnv[0].name=LLM_API_KEY", "--set", "extraEnv[0].value=sk-test-key"] },
    { name: "extraEnvFrom", args: ["--set", "extraEnvFrom[0].secretRef.name=llm-secret"] },
    { name: "secrets.existingSecret", args: ["--set", "secrets.existingSecret=llm-secret"] },
  ];

  test.each(holes)("$name carries a model past the guard at 2 replicas", ({ args }) => {
    // Not an aspiration: this is what the chart does today, and the reason each one
    // has to be written down where an operator will read it.
    expect(helmTemplate([...args, "--set", "replicaCount=2", ...JWT]).exitCode).toBe(0);
  });

  test.each(["charts/libredb-studio/README.md", "charts/libredb-studio/templates/_helpers.tpl"])(
    "%s names every one of them",
    (file) => {
      const text = read(file);
      for (const { name } of holes) expect(text).toContain(name);
    },
  );
});

describe("an operator is told where run history lives", () => {
  test("the install notes carry it, guarded on persistence being off", () => {
    // Asserted against the template source rather than rendered output on purpose:
    // `helm template` prints no NOTES.txt at all, and the dry-run path that would
    // render it behaves differently across Helm majors - which contributors run
    // freely, and helm-release's ct install job still pins to Helm 3.16. An
    // assertion on stdout would pass on one machine and fail on the other. What
    // must not silently disappear is the note and its condition.
    const notes = read("charts/libredb-studio/templates/NOTES.txt");
    const block = notes.split(/^{{- if and \(include "libredb-studio\.agentPossible"/m)[1] ?? "";
    expect(block).toContain("persistenceEnabled");
    expect(block).toMatch(/emptyDir/);
    expect(block).toContain("persistence.enabled=true");
  });

  test("values.yaml states it where the field is configured", () => {
    // The whole section an operator reads before editing the field: its header
    // comment plus the field itself, bounded by the next section banner.
    const values = read("charts/libredb-studio/values.yaml");
    const section = values.split(/^# Agent Runtime$/m)[1]?.split(/^# Persistence/m)[0] ?? "";
    expect(section).toContain("agent:");
    expect(section).toContain("persistence.enabled");
    expect(section).toMatch(/emptyDir/);
  });

  test("the chart README states it in the agent section", () => {
    const section =
      read("charts/libredb-studio/README.md")
        .split(/^## Agent Runtime/m)[1]
        ?.split(/^## /m)[0] ?? "";
    expect(section).toMatch(/emptyDir/);
    expect(section).toContain("persistence.enabled=true");
  });
});

describe("the chart no longer states the pre-T5 default", () => {
  /**
   * #353 derived availability and left three packaged files saying the agent is
   * off unless the flag is set. That claim is now false: a Studio with a model
   * configured and a writable ledger runs agents with no flag at all. These are
   * drift guards on the correction, not on prose style — each pattern is the exact
   * wording that used to be there.
   */
  const FILES = [
    "charts/libredb-studio/README.md",
    "charts/libredb-studio/values.yaml",
    "charts/libredb-studio/Chart.yaml",
  ];

  test.each(FILES)("%s does not say the agent is off by default", (file) => {
    expect(read(file)).not.toMatch(/off by default/i);
  });

  test.each(FILES)("%s does not say the agent is off unless the flag is set", (file) => {
    expect(read(file)).not.toMatch(/off unless/i);
  });

  test("the README says what IS required now: an AI configuration, not the flag", () => {
    const section =
      read("charts/libredb-studio/README.md")
        .split(/^## Agent Runtime/m)[1]
        ?.split(/^## /m)[0] ?? "";
    expect(section).toMatch(/derive/i);
    expect(section).toContain("agent.enabled=false");
  });

  test("docs/AGENT.md no longer sends the reader after a correction that has landed", () => {
    // #353's blockquote said "this PR deliberately did not change it" and promised a
    // follow-up. This is that follow-up: a reader who finds the promise still there
    // goes looking for a chart that no longer says the old thing.
    expect(read("docs/AGENT.md")).not.toMatch(/it still states the pre-T5\s+default/);
  });
});
