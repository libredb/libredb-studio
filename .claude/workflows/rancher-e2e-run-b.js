export const meta = {
  name: 'rancher-e2e-run-b',
  description: 'Rancher E2E validation Run B: scenario matrix S2-S9 plus the S1-UI Apps-UI install, adversarial FAIL verification, UI evidence, report, mandatory cleanup. Parameterized: pass repoRoot + environmentContext (chartVersion pinned to the release under validation).',
  phases: [
    { title: 'Phase 3 - Scenario matrix' },
    { title: 'Verification - adversarial FAIL repro' },
    { title: 'Judge - matrix' },
    { title: 'Phase 4 - UI evidence' },
    { title: 'Phase 5 - Report' },
    { title: 'Phase 6 - Cleanup' },
  ],
}

// Everything machine- and release-specific arrives through args, so the same
// script re-runs for any release from any checkout (#170). Expected shape:
//   { repoRoot, s1, environmentContext: { chartVersion, appVersion, kubeconfigPath,
//     adminTokenPath, httpPort, httpsPort, rancherVersion, k3sVersion, k8sVersion } }
const ctx = args?.environmentContext
const REPO_ROOT = args?.repoRoot ?? ctx?.repoRoot
const REQUIRED_CTX = ['chartVersion', 'appVersion', 'kubeconfigPath', 'adminTokenPath', 'httpPort', 'httpsPort']
const missing = [
  ...(REPO_ROOT ? [] : ['repoRoot']),
  ...(ctx ? REQUIRED_CTX.filter((key) => !ctx[key]) : ['environmentContext']),
]
if (missing.length > 0) {
  throw new Error(
    `rancher-e2e-run-b: missing args: ${missing.join(', ')}. ` +
      `Invoke with {repoRoot, s1, environmentContext: {${REQUIRED_CTX.join(', ')}, rancherVersion, k3sVersion, k8sVersion}} ` +
      `- pin chartVersion to the release under validation.`
  )
}
const RESULTS_DIR = `${REPO_ROOT}/deploy/rancher/results`

const GROUND_RULES = `
GROUND RULES (mandatory, from deploy/rancher/E2E_VALIDATION_TASK.md):
- Never commit or push anything, anywhere. Never touch rancher/partner-charts, gh-pages, GHCR, npm, or any release infra. Read-only toward the outside world except pulling public images/charts/git refs.
- All artifacts go under ${RESULTS_DIR}/ (already gitignored). Create subdirectories as needed.
- Evidence before claims: every PASS/FAIL/BLOCKED must quote the exact command and the relevant output lines (trim to <=10 lines per check in your structured evidence; full raw output goes to a file under results/ and you list the path in artifacts). No output, no verdict.
- Secrets hygiene: any generated password/secret goes to a FILE under ${RESULTS_DIR}/<scenario>/ and you return only the PATH, never the raw value, in your response text, evidence excerpts, or notes.
- If you need a timestamp, run \`date -u\` as a shell command - never reason about "today" yourself.
- Max 2 retries per step before you report FAILED/BLOCKED and move on - do not loop indefinitely.
- You are a fresh agent with no memory of any other agent's work in this run - rely only on the context given to you below.
- The cluster's kubeconfig is at ${ctx.kubeconfigPath} - always \`export KUBECONFIG=${ctx.kubeconfigPath}\` first. The "libredb" helm repo alias (https://libredb.org/libredb-studio/) should already be registered locally; if \`helm repo list\` does not show it, register it yourself (\`helm repo add libredb https://libredb.org/libredb-studio/ && helm repo update\`) instead of reporting BLOCKED - this run must work on a machine that has never run it before. Chart version to pin everywhere: ${ctx.chartVersion} (appVersion ${ctx.appVersion}). Rancher admin token file (if you need the Rancher API, most scenarios don't): ${ctx.adminTokenPath}, Rancher HTTPS port: ${ctx.httpsPort}.
- This is a SHARED single-node cluster other scenario workers are using concurrently - use ONLY your assigned namespace, never touch other namespaces, never run cluster-wide destructive commands.
`

