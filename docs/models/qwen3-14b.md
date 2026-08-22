# `qwen3:14b`

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
| Median run | 39 |
| Slowest run | 151 |

Measured on one machine, an Apple Silicon laptop with the model loaded locally where the provider
is Ollama. Treat them as the shape of the answer rather than as a promise: a slower machine, a
colder cache or a larger database moves all of them. What they are good for is comparing the ten
against each other, since every figure here was taken the same way.

Runs are bounded the same way for every model — the shipped per-turn limit is 90 seconds, and a
run that cannot finish a turn inside it is ended rather than left hanging.

## What this model needs that the others do not

**`planStatementRetries: 1`**

The model this setting was written for. It locked five surfaces and lost plan four times out of five on one shortfall: its prose lists every table, both join tables and the key each relation travels on, and never writes a statement or the explicit `NO STATEMENT:` refusal the bar accepts.

## Running it

```bash
# Pull the weights, then tell LibreDB Studio to use them.
ollama pull qwen3:14b

LLM_PROVIDER=ollama
LLM_MODEL=qwen3:14b
OLLAMA_BASE_URL=http://localhost:11434/v1
```

Then point the agent at a connection and start a run. Nothing else is configured per model: the
tools, the prompts and the bars are the same for all ten.
