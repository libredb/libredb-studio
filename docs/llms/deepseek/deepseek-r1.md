# deepseek-r1

`ollama pull deepseek-r1:<size>` · sizes measured: 7b, 8b, 14b, 32b

**None of them can drive an agent run, and no configuration changes that.** Four
sizes, two endpoints, the same result each time: the model is given tools, thinks
about the question, and answers in prose without calling one.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 7b | 4.7 GB | ❌ | ❌ | ❌ | 0/3 |
| 8b | 5.2 GB | ❌ | ❌ | ❌ | 0/3 |
| 14b | 9.0 GB | ❌ | ❌ | ❌ | 0/3 |
| 32b | 19 GB | ❌ | ❌ | ❌ | 0/3 |

## What it does instead

Given `inspect_operations` and asked what is happening on the database, with the tool
declared in the request:

```
--- deepseek-r1:8b ---
  tool_calls : none
  thinking   : "Okay, user is asking about the health of a database. That's a pretty
                broad question..."
  content    : "To check the health of a database, I need to know which specific
                database you're referring to (e.g., MySQL, PostgreSQL)..."
```

It sees the tool, reasons about the request, and then asks a clarifying question. It
is treating the exchange as a conversation rather than as work to be done.

`deepseek-r1:32b` fails a step further out: rather than calling the tool it writes a
shell block, ` ```bash libredb_capability_probe -ack``` `, inventing a command line
for a tool it was handed a calling convention for.

## What was ruled out

This is not our client, not the endpoint, and not the prompt:

| Checked | Result |
| --- | --- |
| OpenAI-compatible endpoint (`/v1/chat/completions`) | no `tool_calls` |
| Native Ollama endpoint (`/api/chat`) | no `tool_calls` |
| Same request replayed with a control model | `gemma4:26b` calls the tool immediately |
| Short prompt, no system prompt | still no `tool_calls` |
| Four sizes | identical behaviour |

One hypothesis was tested and **disproved**: that Ollama's packaging was at fault,
because the `deepseek-r1` chat template contains no `.Tools` block while the tag
advertises `capabilities: ["tools"]`. Scanning all installed models killed it —
`gemma4:26b`, `qwen3.8` and `muse-glimmer` have no `.Tools` in their templates either,
and all three score 3/3. Recent Ollama renders tools outside the Go template, so the
template says nothing about capability.

The remaining explanation is the model itself. DeepSeek-R1 is a reasoning model
trained to think and then answer; the distills inherit that and not tool use.

## What to use instead

`deepseek-r1:8b` is a Qwen3 distill, so the closest working substitute at the same
size is the model it was distilled from:

```bash
ollama pull qwen3:8b     # 5.2 GB, 3/3
```

Or, smaller, [`qwen3:4b`](../qwen/qwen3.md) at 2.5 GB — also 3/3.
