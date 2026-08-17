# qwen3.6

`ollama pull qwen3.6:27b` · one size measured: 27b (17 GB)

Passes all three workflows — and is the clearest evidence on these pages that the
machine matters as much as the model.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 27b | 17 GB | ✅ 56s | ✅ 108s | ✅ 87s | **3/3** |

No small tags are published, same as [`qwen3.8`](qwen3.8.md). For a smaller Qwen see
[`qwen3`](qwen3.md) or [`qwen3.5`](qwen3.5.md).

## It scored 0/3 on the same machine an hour earlier

Every one of the three workflows failed with `model-timeout`. The ledger showed where
the 90-second per-turn ceiling went:

```
    0.0s  run-started
   42.0s  tool-invoked x4        <- turn 1 took 42s
  132.0s  run-finished           <- turn 2 hit exactly 90s and was cut
```

Lifting the ceiling temporarily to measure it showed turn 2 needed **91.4 seconds**.
The model was missing agent mode by 1.4 seconds.

The laptop was in low-power mode. Switched to high power, the same run passed:

| | Low power | High power |
| --- | --- | --- |
| one turn, small prompt | 20.6s | 4.6s |
| throughput | 10.3 tok/s | 28.9 tok/s |
| Investigate | ❌ `model-timeout` | ✅ 56s |
| Operate | ❌ `model-timeout` | ✅ 108s |
| Analyze | ❌ `model-timeout` | ✅ 87s |

No code changed. A per-turn timeout override was drafted and then not written,
because the number it was sized against turned out to be an artifact of the power
setting.

**If a 27B model times out for you, check the power mode before concluding anything
about the model.** On macOS: `pmset -g | grep powermode` — `2` is high power. Turn 2
of an agent run is the expensive one, because the tool results from turn 1 are in the
prompt by then.
