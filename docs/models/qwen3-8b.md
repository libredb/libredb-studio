# `qwen3:8b`

Runs every agent surface. **30 of 30 measured runs passed**, five consecutive passes on each of
the six surfaces, which is what this project counts as supported.

| Surface | Result |
| --- | --- |
| Investigate | 5 / 5 |
| Optimize | 5 / 5 |
| Assess | 5 / 5 |
| Operate | 5 / 5 |
| Analyze | 5 / 5 |
| Plan | 5 / 5 |

Served through **Ollama**.

## How long it takes

| | Seconds |
| --- | --- |
| Median run | 32 |
| Slowest run | 132 |

Measured on one machine, an Apple Silicon laptop with the model loaded locally where the provider
is Ollama. Treat them as the shape of the answer rather than as a promise: a slower machine, a
colder cache or a larger database moves all of them. What they are good for is comparing the ten
against each other, since every figure here was taken the same way.

Runs are bounded the same way for every model — the shipped per-turn limit is 90 seconds, and a
run that cannot finish a turn inside it is ended rather than left hanging.

## What this model needs that the others do not

**`perWorkflow: { query-optimization: { temperature: 0.8, top_p: 0.9 } }`**

The only sampled cell in the product, and the measurement that made per-model settings necessary at all. Pinning temperature to 0 won five cells across the fleet and cost this one: at 0.8 the model opened with `inspect_plan` on three runs of five and won all three; at 0 it opened with `inspect_schema` ten times out of ten and lost every one. Determinism pinned it to the losing branch. Scoped to the one surface that needed it — the other five lock deterministically.

## Running it

```bash
# Pull the weights, then tell LibreDB Studio to use them.
ollama pull qwen3:8b

LLM_PROVIDER=ollama
LLM_MODEL=qwen3:8b
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Then point the agent at a connection and start a run. Nothing else is configured per model: the
tools, the prompts and the bars are the same for all ten.
