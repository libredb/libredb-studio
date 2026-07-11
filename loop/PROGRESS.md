# Progress Log (lab notebook)

> Append-only during the loop. This file is the loop's cross-iteration memory: the next
> fresh-context iteration learns dead ends, pinned decisions, and known limitations ONLY from here
> and from git history. Thin entries starve later iterations — write decision-record grade notes.

## Entry anatomy (follow this shape)

```markdown
### YYYY-MM-DD — {{issue # and title}} (DONE | BLOCKED | NEEDS-INFO)

- Tests first: {{suite/file, N new cases}}; watched them fail RED ({{the actual failure message}})
  before implementing.
- {{What was built or changed — one or two factual sentences.}}
- DECISION — {{the decision, pinned}}: {{rationale in one or two sentences; what was rejected and
  why}}. (add "flagged for human review" when non-obvious)
- KNOWN LIMITATION (recorded): {{honest deferral or edge left open, and why it is acceptable now}}.
- Gate: typecheck OK, lint clean, {{N}} tests pass (was {{M}}; +{{K}}), build OK.
- Next: {{the single next task, per the plan}}.
```

Rules:

- Record decisions WITH their reasoning. A bare "chose X" cannot stop a later fresh-context
  iteration from re-litigating X; the rationale can.
- Record failures and dead ends explicitly — preventing re-attempts is this file's whole purpose.
- Record known limitations at the moment you accept them, not when they bite.
- Tag anything a human should re-check with "flagged for human review".
- Include the gate numbers (test count delta) so progress is measurable, not narrated.
- `needs-info` triage evaluations (step 0f) get their own entry too — quote the reply verbatim.

---

## Log

### 2026-07-11 — Milestone setup (DONE, human)

- Plan hand-authored directly from issues #132, #133, #134, #135, #137 — planning mode was not
  run since the scope was already fully known and fixed before the loop started.
- Order chosen: #134, #135 (both touch the packaging wrapper bind/data-dir logic, kept adjacent
  to reuse warm context), then #132, #133 (npx/tarball), then #137 (Helm, largest/most distinct).
- Next: #134.
