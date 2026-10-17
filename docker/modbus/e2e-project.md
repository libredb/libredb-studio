# Modbus and `playwright.config.ts`: what lands, and what the e2e job cannot run

Two things land in the config, and six of the spec's nine cases do not run in CI. Both are
measured below, because an earlier version of this file said the opposite of both.

## What lands

| in `playwright.config.ts` | why |
|---|---|
| a `chromium-modbus` project on the second server | the spec's Establish Connection probes the connection through `POST /api/db/test-connection`, which is rate limited |
| `modbus-provider` in the shared project's `testIgnore` | so the spec does not also run against the first server |

`tests/unit/e2e-project-servers.test.ts` holds both: `modbus-provider.spec.ts` is in its
`SECOND_SERVER_SPECS`, and it passes on this branch with **63 pass, 0 fail**.

**WHAT THIS FILE USED TO SAY, AND THE MEASUREMENT THAT CORRECTS IT.** It said the spec needs no
project block, because the second-server projects exist for the rate-limit bucket that **Test
Connection** spends and this spec never clicks Test Connection. The second half is true and the
conclusion is still wrong: the dialog has one probe for both buttons.
`src/hooks/use-connection-form.ts:1321-1343` says so in its own words - *"The one place the
connection is probed, for both buttons"* - and that place is `POST /api/db/test-connection`,
which `src/app/api/db/test-connection/route.ts:54` guards on the `query` bucket. So Establish
Connection spends exactly what Test Connection spends, and the project block is needed for the
reason `chromium-mtconnect` gives, not in spite of it.

The old text also quoted 57 passing cases for the project-servers test. It is 63 now; a number
quoted from a run that is no longer the branch's is a number that will be wrong again.

## What the e2e job cannot run

Six of the nine cases dial the device. **CI never serves it**, and this was measured rather
than assumed:

- the `e2e` job of `.github/workflows/ci.yml` has no `services:`, no compose command and no
  `docker run`: its steps are checkout, Bun, dependencies, Playwright browsers, the test run,
  the subpath run and the report upload;
- the Modbus live check of `docker/modbus/ci-step.yml` starts a container on 1502, but it is
  pasted into the **`functional-smoke` job**, which is not the job the Playwright projects run
  in, so pasting it changes nothing here;
- on the run of 2026-10-16 those six cases dialled `127.0.0.1:1502` and got
  `connect ECONNREFUSED` **eighteen times**, which is what turned the gate red.

So the spec asks the fixture whether it is there and **skips, naming the address**, rather than
failing where no device was ever meant to be. `e2e/mtconnect-provider.spec.ts` and
`e2e/opcua-screens.spec.ts` guard their live cases the same way.

MEASURED both directions, locally, with the fixture of `docker/modbus/README.md` on 1502:

| run | result |
|---|---|
| fixture up | **9 passed**, 0 skipped |
| `MODBUS_E2E_TARGET=127.0.0.1:1599` (nothing listening) | **6 skipped, 3 passed** |

The three that keep running read the dialog alone: Modbus is offered as a driver, it offers no
connection string, and it says Studio cannot write to a device.

**AND WHAT A SKIP COSTS.** The `e2e` job's own comment records the price: a spec guarded by
`test.skip(!dockerAvailable())` once *vanished* there, and PR #435 turned 0 skipped into 1
skipped with CI still green. That is why `functional-smoke.spec.ts` is excluded by name instead.
The same answer is not available here: no job starts this fixture, so the alternatives are a
skip that says which address it wanted, or a red that measures nothing about the product. The
count is written above so that a later run with a different one can be seen to differ.

`MODBUS_E2E_TARGET` overrides the address, the way `MTCONNECT_E2E_ORIGIN` overrides the agent's.
It is read in one place, so the probe and the two boxes the cases type into cannot name
different ports.
