/**
 * `qwen3:8b` — five surfaces deterministic, `query-optimization` sampled.
 *
 * The first model to earn a file of its own, and the measurement that gave it one is the
 * reason this directory exists at all.
 *
 * The loop set no temperature for a long time, so every run inherited Ollama's 0.8. Pinning
 * it to 0 won five cells across the fleet — a cell locks only at 5/5 consecutive passes, so
 * the bar is a variance test as much as a capability one — and it cost this model its
 * `query-optimization` cell, 3/5 down to 0/5.
 *
 * All fifteen of its ledgers on that surface were read. The opening move decides the run:
 *
 *   opened with `inspect_plan`    → 3 of 3 answered
 *   opened with `inspect_schema`  → 1 of 12 answered
 *
 * At 0.8 it opened with `inspect_plan` on 3 of 5 runs and won all three. At 0 it opened with
 * `inspect_schema` on 10 of 10 and lost every one, with near-identical timings (+7.7–9.8s,
 * then +4.8–6.5s). Determinism did not make it worse at optimization; it pinned it to the
 * losing branch instead of letting it wander into the winning one.
 *
 * WHY THE LOSING BRANCH LOSES, which is the defect this profile works around rather than
 * fixes: the workflow's first rule orders `inspect_schema` with `kind="indexes"`, the sample
 * database declares no secondary index anywhere, and the zero-row read is answered "There is
 * no object of that name in this database" — false, since the object exists and simply has no
 * indexes. Nothing is written to the ledger for it either, so the turn is invisible as well
 * as wasted. 218 of 267 catalog calls across 133 optimization runs are that shape.
 *
 * So this override is honest but temporary. When that refusal tells the truth, the losing
 * branch stops being a trap and this file should be re-measured at the default before it is
 * kept. That is written here rather than in a backlog because the next person to read it will
 * be reading this file.
 */

import { BASELINE_NOTICES } from "./notices";
import type { AgentModelProfile } from "./profile";

export const QWEN3_8B: AgentModelProfile = {
  measured:
    "query-optimization: 3/5 at temperature 0.8, then 1/5 and 0/5 at temperature 0. All 15 " +
    "ledgers on that surface read: opening with inspect_plan answers 3/3, opening with " +
    "inspect_schema answers 1/12, and at temperature 0 it opens with inspect_schema 10 times " +
    "out of 10. Its other five surfaces lock 5/5 deterministically, so the override is scoped " +
    "to this one cell and not to the model.",
  perWorkflow: { "query-optimization": { temperature: 0.8, topP: 0.9 } },
  notices: { ...BASELINE_NOTICES },
};
