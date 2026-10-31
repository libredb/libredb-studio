#!/usr/bin/env node
// One isolated basic-e2e lane: one provider, one database container, one Studio server, one Chrome.
// Usage and the contract it implements: .claude/skills/basic-e2e/SKILL.md.
//
//   node lane.mjs --provider postgres --build <prebuilt worktree> --out <evidence dir> --work <scratch dir>
//                 --env-file <file holding LLM_*> [--storage sqlite|local] [--headed] [--keep]
//
// Exit code: 0 when every step passed, 1 when a step failed, 2 when the lane could not be set up.
// Dependency-free beyond Node 24 and the playwright package in the build worktree's node_modules.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AGENT, PROVIDERS } from "./providers.mjs";

const { values: opt } = parseArgs({
  options: {
    provider: { type: "string" },
    build: { type: "string" },
    out: { type: "string" },
    work: { type: "string" },
    "env-file": { type: "string" },
    storage: { type: "string", default: "sqlite" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});
for (const k of ["provider", "build", "out", "work", "env-file"]) {
  if (!opt[k]) throw new Error(`--${k} is required`);
}
const P = PROVIDERS[opt.provider];
if (!P) throw new Error(`unknown provider ${opt.provider}; known: ${Object.keys(PROVIDERS).join(", ")}`);

const BUILD = resolve(opt.build);
const OUT = resolve(opt.out);
const WORK = resolve(opt.work);
const BASE = `http://127.0.0.1:${P.studioPort}`;
const CONTAINER = `basic-e2e-${opt.provider}`;
const UI_NAME = `E2E ${P.engineButton} (UI)`;
const SEED_NAME = `E2E ${P.engineButton} (agent)`;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
// A file the lane writes into its work dir, so a mistyped --work path is never deleted.
const WORK_MARKER = ".basic-e2e-lane";
// Set as soon as each exists, so a signal handler can tear down what was started.
let server;
let ownContainer = false;

// Generated per lane, held in this process only, never written to a file or a log.
const pw = () => `Be2e${randomBytes(9).toString("hex")}!9`;
const SECRETS = {
  root: pw(),
  agent: pw(),
  admin: pw(),
  jwt: randomBytes(32).toString("base64"),
  // Not a secret, but generated, so no root principal is a literal next to its password.
  rootUser: `be2e_${randomBytes(4).toString("hex")}`,
};
// Every value the evidence must never contain: the generated ones, plus the LLM key once read.
const SCAN = [SECRETS.root, SECRETS.agent, SECRETS.admin, SECRETS.jwt];
// Docker and setup-tool errors can quote a credential, so every line is redacted before it is
// printed or stored. Server log lines and browser messages are not: the scan at the end flags those.
const redact = (v) => SCAN.reduce((text, s) => text.split(s).join("***"), String(v));

const log = (...a) => console.log(`[${opt.provider}]`, ...a.map(redact));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- environment ----------

function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function imageFromCompose(service) {
  // The commit under test pins its own images; mongo:8 resolves to a build that fails on Linux 6.19+.
  const lines = readFileSync(join(BUILD, "database-compose.yml"), "utf8").split("\n");
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start < 0) throw new Error(`service ${service} not found in database-compose.yml`);
  for (let i = start + 1; i < lines.length && !/^ {2}\S/.test(lines[i]); i++) {
    const m = lines[i].match(/^ {4}image:\s*(\S+)/);
    if (m) return m[1];
  }
  throw new Error(`service ${service} has no image line`);
}

function portFree(port) {
  return new Promise((done) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      done(false);
    });
    s.once("error", () => done(true));
  });
}

// ---------- docker ----------

function docker(args, { env = {}, input, check = true } = {}) {
  const r = spawnSync("docker", args, { env: { ...process.env, ...env }, input, encoding: "utf8", maxBuffer: 1 << 26 });
  if (check && r.status !== 0) {
    throw new Error(`docker ${args[0]} failed (${r.status}): ${(r.stderr || r.stdout || "").trim().slice(-600)}`);
  }
  return r;
}
// Values travel in the docker client's environment and are named with `-e NAME`, so no secret is on an argv.
const envFlags = (env) => Object.keys(env).flatMap((k) => ["-e", k]);

