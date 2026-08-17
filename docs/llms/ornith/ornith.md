# ornith

`ollama pull ornith:9b` · one size measured: 9b (5.6 GB)

An unproven family that passes everything, quickly, at a size a laptop can hold. One
of the two models worth reaching for first on modest hardware.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| **9b** | **5.6 GB** | ✅ 14s | ✅ 26s | ✅ 21s | **3/3** |

Every workflow inside half a minute, including the analysis question, where it read
the data, presented the result and reported with citations. No runtime fix was needed
for any of it.

```bash
ollama pull ornith:9b
LLM_PROVIDER=ollama LLM_MODEL=ornith:9b LLM_API_URL=http://localhost:11434/v1
```

## Why it is here

It was pulled as a deliberate long shot — a family with no track record for this
workload — on the reasoning that a user browsing the model library will try exactly
such a model, so the docs should say what happens when they do. It scores 3/3.

For an even smaller download at the same score, see
[`qwen3:4b`](../qwen/qwen3.md) at 2.5 GB. `ornith:9b` has more headroom on the
analysis question.
