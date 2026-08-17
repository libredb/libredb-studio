# qwen3.8

`ollama pull qwen3.8` · one size published: 27b (17 GB)

Passes all three workflows. Worth reading for what it took to get there: this model
was scored as answering nothing for weeks, and the model was never the problem.

## Results

| Size | Disk | Investigate | Operate | Analyze | Score |
| --- | --- | --- | --- | --- | --- |
| 27b (`latest`) | 17 GB | ✅ 49.3s | ✅ 90.0s | ✅ 62.0s | **3/3** |

There is no small `qwen3.8`. `4b`, `8b` and `12b` tags do not exist; the registry
serves `latest` and `27b`, which are the same 27.3B model. For a smaller Qwen see
[`qwen3`](qwen3.md) or [`qwen3.5`](qwen3.5.md).

## It was being refused, not failing

On the salary question it read the data, wrote the right query, got the right figure,
and was scored `no-answer`. The rail showed a report with nothing beside it.

`present_answer` had been called three times, each with a correct artifact id and a
correct chart spec — right type, right x, right y, columns spelled as the result
spells them. Each call was refused, because the model had serialized the nested
object instead of nesting it:

```json
{"artifact": "67fb154a-…",
 "presentation": "{\"kind\": \"chart\", \"spec\": {\"type\": \"bar\", …}}"}
```

A string holding an object, where the schema wanted the object. None of it was
visible: a refused ledger-only tool records no event, so the run's ledger could not
tell "never tried" from "tried and was refused". The only surviving trace was the
model saying so in its closing prose — *"the presentation call is being persistently
rejected despite conforming to the declared shape"*. It was conforming; only the
encoding was wrong.

The tool now reads such a payload back once before validating, through the same
schema, so nothing is admitted that would not have been admitted written properly.
`qwen3.8` went from `no-answer` in 84.9s to **answered in 62.0s**.

## Answer quality

Asked which part of the company costs most in salary, it reported 14,121,582 for
Development — the most defensible figure of the seven models compared by hand. It
joined through `current_dept_emp`, the strictest reading of "current", and said in
its claims which reading it had used. Two models that also passed report inflated
totals because they double-count employees who changed department, or include people
who have left.

Passing and being right are different things, and only one of them is checked.
