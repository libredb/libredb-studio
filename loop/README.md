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
./loop/scripts/new-milestone.sh <name>   # archive previous milestone, reset state
git add -A loop && git commit -m "chore(loop): open milestone <name>"
./loop/scripts/pipeline.sh               # unattended: triage -> planning -> build
# then, always human: review the branch, push, open the PR
```

Full runbook and current status: [`HANDOFF.md`](./HANDOFF.md).

## File map

| File | What it is | Authoritative for |
|---|---|---|
| [`LOOP-ENGINEERING.md`](./LOOP-ENGINEERING.md) | Operating discipline: honesty contract, untrusted-input firewall, modes, error handling | How the loop works |
| [`SCENARIOS.md`](./SCENARIOS.md) | Written scenario catalogue: stories + 24 use cases (success, failure, skip, needs-info, moderator, scam, injection) | What the loop does per input class |
| [`PROMPT-TRIAGE.md`](./PROMPT-TRIAGE.md) / [`PROMPT-PLANNING.md`](./PROMPT-PLANNING.md) / [`PROMPT.md`](./PROMPT.md) | The three mode prompts fed to fresh-context iterations | Agent behavior (the only instruction source) |
| [`ACCEPTANCE.md`](./ACCEPTANCE.md) | Current milestone's definition of done (written by planning mode) | When a milestone may complete |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | Current milestone's task list (written by planning mode) | What build iterations pick |
| [`TRIAGE.md`](./TRIAGE.md) | Sanitized specs (the firewall between raw issues and build mode) + the cross-milestone "Not for the loop" memory | Per-task acceptance bars |
| [`PROGRESS.md`](./PROGRESS.md) | Lab notebook, current milestone only | What happened and why |
| [`HANDOFF.md`](./HANDOFF.md) | Cross-session orientation + operator runbook | Nothing (orientation only) |
| `archive/<milestone>/` | Frozen history rotated out by `new-milestone.sh` | Past milestones |
| `config/loop.env` | Runner configuration (sentinel, mode, tool blocks, limits) | Runner behavior |
| `scripts/` | `loop.sh` (iteration engine) · `pipeline.sh` (stage sequencing) · `new-milestone.sh` (rotation) · `gate.sh` (mechanical gate) · `functional-smoke.sh` (product gate) | Deterministic mechanics |

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