const CONVENTIONS = `
COMMON CONVENTIONS for every scenario (from Phase 3 of the task file):
- Install with: \`helm install <release> libredb/libredb-studio --version ${ctx.chartVersion} -n <ns> --create-namespace\` plus whatever --set flags the scenario specifies, against the shared cluster kubeconfig.
- "Ready" means \`kubectl rollout status deploy/<release>-libredb-studio -n <ns> --timeout=120s\` succeeds.
- "Health 200" means: port-forward \`kubectl port-forward svc/<release>-libredb-studio <local-port>:80 -n <ns>\` (backgrounded, pick a free local port to avoid clashing with other concurrent scenario workers), wait for the forward to actually bind (poll until curl gets ANY response, not a blind sleep), then \`curl -s http://localhost:<local-port>/api/db/health\` and confirm HTTP 200. Kill the port-forward process afterward, every time, even on failure.
- "Login 200" means \`curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:<local-port>/api/auth/login -H 'Content-Type: application/json' -d '{"email":"<email>","password":"<password>"}'\` returns 200.
- ALWAYS \`helm uninstall <release> -n <ns>\` and \`kubectl delete namespace <ns>\` at scenario end, even on FAIL - but first capture \`kubectl describe pod -n <ns> -l app.kubernetes.io/instance=<release>\` and \`kubectl logs -n <ns> -l app.kubernetes.io/instance=<release>\` into files under ${RESULTS_DIR}/<scenario-id>/ when the scenario failed (so there's something to debug).
- Write every raw command output (helm install/upgrade output, full deployment yaml, full pod logs, full describe) to files under ${RESULTS_DIR}/<scenario-id>/ and list the paths in "artifacts". Only trimmed excerpts (<=10 lines) go in "evidence".
`

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED'] },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          check: { type: 'string' },
          command: { type: 'string' },
          output_excerpt: { type: 'string' },
        },
        required: ['check', 'command', 'output_excerpt'],
      },
    },
    artifacts: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['id', 'verdict', 'evidence'],
}

