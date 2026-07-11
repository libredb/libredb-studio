# Loop Engineering — operating manual

> How to let a coding agent build your project autonomously, test-first, without losing reliability or honesty.
>
> Read [`HANDOFF.md`](./HANDOFF.md), the repo root `CLAUDE.md`, and the current task's linked
> GitHub issue first — this maintainer variant has no `MANIFESTO.md`/`DESIGN.md`; the repo's
> existing conventions and the issue tracker are the spec.
> This document is the operating discipline; [`PROMPT.md`](./PROMPT.md) is the iteration prompt; [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) is the live task list; [`scripts/loop.sh`](./scripts/loop.sh) runs it.

---

## 1. Why a loop

Complex software built in one long agent conversation suffers **context rot** — quality degrades as the window fills, the agent forgets constraints, and sunk-cost bias locks in bad approaches.

The loop pattern (Geoffrey Huntley's "Ralph" technique, extended by Recursive Language Models and dynamic workflows):

```bash
while :; do cat PROMPT.md | agent --non-interactive ; done
```

Each iteration is a **fresh context**. Progress persists in **files and git**, not in the model's memory. One task per iteration. Tests gate every commit.

This trades token efficiency for **determinism and honesty**. The model re-derives state each time by reading the spec, plan, and code.

### Relationship to RLM and dynamic workflows

| Concept | Role in loop engineering |
|---------|-------------------------|
| **RLM** ([blog](https://alexzhang13.github.io/blog/2025/rlm/), [paper](https://arxiv.org/html/2512.24601v3)) | The repo *is* the external environment. Context (spec, plan, code) lives outside the window; the agent programmatically reads subsets each iteration. |
| **Dynamic subagents** ([LangChain](https://www.langchain.com/blog/introducing-dynamic-subagents-in-deep-agents)) | Inside a hard task, the agent writes orchestration code (`task()` loops) instead of sequential tool calls — structural coverage at scale. |
| **Dynamic workflows** ([Claude Code](https://code.claude.com/docs/en/workflows)) | Same idea in Claude Code: JavaScript script fans out agents, synthesizes results; intermediate state stays in script variables. |
| **Planner / worker** ([Cursor research](https://cursor.com/blog/scaling-agents)) | **Human + planning mode = planner.** Loop iteration = worker. Workers don't coordinate with each other; the plan serializes work. |
| **Agent teams** ([Claude Code](https://code.claude.com/docs/en/agent-teams)) | Optional for human-supervised parallel exploration between milestones — not the default unattended loop. |

**Default unattended loop:** one worker, one task, fresh context, file-backed state.
**Optional fan-out:** dynamic workflow inside a single iteration for embarrassingly parallel sub-work (audit N files, run N seeds).

---

## 2. The honesty contract (non-negotiable)

Autonomous agents have two fatal failure modes for serious software:

1. **Agentic laziness** — declaring victory early or finding excuses to stop.
2. **Placeholder implementations** — stubs that satisfy weak tests and look done.

The loop operates under a hard contract, enforced by the prompt and the gate:

1. **No placeholder, stub, or `TODO`-as-implementation.** Verify by reading before claiming missing.
2. **Tests are real and derived from acceptance criteria.** Written first. Never weakened, skipped, or deleted to pass the gate.
3. **The gate is truth, not the model's opinion.** Commit only when the full gate is green.
4. **Guarded core stays honest.** Complexity may not be swept out of trust-boundary files to satisfy metrics.
5. **When blocked, write it down — do not fake progress.** Same task fails twice → record in `PROGRESS.md`, stop or skip per plan rules.
6. **No interactive pauses.** The loop has no human. At forks: decide per spec, record reasoning in `PROGRESS.md`, commit, flag for later review.

These are restated as highest-priority guardrails in `PROMPT.md` section 999.

---

## 3. File layout (the loop's working set)

| File | Role | Who writes |
|------|------|------------|
| `PROMPT.md` | Never-changing loop instruction. Guardrails last (highest priority). | Human; evolves slowly |
| `PROMPT-PLANNING.md` | Planning-mode variant. Regenerates `IMPLEMENTATION_PLAN.md`. | Human |
| `CLAUDE.md` (repo root) | Conventions, project map, build/test, the mandatory gate. Not duplicated here. | Human (pre-existing) |
| Linked GitHub issue (per task) | Frozen per-task spec — the *what* and *why* for the one task in progress. | Human (pre-existing, external) |
| `loop/IMPLEMENTATION_PLAN.md` | Prioritized task checklist. **Disposable.** | Loop + human |
| `loop/PROGRESS.md` | Lab notebook: done, failed, decisions, limitations. | Loop |
| `loop/HANDOFF.md` | Cross-session baton. Orientation only — not authoritative state. | Human / loop at close |
| `loop/ACCEPTANCE.md` | Current milestone definition of done. | Human |
| `loop/config/loop.env` | Runner configuration (agent cmd, gate, sentinel). | Human |

**Authoritative state during a build:** `IMPLEMENTATION_PLAN.md` (ticks) + `PROGRESS.md` + git history — not `HANDOFF.md` prose.

Map to Ralph canon: `DESIGN.md` ≈ specs, `CLAUDE.md` ≈ AGENTS.md, `PROGRESS.md` ≈ lab notebook.

---

## 4. Two modes, one loop

| Mode | When | Prompt | Output |
|------|------|--------|--------|
| **Planning** | Start of milestone; plan went stale; agent circling | `PROMPT-PLANNING.md` | Refreshed `IMPLEMENTATION_PLAN.md` |
| **Building** | Plan exists | `PROMPT.md` | One task implemented, tested, committed |

Switch modes by setting `LOOP_PROMPT_FILE` in `loop/config/loop.env` (the non-destructive way — both prompt files stay intact).

Planning is cheap and regenerable. Prefer regenerating the plan over letting the build circle.

---

## 5. Backpressure: the commit gate

Nothing commits unless every gate is green. Define one command in `loop/scripts/gate.sh`:

```bash
# Example shape — adapt to your stack (see gate.sh.example)
typecheck && lint && test && build
```

Tests are the primary gate — derived from acceptance criteria, written before implementation.

For subjective goals ("is the code readable in one sitting?"), use a binary LLM-as-judge check **after** mechanical gates pass — do not block mechanical progress on taste. Run the judge with a **fresh-context subagent**: the in-loop agent has just read the code deeply and is the worst judge of a cold first read (the reference build used this at every milestone close). The judge returns PASS / PASS WITH NOTES / BLOCK with frictions ranked HIGH / MEDIUM / LOW; the iteration applies findings by severity and records the verdict in `PROGRESS.md`. See `.claude/agents/judge.md.template`.

Document the exact gate in `docs/TOOLCHAIN.md` and `CLAUDE.md`.

---

## 6. How to run

### Containment

Unattended agents need permission bypass. **Containment is the only safety boundary:**

- **Sandbox** — Docker, VM, or dedicated machine
- **Branch** — clean working tree; never edit while loop runs
- **Iteration cap** — `loop.sh` first argument
- **Budget cap** — agent-specific spend limits
- **Block destructive tools** — `rm`, `git push --force`, etc.
- **One task, one commit** — git history is the recovery trail

### Error handling

Multi-hour runs hit API limits and transient failures. Three layers:

1. **Agent CLI retries** — 5xx, timeouts, temporary 429 (configure per agent)
2. **Per-iteration timeout** (`LOOP_ITERATION_TIMEOUT`, default 1800s) — a usage limit
   hitting MID-iteration leaves the agent process hung with no output and no exit, so the
   classifier below never runs; `timeout(1)` turns the hang into exit 124, retried as
   transient. Observed repeatedly in real runs — do not remove this layer.
3. **Loop classifier** (`classify()` in `loop.sh`) — routes to:
   - **ok** — check completion marker; advance iteration
   - **usage_limit** — sleep and retry same iteration (cap total waits)
   - **transient** — backoff and retry same iteration (cap consecutive); includes timeouts
   - **fatal** — auth, credits, policy; stop immediately

A killed/timed-out iteration may leave uncommitted half-done work in the tree. This is safe
by design — nothing commits mid-task, so the next fresh iteration redoes the same task; do
not auto-reset the tree (it could wipe human edits). If recovering manually, `git status`
first, then discard only what the dead iteration touched.

Exit codes: `0` done, `1` max iterations, `2` usage-limited, `3` transient exhaustion, `4` fatal.

### Three ways to drive (Claude Code)

1. **`/loop`** — in-session re-prompt. Good for supervised light iteration. Context accumulates.
2. **Ralph plugin** — Stop hook re-injects prompt. Context accumulates until compaction.
3. **Fresh-context loop (recommended for long builds)** — `loop/scripts/loop.sh`. New process each iteration. Highest determinism.

For other agents, implement (3): new process + same `PROMPT.md`.

---

## 7. Stop / exit conditions

The loop ends when any holds:

| Condition | Detection |
|-----------|-----------|
| **Milestone complete** | Agent creates `.loop/COMPLETE` **file** AND gate green |
| **Empty plan** | No unchecked tasks in `IMPLEMENTATION_PLAN.md` |
| **Iteration cap** | `loop.sh` exhausts max iterations |
| **Repeated block** | Same task failed twice; blocker recorded |

**Critical:** Completion detection is **file-based only**. The agent often quotes the sentinel string in prose while explaining it is NOT done — text grep false-positives and stops the loop on iteration 1.

---

## 8. Acceptance criteria (milestone template)

Copy and fill [`ACCEPTANCE.md`](./ACCEPTANCE.md) per milestone. The completion marker fires only when ALL criteria are met.

Example structure:

```markdown
## Milestone M1 — {{name}}

### Functional
- [ ] Criterion 1 (testable)
- [ ] Criterion 2 (testable)

### Quality
- [ ] Full gate green on clean tree
- [ ] Coverage threshold met (if applicable)
- [ ] docs/DESIGN.md open questions updated
- [ ] README reflects actual behavior

### Process
- [ ] IMPLEMENTATION_PLAN.md all ticked
- [ ] PROGRESS.md and HANDOFF.md reconciled
```

---

## 9. Dynamic workflows inside an iteration

Use when a **single plan task** requires fan-out (not as a replacement for the outer loop).

Trigger (Claude Code): include `workflow` or `ultracode` in the task description, or use `/effort ultracode`.

Common patterns ([LangChain](https://www.langchain.com/blog/introducing-dynamic-subagents-in-deep-agents)):

| Pattern | Use when |
|---------|----------|
| **Classify and act** | Mixed inputs need different specialists |
| **Fanout and synthesize** | Same check across many files, one report |
| **Adversarial verification** | False positives are costly (security audit) |
| **Generate and filter** | Explore options, keep best |
| **Loop until done** | Unknown scope; repeat until no new findings |

**Rule:** The outer loop still commits **one plan task** per iteration. A workflow may implement that task's interior; the iteration ends with gate green + one commit.

See [`.claude/workflows/README.md`](../.claude/workflows/README.md).

---

## 10. Phases and milestones

Structure long projects as **milestones**, each a full loop cycle:

```
Milestone 0: toolchain + gate + empty scaffold (human + few loop iterations)
Milestone 1: core / proof of architecture
Milestone 2: differentiator features
Milestone 3: hardening / simulation / production bar
...
```

Between milestones (human):

1. Verify independently (gate + risky tests)
2. Update `DESIGN.md`, `ACCEPTANCE.md`, `HANDOFF.md`
3. Regenerate `IMPLEMENTATION_PLAN.md` (planning mode)
4. **Specialize `PROMPT.md` step 2** with milestone-specific test guidance — name what this
   milestone's tests must genuinely exercise (the reference build did this every cycle, e.g.
   "for the catalog: reserved-prefix isolation and validate-on-reopen; for DST: the
   crash/recovery invariant under a seeded simulated filesystem"). Guardrails stay unchanged.
5. New `COMPLETION_SENTINEL` in `loop.env`
6. Remove stale `.loop/COMPLETE`
7. Run loop again

The machinery never changes; only inputs do.

---

## 11. Your job: sit on the loop, not in it

Highest leverage:

1. **Engineer inputs** — spec, plan, prompt, gate
2. **Watch first 5–10 iterations** — catch wrong patterns early
3. **Fix inputs, not output** — sharpen prompt, add spec constraint, regenerate plan
4. **Verify at milestones** — trust but check risky pieces
5. **Never edit repo mid-run** — pause loop first

When the agent goes wrong, ask: *which input was ambiguous?*

---

## 12. Limits (honest)

Loop engineering is powerful, not universal:

- Requires a **verification oracle** — no ground truth, no loop
- Costs **tokens** — each iteration re-reads the project
- Punishes **vague goals** — rewards small, scoped, testable tasks
- **Weak gate → confident garbage** — the discipline is what makes it shippable
- **Subjective work** stays human (design, product calls, prose)

---

## References

- Geoffrey Huntley — [how-to-ralph-wiggum](https://github.com/ghuntley/how-to-ralph-wiggum)
- Anthropic — [ralph-loop plugin](https://claude.com/plugins/ralph-loop), [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- Alex L. Zhang — [Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/)
- arXiv — [RLM paper](https://arxiv.org/html/2512.24601v3)
- LangChain — [Dynamic Subagents](https://www.langchain.com/blog/introducing-dynamic-subagents-in-deep-agents)
- Anthropic — [Dynamic Workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- Claude Code — [Workflows docs](https://code.claude.com/docs/en/workflows)
- Cursor — [Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents)
- Claude Code — [Agent Teams](https://code.claude.com/docs/en/agent-teams)
- Open-Spek — [the Spek standard](https://github.com/open-spek/spek) (this template is its reference method)
- jsonq — [open-spek/jsonq](https://github.com/open-spek/jsonq) (first fully autonomous reference build)
- LibreDB — [libredb/libredb-database](https://github.com/libredb/libredb-database) (the original reference build this template was distilled from)
