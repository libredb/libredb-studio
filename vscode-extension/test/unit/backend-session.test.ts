import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { backendForkOptions } from "../../src/host/fork-options";
import { type BackendSession, openSession } from "../backend-session";

const ANSWER = {
  protocolVersion: 1,
  runtime: { node: "24.21.0", electron: null, modules: "148", platform: "linux", arch: "x64" },
  enabledProviders: ["postgres", "mssql", "mysql", "mongodb"],
};

/** A child that answers initialize with ANSWER once `ready` settles, and exits once its host closes the channel. */
function answering(ready = "Promise.resolve()"): string {
  return `
const ready = ${ready};
process.on("message", (message) => {
  if (message.method === "initialize") {
    ready.then(() => process.send({ jsonrpc: "2.0", id: message.id, result: ${JSON.stringify(ANSWER)} }));
  }
});
process.on("disconnect", () => process.exit(0));
`;
}

function forkScript(source: string): BackendSession {
  const dir = mkdtempSync(join(tmpdir(), "libredb-backend-session-"));
  const script = join(dir, "child.js");
  writeFileSync(script, source);
  return openSession(fork(script, [], backendForkOptions(dir, process.execPath)));
}

/**
 * Closes the channel and waits for the child's exit and the end of its pipes.
 * Not the child's close event: after the host's own disconnect(), Node 24 never emits it.
 */
async function end(session: BackendSession): Promise<void> {
  const { child } = session;
  const exited = once(child, "exit");
  session.connection.dispose();
  child.disconnect();
  await exited;
  await Promise.all([child.stdout, child.stderr].map((pipe) => pipe && finished(pipe)));
}

describe("openSession", () => {
  it("resolves initialize with the child's answer", async () => {
    const session = forkScript(answering());
    assert.deepEqual(await session.initialize(), ANSWER);
    await end(session);
  });

  it("rejects with the exit code and the child's stderr when the child exits before answering", async () => {
    const session = forkScript('console.error("boom"); process.exit(3);');
    await assert.rejects(session.initialize(), { message: "child exited 3 before answering: boom" });
    assert.equal(session.stderr(), "boom\n");
  });

  it("names the signal when a signal ends the child before it answers", async () => {
    const session = forkScript("setInterval(() => {}, 1000);");
    const answer = session.initialize();
    session.child.kill("SIGKILL");
    await assert.rejects(answer, { message: "child exited SIGKILL before answering: " });
  });

  it("reads stdout throughout, so a child that writes 1 MB to stdout first still answers", async () => {
    // The answer waits until the pipe took the last byte, which it never does unless the host reads it.
    const session = forkScript(
      answering('new Promise((resolve) => process.stdout.write("x".repeat(1024 * 1024), resolve))'),
    );
    assert.deepEqual(await session.initialize(), ANSWER);
    await end(session);
    assert.equal(session.stdout().length, 1024 * 1024);
  });
});