const SCENARIOS = [
  {
    id: 'S2',
    ns: 's2',
    title: 'Manual secrets (production path)',
    spec: `- Generate a random 48-char jwtSecret and a random adminPassword (e.g. \`openssl rand -hex 24\` for jwtSecret, \`openssl rand -base64 18\` for adminPassword), write BOTH to a file under ${RESULTS_DIR}/s2/secrets.txt (chmod 600), never print raw values elsewhere.
- Install: \`helm install s2 libredb/libredb-studio --version ${ctx.chartVersion} -n s2 --create-namespace --set secrets.jwtSecret=<jwtSecret> --set secrets.adminPassword=<adminPassword>\`.
- Expect: pod Ready; Login 200 with the provided password (email defaults to admin@libredb.org unless the chart docs say otherwise - check \`helm get notes\` if unsure); pod log contains NO "generated admin credentials" banner (\`kubectl logs ... | grep -i "generated admin credentials"\` -> no match, that's the PASS condition here); the release Secret (\`kubectl get secret -n s2 -o yaml\`, find the one owned by this release) contains keys \`jwt-secret\` and \`admin-password\`; the Secret must NOT contain \`user-email\`/\`user-password\` keys (admin-only by design, no user account was configured).`,
  },
  {
    id: 'S3',
    ns: 's3',
    title: 'Strict mode without secrets (negative test)',
    spec: `- Install attempt: \`helm install s3 libredb/libredb-studio --version ${ctx.chartVersion} -n s3 --create-namespace --set config.authBootstrap=off\` (no secrets set at all).
- Expect: the \`helm install\` command ITSELF FAILS at render/template time with an error mentioning \`secrets.jwtSecret is required\` (or equivalent). A FAILING helm install with that exact kind of error IS the PASS condition. If the command instead succeeds and a release gets created, that is a FAIL (and you must then uninstall it / delete the namespace as part of cleanup).
- No pod ever gets created in the success path of this test, so most "Ready"/"Health"/"Login" conventions don't apply - just capture the exact helm error text as evidence.`,
  },
  {
    id: 'S4',
    ns: 's4',
    title: 'Strict mode with secrets',
    spec: `- Generate random jwtSecret, adminPassword, and userPassword (write to ${RESULTS_DIR}/s4/secrets.txt, chmod 600, paths only elsewhere).
- Install: \`helm install s4 libredb/libredb-studio --version ${ctx.chartVersion} -n s4 --create-namespace --set config.authBootstrap=off --set secrets.jwtSecret=<jwtSecret> --set secrets.adminPassword=<adminPassword> --set secrets.userPassword=<userPassword>\` (check the chart README/values schema for the exact userPassword key name if this one doesn't render - report exactly what you found).
- Expect: pod Ready; Login 200 for the admin account; Login 200 for the optional user account too if one was configured; inspect the rendered Deployment env for JWT_SECRET and ADMIN_PASSWORD - both must be hard \`secretKeyRef\`s with NO \`optional: true\` set on them (\`kubectl get deploy s4-libredb-studio -n s4 -o yaml\`, look at the env entries' valueFrom.secretKeyRef.optional field - must be absent or false, not true).`,
  },
  {
    id: 'S5',
    ns: 's5',
    title: 'existingSecret',
    spec: `- First \`kubectl create namespace s5\`, then pre-create a Secret in that namespace with keys \`jwt-secret\`, \`admin-email\`, \`admin-password\` (generate random values, write to ${RESULTS_DIR}/s5/secrets.txt chmod 600) via \`kubectl create secret generic s5-manual --from-literal=jwt-secret=<val> --from-literal=admin-email=admin@libredb.org --from-literal=admin-password=<val> -n s5\`.
- Install: \`helm install s5 libredb/libredb-studio --version ${ctx.chartVersion} -n s5 --set secrets.existingSecret=s5-manual\` (namespace already exists, don't pass --create-namespace or it may error - test both and report what actually works).
- Expect: pod Ready; Login 200 with the pre-created admin-email/admin-password; the chart must have created NO release Secret of its own for auth (\`kubectl get secret -n s5\` - only your manually-created s5-manual should relate to auth, any chart-created secret must not duplicate jwt-secret/admin-password keys).
- Cleanup for this scenario must also delete the manually-created s5-manual Secret (namespace deletion will do that automatically, that's fine).`,
  },
  {
    id: 'S6',
    ns: 's6',
    title: 'Multi-replica guard + valid multi-replica (two parts)',
    spec: `TWO PARTS, both under id "S6" - put both sets of evidence in the same evidence array, prefixed "6a:" / "6b:":
- 6a (negative): \`helm install s6a libredb/libredb-studio --version ${ctx.chartVersion} -n s6 --create-namespace --set replicaCount=2\` with NO jwtSecret set. Expect: helm install FAILS at render with a message about needing a shared JWT secret across replicas (per-pod JWT generation guard). This refusal IS the PASS condition for 6a. If it succeeds instead, that's a FAIL for 6a.
- 6b (positive): generate a random jwtSecret + adminPassword (${RESULTS_DIR}/s6/secrets.txt, chmod 600), then \`helm install s6b libredb/libredb-studio --version ${ctx.chartVersion} -n s6 --set replicaCount=2 --set secrets.jwtSecret=<jwtSecret> --set secrets.adminPassword=<adminPassword>\` (namespace s6 should already exist from the 6a attempt, or create it if 6a's failure prevented namespace creation - create it explicitly with kubectl if needed). Expect: 2/2 replicas Ready (\`kubectl rollout status deploy/s6b-libredb-studio -n s6 --timeout=150s\` and confirm READY 2/2 via \`kubectl get deploy s6b-libredb-studio -n s6\`); port-forward the SERVICE (not a pod) and run Login 10 times in a loop, ALL must return 200 (shared JWT secret across replicas means no cross-pod 401s - if any of the 10 fail, that's a FAIL for 6b, note which attempt numbers failed).
- Overall S6 verdict: PASS only if BOTH 6a and 6b individually passed their expected outcome.
- Cleanup: uninstall s6b (and s6a if it somehow left a release) and delete namespace s6 at the end regardless of outcome.`,
  },
  {
    id: 'S7',
    ns: 's7',
    title: 'Persistence: credentials survive pod recreation',
    spec: `- Install: \`helm install s7 libredb/libredb-studio --version ${ctx.chartVersion} -n s7 --create-namespace --set persistence.enabled=true\` (zero-config otherwise, no secrets set).
- Expect pod Ready; extract the generated admin email+password from the pod log banner (same as S1), write to ${RESULTS_DIR}/s7/original-credentials.txt chmod 600.
- Then \`kubectl delete pod -n s7 -l app.kubernetes.io/instance=s7\` and wait for the replacement pod to become Ready (\`kubectl rollout status deploy/s7-libredb-studio -n s7 --timeout=120s\` again, or poll \`kubectl get pods\`).
- Expect the NEW pod's log to show a "using generated admin credentials from" (or equivalent reuse-not-regenerate) message rather than a fresh "generated admin credentials" banner - grep the new pod's logs specifically (not the old pod's, which may still be terminating).
- Login 200 with the ORIGINAL password captured before the pod was deleted (proves persistence.enabled kept the credentials file across pod recreation via the PVC, not just in-memory).`,
  },
  {
    id: 'S8',
    ns: 's8',
    title: 'Upgrade path (previous chart -> current)',
    spec: `- First determine the PREVIOUS published chart version: \`helm search repo libredb/libredb-studio --versions -o json\`, sort semver, and pick the version immediately below ${ctx.chartVersion} (do NOT assume which one it is, derive it). Call it $PREV_VERSION.
- Generate random jwtSecret + adminPassword (${RESULTS_DIR}/s8/secrets.txt chmod 600).
- Install $PREV_VERSION with explicit secrets: \`helm install s8 libredb/libredb-studio --version $PREV_VERSION -n s8 --create-namespace --set secrets.jwtSecret=<jwtSecret> --set secrets.adminPassword=<adminPassword>\` (if $PREV_VERSION's values schema uses different keys for these, that's itself worth noting - use what the old chart's README/values.schema.json expects). Confirm pod Ready, Login 200.
- Then upgrade: \`helm upgrade s8 libredb/libredb-studio --version ${ctx.chartVersion} -n s8 --set secrets.jwtSecret=<jwtSecret> --set secrets.adminPassword=<adminPassword>\` (same values).
- Expect: upgrade succeeds; pod Ready again on the new version; Login 200 with the SAME credentials after upgrade (no regeneration); explicitly note in your notes field that the zero-config-default flip in ${ctx.chartVersion} did not disturb an install that sets explicit secrets, since this is a documented compatibility claim worth confirming.`,
  },
]

