# `granite4.1:8b`

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

The fastest local model of the ten, matching the hosted one at a ten-second median.

## How long it takes

| | Seconds |
| --- | --- |
| Median run | 10 |
| Slowest run | 21 |

Measured on one machine, an Apple Silicon laptop with the model loaded locally where the provider
is Ollama. Treat them as the shape of the answer rather than as a promise: a slower machine, a
colder cache or a larger database moves all of them. What they are good for is comparing the ten
against each other, since every figure here was taken the same way.

Runs are bounded the same way for every model — the shipped per-turn limit is 90 seconds, and a
run that cannot finish a turn inside it is ended rather than left hanging.

## What this model needs that the others do not

**`refusalExamples: true`**

When a tool refuses this model's call, the refusal carries a worked example of the call built from the run's own ledger — real artifact ids, correctly shaped. The measured failure it answers is a model that knows what it wants to record and cannot build the object that carries it, which produced loops of the same refusal repeated until the run ran out.

## Running it

```bash
# Pull the weights, then tell LibreDB Studio to use them.
ollama pull granite4.1:8b

LLM_PROVIDER=ollama
LLM_MODEL=granite4.1:8b
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Then point the agent at a connection and start a run. Nothing else is configured per model: the
tools, the prompts and the bars are the same for all ten.
