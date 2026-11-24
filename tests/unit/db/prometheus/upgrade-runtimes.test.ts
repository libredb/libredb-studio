/**
 * A 101 that announces an upgrade, answered to the Prometheus TLS path, on Bun and on the Node the tests find on PATH:
 * the send fails at once as a network failure, and the switched connection is closed.
 *
 * node:https hands such a 101 to the request's `upgrade` event and the socket with it. Destroying the request closes
 * that socket on Bun but not on Node, the production runtime, so only the Node run tells whether the path destroys the
 * socket itself.
 *
 * Under Node: tests/helpers/prometheus-upgrade-outcome.ts is bundled for Node and run in a child process.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { prometheusUpgradeOutcome, type UpgradeOutcome } from "../../../helpers/prometheus-upgrade-outcome";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const TLS = loadTlsFixtures();
const MATERIAL = { ca: TLS.ca, cert: TLS.server.cert, key: TLS.server.key };

const EXPECTED: UpgradeOutcome = {
  failure: "RequestFailure network: The request failed before a complete response arrived",
  peerClosed: true,
};

let inBun: UpgradeOutcome | undefined;
let underNode: { version: string; outcome: UpgradeOutcome | undefined } = { version: "", outcome: undefined };

beforeAll(async () => {
  inBun = await prometheusUpgradeOutcome(MATERIAL);
  const node = Bun.which("node");
  if (node === null) {
    throw new Error(
      "No node on PATH: this test runs the Prometheus TLS path under Node, the production runtime; install Node 24 or later",
    );
  }
  const work = mkdtempSync(join(tmpdir(), "prometheus-upgrade-"));
  try {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "..", "..", "helpers", "prometheus-upgrade-outcome.ts")],
      target: "node",
      format: "esm",
      outdir: work,
    });
    expect({ success: build.success, logs: build.logs.map(String) }).toMatchObject({ success: true });
    writeFileSync(join(work, "input.json"), JSON.stringify(MATERIAL));
    writeFileSync(
      join(work, "run.mjs"),
      [
        'import { readFileSync } from "node:fs";',
        `const { prometheusUpgradeOutcome } = await import(${JSON.stringify(pathToFileURL(build.outputs[0].path).href)});`,
        `const material = JSON.parse(readFileSync(${JSON.stringify(join(work, "input.json"))}, "utf8"));`,
        "process.stdout.write(JSON.stringify({ version: process.version, outcome: await prometheusUpgradeOutcome(material) }));",
        "",
      ].join("\n"),
    );
    // A synchronous spawn holds this process, so the child carries its own bound.
    const run = Bun.spawnSync([node, join(work, "run.mjs")], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect({
      exitCode: run.exitCode,
      timedOut: run.exitedDueToTimeout === true,
      stderr: run.stderr.toString(),
    }).toMatchObject({ exitCode: 0, timedOut: false });
    // The report is the child's last line: its first egress decision logs one info line to the same stdout before it.
    underNode = JSON.parse(run.stdout.toString().trim().split("\n").at(-1) as string);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 90_000);

describe("a 101 that switches protocols, on the Prometheus TLS path", () => {
  test("under Bun, the send fails at once as a network failure and the switched connection is closed", () => {
    expect(inBun).toEqual(EXPECTED);
  });

  test("under Node, the production runtime, the same", () => {
    expect(underNode.version).toMatch(/^v\d+\./);
    expect(underNode.outcome).toEqual(EXPECTED);
  });
});