const S9 = {
  id: 'S9',
  ns: 's9-repo',
  title: 'Partner-charts catalog preview (optional, best-effort)',
  spec: `- This scenario is OPTIONAL and best-effort. If you hit a real blocker within a few minutes of reasonable effort, return verdict="BLOCKED" with a short explanation rather than spending a long time forcing it - do not let this scenario eat time from the rest of the run.
- Add a second ClusterRepo of type Git pointing at the partner-charts fork:
  \`\`\`
  kubectl apply -f - <<EOF
  apiVersion: catalog.cattle.io/v1
  kind: ClusterRepo
  metadata:
    name: partner-charts-preview
  spec:
    gitRepo: https://github.com/yusuf-gundogdu/partner-charts
    gitBranch: add-libredb-studio
  EOF
  \`\`\`
- Poll for Downloaded/active status (same pattern as the "libredb" ClusterRepo in Phase 2).
- Expect: the catalog serves a libredb-studio card (name/icon/description) - verify via the Rancher catalog API \`GET /v1/catalog.cattle.io.clusterrepos/partner-charts-preview?link=index\`.
- KNOWN AND EXPECTED: that branch still carries chart 0.1.3, whose default install fails on required secrets - do NOT count that as a chart failure or attempt to install it. This scenario ONLY previews catalog presentation (the repo/index serving correctly), nothing else.
- Record the raw catalog index JSON response to ${RESULTS_DIR}/s9/catalog-index.json.
- Cleanup: \`kubectl delete clusterrepo partner-charts-preview --ignore-not-found\` at the end of this scenario (separate from the main "libredb" ClusterRepo, which stays for now).`,
}

