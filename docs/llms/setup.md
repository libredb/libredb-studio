# Configuring a model for Agent mode

From nothing to a finished agent run: which model the agent uses, and how you tell it.

**There is no settings screen for this, deliberately.** The model, the provider and any key
are environment variables read at server startup, which is how everything else in this product
is configured. It keeps the choice with whoever operates the server rather than turning it into
a permission to grant, revoke and audit per user.

Twenty-two models are supported — every one of them clears all six agent surfaces five consecutive
times. They are listed with their measured durations in the [index](README.md).

## A local model, through Ollama

Twenty-one of the twenty-two run locally, with no key and no traffic leaving the machine.

```bash
# macOS
brew install ollama
ollama serve            # leave running

ollama pull qwen3:4b    # 2.5 GB, and it clears every surface
```

Then in `.env.local`:

```bash
LLM_PROVIDER=ollama
LLM_MODEL=qwen3:4b
LLM_API_URL=http://localhost:11434/v1
```

`LLM_API_URL` must end in `/v1`: that is Ollama's OpenAI-compatible endpoint, which is what the
agent runtime posts to. The native `/api/chat` endpoint is not used.

No API key is needed, and nothing reaches a hosted provider on this path — what a run sends and
where is in [`../AGENT_DATA_FLOW.md`](../AGENT_DATA_FLOW.md).

## A hosted model

One of the twenty-two is hosted, and it is configured the same way with one line more:

```bash
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.5-flash-lite
LLM_API_KEY=<your key>
```

The key is read server-side only. It is never sent to the browser and never written to a run's
ledger, so a key configured here does not travel with the artefacts a run produces.

Restart the server after editing the file: these are read at startup, so an edit under a running
server changes nothing until it restarts.

## Checking a model this list does not cover

Agent mode needs tool calling, and a model that cannot call a tool produces fluent prose and
answers nothing. Ten seconds tells you which you have:

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

A usable model answers with a `tool_calls` array naming `inspect_operations`. One that cannot
answers in prose.

That is not a refusal by itself: the application drops such a model to a prose tool protocol
rather than turning it away, and decides per endpoint rather than from a list of names. What it
does refuse is a model whose tool calling is established as absent AND which cannot be driven in
prose either.

Measuring one properly — six surfaces, five runs each — is
[`testing-your-own.md`](testing-your-own.md).

## Run one

Open Agent mode, pick a connection, and ask a question that needs the database. The embedded
SQLite sample is there by default.

A finished run leaves a report whose claims cite what it read. On the surfaces that answer with a
result, it leaves the result beside the report.

## When it does not work

| What you see | Where to look |
| --- | --- |
| A report with an empty answer pane | the model reported without presenting; the ledger's verdict names it `no-answer` |
| A run that ends having recorded nothing | `no-report` — the model narrated its findings instead of filing them |
| `model-timeout` | one turn exceeded 90 seconds. Check the power mode first: `pmset -g \| grep powermode` |
| Runs that pass alone and fail in a batch | sustained load throttles the machine; a measured sweep of nine models slowed five of one model's six surfaces by half again |

Every run writes its ledger to `.workflow-data`, and that is the authority on what a run did.