async function startDatabase() {
  if (!P.composeService) {
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(WORK, "shop.db");
    const db = new DatabaseSync(file);
    db.exec(P.sqliteScript());
    db.close();
    return { image: "none (SQLite file)", file };
  }
  const image = imageFromCompose(P.composeService);
  // A running container of this name may belong to a concurrent run, so it is never removed here.
  const existing = docker(["inspect", "-f", "{{.State.Running}}", CONTAINER], { check: false });
  if (existing.status === 0) {
    if (existing.stdout.trim() === "true")
      throw new Error(
        `container ${CONTAINER} is running; another basic-e2e run may own it, so this lane leaves it alone`,
      );
    docker(["rm", CONTAINER]);
  }
  ownContainer = true;
  const env = P.containerEnv(SECRETS);
  docker(
    [
      "run",
      "-d",
      "--name",
      CONTAINER,
      "-p",
      `127.0.0.1:${P.dbPort}:${P.containerPort}`,
      ...(P.dockerArgs ?? []),
      ...envFlags(env),
      image,
    ],
    { env },
  );
  const deadline = Date.now() + 300_000;
  const logs = () => {
    const r = docker(["logs", CONTAINER], { check: false });
    return r.stdout + r.stderr;
  };
  while (!logs().includes(P.readyLog)) {
    if (Date.now() > deadline) throw new Error(`${CONTAINER} never logged "${P.readyLog}"`);
    const state = docker(["inspect", "-f", "{{.State.Status}}", CONTAINER], { check: false }).stdout.trim();
    if (state !== "running")
      throw new Error(
        `${CONTAINER} is ${state}: ${docker(["logs", "--tail", "20", CONTAINER], { check: false }).stderr.slice(-800)}`,
      );
    await sleep(2000);
  }
  const readyEnv = P.readyEnv?.(SECRETS) ?? {};
  while (
    docker(["exec", ...envFlags(readyEnv), CONTAINER, ...P.readyCmd], { env: readyEnv, check: false }).status !== 0
  ) {
    if (Date.now() > deadline) throw new Error(`${CONTAINER} never answered its readiness probe`);
    await sleep(2000);
  }
  const setupEnv = P.setupEnv?.(SECRETS) ?? {};
  const r = docker(["exec", "-i", ...envFlags(setupEnv), CONTAINER, ...P.setupCmd], {
    env: setupEnv,
    input: P.setupScript(SECRETS),
  });
  log("database seeded", r.stdout.trim().split("\n").pop() ?? "");
  return { image };
}

// ---------- studio ----------

function writeSeedFile(dbFile) {
  const s = { ...P.seed };
  const lines = [
    'version: "1"',
    "connections:",
    `  - id: "basic-e2e-${opt.provider}-agent"`,
    `    name: "${SEED_NAME}"`,
    `    type: ${s.type}`,
  ];
  if (s.type === "sqlite") lines.push(`    database: "${dbFile}"`);
  else {
    lines.push(
      `    host: "${s.host}"`,
      `    port: ${s.port}`,
      `    database: "${s.database}"`,
      `    user: "${s.user}"`,
    );
    // An env reference, so the file on disk holds no secret.
    lines.push('    password: "${BE2E_AGENT_PASSWORD}"');
    if (s.authSource) lines.push(`    authSource: "${s.authSource}"`);
  }
  // Admin only: a SQLite seed shared with any other role is refused, agent runs included
  // (docs/providers/sqlite.md), and the lane signs in as the admin anyway.
  lines.push('    roles: ["admin"]', "    managed: true", "");
  const path = join(WORK, "seed-connections.yaml");
  writeFileSync(path, lines.join("\n"));
  return path;
}

