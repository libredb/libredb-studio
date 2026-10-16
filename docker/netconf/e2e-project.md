# NETCONF and `playwright.config.ts`: nothing to land, and two variables to set

`e2e/netconf-provider.spec.ts` needs **no project block and no `testIgnore` entry**. The
second-server projects exist for one reason, which the config states: a spec that drives **Test
Connection** spends the shared account's per-process rate-limit bucket, and ~30 specs replaying
"fresh login" against one server exhaust it. This spec never clicks Test Connection. It signs in,
opens the dialog, and in its second group establishes one connection and runs one read, which is
what `functional-smoke.spec.ts` does on the shared server.

It needs no entry in `SECOND_SERVER_SPECS` either. The `chromium` project's `testIgnore` names
the specs that run elsewhere and this is not one of them, so it is picked up by the default
project with no change to that file.

**What would change this.** If the spec ever asserts a Test Connection outcome - the refusal a
wrong fingerprint gets, say, which is a real thing to want for an engine whose `connect()` dials
and whose pin is checked during the handshake - it takes a second server at that moment, and the
entry belongs here then.

**And one measurement that qualifies the reasoning above.** Not clicking Test Connection is what
keeps this spec off a second server, but it is not the whole of what spends the bucket. MEASURED
2026-10-15, running this spec and `modbus-provider.spec.ts` in one `chromium` run with Playwright's
default worker count: four of the cases in this file's second group failed, and the dialog said why
- **"Too many requests. Try again in 46 seconds."** Run one at a time, each is green: 8 of 8 here
and 9 of 9 there. The arithmetic is the config's own: every case signs in afresh in its
`beforeEach`, each fresh login auto-hydrates about 7 slots, 17 cases is ~119 against a budget of
120 a minute, and locally they land inside one window.

So establishing a connection and signing in per case is enough on its own, without Test Connection.
**CI runs `workers: 1`, which spreads the same load over time - I am not claiming this breaks in
CI, I did not measure CI.** What it does mean is that a second connecting spec added to this
project, or a local run of several at once, is the thing to watch - and that a red in those four
cases is worth reading before it is believed, because the sentence on the page names the cause.

## The two variables, and what happens without them

The spec has two groups and only the first runs unconditionally.

| Group | Needs | Without it |
|---|---|---|
| `NETCONF in the connection dialog` | nothing | runs; this is the guard against the field that was never drawn |
| `a read of the fixture, as a reader sees it` | the fixture and two variables | **skipped, with its reason printed** |

```sh
export NETCONF_E2E_FINGERPRINT="$(ssh-keyscan -T 5 -p 1830 127.0.0.1 2>/dev/null | ssh-keygen -lf - | awk '{print $2}')"
export NETCONF_E2E_PASSWORD=...          # the read-only account named in docker/netconf/README.md
export NETCONF_E2E_HOST=127.0.0.1        # optional; the device's address if it is not loopback
export NETCONF_E2E_PORT=1830             # optional
```

Neither value is committed and neither has a default in the spec. A password in a repository is a
published credential whatever it unlocks, and the host key is generated when the image is BUILT,
so a fingerprint written into the file would be wrong on the next build - it is read out of band,
which is also how the provider's own refusal tells a user to get one.

**A skip here is a third state and not a pass.** A step that runs this suite without the two
variables has measured the dialog and nothing else. Playwright prints the skip with its reason, so
the step's log says which of the two it was; a step that wants the reads measured has to set them,
and a step that cannot should say NOT MEASURED rather than report a green suite.

## Where it was run, and the one thing that is not reproducible on a developer's Mac

MEASURED 2026-10-15. The e2e suite does not run on this machine under Bun at all, and it is not
this spec's doing: `bunx playwright test` cannot bundle ANY spec in this repository, including
`e2e/modbus-provider.spec.ts`, because `playwright-core`'s bundle reaches for
`chromium-bidi/lib/cjs/bidiMapper/BidiMapper` and that package is not installed. Under Node the
same require sits behind a try/catch and never resolves at build time, so this is a Bun-only
failure: Playwright is run by Node everywhere it is meant to run, and this machine has no Node.

So the verification here was done in a Linux container with Node and the browsers
(`mcr.microsoft.com/playwright`), against the fixture on the compose network, which is also the
shape CI already has. Nothing in the spec depends on that: the address is read from the two
optional variables above precisely so that the same file runs beside the fixture on a workstation
and against a named container in a runner.
