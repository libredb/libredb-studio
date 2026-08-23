/**
 * The ten supported models, driven through the APPLICATION rather than through its API.
 *
 * Every figure in `docs/llms/` came from runs opened over HTTP: real runs against a real database
 * with a real model, but never once through the rail a user actually clicks. That gap is the
 * whole reason this file exists — "the agent works with this model" and "a person can get an
 * answer out of this model in the product" are two claims, and only one of them was measured.
 *
 * So this logs in, picks the embedded sample connection, types an objective into the rail,
 * presses Start, and waits for the run to finish on screen. What it asserts is what the user
 * sees: the run reaches a terminal state and the rail shows the answer rather than a failure.
 *
 * It tests whichever model the SERVER is configured with — the model is an environment variable
 * and there is no picker in the product — so the loop over the ten lives in
 * `scripts/agent-model-e2e.sh`, which sets the model, restarts, and runs this file once per model.
 */
import { expect, test, type Page } from "@playwright/test";

/** Long by design: a plan turn on the slowest of the ten took 195 seconds when measured. */
const RUN_TIMEOUT_MS = 300_000;

/*
  Opt-in, and CI is the reason.

  This file drives real models through the real rail: it needs a local Ollama with the weights
  pulled, and the model under test is whichever one the server was started with. CI has neither,
  so every test here fails there for reasons that say nothing about the product — which is
  exactly what happened on the first push, and it turned a green E2E job red.

  `scripts/agent-model-e2e.sh` sets this when it is actually driving a sweep. Nothing else does.
*/
const ENABLED = process.env.AGENT_MODEL_E2E === "1";

const EMAIL = process.env.E2E_EMAIL ?? "user@libredb.org";
const PASSWORD = process.env.E2E_PASSWORD ?? "";

/** The surfaces, and the question each was measured with, so the UI run matches the API one. */
const SURFACES = [
  { workflow: "investigation", objective: "What tables are in this database and how do they relate to each other?" },
  { workflow: "query-optimization", objective: "Why is the employee listing query slow?" },
  { workflow: "database-assessment", objective: "Where is this database's data incomplete or surprising?" },
  { workflow: "operations", objective: "What is currently happening on this database?" },
  { workflow: "data-analysis", objective: "Which part of the company costs us the most in salary?" },
] as const;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  // `.first()`: the page carries more than one field of this type, and a bare type selector is a
  // strict-mode violation rather than a choice between them.
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/**
 * Opens the embedded SQLite sample, which seeds asynchronously after boot — hence the wait
 * rather than an immediate click.
 */
async function openSample(page: Page): Promise<void> {
  const sample = page.locator("text=Sample (Employees)").first();
  await expect(sample).toBeVisible({ timeout: 60_000 });
  await sample.click();
}

async function openRail(page: Page): Promise<void> {
  const rail = page.getByTestId("agent-objective");
  if (await rail.isVisible().catch(() => false)) return;
  const opener = page.getByRole("button", { name: /agent/i }).first();
  await opener.click();
  await expect(page.getByTestId("agent-objective")).toBeVisible({ timeout: 30_000 });
}

