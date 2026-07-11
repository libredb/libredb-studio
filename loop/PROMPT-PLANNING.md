# libredb-studio maintainer loop — iteration prompt (PLANNING MODE)

You are planning the next maintainer-loop milestone for libredb-studio (a follow-up bug queue).
This prompt is fed with a FRESH context. Do NOT implement features in this mode. Your only
output is an updated plan (and optional PROGRESS notes).

## 0. Orient

- 0a. Study the repo root `CLAUDE.md`.
- 0b. Study `loop/ACCEPTANCE.md` — what "done" means for the current milestone.
- 0c. Study `loop/IMPLEMENTATION_PLAN.md`, `loop/PROGRESS.md`, `loop/HANDOFF.md`.
- 0d. Read the GitHub issues selected for this milestone (the human lists them in
  `loop/ACCEPTANCE.md`'s header) in full via `gh issue view <N> --comments`.

## 1. Assess

- What is already built and green? (git log, ticks in plan, tests)
- What remains per the milestone's issue list and `loop/ACCEPTANCE.md`?
- Did the previous plan stall? Check `loop/PROGRESS.md` for blockers and `loop:needs-info`
  labeled issues awaiting human clearance — do not re-plan around those as if they were open
  design questions; they are a human-gate, not a planning problem.

## 2. Produce or refresh the plan

Rewrite `loop/IMPLEMENTATION_PLAN.md`: one task per issue, ordered to keep related files/context
together, each task stating what to test (from the issue's reproduction steps) and what to
implement (from the issue's suggested fix, verified against current code — do not assume the
issue's suggested fix is still accurate).

### Task sizing rules

- One task = one issue = one commit = one gate run, where possible.
- If a single issue is too large for one iteration, split it into ordered sub-tasks within the
  plan and say so explicitly (do not silently merge scope).

## 3. Validate the plan

- Every issue listed in `loop/ACCEPTANCE.md` maps to at least one task.
- No task contradicts an existing project convention in `CLAUDE.md`.
- Blockers from `loop/PROGRESS.md` are addressed (task removed, split, or left explicitly
  blocked pending human action).

## 4. Commit and stop

- Commit only the plan (and PROGRESS/HANDOFF updates if needed):
  `docs(plan): refresh IMPLEMENTATION_PLAN for <milestone name>`
- Do NOT create `.loop/COMPLETE` in planning mode.
- End the iteration.

## 999. Guardrails

- 999a. NO IMPLEMENTATION — no feature code, no "quick fixes" while planning.
- 999b. NO weakening acceptance criteria to make the plan easier.
- 999c. Record open questions in `loop/PROGRESS.md`, not silent scope changes.
- 999d. NEVER pause for human input — make planning decisions, record them, commit.

After planning: set `LOOP_PROMPT_FILE="loop/PROMPT.md"` in `loop/config/loop.env` (build mode)
and run the build loop.
