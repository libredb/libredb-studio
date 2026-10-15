# MTConnect and `playwright.config.ts`: already landed, and one skip that never turns into a run

Unlike the other four engines of this round, this one **does** take a project block, and it is
already in the branch. This file says what is there, why, and the one thing about it that is not
finished.

## What is in `playwright.config.ts`, and why

| Where | What | Why |
|---|---|---|
| `chromium` project, `testIgnore` | `mtconnect-provider` | so the shared server does not also run it |
| projects | `chromium-mtconnect`, `baseURL` = the second server (`E2E_OFFLINE_PORT`, 3010) | the spec drives **Establish Connection** |
| `tests/unit/e2e-project-servers.test.ts` | `"mtconnect-provider.spec.ts"` in `SECOND_SERVER_SPECS` | holds the two rows above to each other |

The second server exists for the reason the config states: a spec that establishes a connection
spends the shared account's per-process rate-limit bucket, and ~30 specs replaying "fresh login"
against one server exhaust it. A spec that only opens the dialog does not need one - `modbus` and
`netconf` deliver no project block at all for exactly that reason - and this spec does more.

MEASURED on `69093997a`: `bun tests/run-tests.ts tests/unit/e2e-project-servers.test.ts` → **60
pass**. That test is what makes the three rows one fact rather than three, and it was planted to
check it can fail: with `|mtconnect-provider` taken out of the `testIgnore` pattern the run is 59
pass 1 fail, and the failing case names the spec -

```
(fail) specs that need rate-limit counters of their own run against the second server
       > mtconnect-provider.spec.ts is left out of the shared chromium project
```

## What the spec needs

Five cases. **Four need nothing but a browser** - the driver is offered once, the port prefill and
the three fields, the absence of a credential box and of a connection string, and the sentence
that read-only cannot be turned off. The fifth connects to a real agent and reads a moment the
buffer still holds, which is the defect that made the provider useless for its own headline.

```sh
export MTCONNECT_E2E_ORIGIN=http://127.0.0.1:17322   # optional; this is the default
```

The fifth case asks `/probe` first and **skips with its reason** when nothing answers. A skip is a
third state and not a pass: a run without the agent has measured the dialog and nothing else, and
a step that reports that as a green suite is reporting something it did not measure.

## The one thing that is not finished

`docker/mtconnect/ci-step.yml` starts the fixture and publishes it on **`127.0.0.1:17322`**, which
is exactly the origin this spec dials by default. It looks as though the live case would therefore
run in CI. MEASURED against the two files, it will not:

- the step carries `trap 'docker rm -f libredb-ci-mtconnect libredb-ci-mtconnect-adapter …' EXIT`,
  so **the fixture does not outlive the step**;
- the e2e job runs the suite in a step of its own, `bunx playwright test --grep-invert "Functional
  smoke"`, which is not that step.

So wherever the provider step is placed in that job, the agent is gone before or after Playwright
runs, never during, and the fifth case skips every time. Nothing is wrong in either file on its
own - this is the seam between them, and it is the kind of gap that reads as green.

Three ways out, for whoever applies the block to pick from. They are not equal:

1. **Run the spec inside the step's own lifetime**, before the trap fires:
   `bunx playwright test e2e/mtconnect-provider.spec.ts --project=chromium-mtconnect`. It measures
   the case and costs one more Playwright invocation.
2. **Start the compose services for the whole e2e job** and let the suite's single invocation
   cover it. More faithful to how the other specs run, and more to wire.
3. **Leave it skipping and say so in the job's output**, the way the step already says
   `MEASURED NOTHING` when the fixture does not come up. Cheapest, and it keeps the log honest
   rather than making the case run.

What should not happen is the fourth option, which is what the files do today: the case skips and
no line anywhere says it did. The step already has the right instinct for its own checks -
`MTCONNECT_LIVE_REQUIRED=1` turns a live-check skip into a failure, and its own comment records
that without the flag "a step that reached no agent reported success". The e2e case has no
equivalent.

## Where the spec can be verified, and where it cannot

MEASURED 2026-10-15 on this machine: `bunx playwright test` cannot load **any** spec in this
repository - `mtconnect-provider.spec.ts`, `modbus-provider.spec.ts`, any of them. Playwright
reports `AggregateError: N errors building <spec>` and swallows the causes; building the same file
with `bun build` prints them:

```
error: Could not resolve: "chromium-bidi/lib/cjs/bidiMapper/BidiMapper"
    at node_modules/playwright-core/lib/coreBundle.js:44826
```

`playwright-core` declares no dependencies and ships no copy of that package; under Node the
`require` fails at call time behind a guard, while Bun's bundler resolves it while building, and
this machine has no Node, so Playwright runs under Bun. It is not the spec's doing and not this
branch's.

**UNMEASURED, and worth someone checking:** CI's e2e job runs `bunx playwright test` too. Either
something differs there or that job is loading no specs. I did not measure CI and am not claiming
it is broken - only that the local failure has nothing to do with the specs and the same command
is what CI runs.

Verification here was therefore done in a Linux container with Node and the browsers
(`mcr.microsoft.com/playwright:v1.64.0-noble`), with the fixture reached by name on the compose
network, which is the shape used for the NETCONF spec in the same round.
