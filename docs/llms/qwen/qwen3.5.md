# qwen3.5

`ollama pull qwen3.5:<size>` · sizes measured: 2b, 4b, 9b

Two of the three sizes pass everything. The one that does not is the smallest, and it
fails the same way every sub-4B model does.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 2b | 2.7 GB | ❌ `no-report` | ❌ `no-report` | ❌ `no-report` | 0/3 |
| **4b** | **3.4 GB** | ✅ 24s | ✅ 10s | ✅ | **3/3** |
| **9b** | **6.6 GB** | ✅ 25s | ✅ 16s | ✅ | **3/3** |

## 4b and 9b needed a runtime fix to reach 3/3

Both passed Investigate and Operate from the start and failed Analyze with
`no-answer`: they read the data, got the right result, and then called
`compose_report` without ever calling `present_answer`. The report landed with an
empty answer pane beside it, and the goal verifier scored the run as having answered
nothing.

The answer was one call away in both cases. The runtime now intercepts that
`compose_report` — the call is not executed, and the run is told to present the
result it already has first. Both models then present and report normally.

| | Before | After |
| --- | --- | --- |
| 4b Analyze | `no-answer` | ✅ `answered`, 5 tool calls |
| 9b Analyze | `no-answer` | ✅ `answered` |

## Why 2b fails

It calls tools eagerly — on the salary question it made **42 tool calls** — and then
writes its findings as prose instead of calling `compose_report`. Reminded once that
a run reports by calling the tool, it narrates again.

Compare [`qwen3:4b`](qwen3.md), an older generation at a smaller download, which
scores 3/3. Within Qwen, size predicts agent capability and generation does not.

```bash
ollama pull qwen3.5:4b
LLM_PROVIDER=ollama LLM_MODEL=qwen3.5:4b LLM_API_URL=http://localhost:11434/v1
```
