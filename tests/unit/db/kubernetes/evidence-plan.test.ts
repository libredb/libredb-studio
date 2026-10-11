import { describe, expect, test } from "bun:test";
import path from "node:path";
import { KUBECTL_COMMAND_TABLE } from "@/lib/db/providers/platform/kubernetes/console/commands";
import { parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import { connectionOf, insideDirectory, runArguments } from "../../../live/kubernetes-evidence";
import {
  EVIDENCE_TARGETS,
  type EvidenceSet,
  gridShows,
  READER_STATEMENT_FACTS,
  READER_STATEMENTS,
} from "../../../live/kubernetes-evidence-plan";

/**
 * The capture's plan and command line, checked without a cluster: every statement it captures is one the console
 * parses, every v1 command is captured at least once for the reader persona the end-to-end stub server replays, and
 * the command line refuses a kubeconfig directory inside the repository.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");

describe("the plan", () => {
  test("every statement of every scenario is one the console parses", () => {
    const statements = Object.values(EVIDENCE_TARGETS).flatMap((target) =>
      target.scenarios.flatMap((scenario) =>
        scenario.steps.flatMap((step) => (step.op === "statement" ? [step.text] : [])),
      ),
    );
    for (const text of statements) expect({ text, ok: parseKubectl(text).ok }).toEqual({ text, ok: true });
  });

  test("the reader's statements run every v1 command at least once", () => {
    for (const { command } of KUBECTL_COMMAND_TABLE) {
      expect({ command, captured: READER_STATEMENTS.some((text) => text.startsWith(`kubectl ${command}`)) }).toEqual({
        command,
        captured: true,
      });
    }
  });

  test.each(Object.keys(EVIDENCE_TARGETS) as EvidenceSet[])("set %s connects first in every scenario", (set) => {
    for (const scenario of EVIDENCE_TARGETS[set].scenarios)
      expect(scenario.steps[0]).toEqual(expect.objectContaining({ op: "connect" }));
  });

  test("each set reads the server version, which the manifest records", () => {
    for (const target of Object.values(EVIDENCE_TARGETS)) {
      const readsVersion = target.scenarios.some((scenario) =>
        scenario.steps.some(
          (step) => step.op === "health" || (step.op === "statement" && step.text === "kubectl version"),
        ),
      );
      expect({ cluster: target.cluster, readsVersion }).toEqual({ cluster: target.cluster, readsVersion: true });
    }
  });

  test("every reader statement has the fact its grid must show, and no fact names a statement the reader skips", () => {
    expect(Object.keys(READER_STATEMENT_FACTS).sort()).toEqual([...READER_STATEMENTS].sort());
  });

  test("every statement that is not refused names the fact its grid must show", () => {
    for (const target of Object.values(EVIDENCE_TARGETS)) {
      for (const scenario of target.scenarios) {
        for (const step of scenario.steps) {
          if (step.op !== "statement" || step.refused === true) continue;
          expect({ text: step.text, shows: step.shows !== undefined }).toEqual({ text: step.text, shows: true });
        }
      }
    }
  });
});

describe("gridShows", () => {
  test("a cell fact matches a whole cell, a within fact a part of one, and a notice row matches neither", () => {
    const rows = [{ NAME: "crasher", STATUS: "CrashLoopBackOff", RESTARTS: 4 }];
    expect(gridShows(rows, { cell: "crasher" })).toBe(true);
    expect(gridShows(rows, { cell: "crash" })).toBe(false);
    expect(gridShows(rows, { within: "LoopBack" })).toBe(true);
    expect(gridShows(rows, { cell: "4" })).toBe(true);
    expect(gridShows([{ notice: "Kubernetes refused this read." }], { cell: "crasher" })).toBe(false);
    expect(gridShows([], { within: "crasher" })).toBe(false);
  });
});

describe("insideDirectory", () => {
  test.each([
    [path.posix, "/repo", "/repo", true],
    [path.posix, "/repo", "/repo/tmp-env", true],
    [path.posix, "/repo", "/repo/a/../tmp-env", true],
    [path.posix, "/repo", "/repo-sibling", false],
    [path.posix, "/repo", "/repo/../elsewhere", false],
    [path.posix, "/repo", "/var/tmp/k8s-env", false],
    [path.win32, "D:\\a\\repo", "D:\\a\\repo", true],
    [path.win32, "D:\\a\\repo", "D:\\a\\repo\\tmp-env", true],
    [path.win32, "D:\\a\\repo", "d:\\A\\Repo\\tmp-env", true],
    [path.win32, "D:\\a\\repo", "D:\\a\\repo-sibling", false],
    [path.win32, "D:\\a\\repo", "C:\\a\\repo\\tmp-env", false],
  ])("case %#: a directory inside the root, by the platform's own path rules", (paths, root, dir, inside) => {
    expect(insideDirectory(root, dir, paths)).toBe(inside);
  });
});

describe("runArguments", () => {
  test("takes a set and an absolute directory outside the repository", () => {
    expect(runArguments(["--set", "v1.35.5", "--env", "/var/tmp/k8s-env"])).toEqual({
      set: "v1.35.5",
      envDir: "/var/tmp/k8s-env",
    });
  });

  test.each([
    [[], "--set takes one of v1.35.5, v1.30.14, v1.29.15"],
    [["--set", "v1.27.0", "--env", "/var/tmp/x"], "--set takes one of v1.35.5, v1.30.14, v1.29.15"],
    [["--set", "v1.35.5"], "--env takes the absolute K8S_ENV_DIR that docker/kubernetes/seed.sh wrote"],
    [
      ["--set", "v1.35.5", "--env", "relative/dir"],
      "--env takes the absolute K8S_ENV_DIR that docker/kubernetes/seed.sh wrote",
    ],
    [
      ["--set", "v1.35.5", "--env", path.join(ROOT, "tmp-env")],
      "--env must be outside the repository: it holds tokens and a client key",
    ],
  ])("refuses %j", (argv, sentence) => {
    expect(() => runArguments(argv)).toThrow(sentence);
  });
});

describe("connectionOf", () => {
  test("maps an imported context onto a Kubernetes connection, numbers and all", () => {
    expect(
      connectionOf(
        {
          name: "reader",
          fields: { host: "127.0.0.1", port: "26443", password: "token", database: "shop" },
          ssl: { mode: "verify-full", caCert: "CA" },
          notices: [],
        },
        "reader",
      ),
    ).toEqual({
      id: "kubernetes-evidence-reader",
      name: "kubernetes evidence reader",
      type: "kubernetes",
      host: "127.0.0.1",
      port: 26443,
      password: "token",
      database: "shop",
      ssl: { mode: "verify-full", caCert: "CA" },
      createdAt: new Date(0),
    });
  });

  test("refuses a context that names no server", () => {
    expect(() => connectionOf({ name: "x", fields: {}, notices: [] }, "viewer")).toThrow(
      "the viewer kubeconfig names no server",
    );
  });
});
