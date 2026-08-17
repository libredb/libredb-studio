# qwen3

`ollama pull qwen3:<size>` · sizes measured: 0.6b, 1.7b, 4b, 8b, 14b

The family where the size threshold is visible in one table. The same generation,
the same training, the same tool-calling format — and 4b answers every workflow
while 1.7b answers none. Whatever agent work needs, it is not present at 1.7b and
is present at 4b.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 0.6b | 522 MB | — | ❌ `no-report` | ❌ `no-report` | 0/3 |
| 1.7b | 1.4 GB | ❌ `no-report` | ❌ `no-report` | ❌ `no-answer` | 0/3 |
| **4b** | **2.5 GB** | ✅ 27s | ✅ 36s | ✅ 56s | **3/3** |
| **8b** | **5.2 GB** | ✅ | ✅ 17s | ✅ 31s | **3/3** |
| 14b | 9.3 GB | not yet measured | | | |

## 4b is the recommendation for a modest machine

2.5 GB, and it does the whole job: it reads, it presents the result, it reports with
citations. On the salary question it made 5 tool calls and left an `answer-composed`
entry on the ledger — the thing a 0.6b run never produces.

It is also the counterexample to reading version numbers as quality: `qwen3:4b` is an
older generation than `qwen3.5:2b`, and it scores 3/3 where that one scores 0/3.

```bash
ollama pull qwen3:4b
LLM_PROVIDER=ollama LLM_MODEL=qwen3:4b LLM_API_URL=http://localhost:11434/v1
```

## Why the small sizes fail

They call tools. That is the surprise — `qwen3:0.6b` and `qwen3:1.7b` both invoke
`inspect_operations` correctly, with the right argument. What they will not do is
finish: having taken readings, they write their findings as prose instead of calling
`compose_report`, and a run that ends that way recorded nothing.

The runtime reminds such a run once, and these sizes narrate again rather than
reporting. The reminder rescues models that were one call short; these are not one
call short, they are answering in a different register entirely.

`qwen3:0.6b` is worth calling out because it is the most-downloaded Qwen model on
Hugging Face by a wide margin. It is an excellent small chat model. It is not an
agent.

## Ledger evidence

`qwen3:4b`, the salary question:

```
run-started -> context-captured -> statement-drafted
            -> tool-invoked (run_read_query) -> tool-completed
            -> answer-composed
            -> report-composed -> run-finished
```

`qwen3:1.7b`, the same question:

```
run-started -> context-captured -> tool-invoked x4 -> tool-completed x4
            -> run-finished    (stopReason: model-stopped, unmet: no-report)
```

Four readings taken, nothing recorded.
