# What Stops a Small Language Model From Driving a Database Agent

An empirical study of why small open-weight models fail when driving the tool-calling agent in
LibreDB Studio, and of how much of that failure was ours rather than theirs.

## Status

| | |
|---|---|
| Dataset | published, [10.57967/hf/10485](https://doi.org/10.57967/hf/10485) |
| Preprint | announced 2026-09-21, cs.SE primary with cs.DB cross-list |
| arXiv id | [2609.21341](https://arxiv.org/abs/2609.21341) |

## Layout

| Path | What it is |
|---|---|
| `paper.tex` | The paper. The only source file arXiv compiles. |
| `paper.pdf` | A local build, for reading. arXiv builds its own from the source. |
| `anc/` | Ancillary files. arXiv publishes these beside the paper without compiling them. |
| `anc/verify.py` | Regenerates every figure in the paper from the released corpus. The single copy; `build.sh` ships this one. |
| `anc/score.py` | The scorer, with the three modes the paper compares. |
| `anc/hf-export.py` | Builds the released corpus from the raw run ledgers. |
| `anc/refused-call-arguments*.jsonl` | The captured arguments of refused tool calls, the basis of Section 6. |
| `anc/sweep-logs/` | 160 per-cell run logs. |
| `submission/arxiv.md` | Every form field, with the reasoning behind each choice. |
| `submission/abstract.txt` | The abstract as plain ASCII, for arXiv's metadata field, which does not render TeX. |
| `dist/` | Build output. Not committed. |

## Building and checking

    ./build.sh                    # package only
    ./build.sh path/to/runs.jsonl # verify first, then package

The verifier prints one line per figure and exits non-zero if any disagrees. Get the corpus with:

    hf download libredb/database-agent-runs runs.jsonl --type=dataset --local-dir .

## Two things worth knowing before editing

**The sweep logs record process exit, not whether a run answered.** A log line reading
`status=succeeded` belongs to runs that reported nothing. Scores must come from joining the log's
run identifiers against the corpus and reading each run's verdict. Getting this wrong put a wrong
score in the paper once; `verify.py` now rebuilds the intervention table that way so it cannot
happen again.

**The taxonomy is order-dependent.** 231 losses both ran out of clock and invoked no tool, so they
satisfy two class definitions at once. The paper adopts clock-first, states the alternative, and
reports both. Changing that order changes which class is smallest, so do not change it silently.
