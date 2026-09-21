# What Stops a Small Language Model From Driving a Database Agent

An empirical study of why small open-weight models fail when driving the tool-calling agent in
LibreDB Studio, and of how much of that failure was ours rather than theirs.

Authors: Cevheri Bozoglan, Yusuf Gundogdu, Abdullah Kaya, Koray Sirin.

## Contents

- [Status](#status)
- [Corpus at a glance](#corpus-at-a-glance)
- [Layout](#layout)
- [Building and checking](#building-and-checking)
- [Three things worth knowing before editing](#three-things-worth-knowing-before-editing)
- [Citation](#citation)
- [Questions or corrections](#questions-or-corrections)

## Status

| | |
|---|---|
| Dataset | published, [10.57967/hf/10485](https://doi.org/10.57967/hf/10485) |
| Preprint | announced 2026-09-21, cs.SE primary with cs.DB cross-list |
| arXiv id | [2609.21341](https://arxiv.org/abs/2609.21341) |
| License | CC BY 4.0 |

## Corpus at a glance

Eleven days, 39 open-weight models served locally plus one hosted control, 8,199 runs, 110,711
ledger events, 14,008 refused tool calls. All of it is in the released dataset above.

The six task surfaces are investigate, analyze, plan, optimize, operate and assess; the sweep logs
under `anc/sweep-logs/` are named `<model>-<surface>.log`.

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

`build.sh` writes `libredb-arxiv-submission.tar.gz` into `dist/`: `paper.tex` plus `anc/` (verifier,
scorer, exporter, argument captures, 160 sweep logs). That is the file to upload, not `paper.pdf`;
arXiv rejects a PDF built from LaTeX.

The verifier prints one line per figure and exits non-zero if any disagrees. Get the corpus with the
[`huggingface_hub` CLI](https://pypi.org/project/huggingface-hub/) (`pip install -U
"huggingface_hub[cli]"` if `hf` is not already on your PATH):

    hf download libredb/database-agent-runs runs.jsonl --type=dataset --local-dir .

## Three things worth knowing before editing

**The sweep logs record process exit, not whether a run answered.** A log line reading
`status=succeeded` belongs to runs that reported nothing. Scores must come from joining the log's
run identifiers against the corpus and reading each run's verdict. Getting this wrong put a wrong
score in the paper once; `verify.py` now rebuilds the intervention table that way so it cannot
happen again.

**The taxonomy is order-dependent.** 231 losses both ran out of clock and invoked no tool, so they
satisfy two class definitions at once. The paper adopts clock-first, states the alternative, and
reports both. Changing that order changes which class is smallest, so do not change it silently.

**An uncapped context window looks like a hang.** With no context cap, one 7.1 GB model was
admitted at its full 262,144-token window and held 51 GB on a 64 GB machine. In any ordinary log
that run is indistinguishable from a model that timed out; we believe this confound affects
published local-model benchmarks generally, ours included.

## Citation

    @misc{libredb2026databaseagent,
      title  = {What Stops a Small Language Model From Driving a Database Agent},
      author = {Bozoglan, Cevheri and Gundogdu, Yusuf and Kaya, Abdullah and Sirin, Koray},
      year   = {2026},
      eprint = {2609.21341},
      archivePrefix = {arXiv},
      primaryClass  = {cs.SE},
      url    = {https://arxiv.org/abs/2609.21341}
    }

## Questions or corrections

Open an issue on [libredb/libredb-studio](https://github.com/libredb/libredb-studio/issues) and
mention this directory.
