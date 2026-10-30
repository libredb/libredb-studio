#!/usr/bin/env node
// Runs basic-e2e lanes in parallel, at most --concurrency at a time, then writes the summary table.
// Usage and the contract it implements: .claude/skills/basic-e2e/SKILL.md.
//
//   node run.mjs --build <prebuilt worktree> --out <evidence root> --work <scratch root>
//                --env-file <file holding LLM_*> [--providers postgres,mysql,mssql,mongodb,sqlite]
//                [--concurrency 3] [--storage sqlite|local] [--headed] [--keep]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_PROVIDERS, PROVIDERS } from "./providers.mjs";

const { values: opt } = parseArgs({
  options: {
    build: { type: "string" },
    out: { type: "string" },
    work: { type: "string" },
    "env-file": { type: "string" },
    providers: { type: "string", default: DEFAULT_PROVIDERS.join(",") },
    concurrency: { type: "string", default: "3" },
    storage: { type: "string", default: "sqlite" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
  },
});
for (const k of ["build", "out", "work", "env-file"]) if (!opt[k]) throw new Error(`--${k} is required`);
const providers = opt.providers
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
for (const p of providers) if (!PROVIDERS[p]) throw new Error(`unknown provider ${p}`);
const limit = Number(opt.concurrency);
if (!Number.isInteger(limit) || limit < 1)
  throw new Error(`--concurrency must be an integer of at least 1, got "${opt.concurrency}"`);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(opt.out);
const WORK = resolve(opt.work);
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

// A signal stops the queue and reaches every running lane, which then tears itself down.
const queue = [...providers];
const children = new Set();
let interrupted;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    interrupted ??= sig;
    queue.length = 0;
    for (const c of children) c.kill(sig);
  });
}

function lane(provider) {
  const args = [
    join(here, "lane.mjs"),
    "--provider",
    provider,
    "--build",
    resolve(opt.build),
    "--out",
    join(OUT, provider),
    "--work",
    join(WORK, provider),
    "--env-file",
    resolve(opt["env-file"]),
    "--storage",
    opt.storage,
  ];
  if (opt.headed) args.push("--headed");
  if (opt.keep) args.push("--keep");
  const logPath = join(WORK, `${provider}.lane.log`);
  const fd = openSync(logPath, "w");
  const started = Date.now();
  console.log(`start ${provider} (log ${logPath})`);
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", fd, fd] });
    children.add(child);
    child.on("exit", (code, signal) => {
      children.delete(child);
      console.log(`end   ${provider}: exit ${code ?? signal} after ${Math.round((Date.now() - started) / 1000)} s`);
      done({ provider, code: code ?? signal });
    });
  });
}

const results = [];
await Promise.all(
  Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) results.push(await lane(queue.shift()));
  }),
);

const STEP_TITLES = [
  "Create a connection in the UI and connect",
  "Read, write and read back",
  "Object list",
  "Agent, Plan mode",
  "Agent, Agent mode with auto-execute",
];
const reports = providers.map((p) => {
  const f = join(OUT, p, "RESULT.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { provider: p, steps: [] };
});
const cell = (r, id) => {
  const s = r.steps.find((x) => x.id === id);
  const s0 = r.steps.find((x) => x.id === 0);
  if (!s) return s0 ? `NOT RUN (${s0.title === "Lane interrupted" ? "interrupted" : "setup failed"})` : "NOT RUN";
  return s.result;
};
const lines = [
  "# basic-e2e summary",
  "",
  `Build ${reports.find((r) => r.commit)?.commit ?? "?"}, providers ${providers.join(", ")}, at most ${limit} lanes at once.`,
  "Each provider folder holds its own RESULT.md, RESULT.json and screenshots.",
  ...(interrupted ? [`Interrupted by ${interrupted}: lanes not started are NOT RUN.`] : []),
  "",
  `| Step | ${providers.join(" | ")} |`,
  `| --- | ${providers.map(() => "---").join(" | ")} |`,
  ...STEP_TITLES.map((t, i) => `| ${i + 1}. ${t} | ${reports.map((r) => cell(r, i + 1)).join(" | ")} |`),
  `| Lane exit code | ${providers.map((p) => results.find((r) => r.provider === p)?.code ?? "?").join(" | ")} |`,
  "",
  ...reports.flatMap((r) => {
    // The lane's own scan found a secret in its evidence: name the lane, quote nothing from it.
    if (existsSync(join(OUT, r.provider, "SECRET-FOUND")))
      return [
        `- ${r.provider}: the lane's secret scan found a secret in its evidence; details withheld, see ${join(OUT, r.provider, "SECRET-FOUND")}`,
      ];
    const failed = r.steps.flatMap((s) =>
      s.checks
        .filter((c) => !c.ok)
        .map((c) => `- ${r.provider}, step ${s.id}: ${c.name}${c.detail ? `: ${c.detail}` : ""}`),
    );
    return failed;
  }),
  "",
];
writeFileSync(join(OUT, "SUMMARY.md"), lines.join("\n"));
console.log(lines.join("\n"));
process.exitCode = !interrupted && results.length === providers.length && results.every((r) => r.code === 0) ? 0 : 1;