/** Runs one objective on one surface and returns what the rail ended up saying. */
async function runOnce(page: Page, mode: "agent" | "planning", workflow: string, objective: string): Promise<string> {
  await page.getByTestId(`agent-mode-${mode}`).click();
  await page.getByTestId("agent-objective").fill(objective);

  // The workflow axis is Automatic by default and lives under Advanced; naming it explicitly is
  // what keeps this test measuring the surface it says it measures rather than the classifier.
  const advanced = page.getByTestId("agent-advanced-toggle");
  if (await advanced.isVisible().catch(() => false)) {
    await advanced.click();
    const choice = page.getByTestId(`agent-workflow-${workflow}`);
    if (await choice.isVisible().catch(() => false)) await choice.click();
  }

  await page.getByTestId("agent-start").click();

  /*
    One surface asks before it opens, and the sweep found it by failing on every model.

    `data-analysis` runs a statement the model wrote and presents the result as the answer, so
    the rail asks the user to agree to that FIRST — consent is taken before the run exists,
    because every widening decision has to be made by the request that opens the run and none
    may widen it later. Start therefore holds, a consent card appears, and nothing happens until
    it is answered.

    The API measurements passed this as a parameter and never saw the card. Here it is clicked,
    which is the difference between testing the product and testing the endpoint.
  */
  const consent = page.getByTestId("agent-consent-open");
  if (await consent.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await page
      .getByTestId("agent-auto-execute")
      .check()
      .catch(() => undefined);
    await consent.click();
  }

  /*
    A run has to be seen STARTING before it can be seen finishing, and the first version of this
    skipped that: it waited for the Stop control to be hidden, which is also true a millisecond
    after the click and before anything has happened. Every test passed in seven seconds against
    a model whose runs take a minute, which is a vacuous pass rather than a fast one.

    Stop is rendered only while a run is live, so waiting for it to APPEAR is the proof the run
    opened, and only then does waiting for it to go mean the run ended.
  */
  const stop = page.getByTestId("agent-stop");
  await expect(stop).toBeVisible({ timeout: 60_000 });
  const runId = ((await page.getByTestId("agent-run-id").textContent()) ?? "").trim();
  expect(runId).toMatch(/^arun_/);
  await expect(stop).toBeHidden({ timeout: RUN_TIMEOUT_MS });
  return runId;
}

/**
 * The verdict this run earned, read from the product's own record of it.
 *
 * "The rail did not say failed" is a weaker claim than the one every measured figure rests on: a
 * run that reads the database and never files a report finishes perfectly happily and answers
 * nothing. The bar for all 300 runs behind `docs/llms/` is `goalVerdict.outcome === "answered"`,
 * and this asks the same question of a run opened through the interface — same rule, same
 * verifier, so the two sets of numbers mean the same thing.
 */
async function verdictOf(page: Page, runId: string): Promise<{ outcome: string; unmet: string[] }> {
  const response = await page.request.get(`/api/agent/runs/${runId}`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    record?: { events?: { kind: string; goalVerdict?: { outcome?: string; unmet?: string[] } }[] };
  };
  const finished = (body.record?.events ?? []).find((event) => event.kind === "run-finished");
  return { outcome: finished?.goalVerdict?.outcome ?? "none", unmet: finished?.goalVerdict?.unmet ?? [] };
}

test.describe("the agent, driven through the rail a user clicks", () => {
  // Skipped rather than absent: the file documents how the sweep is driven, and a reader looking
  // for it should find it here rather than in a script's shell history.
  test.skip(!ENABLED, "set AGENT_MODEL_E2E=1 with a local model server to drive this");

  /*
    Sequential, but not abandoned at the first loss.

    `serial` skips every remaining test once one fails, which cost three models their last three
    surfaces in the first watched sweep: what came back was "1 failed, 3 did not run" for a model
    whose remaining cells were the question being asked. These runs cannot go in parallel — one
    server, one configured model — so the ordering comes from `--workers=1` instead.
  */
  test.describe.configure({ timeout: RUN_TIMEOUT_MS + 120_000 });

  test.beforeEach(async ({ page }) => {
    await login(page);
    await openSample(page);
    await openRail(page);
  });

  for (const { workflow, objective } of SURFACES) {
    test(`agent mode answers on ${workflow}`, async ({ page }) => {
      const runId = await runOnce(page, "agent", workflow, objective);
      const verdict = await verdictOf(page, runId);
      // Named in the failure so a red run says WHICH bar it missed rather than just that it did.
      expect(verdict.outcome, `unmet: ${verdict.unmet.join(", ") || "-"}`).toBe("answered");
    });
  }

  test("plan mode answers, with a statement or with a refusal", async ({ page }) => {
    const runId = await runOnce(page, "planning", "investigation", SURFACES[0].objective);
    const verdict = await verdictOf(page, runId);
    expect(verdict.outcome, `unmet: ${verdict.unmet.join(", ") || "-"}`).toBe("answered");

    /*
      Plan mode has TWO answers, and asserting only one of them failed three models whose runs
      the product had accepted. Its bar is a runnable statement OR an explicit refusal — a run
      that says it cannot answer from this inventory has answered honestly, and the rail renders
      a refusal card rather than a statement card for it.
    */
    await expect(page.getByTestId("agent-plan-statement").or(page.getByTestId("agent-plan-refusal"))).toBeVisible({
      timeout: 30_000,
    });
  });
});
