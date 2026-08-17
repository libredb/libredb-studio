# muse-glimmer

`ollama pull muse-glimmer` · one tag: `latest` (18 GB)

Passes all three workflows. Reached that score through the same fix as
[`qwen3.8`](../qwen/qwen3.8.md), which is what makes it interesting: two unrelated
model families were losing runs to one encoding detail.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| latest | 18 GB | ✅ 90.4s | ✅ 69.4s | ✅ *(fixed)* | **3/3** |

The slowest passing model measured — 90.4s on Investigate, where
[`gemma4:26b`](../gemma/gemma4.md) takes 6.5s at a similar size. It finishes, but a
run is a wait.

## The fix it needed

Like `qwen3.8`, it called `present_answer` with the nested `presentation` object
serialized as a string rather than nested. Every call was refused as invalid input,
no event was written for the refusal, and the run was scored `no-answer` — a report
with an empty answer beside it.

Two model families making the identical mistake is why this was treated as a
compatibility gap rather than a quirk of one model: the tool now reads such a payload
back once, through the same schema, and `muse-glimmer` answers.

Before: `no-answer` after 234.4s. After: **answered**.
