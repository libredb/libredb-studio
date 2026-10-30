/**
 * The Redis agent read-only proof (`redis-read-only-proof.ts`) over what Redis 8.10.2 and Valkey 9.1.2 answered each
 * principal, replayed from tests/fixtures/redis/<version>/agent-boundary/.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError } from "@/lib/db/errors";
import {
  proveRedisReadOnly,
  REDIS_PROOF_SENTENCES,
  type RedisReply,
  redisAgentUser,
  redisProofProbes,
} from "@/lib/db/providers/keyvalue/redis-read-only-proof";
import {
  type CapturedStep,
  capturedRoundTrip,
  probeLabel,
  REDIS_CAPTURE_VERSIONS,
  readRedisCapture,
} from "../../../helpers/redis-agent";

const NONCE = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";

async function refusalOf(promise: Promise<void>): Promise<ExecutionProfileError> {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof ExecutionProfileError)) throw new Error(`not refused: ${String(error)}`);
  return error;
}

describe("the agent's ACL user", () => {
  test("a connection naming no user, or default, is refused before anything is sent", () => {
    for (const user of [undefined, ""]) {
      expect(() => redisAgentUser(user)).toThrow(REDIS_PROOF_SENTENCES.noUser);
      try {
        redisAgentUser(user);
      } catch (error) {
        expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_SERVER_UNENFORCED");
      }
    }
    expect(() => redisAgentUser("default")).toThrow(REDIS_PROOF_SENTENCES.defaultUser);
    try {
      redisAgentUser("default");
    } catch (error) {
      expect((error as ExecutionProfileError).reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    }
    expect(redisAgentUser("agent_reader")).toBe("agent_reader");
    expect(redisAgentUser("Default")).toBe("Default");
  });
});

describe("the probes", () => {
  test("each names a key, channel, parameter, library and script that exist nowhere, fresh for the nonce", () => {
    expect(redisProofProbes(NONCE).map((probe) => [...probe.argv])).toEqual([
      ["DEL", `libredb-agent-probe:${NONCE}`],
      ["UNLINK", `libredb-agent-probe:${NONCE}`],
      ["SET", `libredb-agent-probe:${NONCE}`, "x", "XX"],
      ["EXPIRE", `libredb-agent-probe:${NONCE}`, "1"],
      ["HDEL", `libredb-agent-probe:${NONCE}`, "f"],
      ["LREM", `libredb-agent-probe:${NONCE}`, "0", "x"],
      ["SREM", `libredb-agent-probe:${NONCE}`, "x"],
      ["ZREM", `libredb-agent-probe:${NONCE}`, "x"],
      ["XDEL", `libredb-agent-probe:${NONCE}`, "0-1"],
      ["MOVE", `libredb-agent-probe:${NONCE}`, "1"],
      ["RESTORE", `libredb-agent-probe:${NONCE}`, "0", "not-a-dump-payload"],
      ["CONFIG", "SET", `libredb-agent-probe-${NONCE}`, "x"],
      ["EVALSHA", "0f1e2d3c4b5a69788796a5b4c3d2e1f000000000", "0"],
      ["FUNCTION", "DELETE", "libredb_agent_probe_0f1e2d3c_4b5a_6978_8796_a5b4c3d2e1f0"],
      ["PUBLISH", `libredb-agent-probe:${NONCE}`, "x"],
    ]);
    expect(redisProofProbes(NONCE).map((probe) => probe.label)).toEqual(
      redisProofProbes(NONCE).map((probe) => probeLabel(probe.argv)),
    );
  });

  test("the captures measured every probe the proof sends, so each label is on record", () => {
    for (const version of REDIS_CAPTURE_VERSIONS) {
      const captured = readRedisCapture<{ probes: CapturedStep[] }>(version, "reader").probes.map((step) =>
        probeLabel(step.argv),
      );
      expect(captured).toEqual(redisProofProbes(NONCE).map((probe) => probe.label));
    }
  });

  test("a fresh nonce is drawn for every proof that names none", async () => {
    const roundTrip = capturedRoundTrip("8.10.2", "reader");
    await proveRedisReadOnly(roundTrip);
    await proveRedisReadOnly(roundTrip);
    const [first, second] = roundTrip.sent.map((commands) => commands[1][1]);
    expect(first).toMatch(/^libredb-agent-probe:[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});

describe.each(REDIS_CAPTURE_VERSIONS)("the proof over %s's answers", (version) => {
  test.each(["reader", "reader-info", "read-keys-read", "prefix"])(
    "%s is refused every probe NOPERM, so it is proved read-only in one round trip",
    async (principal) => {
      const roundTrip = capturedRoundTrip(version, principal);
      await proveRedisReadOnly(roundTrip, NONCE);
      expect(roundTrip.sent).toHaveLength(1);
      expect(roundTrip.sent[0][0]).toEqual(["HELLO", "2"]);
      expect(roundTrip.sent[0].slice(1)).toEqual(redisProofProbes(NONCE).map((probe) => probe.argv));
    },
  );

  test.each([
    ["default-nopass", "DEL"],
    ["full", "DEL"],
    ["read-del", "DEL"],
    ["read-set", "SET"],
  ])("%s is refused at the first probe it is admitted, %s", async (principal, label) => {
    const error = await refusalOf(proveRedisReadOnly(capturedRoundTrip(version, principal), NONCE));
    expect(error.message).toBe(REDIS_PROOF_SENTENCES.admitted(label));
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
  });

  test("read-keys is refused at CONFIG SET, which it is admitted and which then refuses the unknown parameter ERR", async () => {
    const error = await refusalOf(proveRedisReadOnly(capturedRoundTrip(version, "read-keys"), NONCE));
    expect(error.message).toBe(REDIS_PROOF_SENTENCES.unread("CONFIG SET"));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
  });

  test("a write granted mid-run is refused at the next proof: no verdict is kept", async () => {
    const midrun = readRedisCapture<{ probesBeforeGrant: CapturedStep[]; probesAfterGrant: CapturedStep[] }>(
      version,
      "midrun",
    );
    await proveRedisReadOnly(capturedRoundTrip(version, "midrun", { probes: midrun.probesBeforeGrant }), NONCE);
    const error = await refusalOf(
      proveRedisReadOnly(capturedRoundTrip(version, "midrun", { probes: midrun.probesAfterGrant }), NONCE),
    );
    expect(error.message).toBe(REDIS_PROOF_SENTENCES.admitted("DEL"));
  });

  test("a probe refused with anything but NOPERM proves nothing", async () => {
    const reader = readRedisCapture<{ probes: CapturedStep[] }>(version, "reader").probes;
    const probes = reader.map((step) =>
      probeLabel(step.argv) === "UNLINK"
        ? { ...step, error: "READONLY You can't write against a read only replica." }
        : step,
    );
    const error = await refusalOf(proveRedisReadOnly(capturedRoundTrip(version, "midrun", { probes }), NONCE));
    expect(error.message).toBe(REDIS_PROOF_SENTENCES.unread("UNLINK"));
    expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    const renamed = reader.map((step) =>
      probeLabel(step.argv) === "CONFIG SET" ? { ...step, error: "ERR unknown command 'CONFIG'" } : step,
    );
    expect(
      (await refusalOf(proveRedisReadOnly(capturedRoundTrip(version, "midrun", { probes: renamed }), NONCE))).message,
    ).toBe(REDIS_PROOF_SENTENCES.unread("CONFIG SET"));
    const lowercase = reader.map((step) =>
      probeLabel(step.argv) === "DEL" ? { ...step, error: "noperm no permissions" } : step,
    );
    expect(
      (await refusalOf(proveRedisReadOnly(capturedRoundTrip(version, "midrun", { probes: lowercase }), NONCE))).message,
    ).toBe(REDIS_PROOF_SENTENCES.unread("DEL"));
  });
});

describe("what the server says it is", () => {
  const hello = (fields: Record<string, unknown>): RedisReply => ({ ok: true, reply: Object.entries(fields).flat() });

  test("Valkey reporting itself as Redis under its compatibility switch is still the server measured", async () => {
    const compat = readRedisCapture<{ hello: unknown[] }>("valkey-9.1.2", "identity-compatibility");
    expect(compat.hello.slice(0, 2)).toEqual(["server", "redis"]);
    await proveRedisReadOnly(
      capturedRoundTrip("valkey-9.1.2", "reader", { hello: { ok: true, reply: compat.hello } }),
      NONCE,
    );
  });

  test("a server naming itself anything else, or a cluster, is refused until measured", async () => {
    for (const reply of [
      hello({ server: "dragonfly", version: "1.40.1", mode: "standalone" }),
      hello({ server: "redis", version: "8.10.2", mode: "cluster" }),
      hello({ server: "redis", version: "8.10.2", mode: "sentinel" }),
      hello({ server: "redis", version: "8.10.2" }),
      hello({ server: 7, mode: "standalone" }),
      hello({ version: "8.10.2", mode: "standalone" }),
    ]) {
      const error = await refusalOf(proveRedisReadOnly(capturedRoundTrip("8.10.2", "reader", { hello: reply }), NONCE));
      expect(error.message).toBe(REDIS_PROOF_SENTENCES.notMeasured);
      expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
    }
  });

  test("a HELLO the proof cannot read refuses the profile", async () => {
    for (const reply of [
      { ok: false, error: "NOPERM User agent has no permissions to run the 'hello' command" },
      { ok: true, reply: "OK" },
      { ok: true, reply: ["server", "redis", "version"] },
      { ok: true, reply: [1, "redis"] },
    ] as RedisReply[]) {
      const error = await refusalOf(proveRedisReadOnly(capturedRoundTrip("8.10.2", "reader", { hello: reply }), NONCE));
      expect(error.message).toBe(REDIS_PROOF_SENTENCES.unread("HELLO 2"));
    }
  });

  test("a round trip that answers fewer commands than it was sent proves nothing", async () => {
    expect((await refusalOf(proveRedisReadOnly(async () => [], NONCE))).message).toBe(
      REDIS_PROOF_SENTENCES.unread("HELLO 2"),
    );
    const helloOnly = capturedRoundTrip("8.10.2", "reader");
    const short = async (commands: readonly (readonly string[])[]) => (await helloOnly(commands)).slice(0, 3);
    expect((await refusalOf(proveRedisReadOnly(short, NONCE))).message).toBe(REDIS_PROOF_SENTENCES.unread("SET"));
  });

  test("a failed round trip is raised as it is, never read as a verdict", async () => {
    const failure = new Error("Connection is closed.");
    const error = await proveRedisReadOnly(async () => {
      throw failure;
    }, NONCE).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBe(failure);
  });
});
