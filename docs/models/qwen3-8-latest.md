# `qwen3.8:latest`

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

The slowest of the ten, and the widest spread: a median run takes a minute and the slowest took nearly six. It reaches the same verdicts as models six times faster, so the choice between them is about waiting rather than about capability.

## How long it takes

| | Seconds |
| --- | --- |
| Median run | 62 |
| Slowest run | 347 |

Measured on one machine, an Apple Silicon laptop with the model loaded locally where the provider
is Ollama. Treat them as the shape of the answer rather than as a promise: a slower machine, a
colder cache or a larger database moves all of them. What they are good for is comparing the ten
against each other, since every figure here was taken the same way.

Runs are bounded the same way for every model — the shipped per-turn limit is 90 seconds, and a
run that cannot finish a turn inside it is ended rather than left hanging.

## What this model needs that the others do not

Nothing. It was measured at the defaults — temperature 0, top_p 1, and a ceiling of twelve unreported calls — and it clears every surface on them.

Its profile file exists anyway, holding those values explicitly, because a default is a shared value: a later change to one would silently invalidate the numbers above, and a model that states what it was measured with cannot be moved by it.

## Running it

```bash
# Pull the weights, then tell LibreDB Studio to use them.
ollama pull qwen3.8:latest

LLM_PROVIDER=ollama
LLM_MODEL=qwen3.8:latest
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Then point the agent at a connection and start a run. Nothing else is configured per model: the
tools, the prompts and the bars are the same for all ten.