async function startStudio(seedPath) {
  for (const f of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    // next start would load it, and any key the lane does not set would leak into the lane.
    if (existsSync(join(BUILD, f)))
      throw new Error(`${join(BUILD, f)} exists; the build worktree must hold no env file`);
  }
  if (!(await portFree(P.studioPort))) throw new Error(`port ${P.studioPort} is in use`);
  const fileEnv = readEnvFile(resolve(opt["env-file"]));
  const llm = Object.fromEntries(Object.entries(fileEnv).filter(([k]) => k.startsWith("LLM_")));
  if ((llm.LLM_API_KEY ?? "").length >= 8) SCAN.push(llm.LLM_API_KEY);
  if (!llm.LLM_PROVIDER) throw new Error(`${opt["env-file"]} sets no LLM_PROVIDER, so the agent steps cannot run`);
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TZ", "XDG_RUNTIME_DIR"];
  const data = join(WORK, "data");
  mkdirSync(data, { recursive: true });
  const env = {
    ...Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])),
    ...llm,
    PORT: String(P.studioPort),
    JWT_SECRET: SECRETS.jwt,
    ADMIN_EMAIL: "admin@libredb.org",
    ADMIN_PASSWORD: SECRETS.admin,
    STORAGE_PROVIDER: opt.storage,
    STORAGE_SQLITE_PATH: join(data, "libredb-storage.db"),
    WORKFLOW_LOCAL_DATA_DIR: join(data, "workflow"),
    LIBREDB_EMBEDDED_SAMPLE_PATH: join(data, "sample.libredb"),
    SQLITE_EMBEDDED_SAMPLE_PATH: join(data, "sample-employees.db"),
    SEED_CONFIG_PATH: seedPath,
    BE2E_AGENT_PASSWORD: SECRETS.agent,
  };
  const logFd = openSync(join(WORK, "server.log"), "a");
  // Detached, so it is a process group of its own that the teardown stops as one.
  server = spawn("bun", ["run", "start", "--", "-p", String(P.studioPort), "-H", "127.0.0.1"], {
    cwd: BUILD,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`studio exited with ${server.exitCode}; see ${join(WORK, "server.log")}`);
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("studio did not answer /api/health within 120 s");
    await sleep(1000);
  }
}

// ---------- browser helpers ----------

let page;
let ctx;
const observed = { console: [], http: [] };
const evidence = (name) => join(OUT, `${name}.png`);
const shot = async (name) => {
  await page.screenshot({ path: evidence(name) });
  return `${name}.png`;
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const treeItem = (label) => page.getByRole("treeitem", { name: new RegExp(`^${escapeRe(label)}(\\s|$)`) }).first();
const visible = (loc, timeout = 0) =>
  loc
    .first()
    .waitFor({ state: "visible", timeout })
    .then(
      () => true,
      () => false,
    );
// "4,321" reads as 4321; words keep their spaces.
const norm = (s) => String(s ?? "").replace(/(\d),(?=\d{3}\b)/g, "$1");

async function openBrowser() {
  const require = createRequire(join(BUILD, "package.json"));
  const { chromium } = require("playwright");
  ctx = await chromium.launchPersistentContext(join(WORK, "chrome-profile"), {
    channel: "chrome",
    headless: !opt.headed,
    viewport: { width: 1600, height: 1000 },
    baseURL: BASE,
    // The lane's own handlers close Chrome as part of the teardown.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("console", (m) => {
    if (m.type() === "error") observed.console.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => observed.console.push(`pageerror: ${String(e).slice(0, 300)}`));
  page.on("response", (r) => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && path.startsWith("/api/"))
      observed.http.push(`${r.status()} ${r.request().method()} ${path}`);
  });
}

async function login() {
  await page.goto("/login");
  await page.locator('input[type="email"]').first().fill("admin@libredb.org");
  await page.locator('input[type="password"]').first().fill(SECRETS.admin);
  await page.locator('button[type="submit"]').first().click();
  // An admin lands on /admin/overview; the studio itself is at /.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await gotoStudio();
}

async function gotoStudio() {
  await page.goto("/");
  await page.getByRole("button", { name: "RUN", exact: true }).waitFor({ timeout: 60_000 });
}

async function selectConnection(name) {
  const item = page.getByText(name, { exact: true }).first();
  await item.waitFor({ timeout: 60_000 });
  await item.scrollIntoViewIfNeeded();
  await item.click();
  await page.waitForTimeout(2500);
}

// Monaco takes clicks on its rendered lines, not on its hidden textarea.
async function runInEditor(text, name) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(text);
  return clickRun(name);
}

async function clickRun(name) {
  // The editor also posts a background EXPLAIN and a dry-run estimate to the same route; only the
  // request without an `explain` field is the statement the user ran.
  const resp = page.waitForResponse(
    (r) => {
      if (new URL(r.url()).pathname !== "/api/db/query" || r.request().method() !== "POST") return false;
      try {
        return !("explain" in JSON.parse(r.request().postData() ?? "{}"));
      } catch {
        return false;
      }
    },
    { timeout: 180_000 },
  );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  const dialog = page.getByRole("alertdialog").filter({ hasText: "Query Safety Check" });
  const first = await Promise.race([
    resp.then(() => "response"),
    dialog.waitFor({ timeout: 20_000 }).then(
      () => "dialog",
      () => "response",
    ),
  ]);
  let safety = false;
  if (first === "dialog") {
    safety = true;
    // The button stays disabled while the analysis runs.
    const go = dialog.getByRole("button", { name: /^(Execute Query|Proceed with Caution|Execute Anyway)$/ });
    const until = Date.now() + 120_000;
    while (await go.isDisabled()) {
      if (Date.now() > until)
        throw new Error(
          "Query Safety Check never enabled its execute button (a typed confirmation is not expected for a primary-key write)",
        );
      await page.waitForTimeout(1000);
    }
    await shot(`${name}-safety-check`);
    await go.click();
  }
  const r = await resp;
  const body = await r.json().catch(() => ({}));
  await page.waitForTimeout(1500);
  await shot(name);
  return { status: r.status(), body, safety };
}

