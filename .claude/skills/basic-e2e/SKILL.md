---
name: basic-e2e
description: Use after a critical libredb-studio change, or before tagging a release, to prove in a real Chrome browser that the basic functions still work - create a connection and connect, read/write/read-back queries, the object list, the AI agent in Plan mode and in Agent mode with auto-execute - on PostgreSQL, MySQL, SQL Server, MongoDB and SQLite, in parallel isolated lanes.
argument-hint: "[commit-or-branch] [providers] [concurrency]"
disable-model-invocation: true
---

# Basic browser E2E on five providers

## Overview

The gate (`bun run test`, coverage, build) proves the code compiles and its units hold.
It does not prove that a person can open Studio, connect to a database, run a query and get an answer from the agent.
This skill does, the way a user does it: a prebuilt Studio, real databases in containers, real Google Chrome driven by Playwright, and the configured LLM.

It was distilled from the pre-release run of 2026-10-30 (25 of 25 steps passed on 12e81a05f).
The lane code is next to this file, so a run never rewrites it:

- `providers.mjs`: per provider, the compose service, ports, seed data, the agent's least-privilege principal, the queries, the object tree path and the documented auto-execute expectation.
- `lane.mjs`: one isolated lane, one provider, end to end, including its own cleanup and its own `RESULT.md`.
- `run.mjs`: runs the lanes at most N at a time and writes `SUMMARY.md` with the table.

Three properties drive every rule below:

1. **An agent step passes only on a real run.** An earlier API-only check reported agent success on an HTTP 200 while the run had `runId: null` and no events.
   A pass needs a run id, a ledger with events, the statements the run executed and an answer the rail rendered.
2. **Lanes share nothing.** Each lane has its own Studio port, database container and host port, data dirs, seed file and Chrome profile.
   Five testers on one machine stepped on each other through a shared `SEED_CONFIG_PATH` before this was enforced.
3. **The run reports, it does not repair.** A defect found here is written up with a repro.
   Fixing it inside the run changes the build under test and invalidates every other lane.

## When to use

After any change that could break what a user does first, before it merges or before the release that carries it is tagged:

- authentication, cookies, the proxy or session handling;
- storage (`STORAGE_PROVIDER`, `useStorageSync`, seed connections);
- the connection dialog, connection fields or connection-string parsing;
- query execution, the editor, the result grid or the Query Safety Check;
- the object tree;
- the agent runtime, the rail, the read-only execution profiles or the LLM layer;
- any of the five providers;
- a Next.js, Bun, React or Playwright upgrade, or a change to `next.config.ts`.

It is not a substitute for the required gate set in `CLAUDE.md`, nor for `bun run test:e2e`.
It does not cover OIDC or OpenShift sign-in, `STORAGE_PROVIDER=postgres`, the npm package or the Docker image (`/cut-release` Phase 7 smokes the published image), or the other providers.

## Arguments

`/basic-e2e [commit-or-branch] [providers] [concurrency]`, all optional:

| Argument | Default | Meaning |
| --- | --- | --- |
| commit or branch | `origin/main` | What to build and test. A PR is tested by its branch or head commit. |
| providers | `postgres,mysql,mssql,mongodb,sqlite` | Comma-separated keys of `providers.mjs`. Five is the minimum for a release; fewer is fine for a change scoped to one engine. |
| concurrency | `3` | Lanes at once. Three is the memory ceiling on the maintainer machine: SQL Server alone needs about 2 GiB, each Studio about 1 GiB, each Chrome a few hundred MiB. |

## Step 1 - Build once, in a detached worktree, inside the memory cap

One build serves every lane.
Build in a fresh detached worktree, never in the checkout you are working in, so the build is exactly the commit under test.

Run each block below as one command, from anywhere inside the repository.
An agent's shell keeps no variables and no `cd` from one call to the next, so every block sets the variables it uses and changes directory only inside its own subshell.
`CHECKOUT` resolves to the main checkout even from a linked worktree.

```bash
REF=origin/main                                  # or the branch / commit argument
CHECKOUT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")   # the main checkout, which holds .env and .team/
BUILD=$(dirname "$CHECKOUT")/wt-basic-e2e-build
git -C "$CHECKOUT" fetch origin
git -C "$CHECKOUT" worktree add --detach "$BUILD" "$REF"
git -C "$BUILD" log --oneline -1                 # record the commit for the report
```

