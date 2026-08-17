# granite4.1

`ollama pull granite4.1:<size>` · sizes measured: 3b, 8b, 30b

The fastest family measured by a wide margin — and the one where speed does not carry
over to the analysis question.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 3b | 2.1 GB | ✅ 2.8s | ✅ 1.3s | ❌ `no-report` | 2/3 |
| 8b | 5.3 GB | ✅ 4.0s | ✅ 2.9s | ❌ `empty-evidence` | 2/3 |
| **30b** | **17 GB** | ✅ 6.7s | ✅ 23.7s | ✅ 19.9s | **3/3** |

`granite4.1:3b` finishing Operate in **1.3 seconds** is the fastest run recorded on
any model here. For questions that are only about the engine's own state, at 2.1 GB,
that is hard to beat.

## The two smaller sizes fail differently

**3b — `no-report`.** It reads, then writes its findings as prose instead of calling
`compose_report`. The runtime reminds such a run once; this one narrates again.

**8b — `empty-evidence`.** More interesting: it composes a report, but the claims
cite nothing the run established. This is the citation contract doing its job rather
than a defect. A report whose claims are not backed by a reading this run took is
refused, and that refusal is the feature — it is what stops a confident summary of a
database nobody looked at.

Neither is fixable by a nudge. `empty-evidence` in particular should not be: loosening
it would let exactly the failure the contract exists to prevent through.

## Recommendation

Use `granite4.1:30b` if you want the whole workflow set. Use `granite4.1:3b`
deliberately, for operational questions only, where its speed is remarkable.