// S1 in Run A installed with helm and only photographed the catalog card and the
// install form. The path a Rancher user actually takes - Install from the Apps UI
// with default values - was never exercised, so a form/schema regression could
// pass the whole matrix (#170). This variant walks that path and keeps the
// screenshots as catalog-listing evidence.
const S1_UI = {
  id: 'S1-UI',
  ns: 's1ui',
  title: 'Zero-config install through the Rancher Apps UI (browser)',
  spec: `- Requires browser automation. If it is unavailable to you, return verdict="BLOCKED" immediately with that reason in notes - do not fall back to a helm install and call it a UI test, and do not spend time forcing the tooling.
- Log in to Rancher at https://localhost:${ctx.httpsPort} (self-signed cert: accept/bypass the warning). The admin password file path is recorded in the Phase 1 bootstrap transcript at ${RESULTS_DIR}/phase1-bootstrap.txt - read the path from there, never inline a password into your response.
- Install the chart the way a user would, taking a screenshot into ${RESULTS_DIR}/s1ui/ at each step (name them 01-catalog.png, 02-chart-detail.png, ... in order):
  1. Apps > Charts, "libredb" repo, the LibreDB Studio card visible.
  2. The chart detail page, with version ${ctx.chartVersion} selected.
  3. The install form step 1 (metadata): namespace s1ui, release name s1ui.
  4. The install form step 2 (values) LEFT AT DEFAULTS - change nothing. Capture the rendered form, and also the "Edit YAML" view so the defaults are on record.
  5. The install progress/log drawer.
  6. Apps > Installed showing the release as Deployed.
  7. The installed app's detail page, including the post-install notes if the UI shows them.
- Then verify from the CLI (this is what decides the verdict; the screenshots are evidence, not proof):
  - \`helm list -n s1ui\` shows s1ui with the chart version ${ctx.chartVersion} and status deployed.
  - \`kubectl rollout status deploy/s1ui-libredb-studio -n s1ui --timeout=150s\` succeeds and the pod is 1/1 Ready.
  - The zero-config credentials are retrievable exactly as the chart NOTES instruct: the pod-log banner, and \`kubectl exec deploy/s1ui-libredb-studio -n s1ui -- cat /app/data/auth-bootstrap.json\`. Write the retrieved credentials to ${RESULTS_DIR}/s1ui/credentials.txt (chmod 600) and report only that path.
  - Port-forward the service and log in once with those credentials: HTTP 200.
- Report any place the UI form contradicted the chart (a value marked required that the schema treats as optional, a rendered default that differs from values.yaml) - that mismatch is a FAIL, and it is the specific class of bug this scenario exists to catch.
- Cleanup: \`helm uninstall s1ui -n s1ui\` then \`kubectl delete ns s1ui\`, and confirm both are gone.`,
}

function buildWorkerPrompt(scenario, priorFailureNotes) {
  const retryNote = priorFailureNotes
    ? `\nNOTE: a previous fresh attempt at this exact scenario returned BLOCKED with these notes: "${priorFailureNotes}". You are a NEW fresh agent - try again from scratch, working around that specific blocker if possible.\n`
    : ''
  return `${GROUND_RULES}
${CONVENTIONS}
${retryNote}
SCENARIO ${scenario.id} - ${scenario.title} (namespace: ${scenario.ns}):
${scenario.spec}

Verdict rule: verdict="PASS" only if EVERY expected outcome above was confirmed with quoted evidence. Any single deviation makes verdict="FAIL". If you could not even attempt the scenario due to an environment/tooling blocker (not a chart behavior issue), verdict="BLOCKED" and explain in notes - be honest about the distinction, a chart behaving wrong is a FAIL, not a BLOCKED.

Return the structured verdict now, in exactly this shape: {id: "${scenario.id}", verdict, evidence: [...], artifacts: [...], notes}.`
}

