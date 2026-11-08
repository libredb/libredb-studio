/**
 * What an etcd user reaches through MCP beyond the keys it is meant to read, from the raw answers v3.7.2 gave in
 * tests/fixtures/etcd/v3.7.2/mcp-scope/ (written by tests/live/etcd-mcp-boundary.ts), and what Studio withholds from
 * each answer whatever the command said.
 *
 * Two layers, each pinned on its own. The server's grants: a user reading `/app/` is refused a Kubernetes Secret's
 * key `permission denied` whether the Secret exists or not, a key of another prefix alike, and the lease list and a
 * lease's keys while a lease holds a key outside its ranges. Studio's side: the proof reads each role's ranges from the
 * server's own RoleGet answer and refuses READ on every key, on `/registry/`, on one Secret's key and on `/`, and
 * proves READ on one key of `/app/`; a refusal is worded by its category alone, so a Secret that exists reads the same
 * as one that does not, and a member's addresses are counted, never named.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { ExecutionProfileError } from "@/lib/db/errors";
import { etcdAgentFailure, etcdAgentResult } from "@/lib/db/providers/keyvalue/etcd/agent-metadata-read";
import { ETCD_PROOF_SENTENCES, proveEtcdReadOnly } from "@/lib/db/providers/keyvalue/etcd/agent-read-only-proof";
import type { ReadOnlyStatementBudget } from "@/lib/db/types";
import { type CapturedAnswer, capturedError, capturedMembers, capturedPermissions } from "../../../helpers/etcd-agent";
import { createFakeEtcdClient } from "../../../helpers/etcd-fake-client";

const SCOPE = posix.join(
  import.meta.dir.replaceAll("\\", "/"),
  "..",
  "..",
  "..",
  "fixtures",
  "etcd",
  "v3.7.2",
  "mcp-scope",
);
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 5_000, maxResultRows: 100, maxResultBytes: 65_536 };

type ScopeCapture = CapturedAnswer & {
  readonly $captured: { readonly version: string };
  readonly principal: string;
  readonly grants: ReadonlyArray<{ readonly role: string }>;
  readonly request: Readonly<Record<string, unknown>>;
};

const capture = (name: string): ScopeCapture =>
  JSON.parse(readFileSync(posix.join(SCOPE, `${name}.json`), "utf8")) as ScopeCapture;

/** The agent's wording of a captured refusal. */
const wording = (name: string, statement: string): string | undefined =>
  etcdAgentFailure(capturedError(capture(name)), BUDGET, statement)?.message;

/** The proof's verdict for a user whose one role answered RoleGet as `name` captured. */
async function verdict(name: string): Promise<string> {
  const captured = capture(name);
  if (captured.outcome !== "ok") throw new Error(`${name} holds a refusal`);
  const permissions = capturedPermissions(captured.answer as Parameters<typeof capturedPermissions>[0]);
  const client = createFakeEtcdClient({
    authStatus: async () => ({ enabled: true, authRevision: "1" }),
    userGet: async () => captured.grants.map((grant) => grant.role),
    roleGet: async () => permissions,
  });
  try {
    await proveEtcdReadOnly(client, captured.principal, new AbortController().signal);
    return "proved";
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error.message;
    throw error;
  }
}

describe("the server's grants: a user reading /app/", () => {
  test("is refused a Secret's key alike whether it exists or not, and a key of another prefix", () => {
    for (const name of ["secret-present-reader-app", "secret-absent-reader-app", "outside-reader-app"]) {
      expect(capture(name)).toMatchObject({
        principal: "mcp_reader_app",
        outcome: "error",
        code: 7,
        details: "etcdserver: permission denied",
      });
    }
    expect(capture("secret-present-reader-app").$captured.version).toBe("3.7.2");
  });

  test("is refused the lease list and a lease's keys while a lease holds a key outside its ranges", () => {
    for (const name of ["lease-list-reader-app", "lease-keys-registry-reader-app"]) {
      expect(capture(name)).toMatchObject({ outcome: "error", code: 7, details: "etcdserver: permission denied" });
    }
  });

  test("is answered the cluster's status, alarms and members, which its grants do not govern", () => {
    for (const name of ["status-reader-app", "alarm-list-reader-app", "member-list-reader-app"]) {
      expect(capture(name).outcome).toBe("ok");
    }
  });
});

describe("Studio's side", () => {
  test("a Secret that exists and one that does not are refused in one sentence, with no word of etcd's", () => {
    const present = wording("secret-present-reader-app", "get /registry/secrets/default/present");
    const absent = wording("secret-absent-reader-app", "get /registry/secrets/default/absent");
    expect(present).toBe(absent);
    expect(present).not.toContain("etcdserver");
    expect(present).not.toContain("/registry/");
  });

  test("a member's addresses, served to the reader, are counted and never named", () => {
    const captured = capture("member-list-reader-app");
    if (captured.outcome !== "ok") throw new Error("the member list was refused");
    const raw = captured.answer as Parameters<typeof capturedMembers>[0];
    expect(JSON.stringify(raw)).toContain("https://127.0.0.1:2379");
    const answer = etcdAgentResult({ op: "member list", members: capturedMembers(raw) }, BUDGET, "member list", 1);
    expect(answer.rows).toEqual([expect.objectContaining({ peer_urls: 1, client_urls: 1 })]);
    expect(JSON.stringify(answer)).not.toContain("127.0.0.1");
  });

  test.each([
    ["READ on every key", "role-read-all", ETCD_PROOF_SENTENCES.everyKey],
    ["READ on /registry/", "role-read-registry", ETCD_PROOF_SENTENCES.kubernetes("/registry/")],
    ["READ on one Secret's key", "role-read-secret-key", ETCD_PROOF_SENTENCES.kubernetes("/registry/")],
    ["READ on /", "role-read-slash", ETCD_PROOF_SENTENCES.kubernetes("/registry/")],
    ["READ on one key of /app/", "role-read-app-key", "proved"],
  ])("the proof over the server's RoleGet answer for %s", async (_what, name, expected) => {
    expect(await verdict(name)).toBe(expected);
  });
});
