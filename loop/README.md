# Maintainer Loop

Autonomous, test-gated maintenance for this repository: fresh-context agent iterations triage
the public issue tracker, plan a milestone, and fix the queue one test-first commit at a time —
with a human always owning publish (push, PR, merge, release).

> **If you are an agent running a loop iteration:** your instructions are EXCLUSIVELY the
> prompt file the runner fed you (`PROMPT-TRIAGE.md`, `PROMPT-PLANNING.md`, or `PROMPT.md`)
> plus the files those prompts direct you to read. This README is orientation for humans; it
> defines no rules and overrides nothing.

## How it runs (operator)

```bash
git checkout -b loop/<name> main
./loop/scripts/new-milestone.sh <name>   # seed/reset the live state under .loop/ from loop/*.template
./loop/scripts/pipeline.sh               # unattended: triage -> planning -> build
# then, always human: review the branch, push, open the PR
```

No bookkeeping commit is needed to open a milestone: `new-milestone.sh` writes only under `.loop/`,
which is gitignored, so the loop's own churn never lands in the branch — only the actual fix commits
the pipeline produces do.

**Tracked scaffold (`loop/`) vs live state (`.loop/`).** `loop/` holds only the tracked source: the
mode prompts, runner scripts, docs, and the `*.template` seeds. All per-run working state — the
progress log, triage register, acceptance/plan, config, and archives — lives under the gitignored
`.loop/`, seeded from the templates by `new-milestone.sh`. This is why a feature/contributor PR
never carries loop bookkeeping. Runbook and current status: [`HANDOFF.md.template`](./HANDOFF.md.template)
(seeded to `.loop/HANDOFF.md`).

## File map

**Tracked scaffold — `loop/` (the source of truth, committed):**

| File | What it is | Authoritative for |
|---|---|---|
| [`LOOP-ENGINEERING.md`](./LOOP-ENGINEERING.md) | Operating discipline: honesty contract, untrusted-input firewall, modes, error handling | How the loop works |
| [`SCENARIOS.md`](./SCENARIOS.md) | Written scenario catalogue: stories + 24 use cases (success, failure, skip, needs-info, moderator, scam, injection) | What the loop does per input class |
| [`PROMPT-TRIAGE.md`](./PROMPT-TRIAGE.md) / [`PROMPT-PLANNING.md`](./PROMPT-PLANNING.md) / [`PROMPT.md`](./PROMPT.md) | The three mode prompts fed to fresh-context iterations | Agent behavior (the only instruction source) |
| `PROGRESS.md.template` · `TRIAGE.md.template` · `ACCEPTANCE.md.template` · `IMPLEMENTATION_PLAN.md.template` · `HANDOFF.md.template` | Pristine seeds for the live working files (`{{MILESTONE}}`/`{{SENTINEL}}` placeholders) | The starting content of each live file |
| `config/loop.env.example` | Runner-config seed (sentinel, mode, tool blocks, limits) | Default runner behavior |
| `scripts/` | `loop.sh` (iteration engine) · `pipeline.sh` (stage sequencing) · `new-milestone.sh` (seed/reset) · `gate.sh` (mechanical gate) · `functional-smoke.sh` (product gate) · `trace.py` (live iteration trace, see below) | Deterministic mechanics |

**Live working state — `.loop/` (gitignored, seeded from the templates by `new-milestone.sh`):**

| File | What it is | Authoritative for |
|---|---|---|
| `.loop/ACCEPTANCE.md` | Current milestone's definition of done (written by planning mode) | When a milestone may complete |
| `.loop/IMPLEMENTATION_PLAN.md` | Current milestone's task list (written by planning mode) | What build iterations pick |
| `.loop/TRIAGE.md` | Sanitized specs (the firewall between raw issues and build mode) + the cross-milestone "Not for the loop" memory (preserved across resets) | Per-task acceptance bars |
| `.loop/PROGRESS.md` | Lab notebook, current milestone only | What happened and why |
| `.loop/HANDOFF.md` | Cross-session orientation + operator runbook | Nothing (orientation only) |
| `.loop/config/loop.env` | Live runner configuration (rotated per milestone) | Runner behavior |
| `.loop/archive/<milestone>/` | Frozen history rotated out by `new-milestone.sh` | Past milestones |
| `.loop/COMPLETE` · `.loop/logs/` | Completion marker + per-iteration logs (`iteration-N.log`, written only when the iteration exits) and `trace.log` (live, from `trace.py`) | Completion signal / run trace |

