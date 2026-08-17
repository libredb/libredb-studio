# lfm2

`ollama pull lfm2:24b` · one size measured: 24b (14 GB)

An unproven family worth trying and, so far, the least reliable model measured. It
calls tools freely and finishes almost nothing.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 24b | 14 GB | ✅ *(fixed)* | ❌ `no-report` | ❌ `no-report` | 1/3 |

## It reads and then does not record

Every failure has the same shape: tools called, readings taken, findings written as
prose. On the analysis question it made **eleven** tool calls and composed no report.

| Workflow | Tool calls | Report |
| --- | --- | --- |
| Investigate | 4 | ❌ |
| Operate | 3 | ❌ |
| Analyze | 11 | ❌ |

The runtime reminds such a run once, and that rescued Investigate. It did not rescue
Analyze: the reminder was delivered after nine readings and the model narrated again.
So the reminder helps models that were one call short of reporting, and `lfm2` is
often further away than that.

## It is also unstable between runs

Investigate passed in one measurement round and failed in the next with no change to
the code or the machine — the same variance seen in
[`mistral-small3.2`](../mistral/mistral-small3.2.md), but wider. Treat any single
`lfm2` result as one sample.

Not recommended for agent mode today. Kept on these pages because the failure is
specific and recorded, and because a future release of the family may close it.
