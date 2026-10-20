import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstAnswer } from "../child-answer";
import { backendForkOptions } from "../fork-options";

function forkScript(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "libredb-child-answer-"));
  const script = join(dir, "child.js");
  writeFileSync(script, source);
  return fork(script, [], backendForkOptions(dir, process.execPath));
}

describe("firstAnswer", () => {
  it("resolves with the child's first message", async () => {
    const child = forkScript('process.send({ hello: "host" }); process.disconnect();');
    assert.deepEqual(await firstAnswer(child), { hello: "host" });
  });

  it("rejects with the exit code and the child's stderr when the child exits before answering", async () => {
    const child = forkScript('console.error("no bundle here"); process.exit(3);');
    await assert.rejects(firstAnswer(child), { message: "child exited 3 before answering: no bundle here" });
  });

  it("names the signal when a signal ends the child before it answers", async () => {
    const child = forkScript("setInterval(() => {}, 1000);");
    const answer = firstAnswer(child);
    child.kill("SIGKILL");
    await assert.rejects(answer, { message: "child exited SIGKILL before answering: " });
  });
});