async function runScenario(scenario, attempt) {
  attempt = attempt || 1
  const priorNotes = scenario._priorNotes || null
  const result = await agent(buildWorkerPrompt(scenario, priorNotes), {
    phase: 'Phase 3 - Scenario matrix',
    label: scenario.id,
    schema: VERDICT_SCHEMA,
  })
  if (result && result.verdict === 'BLOCKED' && attempt < 2) {
    log(`${scenario.id} BLOCKED on attempt ${attempt}, retrying fresh...`)
    scenario._priorNotes = result.notes
    return runScenario(scenario, attempt + 1)
  }
  return result
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

phase('Phase 3 - Scenario matrix')
log('Running S2-S8 in batches of 3 (memory-capped single-node cluster)...')
const batches = chunk(SCENARIOS, 3)
let matrixResults = []
for (const batch of batches) {
  const batchResults = await parallel(batch.map((s) => () => runScenario(s)))
  matrixResults.push(...batchResults)
  log(`Batch done: ${batch.map((s) => s.id).join(', ')} -> ${batchResults.map((r) => (r ? r.verdict : 'ERROR')).join(', ')}`)
}

log('Running S9 (optional, best-effort) and S1-UI (Apps UI install) in parallel...')
const [s9Result, s1UiResult] = await parallel([
  () =>
    agent(buildWorkerPrompt(S9, null), {
      phase: 'Phase 3 - Scenario matrix',
      label: 'S9',
      schema: VERDICT_SCHEMA,
    }),
  // Its own namespace and its own browser session, so it does not contend with
  // S9's ClusterRepo work on the shared single-node cluster.
  () => runScenario(S1_UI),
])
matrixResults.push(s9Result, s1UiResult)

const allResults = matrixResults.filter(Boolean)
const fails = allResults.filter((r) => r.verdict === 'FAIL')

phase('Verification - adversarial FAIL repro')
let verifications = []
if (fails.length > 0) {
  log(`${fails.length} FAIL(s) found (${fails.map((f) => f.id).join(', ')}) - running adversarial repro on each...`)
  verifications = await parallel(
    fails.map((f) => () =>
      agent(
        `${GROUND_RULES}
${CONVENTIONS}
A previous scenario worker reported FAIL for scenario ${f.id}. Your job is NOT to trust that report blindly - reproduce it ONCE from scratch in a FRESH namespace (use "${f.id.toLowerCase()}-verify" as the namespace/release prefix to avoid clashing with anything) and classify the failure.

Original scenario spec (for reference, execute it yourself again):
${(SCENARIOS.find((s) => s.id === f.id) || S9).spec}

Original reported evidence: ${JSON.stringify(f.evidence)}
Original reported notes: ${f.notes}

Reproduce the exact steps that were reported to fail. Then classify as exactly one of:
- "chart_bug" - the chart genuinely does not behave as documented/expected.
- "environment_flake" - a transient infra issue (DNS, port race, image pull, node pressure) that is unrelated to chart correctness; ideally show it succeeding on this fresh attempt as proof.
- "test_script_bug" - the ORIGINAL scenario instructions/commands were wrong or ambiguous, not the chart.

Clean up your verification namespace/release at the end regardless of outcome. Write full transcript to ${RESULTS_DIR}/${f.id.toLowerCase()}/verification.txt.

Return your classification now.`,
        {
          phase: 'Verification - adversarial FAIL repro',
          label: `verify:${f.id}`,
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              classification: { type: 'string', enum: ['chart_bug', 'environment_flake', 'test_script_bug'] },
              reproduced: { type: 'boolean' },
              evidence: { type: 'array', items: { type: 'object', properties: { check: { type: 'string' }, command: { type: 'string' }, output_excerpt: { type: 'string' } } } },
              notes: { type: 'string' },
            },
            required: ['id', 'classification', 'reproduced'],
          },
        }
      )
    )
  )
  verifications = verifications.filter(Boolean)
} else {
  log('No FAILs in the matrix - skipping verification pass.')
}

phase('Judge - matrix')
const compactVerdicts = allResults.map((r) => ({ id: r.id, verdict: r.verdict, notes: r.notes }))
const judge = await agent(
  `You are the judge for the Rancher E2E validation matrix (Run B, scenarios S2-S9). You do NOT re-run anything - you only reason over the verdicts and verification classifications below.

Matrix verdicts: ${JSON.stringify(compactVerdicts)}
Adversarial verification results for FAILs: ${JSON.stringify(verifications.map((v) => ({ id: v.id, classification: v.classification, reproduced: v.reproduced, notes: v.notes })))}

Note: S3 and the "6a" part of S6 are negative tests where a FAILING helm install is the correct/expected behavior - verdict="PASS" for those already reflects that (the worker was instructed on this), so don't re-flag them as concerning just because their scenario involves an intentional install failure.
S9 is optional/best-effort - a BLOCKED or FAIL there is lower severity than the mandatory S2-S8 scenarios.

Decide:
- overallStatus: "MATRIX_HEALTHY" if all mandatory scenarios (S2-S8) are PASS, or any FAILs were classified as environment_flake with reproduced=true on retry (meaning the chart itself is fine). "MATRIX_HAS_CHART_ISSUES" if any FAIL was classified chart_bug. "MATRIX_INCONCLUSIVE" if there are unresolved BLOCKEDs or test_script_bug classifications that need a human to adjudicate.
- candidateIssues: array of short strings, one per chart_bug or unresolved discrepancy worth a follow-up issue (empty array if none).
- reasoning: short paragraph.

Return the structured judgment now.`,
  {
    phase: 'Judge - matrix',
    schema: {
      type: 'object',
      properties: {
        overallStatus: { type: 'string', enum: ['MATRIX_HEALTHY', 'MATRIX_HAS_CHART_ISSUES', 'MATRIX_INCONCLUSIVE'] },
        candidateIssues: { type: 'array', items: { type: 'string' } },
        reasoning: { type: 'string' },
      },
      required: ['overallStatus', 'candidateIssues', 'reasoning'],
    },
  }
)
log(`Judge verdict on matrix: ${judge.overallStatus}`)