// Waits on the run this lane opened, by the id POST /api/agent/runs answered, so a finished earlier
// run still on the rail can never be read as this one.
async function waitForRunEnd(name, runId) {
  const until = Date.now() + 600_000;
  let midShot = false;
  const started = Date.now();
  for (;;) {
    const shown = (
      (await page
        .getByTestId("agent-run-id")
        .first()
        .textContent()
        .catch(() => "")) ?? ""
    ).trim();
    const status = (
      (await page
        .getByTestId("agent-run-status")
        .first()
        .textContent()
        .catch(() => "")) ?? ""
    ).trim();
    if (shown === runId && TERMINAL.has(status)) break;
    if (!midShot && Date.now() - started > 8000) {
      await shot(`${name}-b-running`);
      midShot = true;
    }
    if (Date.now() > until) throw new Error("the agent run did not reach a terminal status within 10 minutes");
    await page.waitForTimeout(2000);
  }
  await page.waitForTimeout(2500);
  const res = await page.request.get(`/api/agent/runs/${runId}`);
  const report = await res.json().catch(() => ({}));
  return { runId, http: res.status(), record: report.record ?? {}, seconds: Math.round((Date.now() - started) / 1000) };
}

async function startAgent(mode, objective, { analyze = false, tickAutoExecute = false } = {}) {
  await selectConnection(SEED_NAME);
  await page.getByTestId("agent-objective").waitFor({ timeout: 60_000 });
  await page.getByTestId(`agent-mode-${mode}`).click();
  await page.getByTestId("agent-objective").fill(objective);
  if (analyze) {
    await page.getByTestId("agent-advanced-toggle").click();
    await page.getByTestId("agent-workflow-data-analysis").click();
  }
  const start = page.getByTestId("agent-start");
  if (await start.isDisabled()) {
    const rail = (
      await page
        .getByTestId("agent-rail-panel")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
    throw new Error(`Start is disabled on the seed connection: ${rail.slice(0, 300)}`);
  }
  const opened = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/agent/runs" && r.request().method() === "POST",
    { timeout: 120_000 },
  );
  await start.click();
  // The consent step appears for agent-mode runs; plan runs usually open directly.
  const consent = page.getByTestId("agent-consent");
  let offered = false;
  if (await visible(consent, mode === "agent" ? 30_000 : 5000)) {
    offered = await visible(page.getByTestId("agent-auto-execute"));
    if (offered && tickAutoExecute) await page.getByTestId("agent-auto-execute").check();
    await page.getByTestId("agent-consent-open").click();
  }
  const r = await opened;
  const body = await r.json().catch(() => ({}));
  if (r.status() !== 202 || typeof body.runId !== "string")
    throw new Error(`POST /api/agent/runs answered ${r.status()}: ${String(body.error ?? "").slice(0, 300)}`);
  return { offered, runId: body.runId };
}

// ---------- steps ----------

const steps = [];
function step(id, title) {
  const s = { id, title, result: "NOT RUN", checks: [], evidence: [], notes: [] };
  steps.push(s);
  const check = (name, ok, detail = "") => {
    s.checks.push({ name, ok: Boolean(ok), detail: redact(detail).slice(0, 300) });
    return ok;
  };
  return { s, check };
}
async function runStep(id, title, fn) {
  const { s, check } = step(id, title);
  try {
    await fn(check, s);
    s.result = s.checks.length > 0 && s.checks.every((c) => c.ok) ? "PASS" : "FAIL";
  } catch (e) {
    s.result = "FAIL";
    s.checks.push({
      name: "step completed without an exception",
      ok: false,
      detail: redact(e?.message ?? e).slice(0, 500),
    });
    await shot(`${String(id).padStart(2, "0")}-failure`).then(
      (f) => s.evidence.push(f),
      () => {},
    );
  }
  log(`step ${id} ${s.result}`);
  return s.result === "PASS";
}

