/**
 * The Milvus agent read-only proof, replayed from what Milvus 3.0.2 answered each principal
 * (tests/fixtures/milvus/3.0.2/agent-boundary/) through the real adapter. The proof reads only: the user list, which a
 * read-only user is refused, the user itself with its roles, and each role's grants and `public`'s; the server's
 * answers decide, and the verdict is never kept.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import { MilvusError } from "@/lib/db/providers/vector/milvus/client";
import type { MilvusAuth, MilvusConnectionOptions } from "@/lib/db/providers/vector/milvus/connection-options";
import { createGrpcMilvusClient } from "@/lib/db/providers/vector/milvus/grpc-client";
import {
  MILVUS_PROOF_MAX_ROLES,
  MILVUS_PROOF_SENTENCES,
  MILVUS_READ_PRIVILEGES,
  milvusAgentUser,
  proveMilvusReadOnly,
} from "@/lib/db/providers/vector/milvus/read-only-proof";
import { expectCalls } from "../../../helpers/call-log";
import { agentMilvusWire, MILVUS_AGENT_USERS, milvusAgentCapture } from "../../../helpers/milvus-agent";
import { okStatus, recordedMilvusWire, statusError } from "../../../helpers/milvus-wire";

const OPTIONS: MilvusConnectionOptions = {
  target: "dns:127.0.0.1:19530",
  endpoint: { host: "127.0.0.1", port: 19530 },
  auth: { kind: "none" },
  database: "default",
  callTimeoutMs: 10_000,
  receiveCapBytes: 16 * 1024 * 1024,
  secretForms: [],
};

const call = () => ({ db: "default", signal: new AbortController().signal });

async function proofOf(principal: string, wire = agentMilvusWire(principal)) {
  const client = await createGrpcMilvusClient(OPTIONS, wire.transport);
  const user = MILVUS_AGENT_USERS[principal] as string;
  const outcome = await proveMilvusReadOnly(client, user, call()).then(
    () => "proved" as const,
    (error: unknown) => error,
  );
  return { outcome, wire };
}

function refusal(outcome: unknown): ExecutionProfileError {
  expect(outcome).toBeInstanceOf(ExecutionProfileError);
  return outcome as ExecutionProfileError;
}

const userList = { method: "ListCredUsers", args: [{}, {}] };
const selfOf = (name: string) => ({ method: "SelectUser", args: [{ user: { name }, include_role_info: true }, {}] });
const grantsOf = (role: string) => ({
  method: "SelectGrant",
  args: [{ entity: { role: { name: role }, db_name: "*" } }, {}],
});
const privilegesIn = (capture: ReturnType<typeof milvusAgentCapture>) =>
  (capture.payload as { entities: { grantor: { privilege: { name: string } }; db_name: string }[] }).entities.map(
    (grant) => `${grant.grantor.privilege.name}@${grant.db_name}`,
  );

describe("the privileges a read-only user may hold", () => {
  const groups = Object.fromEntries(
    (
      milvusAgentCapture("list-privilege-groups", "root").payload as {
        privilege_groups: { group_name: string; privileges: { name: string }[] }[];
      }
    ).privilege_groups.map((group) => [group.group_name, group.privileges.map((privilege) => privilege.name)]),
  );

  test("are the two read-only groups 3.0.2 lists, their members, and ListDatabases, and nothing else", () => {
    expect([...MILVUS_READ_PRIVILEGES].sort()).toEqual(
      [
        "CollectionReadOnly",
        "DatabaseReadOnly",
        ...(groups.CollectionReadOnly as string[]),
        ...(groups.DatabaseReadOnly as string[]),
        "ListDatabases",
      ].sort(),
    );
  });

  test("hold no privilege a read-write, admin or cluster group adds", () => {
    const readOnly = new Set([...(groups.CollectionReadOnly as string[]), ...(groups.DatabaseReadOnly as string[])]);
    for (const wider of ["CollectionReadWrite", "CollectionAdmin", "DatabaseReadWrite", "DatabaseAdmin"]) {
      for (const privilege of groups[wider] as string[]) {
        if (!readOnly.has(privilege)) expect(MILVUS_READ_PRIVILEGES).not.toContain(privilege);
      }
    }
    for (const privilege of groups.ClusterReadOnly as string[]) {
      if (privilege !== "ListDatabases") expect(MILVUS_READ_PRIVILEGES).not.toContain(privilege);
    }
  });
});

describe("the agent's user", () => {
  test("is a pair's user, or a token's user before its colon", () => {
    expect(milvusAgentUser({ kind: "password", user: "agent_reader", password: "not-a-real-password" })).toBe(
      "agent_reader",
    );
    expect(milvusAgentUser({ kind: "token", token: "agent_reader:not-a-real-password" })).toBe("agent_reader");
  });

  test.each<[string, MilvusAuth, string]>([
    ["no credential", { kind: "none" }, MILVUS_PROOF_SENTENCES.noUser],
    ["a token with no user", { kind: "token", token: "not-a-real-token" }, MILVUS_PROOF_SENTENCES.noUser],
    [
      "a token that starts with its colon",
      { kind: "token", token: ":not-a-real-token" },
      MILVUS_PROOF_SENTENCES.noUser,
    ],
    ["an empty user", { kind: "password", user: "", password: "not-a-real-password" }, MILVUS_PROOF_SENTENCES.noUser],
  ])("%s is refused before anything is sent", (_name, auth, sentence) => {
    let thrown: unknown;
    try {
      milvusAgentUser(auth);
    } catch (error) {
      thrown = error;
    }
    expect(refusal(thrown).message).toBe(sentence);
    expect((thrown as ExecutionProfileError).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
  });
});

describe("the proof against what 3.0.2 answered", () => {
  test("a CollectionReadOnly reader is proved by its user list refused, its role's grants and public's", async () => {
    const { outcome, wire } = await proofOf("reader");
    expect(outcome).toBe("proved");
    expectCalls(wire, [userList, selfOf("agent_reader"), grantsOf("agent_reader_role"), grantsOf("public")]);
  });

  test("a DatabaseReadOnly user is proved: 3.0.2's group grants ShowCollections and DescribeDatabase alone", async () => {
    expect((await proofOf("dbro")).outcome).toBe("proved");
    expect(milvusAgentCapture("write-create-collection", "dbro").payload).toMatchObject({ error: { code: 7 } });
  });

  test("a user with no role is proved on public's grants alone", async () => {
    const { outcome, wire } = await proofOf("nobody");
    expect(outcome).toBe("proved");
    expectCalls(wire, [userList, selfOf("agent_nobody"), grantsOf("public")]);
  });

  test.each([
    ["rw", "CollectionReadWrite"],
    ["custom", "agent_read_group"],
  ])("%s is refused by the grant it holds, %s", async (principal, privilege) => {
    const error = refusal((await proofOf(principal)).outcome);
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(MILVUS_PROOF_SENTENCES.grant(privilege));
  });

  test("a role's grants are read in every database: one that writes only another database is refused", async () => {
    expect(privilegesIn(milvusAgentCapture("select-grant-own-role-default-only", "elsewhere"))).toEqual([
      "CollectionReadOnly@default",
    ]);
    expect(privilegesIn(milvusAgentCapture("select-grant-own-role", "elsewhere")).sort()).toEqual([
      "CollectionReadOnly@default",
      "Insert@agent_other_db",
    ]);
    expect(milvusAgentCapture("write-insert-other-db", "elsewhere").outcome).toBe("pass");
    const { outcome, wire } = await proofOf("elsewhere");
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.grant("Insert"));
    expectCalls(wire, [userList, selfOf("agent_elsewhere"), grantsOf("agent_elsewhere_role")]);
  });

  test("a read-write user of a database other than default is refused, whichever database it connects to", async () => {
    expect(privilegesIn(milvusAgentCapture("select-grant-own-role-default-only", "rwother"))).toEqual([]);
    expect(milvusAgentCapture("write-insert-other-db", "rwother").outcome).toBe("pass");
    const error = refusal((await proofOf("rwother")).outcome);
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(MILVUS_PROOF_SENTENCES.grant("CollectionReadWrite"));
  });

  test("a ClusterReadOnly user is refused by its grant, though it reads only, since it may list every user", async () => {
    const error = refusal((await proofOf("clusterro")).outcome);
    expect(error.message).toBe(MILVUS_PROOF_SENTENCES.grant("ClusterReadOnly"));
  });

  test("a user holding the admin role is refused by its role, its grants unread", async () => {
    const { outcome, wire } = await proofOf("admin");
    const error = refusal(outcome);
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(MILVUS_PROOF_SENTENCES.admin);
    expectCalls(wire, [userList, selfOf("agent_admin")]);
  });

  test("root is refused by name before anything is sent: it lists no role and passes every check", async () => {
    expect(milvusAgentCapture("select-user-self", "root").payload).toMatchObject({
      results: [{ user: { name: "root" }, roles: [] }],
    });
    const { outcome, wire } = await proofOf("root");
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.root);
    expectCalls(wire, []);
  });

  test("a read-only user on a server with authorization off is refused: the server answered it the user list", async () => {
    const { outcome, wire } = await proofOf("open-reader");
    const error = refusal(outcome);
    expect(error.reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
    expect(error.message).toBe(MILVUS_PROOF_SENTENCES.unenforced);
    expectCalls(wire, [userList, selfOf("agent_reader"), grantsOf("agent_reader_role"), grantsOf("public")]);
  });

  test("a grant made during the run is read at the next proof: no verdict is kept", async () => {
    let grants = "select-grant-own-role";
    const wire = agentMilvusWire("midrun", { ownGrants: () => grants });
    const client = await createGrpcMilvusClient(OPTIONS, wire.transport);
    await proveMilvusReadOnly(client, "agent_midrun", call());
    grants = "select-grant-own-role-after-grant";
    const outcome = await proveMilvusReadOnly(client, "agent_midrun", call()).catch((error: unknown) => error);
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.grant("Insert"));
    expect(wire.calls.filter((logged) => logged.method === "ListCredUsers")).toHaveLength(2);
  });
});

describe("the proof fails closed", () => {
  const reader = (overrides: NonNullable<Parameters<typeof agentMilvusWire>[1]>["overrides"]) =>
    proofOf("reader", agentMilvusWire("reader", { overrides }));

  test("a user list refused with anything but PERMISSION_DENIED is no proof", async () => {
    const statusRefused = await reader({
      ListCredUsers: () => ({ status: { ...okStatus, code: 1100, error_code: "IllegalArgument" }, usernames: [] }),
    });
    expect(refusal(statusRefused.outcome).message).toBe(MILVUS_PROOF_SENTENCES.unread("the user list"));
    expect(refusal(statusRefused.outcome).reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    const unauthenticated = await reader({ ListCredUsers: () => Promise.reject(statusError(16, "auth")) });
    expect(refusal(unauthenticated.outcome).message).toBe(MILVUS_PROOF_SENTENCES.unread("the user list"));
  });

  test("a transport failure is raised as the client's own error, never read as a verdict", async () => {
    const { outcome } = await reader({ ListCredUsers: () => Promise.reject(statusError(14, "unavailable")) });
    expect(outcome).toBeInstanceOf(MilvusError);
    expect((outcome as MilvusError).category).toBe("unavailable");
  });

  test.each([
    ["no result", { status: okStatus, results: [] }],
    ["another user", { status: okStatus, results: [{ user: { name: "root" }, roles: [], description: "" }] }],
    ["no user entity", { status: okStatus, results: [{ user: null, roles: [], description: "" }] }],
    [
      "two results",
      {
        status: okStatus,
        results: [
          { user: { name: "agent_reader" }, roles: [], description: "" },
          { user: { name: "agent_reader" }, roles: [], description: "" },
        ],
      },
    ],
  ])("a user read answering %s refuses the profile", async (_name, answer) => {
    const { outcome } = await reader({ SelectUser: () => answer });
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.unread("the user's roles"));
  });

  test("a user read refused by the server is no proof, and a transport failure on it is raised as itself", async () => {
    const refused = await reader({ SelectUser: () => Promise.reject(statusError(7, "permission deny")) });
    expect(refusal(refused.outcome).message).toBe(MILVUS_PROOF_SENTENCES.unread("the user's roles"));
    const dropped = await reader({ SelectUser: () => Promise.reject(statusError(14, "unavailable")) });
    expect((dropped.outcome as MilvusError).category).toBe("unavailable");
  });

  test("a grant read lost to the transport is raised as the client's own error", async () => {
    const { outcome } = await reader({ SelectGrant: () => Promise.reject(statusError(14, "unavailable")) });
    expect(outcome).toBeInstanceOf(MilvusError);
    expect((outcome as MilvusError).category).toBe("unavailable");
  });

  test("a user holding more roles than the proof reads is refused", async () => {
    const roles = Array.from({ length: MILVUS_PROOF_MAX_ROLES + 1 }, (_, index) => ({
      name: `role_${index}`,
      description: "",
    }));
    const { outcome, wire } = await reader({
      SelectUser: () => ({ status: okStatus, results: [{ user: { name: "agent_reader" }, roles, description: "" }] }),
    });
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.tooManyRoles(MILVUS_PROOF_MAX_ROLES + 1));
    expect(wire.calls.map((logged) => logged.method)).toEqual(["ListCredUsers", "SelectUser"]);
  });

  test("a grant whose privilege cannot be read refuses the profile", async () => {
    const { outcome } = await reader({
      SelectGrant: () => ({
        status: okStatus,
        entities: [{ role: { name: "public" }, object: { name: "Global" }, object_name: "*", grantor: null }],
      }),
    });
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.unread("a role's grants"));
  });

  test("a grant read refused refuses the profile", async () => {
    const { outcome } = await reader({ SelectGrant: () => Promise.reject(statusError(7, "permission deny")) });
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.unread("a role's grants"));
  });

  test("a public role widened with a write is refused, so a grant to every user is caught", async () => {
    const wire = recordedMilvusWire({
      ListCredUsers: () => Promise.reject(statusError(7, "permission deny")),
      SelectUser: () => ({
        status: okStatus,
        results: [{ user: { name: "agent_nobody" }, roles: [], description: "" }],
      }),
      SelectGrant: () => ({
        status: okStatus,
        entities: [
          {
            role: { name: "public" },
            object: { name: "Collection" },
            object_name: "*",
            grantor: { user: { name: "root" }, privilege: { name: "Insert" } },
            db_name: "*",
          },
        ],
      }),
    });
    const client = await createGrpcMilvusClient(OPTIONS, wire.transport);
    const outcome = await proveMilvusReadOnly(client, "agent_nobody", call()).catch((error: unknown) => error);
    expect(refusal(outcome).message).toBe(MILVUS_PROOF_SENTENCES.grant("Insert"));
  });
});