Do not copy `.env` into it.
`next start` loads any `.env*` file in its directory, and a key the lane does not set (a shared `SEED_CONFIG_PATH`, a `STORAGE_POSTGRES_URL`) would leak into every lane; `lane.mjs` refuses to start when it finds one.
`NEXT_PUBLIC_AUTH_PROVIDER` is inlined at build time, so leaving it unset builds the `local` sign-in the lanes use.

Build inside the memory cap.
The machine was OOM-killed once by parallel builds and suites, so the build holds the full-suite lock (when the checkout has `.team/fullsuite.lock`), refuses to start with less than 14 GiB available, and runs in a capped scope:

```bash
CHECKOUT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")   # the main checkout, which holds .env and .team/
BUILD=$(dirname "$CHECKOUT")/wt-basic-e2e-build
avail=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo); [ "$avail" -ge 14 ] || { echo "only ${avail} GiB free"; exit 1; }
flock "$CHECKOUT/.team/fullsuite.lock" \
  systemd-run --user --scope -p MemoryMax=20G -p MemorySwapMax=0 \
  bash -c 'cd "$1" && bun install --frozen-lockfile && NODE_OPTIONS=--max-old-space-size=6144 bun run build' _ "$BUILD"
```

Drop the `flock` when the checkout has no `.team/` directory.
This is the only build of the run.
Nothing else here runs a repository-wide suite, build, lint or typecheck.

## Step 2 - Run the lanes

Pull the images first, once, so lanes do not race each other for them (hold `.team/docker.lock` when it exists).
The images come from `database-compose.yml` at the commit under test; `lane.mjs` reads the `image:` line of the service, so a pin there is a pin here.

```bash
CHECKOUT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")   # the main checkout, which holds .env and .team/
BUILD=$(dirname "$CHECKOUT")/wt-basic-e2e-build
for s in postgres mysql mssql mongodb; do
  img=$(awk -v s="  $s:" '$0==s{f=1;next} f&&/^    image:/{print $2;exit}' "$BUILD/database-compose.yml")
  flock "$CHECKOUT/.team/docker.lock" sg docker -c "docker pull $img"
done
```

Then run the lanes from the skill directory of the build worktree, so the lane code is the one at the commit under test.
When that commit predates this skill, run the same command against the skill directory of your checkout instead.