phase('Phase 4 - UI evidence')
log('Attempting UI evidence capture (best effort, Playwright if available)...')
const phase4 = await agent(
  `${GROUND_RULES}
TASK: Phase 4 UI evidence - BEST EFFORT ONLY, must not block anything else. Budget yourself to roughly 10 minutes.

If Playwright browser automation is available to you, navigate to https://localhost:${ctx.httpsPort} (self-signed cert - you'll need to accept/bypass the certificate warning; Rancher's login form takes the admin credentials from ${ctx.adminTokenPath}'s associated account - if you need to log in via the UI rather than reusing the API token, read the password file mentioned in the Phase 1 bootstrap transcript at ${RESULTS_DIR}/phase1-bootstrap.txt for the file path, do not ask for it inline) and capture screenshots into ${RESULTS_DIR}/screenshots/ for:
1. Apps > Charts showing the LibreDB Studio card from the "libredb" repo.
2. The install form / values YAML view for that chart.
3. Any currently-installed app's detail page (if one exists at the time you check - the matrix scenarios clean up after themselves so you may need to be quick, or just show the Apps > Installed list which is still valid evidence even if empty).
4. Any pod logs view you can reach through the UI.

If Playwright is not available, or the login/cert flow proves too slow to resolve quickly, STOP trying and instead just record equivalent evidence via the Rancher API (same endpoints already used in Phase 1/2 with the Bearer token) - e.g. GET /v1/catalog.cattle.io.clusterrepos/libredb?link=index dumped to a file - and clearly note in your response that UI screenshots were not captured and why.

Return: {screenshotsCaptured: boolean, screenshotPaths: string[], apiFallbackUsed: boolean, apiFallbackPaths: string[], gapNotes: string}`,
  {
    phase: 'Phase 4 - UI evidence',
    schema: {
      type: 'object',
      properties: {
        screenshotsCaptured: { type: 'boolean' },
        screenshotPaths: { type: 'array', items: { type: 'string' } },
        apiFallbackUsed: { type: 'boolean' },
        apiFallbackPaths: { type: 'array', items: { type: 'string' } },
        gapNotes: { type: 'string' },
      },
      required: ['screenshotsCaptured', 'apiFallbackUsed'],
    },
  }
)
log(`Phase 4 UI evidence: screenshots=${phase4.screenshotsCaptured}, apiFallback=${phase4.apiFallbackUsed}`)

phase('Phase 5 - Report')
log('Writing the RESULTS-<date>.md report...')
const report = await agent(
  `${GROUND_RULES}
TASK: Phase 5 - write the final report to ${RESULTS_DIR}/RESULTS-<date>.md, where <date> comes from running \`date -u +%F\` yourself right now (never guess it).

Data to include, exactly per deploy/rancher/E2E_VALIDATION_TASK.md Phase 5:

1. ENVIRONMENT TABLE: Rancher version (${ctx.rancherVersion}), bundled K3s version (${ctx.k3sVersion}), Kubernetes version (${ctx.k8sVersion}), chart version (${ctx.chartVersion}), appVersion (${ctx.appVersion}), host OS/kernel (run \`uname -a\` yourself), Docker version (run \`docker version --format '{{.Server.Version}}'\` yourself), port mapping (${ctx.httpPort}/${ctx.httpsPort}).

2. SCENARIO VERDICT TABLE, S1 through S9, PASS/FAIL/BLOCKED/SKIPPED with a one-line evidence summary each. Source data:
   - S1 (from Run A): ${JSON.stringify(args.s1)}
   - S2-S9 (from Run B matrix): ${JSON.stringify(allResults)}
   - Adversarial verification classifications for any FAILs: ${JSON.stringify(verifications)}
   - Judge's overall matrix status: ${judge.overallStatus} - ${judge.reasoning}

3. FULL EVIDENCE APPENDIX per scenario: for each of S1-S9, list its evidence array's check/command/output_excerpt entries and its artifacts file paths (from the JSON above - do not invent anything not present there).

4. A ready-to-paste row for the docs/RANCHER.md "Validated combinations" table, in exactly this format (fill in with real values, use the date you just obtained):
   \`| Rancher ${ctx.rancherVersion} (single-node Docker) | v${ctx.k8sVersion} | <date> | bundled K3s ${ctx.k3sVersion}; installed via Rancher Apps catalog |\`

5. Any chart/doc discrepancies found (behavior differing from README/RANCHER.md) as a bullet list of CANDIDATE issues (do not open any GitHub issue yourself) - pull from the judge's candidateIssues: ${JSON.stringify(judge.candidateIssues)}, plus anything else you notice reading through the evidence above (e.g. the S1 helm v4-vs-v3 observation from Phase 0, if it seems relevant).

6. UI evidence section: note whether screenshots were captured (${phase4.screenshotsCaptured}) with paths, or the API-fallback gap (${phase4.gapNotes}).

Write the file with Bash (heredoc or similar). After writing, \`cat\` it back to confirm it was written, and report the exact final file path and the date string you used.

Return: {reportPath: string, dateUsed: string, wordCountApprox: number}`,
  {
    phase: 'Phase 5 - Report',
    schema: {
      type: 'object',
      properties: {
        reportPath: { type: 'string' },
        dateUsed: { type: 'string' },
        wordCountApprox: { type: 'number' },
      },
      required: ['reportPath', 'dateUsed'],
    },
  }
)
log(`Report written: ${report.reportPath}`)

