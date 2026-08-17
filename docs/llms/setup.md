# Running Agent mode against a local model

From nothing to a finished agent run, on your own machine, with no key and no traffic
leaving it.

## 1. Install Ollama and pull a model

```bash
# macOS
brew install ollama
ollama serve            # leave running

ollama pull qwen3:4b    # 2.5 GB, passes all three workflows
```

`qwen3:4b` is the smallest model measured that does the whole job. For the
alternatives and what each costs in disk, see the [index](README.md).

## 2. Point LibreDB Studio at it

In `.env.local`:

```bash
LLM_PROVIDER=ollama
LLM_MODEL=qwen3:4b
LLM_API_URL=http://localhost:11434/v1
```

`LLM_API_URL` must end in `/v1`: that is Ollama's OpenAI-compatible endpoint, which is
what the agent runtime posts to. The native `/api/chat` endpoint is not used.

No API key is needed. Nothing reaches a hosted provider on this path — what a run
sends and where is documented in [`../AGENT_DATA_FLOW.md`](../AGENT_DATA_FLOW.md).

Restart the server after editing the file; these are read server-side at startup.

## 3. Check the model can drive a run at all

Agent mode needs tool calling. A model that cannot call a tool will produce fluent
prose and answer nothing, so it is worth ten seconds to find out first:

```bash
curl -s http://localhost:11434/api/chat -d '{
  "model": "qwen3:4b",
  "messages": [{"role": "user", "content": "Check this database health."}],
  "tools": [{"type": "function", "function": {
    "name": "inspect_operations",
    "description": "Read live database operational state.",
    "parameters": {"type": "object",
      "properties": {"kind": {"type": "string", "enum": ["health"]}},
      "required": ["kind"]}}}],
  "stream": false
}' | grep -o '"tool_calls".\{0,120\}'
```

A model that is usable answers with a `tool_calls` array naming
`inspect_operations`. One that is not answers in prose — that is what every
`deepseek-r1` size does, and [its page](deepseek/deepseek-r1.md) has the detail.

The application runs its own capability probe before a run and refuses a model whose
tool calling is established as absent, so this check only saves you the wait.

## 4. Run one

Open Agent mode, pick a connection, and ask a question that needs the database. The
embedded SQLite sample is there by default.

A finished run leaves a report with cited claims. If a workflow presents answers, it
also leaves the result beside the report.

## When it does not work

| What you see | Where to look |
| --- | --- |
| Report with an empty answer pane | the model reported without presenting; see the verdict on the ledger |
| A run that ends having recorded nothing | `no-report` — the model narrated its findings. Common below 4B |
| `model-timeout` | one turn exceeded 90 seconds. Check the power mode first: `pmset -g \| grep powermode` |
| The model refuses, saying it has no tools | it may be unstable rather than incapable; see [`mistral-small3.2`](mistral/mistral-small3.2.md) |

Every run writes its ledger to `.workflow-data`, and that is the authority on what a
run actually did — which tools it called, what came back, and why it was scored the
way it was.

## Using something other than Ollama

`LLM_PROVIDER=custom` with `LLM_API_URL` pointing at any OpenAI-compatible endpoint
works the same way; `openai` and `gemini` take a key. All variables are documented in
[`.env.example`](../../.env.example).
