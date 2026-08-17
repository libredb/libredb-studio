# gemma4

`ollama pull gemma4:<size>` · sizes measured: 12b, 26b

Both sizes pass all three workflows, and 26b is the fastest large model measured.
Nothing here needed a runtime fix.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| **12b** | **7.6 GB** | ✅ 21s | ✅ 72s | ✅ 119s | **3/3** |
| **26b** | **17 GB** | ✅ 6.5s | ✅ 12.0s | ✅ 25.6s | **3/3** |

26b is not just larger, it is faster on this workload: 25.6s on the analysis question
against 119s for 12b. The larger model spends fewer turns getting there.

```bash
ollama pull gemma4:26b
LLM_PROVIDER=ollama LLM_MODEL=gemma4:26b LLM_API_URL=http://localhost:11434/v1
```

## Answer quality

On the salary question, 26b reported 16,171,239 for Development. Reproduced by hand,
that figure double-counts 103 employees who changed department: it joins through
`dept_emp` rather than `current_dept_emp`, so anyone who moved is counted twice.

The run passes — it read the data, presented a result and cited it, which is what the
verifier checks. Whether the join was the right one is not something any automated
check on this workload can see. [`qwen3.8`](../qwen/qwen3.8.md) got the more
defensible figure and was, at the time, the one being scored as having failed.

Treat a passing run as a run that did the work, not as a run that was right.

## Note on the chat template

`gemma4` ships without a `.Tools` block in its Ollama chat template and calls tools
perfectly. If you are debugging a model that will not call tools, the template is not
where the answer is — see [`deepseek-r1`](../deepseek/deepseek-r1.md).