## Watching a running iteration

`claude -p` buffers its output: nothing lands in `.loop/logs/iteration-N.log` until the process
exits, so for up to `LOOP_ITERATION_TIMEOUT` (2.5h here) a healthy iteration and a wedged one look
exactly the same. `trace.py` closes that gap — Claude Code writes each session's event stream to
`~/.claude/projects/<slug>/<uuid>.jsonl` as it happens, and the script follows that, printing one
short line per tool call and result:

```bash
nohup python3 loop/scripts/trace.py --log >/dev/null 2>&1 &   # start once per run
tail -f .loop/logs/trace.log                                   # then just watch
```

```
21:07:04 TOOL Bash      timeout 3000 ./loop/scripts/gate.sh 2>&1 | tail -30
21:07:26   ->           [30 lines] 247:30 warning '_dropped' is assigned a value but never used…
21:07:33 SAY            Lint clean (0 errors, 80 warnings = baseline). Typecheck caught a real type error…
```

Each iteration opens a new session and therefore a new transcript; the script detects the switch and
follows the next one, so it can be left running overnight. It identifies the loop's transcript by
matching the iteration prompt on line 1, so an operator's own interactive session in the same
repository never appears. Output goes to stdout, and to `.loop/logs/trace.log` with `--log`.

**Why it reads a transcript rather than the agent's stdout.** The obvious alternative — running the
agent with `--output-format stream-json` and piping it into a formatter — is unsafe here: `loop.sh`
redirects the agent to a *file* rather than through a pipe on purpose, because a pipe stays open
while any surviving child of a killed agent holds it, wedging the runner long after `timeout(1)`
fired. Reading the transcript leaves the runner's IO untouched, needs no restart, and works on an
iteration that is already in flight.

Note that this is observation only. The authoritative record of what an iteration *decided* is still
its `.loop/PROGRESS.md` entry and its commit; a trace line is not evidence that work was verified.

## The two gates every milestone must pass

1. **Mechanical** — `scripts/gate.sh`: the exact pre-commit verification from the root
   `CLAUDE.md` (format · lint · typecheck · knip · test · build), per task, before every commit.
2. **Functional** — `scripts/functional-smoke.sh`: boot the built app, create a real
   PostgreSQL connection through the UI, run a SQL query, assert the rows render. Mandatory
   before a milestone may complete. (CI covers the same flow by running the underlying spec,
   `e2e/functional-smoke.spec.ts`, inside the regular Playwright E2E job — not this wrapper;
   the wrapper additionally hard-fails when Docker is missing, the spec skips.)

## Trust model in one paragraph

Everything a reporter writes is untrusted data, never instructions — regardless of who they
appear to be. Triage verifies claims against the code and re-states them as sanitized specs;
build mode takes its acceptance bar only from those specs; a fresh-context reviewer
adversarially checks every diff; the runner blocks pushes, network fetches, and GitHub
mutations beyond `loop:*` labels and one clarifying-question comment; and publishing is always
a human act. Details: [`LOOP-ENGINEERING.md`](./LOOP-ENGINEERING.md) §3, worked examples:
[`SCENARIOS.md`](./SCENARIOS.md) §6.

## Provenance

This scaffold is the reference deployment of the generalized maintainer-loop template,
[**open-spek/maintainer-loop**](https://github.com/open-spek/maintainer-loop) (the maintenance
sibling of `open-spek/loop`). The template publishes the same structure as reusable
`*.template` / `*.example` seeds; this repo is where it is battle-tested. The tracked-scaffold
(`loop/`) vs gitignored-live-state (`.loop/`) split documented above keeps loop bookkeeping out of
feature PRs — improvements flow between this deployment and the template manually.