The lanes hold the browser, so no other agent may drive a browser or build an image while they run (the team's decision S6(d), in `.team/openshift/decisions.md` where the checkout has one: one agent at a time on the browser or an image build).
They also need memory: SQL Server takes up to 4 GiB in its container, and three Studios and three Chromes run beside it.
So the block checks for 14 GiB available, as the build does, and caps the lanes' own processes in a scope; the containers run under docker's limits, not in that scope.

```bash
CHECKOUT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")   # the main checkout, which holds .env and .team/
BUILD=$(dirname "$CHECKOUT")/wt-basic-e2e-build
OUT=$(dirname "$CHECKOUT")/reviews/basic-e2e-$(date +%F)-$(git -C "$BUILD" rev-parse --short HEAD)
WORK=<session scratchpad>/basic-e2e
avail=$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo); [ "$avail" -ge 14 ] || { echo "only ${avail} GiB free"; exit 1; }
systemd-run --user --scope -p MemoryMax=12G -p MemorySwapMax=0 \
  sg docker -c "node $BUILD/.claude/skills/basic-e2e/run.mjs \
  --build $BUILD --out $OUT --work $WORK --env-file $CHECKOUT/.env \
  --providers postgres,mysql,mssql,mongodb,sqlite --concurrency 3"
```

Run it in the background and wait for it to exit.
`systemd-run --scope` and `sg` both exec, so a SIGINT or SIGTERM reaches `run.mjs`, which stops starting lanes and forwards the signal to each running lane; each lane then runs its full teardown and exits 2.
Measured on 2026-10-30 with the images already local: a lane takes 65 to 85 seconds, and five lanes at three at a time finish in under three minutes.
`sg docker -c` is there because the docker group is not active in an agent's shell on this machine; drop it where `docker ps` already works.
`--env-file` is read for the `LLM_*` keys only, inside the lane process, and nothing else from it reaches Studio.
One lane alone is `node lane.mjs --provider <key> --build ... --out $OUT/<key> --work $WORK/<key> --env-file ...`; add `--keep` to keep its work dir (server log, Chrome profile) for a failure, and `--headed` to watch it.

## The lane contract

Every lane, set up and torn down by `lane.mjs`:

| Resource | Per lane | Values |
| --- | --- | --- |
| Studio | `bun run start -- -p <port> -H 127.0.0.1` from the build worktree | postgres 3201, sqlite 3202, mysql 3203, mssql 3204, mongodb 3205 |
| Database | container `basic-e2e-<provider>`, image from `database-compose.yml`, loopback host port; a running container of that name fails the lane (it may be another run's), a stopped one is removed | postgres 55432, mysql 53306, mssql 51433 (`--cpus 4 --memory 4g`, the compose limits), mongodb 57017; SQLite is a file the lane writes with `node:sqlite` |
| Credentials | generated per lane, held in the lane process, passed to docker by variable name and to Studio by environment | root principal for the UI connection (MongoDB's root user name is generated too), `libredb_agent` for the agent, the Studio admin password and `JWT_SECRET` |
| Data dirs | `STORAGE_SQLITE_PATH`, `WORKFLOW_LOCAL_DATA_DIR`, both embedded sample paths, all under the lane's work dir, which holds a `.basic-e2e-lane` marker; a non-empty `--work` path without it is refused, never deleted | `STORAGE_PROVIDER=sqlite` by default (`--storage local` to change it) |
| Seed file | `SEED_CONFIG_PATH` pointing at the lane's own one-connection file | the password is `${BE2E_AGENT_PASSWORD}`, never a literal |
| Browser | Playwright `launchPersistentContext` on the lane's own profile, `channel: 'chrome'` (`/usr/bin/google-chrome`), headless | the `playwright` package from the build worktree's `node_modules` |
| Evidence | `$OUT/<provider>/`: screenshots, `RESULT.md`, `RESULT.json` | |

Never drive a lane with the shared Playwright MCP browser or the Chrome DevTools MCP: every lane would share one browser, one profile and one cookie jar.

The agent can only run on a **seed** connection.
`resolveAgentRunConnectionId` (`src/hooks/use-connection-payload.ts`) answers `browser-only` for any connection without a `seedId`, whatever `STORAGE_PROVIDER` is, and the rail then disables Start with "cannot be rebuilt on the server".
So steps 1 to 3 use the connection typed into the dialog, and steps 4 and 5 use the lane's seed connection to the same database, signed in as `libredb_agent`.
That principal is least-privilege on purpose: each engine's agent profile refuses a superuser, owner or `db_owner` login with `PROFILE_PRIVILEGES_TOO_BROAD` (the recipes are in `docs/providers/<type-id>.md`, section 12 or "Setting up the agent's user").
The seed is `roles: ["admin"]`, because a SQLite seed shared with any other role is refused outright, agent runs included.

The seeded data is the same on every engine (`CUSTOMERS` and `ORDERS` in `providers.mjs`): ten customers, Istanbul has four of them and no city ties it, and the five shipped orders total 4321.

## The five steps and what passes

A step passes only when every one of its checks passes; `RESULT.md` lists each check with what it observed.

**1. Create a connection in the UI and connect.**
Sign in through `/login` as the local admin (it lands on `/admin/overview`; the studio is `/`), open New connection, pick the engine, fill the form, press Test Connection, then Establish Connection.
Passes when `POST /api/db/test-connection` answers `success: true`, the dialog says "Connected successfully", the connection is in the sidebar and its object tree renders.

**2. Read, write, read back.**
In the editor of the UI connection: a read of the ten customers, an INSERT of customer 11, an UPDATE of its city by primary key, and a read of customer 11 (MongoDB: `find`, `insertOne`, `updateOne`, `find` in its JSON form).
Passes when the read returns 10 rows, both writes answer without an error, **the UPDATE raises the Query Safety Check** and runs after Execute Query, and the read-back returns the one row with the new city, in the response and in the grid.
Each statement runs alone: with two statements in the editor and no selection, RUN executes only the one under the cursor.

**3. Object list.**
Passes when the tree lists `customers` and `orders` under the connection's database (PostgreSQL `public > Tables`, MySQL `shop > Tables`, SQL Server `shopdb > dbo > Tables`, MongoDB `shop > Collections`, SQLite `Tables`) and each expands, through its `Expand <name>` twisty, to its columns or fields.
Containers toggle on a row click; an object row click opens a data tab instead, so the lane never clicks the name.

**4. Agent, Plan mode.**
On the seed connection: Plan, objective "Which city has the most customers, and how many customers live there?", Start.
Passes when `POST /api/agent/runs` answers 202 with a run id, `GET /api/agent/runs/<id>` shows status `succeeded`, the ledger holds a `plan-statement-drafted` event with a statement and **no** `tool-invoked` event (nothing executed), the goal verifier says `answered`, the rail renders the plan card, and the draft, applied to the editor and run, answers without an error.
Whether the draft's answer is Istanbul is recorded as a note: it is model quality, not a Studio property.

**5. Agent, Agent mode with auto-execute.**
On the seed connection: Agent, Advanced, Analyze (`data-analysis`), objective "What is the combined total value of all orders whose status is shipped?", Start, tick "Also run the final answer in my editor" on the consent card, Start run.
Passes when the run id is real, the status is `succeeded`, the ledger shows at least one `run_read_query` call and a completed tool, an `answer-composed` event carries the statement, the verifier says `answered`, the record's `autoExecute` matches what the engine offers, the hand-over is what the engine allows, and the answer rendered on the rail contains 4321.

An HTTP 200 from any agent route is never evidence of a pass on its own.

The auto-execute outcome differs by engine, and these are documented behaviours, not defects (`docs/AGENT.md`, "Handing the answer to the editor (auto-execute)"):

| Engine | Checkbox | Hand-over the lane accepts | Why |
| --- | --- | --- | --- |
| PostgreSQL | offered | `applied` or `auto-executed` | The gate weighs PostgreSQL plans, but a 10-row table always plans a sequential scan, so the answer is placed unrun with "the plan reads the whole table". |
| MySQL | offered | `applied` only | The gate never fires on MySQL. |
| SQL Server | offered | `applied` only | The gate never fires on SQL Server (BACKLOG A6). |
| MongoDB | absent | `none`, `autoExecute: false` | Not offered on MongoDB (B118). |
| SQLite | offered | aggregate `applied` or `auto-executed`; probe `auto-executed` | The uncosted rule needs every plan step to be a SEARCH. |

Every `applied` hand-over must carry the gate's warning.
SQLite is the lane that proves the hand-over itself: a second Agent run asks "What are the name and city of the customer whose id is 8?", whose plan is a primary-key SEARCH, and passes only when the hand-over is `auto-executed`, `POST /api/agent/runs/<id>/handover` answers 200 and its rows hold Marco Rossi.
If MySQL, SQL Server or MongoDB ever reports `auto-executed`, the lane fails on purpose: the documented behaviour changed and `docs/AGENT.md` and `providers.mjs` have to change with it.

## Evidence and secrets

Evidence lives outside the repository, under `reviews/basic-e2e-<date>-<sha>/`, one folder per provider plus `SUMMARY.md`.
Every check, run id and statement the agent executed is in `RESULT.md` and `RESULT.json`.

- No password, API key, token or cookie value goes into evidence, a log, the ledger, a PR or an issue.
  `lane.mjs` generates every credential, never prints one, writes the seed password as an environment reference, and at the end scans its own text evidence for each generated secret; a hit exits 2.
- Every lane log line and every check detail, docker and setup-tool errors included, has each generated secret and the LLM key replaced with `***` before it is printed or stored.
  The server log lines and browser messages a report quotes are not redacted, so the scan still flags a Studio that printed a secret.
  A lane whose scan hit writes `SECRET-FOUND` (file names only), and `run.mjs` then withholds that lane's details from `SUMMARY.md`.
- The LLM key stays in the lane process, and the same scan looks for it.
  Read the `.env` for key names only (`grep -o '^[A-Z_]*='`), never its values.
- Screenshots show password fields masked; check any screenshot you add by hand.
- Masked columns (the MASKED chip, emails shown as `***`) are the data-masking default, not a failure.

## Failures and defect reports

A failed check is a finding until it is classified:

1. **Rule out the lane.** Rerun that lane alone with `--keep`, read its failure screenshot (`NN-failure.png`) and its server log in the work dir.
   A selector that moved is the lane's fault: fix `lane.mjs` or `providers.mjs` in a follow-up PR and say so in the report.
2. **Rule out the environment.** A port in use, an image that will not start, a missing `LLM_PROVIDER`, the docker group: the lane exits 2 with the reason.
   `mongo:8` resolves to 8.3.13, which refuses to start on Linux 6.19 and newer (SERVER-121912); the compose pin `mongo:9.0.4@sha256:...` is why the lane reads images from `database-compose.yml`.
3. **Separate model quality from Studio.** A run that succeeded and answered with the wrong figure after a retry is model quality; record it as an observation with the run id.
   A run that failed, refused, has no events or rendered no answer is Studio's.
4. **Write the defect with a repro**: severity, provider, UI steps from sign-in, expected, actual, run id, evidence file names, the server log line (secrets removed) and the code reference you read.
   Deduplicate across providers.

Never fix product code inside the run.
Record each defect where the project tracks work (`docs/BACKLOG.md` or an issue, the issue as a draft for the owner to approve), so none is left unrecorded and none grows the change under test.

Known, recorded as D413 in `docs/BACKLOG.md` (PR #2108), and not a reason to fail a lane: the embedded "Sample (Employees)" can show "database is locked" on the very first load of a fresh data dir (five concurrent provider creations); "Try again" clears it.
Row badges on PostgreSQL and MySQL tables are catalog estimates and do not move after an INSERT.

## Cleanup

Each lane removes its container, stops its server, closes Chrome and deletes its work dir in a `finally`, including after a failure (unless `--keep`).
A SIGINT, SIGTERM or SIGHUP runs the same teardown.
Then confirm and remove the build:

```bash
CHECKOUT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")   # the main checkout, which holds .env and .team/
BUILD=$(dirname "$CHECKOUT")/wt-basic-e2e-build
WORK=<session scratchpad>/basic-e2e
sg docker -c "docker ps -a --filter name=basic-e2e- --format '{{.Names}}'"   # empty
ss -ltnp | grep -E ':(320[1-5]|55432|53306|51433|57017) '                        # empty
git -C "$CHECKOUT" worktree remove --force "$BUILD"
rm -rf "$WORK"
```

A lane killed with SIGKILL, or a machine that went down, skips the teardown.
Studio runs in its own process group, so it outlives the lane: `ss -ltnp` names the PID listening on its 320x port, and `kill -- -$(ps -o pgid= -p <pid> | tr -d ' ')` stops that whole group.
Remove each container the `docker ps` line lists with `docker rm -f <name>`, after making sure no other run is using it.

## The report

`run.mjs` writes `SUMMARY.md`: one row per step, one column per provider, `PASS`, `FAIL` or `NOT RUN`, the lane exit codes, and every failed check.
Report to the owner in that order: the commit, the table, the defects with severity and repro, what was not covered, and the cleanup state.
A release goes ahead only on a table with no `FAIL`, or with every `FAIL` classified as lane, environment or model quality with its evidence.

## Traps

- Monaco takes clicks on `.monaco-editor .view-lines`; clicking its hidden textarea times out.
- The Query Safety Check's execute button stays disabled while its analysis runs; wait for it, do not click through.
- Agent Start is disabled on a connection typed into the UI, by design; that is not a failure of step 4 or 5, which use the seed.
- The editor also posts a background EXPLAIN and a dry-run estimate to `/api/db/query`; the statement the user ran is the request without an `explain` field.
  Waiting on the first response to that route reads the plan, not the result.
- Read the run id from the `POST /api/agent/runs` response, not from the rail: after a reload the rail may still show the previous run's terminal status.
- Grepping a server log for `error` matches harmless lines; read the matches, and treat `[ERROR` lines and unhandled rejections as the signal.
- The lanes need Google Chrome at `/usr/bin/google-chrome` (`channel: 'chrome'`); Playwright's bundled Chromium is not what users run.
- `bun run start` serves `.next` from the build worktree; a later `bun run build` there changes what every running lane serves.

## Changing the skill

A selector, a flow or an expectation that changed in Studio changes `lane.mjs` or `providers.mjs` in the same PR that changed Studio, the same way a provider change keeps its doc and tests in lockstep.
A new provider is a new entry in `providers.mjs`: its compose service, the agent principal recipe from its provider doc, its queries in the engine's own syntax, its tree path and its auto-execute row from `docs/AGENT.md`.
