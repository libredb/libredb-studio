# nemotron-3.5-lightning

`ollama pull nemotron-3.5-lightning:30b` · one size measured: 30b (25 GB)

Passes all three workflows, and does it fast for a 30B model.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| **30b** | **25 GB** | ✅ 14s | ✅ 15s | ✅ 21s | **3/3** |

Consistent across the set — 14 to 21 seconds — where several other large models vary
by a factor of five between workflows. On the analysis question it read the data,
presented the result and reported, with no runtime fix required.

The largest download on these pages at 25 GB, so it earns its place only where the
disk and memory are there. At that size [`gemma4:26b`](../gemma/gemma4.md) does the
same job in 17 GB and is faster on Investigate.

## Why it is here

The second unproven family tried on purpose, after [`ornith`](../ornith/ornith.md).
Both score 3/3, which is the argument for testing outside the well-known names rather
than assuming the familiar ones are the capable ones.