async function stepConnect(check, s, ui) {
  await login();
  await page
    .getByRole("button", { name: /^(New connection|Add Connection)$/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await dialog.getByRole("button", { name: P.engineButton, exact: true }).click();
  await dialog.locator("#name").fill(UI_NAME);
  for (const [field, value] of Object.entries(ui)) await dialog.locator(`#${field}`).fill(value);
  const tested = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/db/test-connection");
  await dialog.getByRole("button", { name: "Test Connection", exact: true }).click();
  const tr = await tested;
  const tj = await tr.json().catch(() => ({}));
  const banner = dialog.getByTestId("connection-test-result");
  await banner.waitFor({ timeout: 30_000 });
  const text = (await banner.innerText()).replace(/\s+/g, " ");
  check(
    "Test Connection answers success",
    tr.status() === 200 && tj.success === true,
    `HTTP ${tr.status()}, latency ${tj.latency ?? "?"} ms`,
  );
  check("the dialog says Connected successfully", /Connected successfully/i.test(text), text.slice(0, 120));
  s.evidence.push(await shot("01-test-connection"));
  await dialog.getByRole("button", { name: "Establish Connection", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  check("the connection is listed in the sidebar", await visible(page.getByText(UI_NAME, { exact: true }), 15_000));
  check(
    "the object tree renders for it",
    await visible(treeItem(P.treePath[0]), 30_000),
    `waited for "${P.treePath[0]}"`,
  );
  s.evidence.push(await shot("02-connected"));
}

async function stepQueries(check, s) {
  await selectConnection(UI_NAME);
  const q = P.queries;
  const read = await runInEditor(q.read.text, "03-query-read");
  check(
    "read returns the seeded rows",
    read.status === 200 && !read.body.error && read.body.rows?.length === q.read.rows,
    `HTTP ${read.status}, ${read.body.rows?.length ?? 0} rows${read.body.error ? `, ${read.body.error}` : ""}`,
  );
  const ins = await runInEditor(q.insert.text, "04-query-insert");
  check(
    "insert succeeds",
    ins.status === 200 && !ins.body.error,
    `HTTP ${ins.status}, rowCount ${ins.body.rowCount ?? "?"}${ins.body.error ? `, ${ins.body.error}` : ""}`,
  );
  const upd = await runInEditor(q.update.text, "05-query-update");
  check("update raises the Query Safety Check", upd.safety);
  check(
    "update succeeds after Execute Query",
    upd.status === 200 && !upd.body.error,
    `HTTP ${upd.status}, rowCount ${upd.body.rowCount ?? "?"}${upd.body.error ? `, ${upd.body.error}` : ""}`,
  );
  const back = await runInEditor(q.readBack.text, "06-query-read-back");
  const rows = JSON.stringify(back.body.rows ?? []);
  check(
    "read-back returns the written row",
    back.status === 200 && back.body.rows?.length === 1 && q.readBack.expect.every((v) => rows.includes(v)),
    rows.slice(0, 200),
  );
  const grid = await page
    .locator("main")
    .first()
    .innerText()
    .catch(() => page.locator("body").innerText());
  check("the result grid shows the written value", grid.includes(q.readBack.expect.at(-1)));
  s.evidence.push(
    "03-query-read.png",
    "04-query-insert.png",
    "05-query-update-safety-check.png",
    "05-query-update.png",
    "06-query-read-back.png",
  );
}

async function stepObjects(check, s) {
  await selectConnection(UI_NAME);
  // Containers toggle on a row click; objects expand through their "Expand <name>" twisty.
  for (const label of P.treePath) {
    const item = treeItem(label);
    if ((await visible(item, 10_000)) && (await item.getAttribute("aria-expanded")) === "false") {
      await item.click();
      await page.waitForTimeout(1500);
    }
  }
  for (const obj of Object.keys(P.objects)) check(`${obj} is listed`, await visible(treeItem(obj), 20_000));
  s.evidence.push(await shot("07-object-list"));
  for (const [obj, column] of Object.entries(P.objects)) {
    const twisty = page.getByRole("button", { name: `Expand ${obj}`, exact: true });
    if (await visible(twisty, 5000)) await twisty.first().click();
    check(`${obj} expands to its columns (${column})`, await visible(treeItem(column), 20_000));
  }
  s.evidence.push(await shot("08-object-list-columns"));
}

function eventsOf(record) {
  const events = record.events ?? [];
  return { events, kinds: events.map((e) => e.kind), finished: events.find((e) => e.kind === "run-finished") };
}

async function stepPlan(check, s) {
  const { runId } = await startAgent("planning", AGENT.planObjective);
  s.evidence.push(await shot("09-plan-a-started"));
  const run = await waitForRunEnd("09-plan", runId);
  const { events, kinds, finished } = eventsOf(run.record);
  const drafted = events.find((e) => e.kind === "plan-statement-drafted");
  s.runId = run.runId;
  s.notes.push(`run ${run.runId}, ${run.seconds} s, events: ${kinds.join(", ")}`);
  check(
    "a real run was opened",
    /^arun_[0-9a-f]+$/.test(run.runId) && run.http === 200 && events.length > 0,
    `${run.runId || "no run id"}, HTTP ${run.http}, ${events.length} events`,
  );
  check("the run succeeded", run.record.status === "succeeded", run.record.status);
  check(
    "it drafted a statement",
    typeof drafted?.sql === "string" && drafted.sql.trim().length > 0,
    drafted?.sql?.slice(0, 200),
  );
  check(
    "it executed nothing",
    !kinds.includes("tool-invoked"),
    `${kinds.filter((k) => k === "tool-invoked").length} tool calls`,
  );
  check(
    "the goal verifier says answered",
    finished?.goalVerdict?.outcome === "answered",
    JSON.stringify(finished?.goalVerdict ?? null),
  );
  const card = page.getByTestId("agent-answer-plan");
  check("the rail renders the drafted plan", await visible(card, 10_000));
  s.evidence.push(await shot("09-plan-c-finished"));
  // The draft must also run as the user would run it: Apply to editor, then RUN.
  await page.getByTestId("agent-answer-plan-apply").click();
  await page.waitForTimeout(1000);
  const ran = await clickRun("09-plan-d-applied-and-run");
  check(
    "the applied draft runs in the editor",
    ran.status === 200 && !ran.body.error,
    `HTTP ${ran.status}, ${ran.body.rows?.length ?? 0} rows${ran.body.error ? `, ${ran.body.error}` : ""}`,
  );
  s.notes.push(
    `applied draft answer mentions Istanbul: ${JSON.stringify(ran.body.rows ?? []).includes("Istanbul")} (model quality, not a pass criterion)`,
  );
  s.evidence.push("09-plan-b-running.png", "09-plan-d-applied-and-run.png");
}

async function agentRun(check0, s, { objective, answer, prefix, expectHandover, label = "" }) {
  const check = (name, ...rest) => check0(`${label}${name}`, ...rest);
  const ae = P.autoExecute;
  const { offered, runId } = await startAgent("agent", objective, { analyze: true, tickAutoExecute: true });
  // Armed as soon as the run id is known: the rail posts the hand-over only after the run ends.
  const handover = page
    .waitForResponse((r) => new URL(r.url()).pathname === `/api/agent/runs/${runId}/handover`, {
      timeout: 660_000,
    })
    .catch(() => null);
  check(
    `auto-execute is ${ae.offered ? "offered" : "not offered"} on the consent card`,
    offered === ae.offered,
    `offered: ${offered}`,
  );
  const run = await waitForRunEnd(prefix, runId);
  const { events, kinds, finished } = eventsOf(run.record);
  const reads = events.filter((e) => e.kind === "tool-invoked" && e.tool === "run_read_query");
  const composed = events.find((e) => e.kind === "answer-composed");
  s.notes.push(
    `run ${run.runId}, ${run.seconds} s, handover ${composed?.handover ?? "-"}, events: ${kinds.join(", ")}`,
  );
  if (composed?.handoverWarning) s.notes.push(`gate warning: ${composed.handoverWarning.slice(0, 200)}`);
  check(
    "a real run was opened",
    /^arun_[0-9a-f]+$/.test(run.runId) && run.http === 200 && events.length > 0,
    `${run.runId || "no run id"}, HTTP ${run.http}, ${events.length} events`,
  );
  check("the run succeeded", run.record.status === "succeeded", run.record.status);
  check(
    "it executed read-only statements itself",
    reads.length > 0 && kinds.includes("tool-completed"),
    `${reads.length} run_read_query calls`,
  );
  check(
    "it composed an answer on a statement",
    typeof composed?.sql === "string" && composed.sql.length > 0,
    composed?.sql?.slice(0, 200),
  );
  check(
    "the goal verifier says answered",
    finished?.goalVerdict?.outcome === "answered",
    JSON.stringify(finished?.goalVerdict ?? null),
  );
  check(
    "the run recorded the auto-execute setting",
    run.record.autoExecute === ae.offered,
    `autoExecute: ${run.record.autoExecute}`,
  );
  const allowed = expectHandover ?? ae.handover;
  check(`the hand-over is ${allowed.join(" or ")}`, allowed.includes(composed?.handover), composed?.handover);
  if (composed?.handover === "applied") check("a declined hand-over says why", Boolean(composed.handoverWarning));
  const rendered = (
    await page
      .getByTestId("agent-answer")
      .first()
      .innerText()
      .catch(() => "")
  ).trim();
  check(
    "the rail renders an answer with the right figure",
    rendered.length > 0 && answer.test(norm(rendered)),
    rendered.replace(/\s+/g, " ").slice(0, 200),
  );
  if (composed?.handover === "auto-executed") {
    const h = await Promise.race([handover, sleep(30_000).then(() => null)]);
    const body = h ? await h.json().catch(() => ({})) : {};
    check(
      "the editor replayed the answer",
      h?.status() === 200 && answer.test(norm(JSON.stringify(body.result?.rows ?? []))),
      h
        ? `HTTP ${h.status()}, ${body.result?.rowCount ?? "?"} rows`
        : "no hand-over response within 30 s of the run's end",
    );
  }
  s.evidence.push(`${prefix}-b-running.png`, await shot(`${prefix}-c-finished`));
  return run.runId;
}

async function stepAgent(check, s) {
  s.runId = await agentRun(check, s, {
    objective: AGENT.agentObjective,
    answer: AGENT.agentAnswer,
    prefix: "10-agent",
  });
  if (P.autoExecute.probe) {
    // The aggregate's plan holds a SCAN, so its hand-over is declined; a primary-key lookup is a SEARCH.
    await gotoStudio();
    s.probeRunId = await agentRun(check, s, {
      objective: AGENT.probeObjective,
      answer: AGENT.probeAnswer,
      prefix: "11-agent-probe",
      expectHandover: ["auto-executed"],
      label: "probe: ",
    });
  }
}

// ---------- report ----------

function scanForSecrets() {
  const leaks = [];
  const values = SCAN;
  for (const f of readdirSync(OUT)) {
    if (!/\.(md|json|txt|log)$/.test(f)) continue;
    const text = readFileSync(join(OUT, f), "utf8");
    if (values.some((v) => text.includes(v))) leaks.push(f);
  }
  return leaks;
}

function writeReport(meta) {
  // Only files that exist: a dialog that never opened left no screenshot behind.
  for (const s of steps) s.evidence = [...new Set(s.evidence)].filter((e) => existsSync(join(OUT, e)));
  const md = [
    `# basic-e2e: ${opt.provider}`,
    "",
    `Build: ${meta.commit} from ${BUILD}.`,
    `Database: ${meta.image}${P.dbPort ? ` on 127.0.0.1:${P.dbPort}` : ""}.`,
    `Studio: ${BASE}, STORAGE_PROVIDER=${opt.storage}, real Chrome (channel chrome, ${opt.headed ? "headed" : "headless"}).`,
    `Lane verdict: ${steps.every((s) => s.result === "PASS") ? "PASS" : "FAIL"}.`,
    "",
    "| Step | Result | Evidence |",
    "| --- | --- | --- |",
    ...steps.map((s) => `| ${s.id}. ${s.title} | ${s.result} | ${s.evidence.map((e) => `[${e}](${e})`).join(" ")} |`),
    "",
    ...steps.flatMap((s) => [
      `## ${s.id}. ${s.title}: ${s.result}`,
      "",
      ...s.checks.map(
        (c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `: ${c.detail.replace(/\n/g, " ")}` : ""}`,
      ),
      ...s.notes.map((n) => `- Note: ${n}`),
      "",
    ]),
    "## Observations",
    "",
    `Browser console errors: ${observed.console.length}.`,
    ...observed.console.slice(0, 15).map((c) => `- ${c.replace(/\n/g, " ")}`),
    `API responses at 400 or above: ${observed.http.length}.`,
    ...[...new Set(observed.http)].slice(0, 20).map((h) => `- ${h}`),
    `Server log lines with [ERROR or an unhandled rejection: ${meta.serverErrors.length}.`,
    ...meta.serverErrors.slice(0, 15).map((l) => `- ${l.slice(0, 300)}`),
    "",
    `Cleanup: ${meta.cleanup}`,
    "",
  ].join("\n");
  writeFileSync(join(OUT, "RESULT.md"), md);
  writeFileSync(
    join(OUT, "RESULT.json"),
    JSON.stringify(
      {
        provider: opt.provider,
        commit: meta.commit,
        image: meta.image,
        steps,
        observed: { console: observed.console, http: observed.http },
        serverErrors: meta.serverErrors,
        cleanup: meta.cleanup,
      },
      null,
      2,
    ),
  );
}

// ---------- main ----------

mkdirSync(OUT, { recursive: true });
rmSync(join(OUT, "SECRET-FOUND"), { force: true });
if (existsSync(WORK) && readdirSync(WORK).length > 0 && !existsSync(join(WORK, WORK_MARKER)))
  throw new Error(`${WORK} is not empty and holds no ${WORK_MARKER}; pass a new or empty --work path`);
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
writeFileSync(join(WORK, WORK_MARKER), "");
const meta = {
  commit: spawnSync("git", ["-C", BUILD, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  image: "-",
  serverErrors: [],
  cleanup: "",
};
let setupError;
let interrupted;

// Runs once, from the end of the lane or from a signal, whichever comes first.
let teardown;
const finish = () => {
  teardown ??= (async () => {
    const done = [];
    await ctx?.close().catch(() => {});
    if (server?.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {}
      await sleep(2000);
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {}
      done.push(`server on ${P.studioPort} stopped`);
    }
    if (existsSync(join(WORK, "server.log"))) {
      meta.serverErrors = readFileSync(join(WORK, "server.log"), "utf8")
        .split("\n")
        .filter((l) => /\[ERROR|Unhandled|unhandledRejection/.test(l));
    }
    if (ownContainer) {
      docker(["rm", "-f", CONTAINER], { check: false });
      done.push(`container ${CONTAINER} removed`);
    }
    if (!opt.keep) {
      rmSync(WORK, { recursive: true, force: true });
      done.push("Chrome profile, data dir, seed file and server log deleted");
    } else done.push(`work dir kept at ${WORK}`);
    meta.cleanup = done.join("; ") + ".";
    if (setupError) {
      steps.push({
        id: 0,
        title: interrupted ? "Lane interrupted" : "Lane setup",
        result: "FAIL",
        checks: [
          {
            name: interrupted ? "lane ran to the end" : "lane set up",
            ok: false,
            detail: redact(setupError?.message ?? setupError),
          },
        ],
        evidence: [],
        notes: [],
      });
    }
    writeReport(meta);
    const leaks = scanForSecrets();
    if (leaks.length) {
      // A marker without the secret, so run.mjs withholds this lane's details from SUMMARY.md.
      writeFileSync(join(OUT, "SECRET-FOUND"), `${leaks.join("\n")}\n`);
      log("SECRET FOUND in", leaks.join(", "), "- delete those files before sharing anything");
      process.exitCode = 2;
    }
  })();
  return teardown;
};

// TaskStop, Ctrl-C or run.mjs forwarding a signal: tear down, then exit 2 like any lane that could not finish.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (teardown) return;
    interrupted = sig;
    setupError = new Error(`interrupted by ${sig}`);
    log(`${sig} received; tearing the lane down`);
    finish().finally(() => process.exit(2));
  });
}

try {
  const db = await startDatabase();
  meta.image = db.image;
  await startStudio(writeSeedFile(db.file));
  await openBrowser();
  const ui = P.uiFields(SECRETS, db.file);
  const connected = await runStep(1, "Create a connection in the UI and connect", (c, s) => stepConnect(c, s, ui));
  if (connected) {
    await runStep(2, "Read, write and read back", stepQueries);
    await runStep(3, "Object list", stepObjects);
  } else {
    step(2, "Read, write and read back").s.notes.push("not run: step 1 failed");
    step(3, "Object list").s.notes.push("not run: step 1 failed");
  }
  if (!connected) await login().catch(() => {});
  await gotoStudio();
  await runStep(4, "Agent, Plan mode", stepPlan);
  await gotoStudio();
  await runStep(5, "Agent, Agent mode with auto-execute", stepAgent);
} catch (e) {
  if (!interrupted) {
    setupError = e;
    log("lane setup failed:", e?.message ?? e);
  }
} finally {
  await finish();
}
if (process.exitCode !== 2) process.exitCode = setupError ? 2 : steps.every((s) => s.result === "PASS") ? 0 : 1;
log(`lane ${process.exitCode === 0 ? "PASS" : "FAIL"}; report ${join(OUT, "RESULT.md")}`);