phase('Phase 6 - Cleanup')
log('Running mandatory Phase 6 cleanup - tearing down Rancher and the cluster...')
const cleanup = await agent(
  `${GROUND_RULES}

TASK: Phase 6 - mandatory cleanup, restore the machine to its pre-task state. This runs regardless of matrix outcome.

Steps:
1. \`export KUBECONFIG=${ctx.kubeconfigPath}\`. List namespaces (\`kubectl get ns\`) and uninstall/delete ANY leftover release/namespace from this entire run (S1 through S9's namespaces, and any -verify namespaces from the adversarial verification pass) - every scenario is supposed to have cleaned up after itself already, so this is a safety-net sweep, not the primary cleanup. \`helm list -A\` to see any lingering releases; \`helm uninstall <r> -n <ns> --ignore-not-found\` isn't a real flag for helm uninstall, so check existence first with \`helm status\` or just attempt uninstall and ignore "release: not found" errors.
2. \`kubectl delete clusterrepo libredb --ignore-not-found\` and \`kubectl delete clusterrepo partner-charts-preview --ignore-not-found\` (the S9 repo, if it was created).
3. \`docker rm -f rancher-e2e\`.
4. \`helm repo remove libredb\` (the local CLI alias added in Phase 2 of Run A).
5. \`docker volume prune -f --filter label=io.rancher.stack=rancher-e2e\` if such volumes exist, otherwise skip - do NOT prune all dangling volumes on the machine, only ones clearly created by this task (check \`docker volume ls\` for anything referencing rancher-e2e first).
6. Remove temporary secret/kubeconfig files: ${ctx.kubeconfigPath}, ${ctx.adminTokenPath}, and any .admin-password file alongside it - but KEEP every *.txt transcript, the RESULTS-*.md report, and all scenario evidence subdirectories (s1/ s2/ ... s9/ etc, screenshots/) under ${RESULTS_DIR}/.
7. Verify and report: \`docker ps -a | grep rancher-e2e\` (must be empty), \`ss -ltn | grep -E ':${ctx.httpPort} |:${ctx.httpsPort} '\` (must be empty, ports free again), \`find ${RESULTS_DIR} -maxdepth 1 -name '.admin*' -o -name 'kubeconfig.yaml'\` (must be empty - no stray secret/kubeconfig files remain), and confirm no kubeconfig/token files exist ANYWHERE outside ${RESULTS_DIR}/ that this task created (there shouldn't be any, but check /tmp for anything you may have written there and remove it).

Return: {dockerRemoved: boolean, portsFree: boolean, strayFilesFound: string[], summary: string (under 200 words)}`,
  {
    phase: 'Phase 6 - Cleanup',
    schema: {
      type: 'object',
      properties: {
        dockerRemoved: { type: 'boolean' },
        portsFree: { type: 'boolean' },
        strayFilesFound: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['dockerRemoved', 'portsFree', 'summary'],
    },
  }
)
log(`Cleanup done: dockerRemoved=${cleanup.dockerRemoved}, portsFree=${cleanup.portsFree}`)

return {
  matrixResults: allResults,
  verifications,
  judge,
  phase4,
  report,
  cleanup,
}
