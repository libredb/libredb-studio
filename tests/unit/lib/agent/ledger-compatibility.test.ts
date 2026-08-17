import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunStore, ledgerStreamName } from "@/lib/agent/run-store";

/**
 * The #330 T2 gate: **a ledger written before `workflowType` existed still folds to
 * the same timeline.**
 *
 * The fixture is not synthetic. `tests/fixtures/agent/pre-workflow-type-ledger.ndjson`
 * is a real run, driven in a browser against the bundled SQLite sample on 2026-08-12
 * while verifying #342, read back out of `.workflow-data/streams/chunks/*.bin` and
 * copied here verbatim — only the actor's session id was replaced, because a real
 * account name does not belong in a fixture. Every other byte is what the server
 * wrote, which is the whole point: a hand-written fixture proves that the fold
 * handles the shape somebody THOUGHT the old writer produced.
 *
 * That run is also a useful one to keep: it is the #341 F5 strategy defect caught in
 * the wild — the answer obtained in one query returning nine rows, then a
 * near-identical second query returning the same nine — ended by the model provider's
 * rate limit before any report was composed.
 *
 * A ledger like this one will exist on real deployments for as long as those
 * deployments keep their run history. If a later field ever changes what one of them
 * MEANS, this test is what says so.
 */

const FIXTURE = path.resolve(import.meta.dir, "../../../fixtures/agent/pre-workflow-type-ledger.ndjson");

const dataDirs: string[] = [];

/** Replays a raw ledger into a real backend and folds it, exactly as a server would. */
async function foldFixture(): Promise<Awaited<ReturnType<AgentRunStore["read"]>>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ledger-compat-"));
  dataDirs.push(dataDir);
  const world = createLocalWorld({ dataDir, recoverActiveRuns: false });
  const lines = fs
    .readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const runId = String((JSON.parse(lines[0] ?? "{}") as { runId?: unknown }).runId);
  for (const line of lines) await world.writeToStream(ledgerStreamName(runId), runId, `${line}\n`);
  return new AgentRunStore({ world }).read(runId);
}

describe("a ledger written before workflowType existed", () => {
  test("still folds, and to the same timeline it always had", async () => {
    const view = await foldFixture();

    expect(view).not.toBeNull();
    expect(view?.record.events.map((event) => event.kind)).toEqual([
      "run-started",
      "context-captured",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      "statement-drafted",
      "tool-invoked",
      "tool-completed",
      "tool-invoked",
      "tool-completed",
      "run-finished",
    ]);
    expect(view?.record.mode).toBe("agent");
    expect(view?.record.status).toBe("failed");
    expect(view?.terminal).toBe(true);
    expect(view?.record.objective).toBe("Which department has the most employees?");
  });

  test("reads as an investigation, because that is the only thing the runtime could do when it was written", async () => {
    const view = await foldFixture();

    // The default is a READING of the old ledger, not a fallback: every run written
    // before this field was an investigation, so answering anything else would be
    // inventing a fact about a run nobody can go back and ask.
    expect(view?.record.workflowType).toBe("investigation");
  });

  test("its settled steps and its ending survive the new field", async () => {
    const view = await foldFixture();

    expect(view?.settledSteps.size).toBe(3);
    expect(view?.unsettledStepIds).toEqual([]);
    const finished = view?.record.events.at(-1);
    expect(finished).toMatchObject({ kind: "run-finished", status: "failed", reason: "model-rate-limited" });
  });
});

describe("the fixture is the real thing", () => {
  test("its header carries no workflowType at all, which is what makes this test mean anything", () => {
    const header = JSON.parse(fs.readFileSync(FIXTURE, "utf8").split("\n")[0] ?? "{}") as Record<string, unknown>;

    expect(header.kind).toBe("run-opened");
    expect("workflowType" in header).toBe(false);
  });
});

process.on("exit", () => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("a ledger written before autoExecute existed", () => {
  test("reads as auto-execute off, because no run written then handed a statement anywhere", async () => {
    // The same reading `workflowType` gets, and for a stronger reason: the setting
    // gives away the editor's time limit, so a header that does not carry it must
    // fold to the answer that gives nothing away.
    const view = await foldFixture();

    expect(view?.record.autoExecute).toBe(false);
  });
});

describe("a ledger written before workflowSource existed", () => {
  test("reads as a chosen workflow, because every run written then carried the workflow it was sent", async () => {
    // The opposite reading to `autoExecute`'s, and deliberately so. Nothing inferred
    // a workflow when this header was written — the client sent one on every open
    // request — so `"inferred"` would be inventing a classification that never ran.
    const view = await foldFixture();

    expect(view?.record.workflowSource).toBe("chosen");
  });
});

describe("a ledger written before workflowReading existed", () => {
  test("records no classifier outcome, rather than being read as one that succeeded or one that failed", async () => {
    // Both alternatives are claims this header cannot support. `"classified"` would
    // present a fallback as a verdict — the defect the field was added to end — and
    // `"unclassified"` asserts a failure nobody recorded, which can contradict the
    // workflow beside it.
    const view = await foldFixture();

    expect(view?.record.workflowReading).toBe("unrecorded");
  });
});

describe("a ledger written before goalVerdict existed", () => {
  test("still folds, and its ending still reads as the ending it always was", async () => {
    // B24's field is additive for the same reason `workflowType` was: an older
    // ending carries no verdict, and its ABSENCE means exactly what is true of it —
    // no verifier ran. Adding a fourth STATUS instead would have split `succeeded`
    // by ledger generation, with nothing in a record like this one to say which
    // meaning applied.
    const view = await foldFixture();

    const finished = view?.record.events.at(-1);
    if (finished?.kind !== "run-finished") throw new Error("expected an ending");
    expect(finished.goalVerdict).toBeUndefined();
    expect(finished.status).toBe("failed");
    expect(finished.reason).toBe("model-rate-limited");
  });
});
