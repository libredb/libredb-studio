# Rancher End-to-End Validation - Dynamic Workflow Agent Task

Agent task brief: stand up a real Rancher Manager on this Linux machine, install the
**latest published LibreDB Studio chart** from the live Helm repository through Rancher,
and validate a full scenario matrix (zero-config, manual secrets, strict mode,
existingSecret, persistence, multi-replica, upgrade). Produce an evidence-backed report
suitable for `docs/RANCHER.md` and the SUSE Ready for Rancher certification
(rancher/partner-charts#1158, tracking issue #166).

## Mission

Prove, on a real Rancher installation (not bare K3s/k3d), that:

1. The chart meets the partner-charts requirement verbatim: *"be deployable from the
   current version of Rancher with the default values"*.
2. Every documented configuration mode behaves exactly as the chart README and
   `docs/RANCHER.md` claim.
3. The results extend the `docs/RANCHER.md` "Validated combinations" table with a real
   Rancher row (Rancher version + bundled K3s + Kubernetes version).

## Ground rules (read before any action)

- **Never commit or push.** All artifacts go to `deploy/rancher/results/` (gitignored or
  left untracked); the human reviews everything.
- **Never touch** the `rancher/partner-charts` PR branch, `gh-pages`, GHCR, npm, or any
  release infrastructure. This task is read-only toward the outside world except for
  pulling public images/charts.
- **Evidence before claims.** Every PASS in the report must quote the command and the
  relevant output line. No output, no PASS.
- **Cleanup is mandatory** even on failure (see Phase 6). The machine must return to its
  pre-task state: no leftover containers, volumes, kubeconfigs, or /etc/hosts edits.
- **Timeboxes.** Rancher bootstrap: 15 min. Each scenario: 10 min. Whole task: 90 min.
  On timeout: capture diagnostics, clean up, report the blocker - do not loop retries
  indefinitely (max 2 retries per step, then fail the step and continue where
  independent).
- **Secrets hygiene.** Generated/bootstrap passwords may appear in the local report but
  must never leave this machine. Use throwaway values for manual-secret scenarios.

## Orchestration design

This brief is written to be executed as a dynamic workflow (the orchestration script
holds the plan and the intermediate state; agents do all filesystem/shell work; the
main conversation receives only the final report).

### Run split (sign-off between stages)

Workflows take no mid-run user input, so run this as **two workflows** with a human
gate between them:

- **Run A - bootstrap + certification gate**: Phase 0, 1, 2 and scenario S1 only.
  Ends with the environment context object and the S1 verdict. The human reviews
  before committing to the full matrix.
- **Run B - matrix + report**: takes Run A's context object as `args`; runs S2-S8
  (S9 optional), the verification pass, Phase 4 evidence, and the Phase 5 report.
  Phase 6 cleanup runs at the end of Run B, or at the end of Run A if the human stops
  there.

### Roles (keep them minimal: planner, workers, judge - no extra middle roles)

- The **script** is the planner: phases, scenario fan-out, retry policy live in code.
- **Scenario workers** are one fresh agent per scenario, owning
  install-verify-uninstall in their own namespace. On retry, spawn a **fresh** agent
  with the failure summary rather than re-prompting the same one (fresh starts combat
  drift).
- A **judge** agent runs after S1 and after the matrix: it reads only the verdicts
  (not raw logs) and decides continue / stop / which FAILs need adversarial reruns.

### Worker contract (fixed formats improve reliability)

Every scenario worker receives a self-contained prompt: the context object (below),
its scenario spec copied verbatim from this file, its namespace, and the results
directory. It must return this exact structured verdict (enforce via schema):

```json
{
  "id": "S1",
  "verdict": "PASS | FAIL | BLOCKED",
  "evidence": [{"check": "...", "command": "...", "output_excerpt": "<= 10 lines"}],
  "artifacts": ["results/s1/pod-describe.txt", "..."],
  "notes": "one paragraph max"
}
```

Output-size discipline: workers never return full logs or manifests - grep the
relevant lines (10 lines max per check) and write complete outputs to files under
`deploy/rancher/results/<scenario>/`, returning paths in `artifacts`. The
orchestrator and judge reason over verdicts only.

### Shared context object

Phase 1 ends by returning (as structured output) the state every later agent needs:

```json
{
  "httpsPort": 443, "httpPort": 80,
  "kubeconfigPath": "deploy/rancher/results/kubeconfig.yaml",
  "rancherVersion": "...", "k3sVersion": "...", "k8sVersion": "...",
  "chartVersion": "...", "appVersion": "...",
  "adminTokenPath": "deploy/rancher/results/.admin-token"
}
```

Secrets (admin token, generated passwords) are written to files under `results/` and
passed **by path**, never inline through agent prompts or verdicts.

### Concurrency and scheduling

- Phases 0-2 and S1 are strictly serial (one Rancher, one bootstrap, one gate).
- S2-S8 are independent, but they share ONE single-node K3s cluster on a developer
  machine: cap scenario workers at **3 concurrent** (the app pod needs ~512 MB;
  Rancher itself holds several GB). More parallelism risks node memory pressure that
  produces false FAILs.
- Structure the script so each scenario is one `agent()` call: on resume after a
  pause or a script edit, completed scenarios return cached verdicts and only the
  remainder runs live.

### Runtime constraints to respect

- The workflow script cannot call `Date.now()`/`new Date()`: the report date, result
  file names, and any timestamps come from an agent running `date -u` (or from
  `args`), never from script code.
- Shell commands outside the session allowlist prompt mid-run and stall a background
  workflow: before launching Run A, ensure `docker`, `kubectl`, `helm`, `curl`, `jq`
  invocations are allowlisted (or accept prompts promptly while the run is up).
- A verification pass reviews every FAIL adversarially before it lands in the report:
  a fresh agent reproduces it once from scratch in a fresh namespace and classifies
  it as chart bug vs environment flake vs test-script bug.

## Phase 0 - Preflight (gate: all green or stop)

Check and record:

- Docker present and daemon reachable; user can run privileged containers.
- Free RAM >= 6 GB (`free -g`), free disk >= 15 GB on the Docker root.
- Ports: prefer 80/443; if occupied, choose 8080/8443 and record the mapping. All later
  URLs must use the chosen ports consistently.
- Tools: `helm` (v3.16+), `kubectl`, `jq`, `curl`, `python3`. Install nothing globally
  without recording it for cleanup.
- No existing container named `rancher-e2e` and no port conflict.
- Internet reachability: `https://libredb.org/libredb-studio/index.yaml` resolves and
  contains the latest chart version. Record that version as `$CHART_VERSION` and its
  `appVersion` as `$APP_VERSION` - all scenarios pin `--version $CHART_VERSION`.

## Phase 1 - Rancher bootstrap

1. Resolve the Rancher image: use `rancher/rancher:stable`, then record the exact
   resolved version from the UI/settings for the report (plus the bundled K3s and
   Kubernetes versions once the local cluster is up).
2. Start:
   ```bash
   docker run --name rancher-e2e --restart=unless-stopped --privileged \
     -p <HTTP_PORT>:80 -p <HTTPS_PORT>:443 rancher/rancher:stable
   ```
3. Wait for readiness (poll `https://localhost:<HTTPS_PORT>/ping` with `curl -sk`,
   max 10 min), then extract the bootstrap password from `docker logs rancher-e2e`.
4. Complete first-login via the Rancher API (no UI needed):
   - `POST /v3-public/localProviders/local?action=login` with the bootstrap password
     to obtain a token.
   - Change the admin password to a generated throwaway value
     (`/v3/users?action=changepassword`).
   - Set the `server-url` setting to `https://localhost:<HTTPS_PORT>`.
5. Obtain a kubeconfig for the `local` cluster (Rancher API
   `/v3/clusters/local?action=generateKubeconfig`, or fall back to
   `docker exec rancher-e2e cat /etc/rancher/k3s/k3s.yaml` with the server address
   rewritten). Verify `kubectl get nodes` shows Ready and record the Kubernetes version.

Gate: `local` cluster Active in the Rancher API, `kubectl` works, versions recorded.
This phase ends by emitting the **shared context object** (see Orchestration design);
every later agent receives it instead of re-deriving the environment.

## Phase 2 - Register the LibreDB Helm repository in Rancher

Add the repo the way a Rancher user would (Apps > Repositories), declaratively:

```bash
kubectl apply -f - <<EOF
apiVersion: catalog.cattle.io/v1
kind: ClusterRepo
metadata:
  name: libredb
spec:
  url: https://libredb.org/libredb-studio/
EOF
```

Verify through Rancher's own catalog machinery (not plain helm):

- `ClusterRepo` status becomes `Downloaded`/active.
- The Rancher catalog API serves our index:
  `GET /v1/catalog.cattle.io.clusterrepos/libredb?link=index` lists `libredb-studio`
  with `$CHART_VERSION`.

Gate: chart visible to Rancher's Apps catalog at the expected version.

## Phase 3 - Scenario matrix

Common conventions for every scenario:

- Install with `helm install <release> libredb/libredb-studio --version $CHART_VERSION
  -n <ns> --create-namespace` against the local cluster kubeconfig (the same chart
  Rancher's Apps UI installs; Rancher-side visibility already proven in Phase 2).
- "Ready" means `kubectl rollout status deploy/<release>-libredb-studio` succeeds within
  the scenario timebox.
- "Health 200" means port-forward `svc/<release>-libredb-studio 3000:80` and
  `GET /api/db/health` returns 200. Kill the port-forward afterwards; wait for the
  forward to bind before curling.
- "Login 200" means `POST /api/auth/login` with the scenario's credentials returns 200.
- Always `helm uninstall` + delete the namespace at scenario end, even on FAIL
  (after capturing `kubectl describe pod` + logs into the results folder).

### S1 - Zero-config default install (CERTIFICATION GATE)

- Install with **no values at all**.
- Expect: render succeeds; pod Ready; deployment has **no** `JWT_SECRET` /
  `ADMIN_PASSWORD` env entries; an `emptyDir` volume is mounted at `/app/data`;
  pod log contains the banner `generated admin credentials`; extract email+password
  from the banner; Login 200 with them; Health 200.
- Also verify NOTES: `helm get notes` mentions first-run credential retrieval.

### S2 - Manual secrets (production path)

- `--set secrets.jwtSecret=<random 48 chars> --set secrets.adminPassword=<random>`.
- Expect: pod Ready; Login 200 with the provided password; pod log contains **no**
  `generated admin credentials` banner; the release Secret contains `jwt-secret` and
  `admin-password` keys; no `user-email`/`user-password` keys (admin-only by design).

### S3 - Strict mode without secrets (negative test)

- `--set config.authBootstrap=off`, no secrets.
- Expect: `helm install` **fails at render** with `secrets.jwtSecret is required`.
  A failure here is the PASS condition; an install that proceeds is a FAIL.

### S4 - Strict mode with secrets

- `--set config.authBootstrap=off` + jwtSecret + adminPassword (+ userPassword).
- Expect: pod Ready; Login 200 (admin and the optional user account); env entries are
  hard secretKeyRefs (no `optional: true` on JWT_SECRET/ADMIN_PASSWORD in the rendered
  deployment).

### S5 - existingSecret

- Pre-create a Secret in the namespace with keys `jwt-secret`, `admin-email`,
  `admin-password`; install with `--set secrets.existingSecret=<name>`.
- Expect: pod Ready; Login 200 with the pre-created password; the chart created no
  release Secret of its own.

### S6 - Multi-replica guard + valid multi-replica

- 6a (negative): `--set replicaCount=2` with no jwtSecret. Expect render refusal with
  the per-pod JWT message. Refusal is PASS.
- 6b (positive): `--set replicaCount=2 --set secrets.jwtSecret=<random> --set
  secrets.adminPassword=<random>`. Expect 2/2 Ready; run Login 10 times through the
  Service - all 200 (shared JWT secret means no cross-pod 401s).

### S7 - Persistence: credentials survive pod recreation

- `--set persistence.enabled=true` (zero-config otherwise).
- Expect: pod Ready; capture generated password; `kubectl delete pod` and wait for the
  replacement; pod log shows `using generated admin credentials from` (reuse, not
  regeneration); Login 200 with the ORIGINAL password.

### S8 - Upgrade path (previous chart -> current)

- Install the **previous** chart version (strict-era default) with jwtSecret +
  adminPassword set, then `helm upgrade --version $CHART_VERSION` with the same values.
- Expect: upgrade succeeds; Login 200 with the same credentials before and after; no
  credential regeneration; document that the default-flip did not disturb an install
  that sets explicit secrets.

### S9 (optional, only if time remains) - Partner-charts catalog preview

- Add a second ClusterRepo of type Git pointing at the partner-charts fork
  (`https://github.com/yusuf-gundogdu/partner-charts`, branch `add-libredb-studio`).
- Expect: the catalog card renders (name, icon, description from the PR content).
- Since 2026-08-18 that branch carries chart 0.1.36 (appVersion 0.11.0), so the default
  install works zero-config there as it does from the live Helm repo. The scenario still
  only previews catalog presentation - installing from it is S1's job, not this one.
- **Known and expected:** the card's description line comes from `Chart.yaml`, which now
  names thirteen engines, while the app-readme still names ten. The ten-engine wording is
  deliberate and version-scoped — the catalog prose describes a released version and stays
  at ten until a tag ships Elasticsearch, OpenSearch and Apache Trino — so this mismatch is
  expected, is tracked in `CATALOG_LISTING.md`, and must NOT be reported as a rendering
  failure. Record a screenshot/API dump of the card.

## Phase 4 - UI evidence (best effort, do not block the matrix)

If browser automation is available (Playwright), capture into
`deploy/rancher/results/screenshots/`:

- Apps > Charts showing the LibreDB Studio card from the `libredb` repo.
- The install form / values YAML view.
- The installed app detail page with the workload green.
- Pod logs view showing the first-run credentials banner (S1 namespace, before cleanup).

If UI automation is unavailable, record the equivalent Rancher API responses instead and
note the gap in the report.

## Phase 5 - Report

Write `deploy/rancher/results/RESULTS-<YYYY-MM-DD>.md` (date obtained by an agent via
`date -u +%F`, not by workflow script code) containing:

1. Environment table: Rancher version, bundled K3s version, Kubernetes version, chart
   version, appVersion, host OS/kernel, Docker version, port mapping.
2. Scenario verdict table: S1-S9, PASS/FAIL/BLOCKED/SKIPPED, one-line evidence each.
3. Full evidence appendix per scenario (commands + trimmed outputs).
4. A ready-to-paste row for the `docs/RANCHER.md` "Validated combinations" table:
   `| Rancher <version> (single-node Docker) | v<k8s> | <date> | bundled K3s <ver>; installed via Rancher Apps catalog |`
5. Any chart/doc discrepancies found (behavior differing from README/RANCHER.md),
   listed as candidate issues - do not open issues automatically.

## Phase 6 - Cleanup (always runs, even after failure)

```bash
helm uninstall --ignore-not-found ... (every scenario release, every namespace)
kubectl delete clusterrepo libredb (and the S9 repo if created)
docker rm -f rancher-e2e
# Remove ONLY volumes this task explicitly created by name (none by default -
# the Rancher container's state is removed with the container). Never use
# `docker volume prune` here: even filtered, it risks unrelated volumes on a
# developer machine.
rm -f <temporary kubeconfigs, token files>
```

Verify: `docker ps -a | grep rancher-e2e` empty; chosen ports free again; no stray
kubeconfig/token files outside `deploy/rancher/results/`.

## Final acceptance (what the human checks)

- S1 PASS on a real Rancher install - the certification requirement, evidenced.
- No scenario verdict without quoted evidence.
- RESULTS file present with the ready-to-paste RANCHER.md row.
- Machine clean (Phase 6 verification lines included in the report).

## Reuse: save as a workflow command

Once a run of this task does what we want, save the Run B script as a project
workflow command (`.claude/workflows/`, e.g. `/rancher-e2e`) that accepts
`args: { chartVersion }`. Every future chart release can then rerun the exact same
validation with one command and regenerate the `docs/RANCHER.md` row - this task
stops being a one-off and becomes the release-time Rancher regression check.
