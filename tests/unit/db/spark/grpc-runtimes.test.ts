import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPARK_ERROR_SENTENCES } from "@/lib/db/providers/sql/spark/errors";
import { runSparkRuntimeCases, type SparkRuntimeOutcome } from "../../../helpers/spark-runtime-cases";

const HELPER = join(import.meta.dir, "../../../helpers/spark-runtime-cases.ts");
const ROOT = join(import.meta.dir, "../../../..");

const unreadable = (what: string) => `SparkError: ${SPARK_ERROR_SENTENCES.unreadable(what)}`;
const nested = (levels: number, open: string, inner: string, close: string) =>
  `${open.repeat(levels)}${inner}${close.repeat(levels)}`;

/**
 * What both runtimes must show for every row: the class and the sentence, never a runtime's own text. The two TLS rows
 * lead with the fake's port, which their sentences name, so they are built from the port each run reports.
 */
function expectedOutcomes(port: { plain: number; tls: number }): Readonly<Record<string, string>> {
  return {
    interrupt: `true QueryCancelledError: ${SPARK_ERROR_SENTENCES.cancelled}`,
    "error info": `QueryError: The data type TIME is not supported.\n${SPARK_ERROR_SENTENCES.timeTypeOff}`,
    "oversized command": `QueryError: ${SPARK_ERROR_SENTENCES.receiveCapCommand}`,
    "large var types": `QueryError: ${SPARK_ERROR_SENTENCES.largeVarTypes}`,
    "over-deep schema": `QueryError: ${SPARK_ERROR_SENTENCES.unreadable("a schema nested deeper than 64 levels")}`,
    heartbeat: "beats 3, cleared while running false, cleared at the end true",
    "keepalive cut": `QueryError: ${SPARK_ERROR_SENTENCES.pingGoaway}`,
    "no token": `AuthenticationError: ${SPARK_ERROR_SENTENCES.tokenMissing}`,
    "wrong token": `AuthenticationError: ${SPARK_ERROR_SENTENCES.tokenWrong}`,
    "old version": `ConnectionError: ${SPARK_ERROR_SENTENCES.versionTooOld("3.5.9")}`,
    "vendor suffix": "connected",
    "tls to plaintext": `${port.plain} ConnectionError: ${SPARK_ERROR_SENTENCES.tlsPlaintextServer("127.0.0.1", port.plain)}`,
    "plaintext to tls": `${port.tls} ConnectionError: ${SPARK_ERROR_SENTENCES.tlsPortExpected("127.0.0.1", port.tls)}`,
    "untrusted ca": `ConnectionError: ${SPARK_ERROR_SENTENCES.tlsUntrusted}`,
    reset: `ConnectionError: ${SPARK_ERROR_SENTENCES.connectionDropped}`,
    // The cut connect ends cancelled, and its probe session is released before its channel closes.
    "probe release past a disconnect": `QueryCancelledError: ${SPARK_ERROR_SENTENCES.cancelled} | disconnect answered | AnalyzePlan ReleaseSession`,
    "probe release past a second connect": `QueryCancelledError: ${SPARK_ERROR_SENTENCES.cancelled} | connect answered | AnalyzePlan ReleaseSession, AnalyzePlan ReleaseSession, Config ExecutePlan ReleaseSession`,
    "ipc bounds": [
      unreadable("a message without the continuation marker"),
      unreadable("a message header longer than 1 MiB or past the end of the stream"),
      unreadable("a message body past the end of the stream"),
      unreadable("a stream without its end-of-stream marker"),
      unreadable("a message type Spark does not send"),
      '{"fields":64,"depth":64,"batches":1}',
      unreadable("a schema nested deeper than 64 levels"),
    ].join(" | "),
    "status details": "undefined",
    "status details size": '65536 reason="R" errorClass="X" | 65537 undefined',
    "status details count": '1056 reason="R" errorClass="X" | 1122 undefined',
    "status details value":
      '8285 reason="R" errorClass="X" messageParameters=8192 chars | 8286 reason="R" errorClass="X"',
    "status details bom": '69 reason="\ufeffR" errorClass="X"',
    "variant depth": `${nested(64, "[", "null", "]")} | ${unreadable("a VARIANT value that does not follow the Variant encoding")}`,
    "wkb depth": `${nested(63, "GEOMETRYCOLLECTION (", "POINT (1 2)", ")")} | undefined`,
    "schema depth": `${nested(63, "array<", "int", ">")} | ${unreadable("a result schema nested deeper than 64 levels")}`,
  };
}

/** Every row exactly, in order, against the sentences both runtimes must show. */
function holdsExpectations(outcomes: readonly SparkRuntimeOutcome[]): void {
  const byName = Object.fromEntries(outcomes.map((item) => [item.name, item.outcome]));
  const leadingPort = (name: string) => Number(byName[name]?.split(" ")[0]);
  const port = { plain: leadingPort("tls to plaintext"), tls: leadingPort("plaintext to tls") };
  const expected = expectedOutcomes(port);
  expect(outcomes).toStrictEqual(Object.entries(expected).map(([name, outcome]) => ({ name, outcome })));
}

/**
 * The rows with the number an outcome opens with, if any, written as `<port>` wherever it appears in that outcome. Any
 * row whose outcome opens with a number is masked this way: the two TLS rows, which open with their own port, the
 * one text that differs from run to run, and the status details rows, whose leading sizes are masked with them.
 */
function withoutPorts(outcomes: readonly SparkRuntimeOutcome[]): SparkRuntimeOutcome[] {
  return outcomes.map(({ name, outcome }) => {
    const port = /^(\d+) /.exec(outcome)?.[1];
    return { name, outcome: port === undefined ? outcome : outcome.replaceAll(port, "<port>") };
  });
}

let bun: readonly SparkRuntimeOutcome[] = [];
let node: { version: string; outcomes: readonly SparkRuntimeOutcome[] } = { version: "", outcomes: [] };
let work = "";

beforeAll(async () => {
  bun = await runSparkRuntimeCases();
  work = mkdtempSync(join(tmpdir(), "spark-runtimes-"));
  const binary = Bun.which("node");
  if (binary === null)
    throw new Error("No node on PATH: this file runs the cases under Node; install Node 24 or later");
  writeFileSync(
    join(work, "child.ts"),
    [
      `import { runSparkRuntimeCases } from ${JSON.stringify(HELPER)};`,
      "const outcomes = await runSparkRuntimeCases();",
      'process.stdout.write(JSON.stringify({ version: process.version, outcomes }) + "\\n");',
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const build = await Bun.build({ entrypoints: [join(work, "child.ts")], target: "node", format: "esm", outdir: work });
  if (!build.success) throw new Error(`Bun.build could not bundle the child: ${build.logs.join("\n")}`);
  const child = Bun.spawn([binary, join(work, "child.js")], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The Node child exited ${exitCode}: ${stderr}`);
  node = JSON.parse(stdout.trim()) as typeof node;
}, 150_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("Spark Connect under both runtimes", () => {
  test("under Bun every row shows its class and sentence", () => {
    holdsExpectations(bun);
  });

  test("the child is Node and says which version ran the cases", () => {
    expect(node.version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test("under Node every row shows the same class and sentence as under Bun", () => {
    holdsExpectations(node.outcomes);
    expect(withoutPorts(node.outcomes)).toStrictEqual(withoutPorts(bun));
  });
});
